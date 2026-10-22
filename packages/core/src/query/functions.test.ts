// Unit tests for the expression functions: aggregates, logic, coalesce, caseWhen, exists,
// val, lit, param and fragment.
import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { QueryError } from "../errors.js";
import { Schema, t } from "../schema/index.js";
import { collectParams, type NamedParamNode, shapeOf } from "./ast.js";
import type { AnyExpr } from "./expr.js";
import { asSubquery, columns, postsByViews, show } from "./expr-fixtures.js";
import {
  and,
  arrayAgg,
  avg,
  caseWhen,
  coalesce,
  count,
  countDistinct,
  exists,
  fragment,
  jsonAgg,
  lit,
  max,
  min,
  not,
  now,
  or,
  param,
  stringAgg,
  sum,
  val,
} from "./functions.js";

const u = columns(User, "u");
const p = columns(Post, "p");

class Ledger extends Schema("ledgers", {
  id: t.integer().primaryKey(),
  total: t.bigint(),
  amount: t.float(),
  balance: t.decimal(),
  secret: t.integer().redact(),
}) {}
const l = columns(Ledger, "l");

function shown(expr: AnyExpr): string {
  const params: unknown[] = [];
  const lists: number[] = [];
  const named: NamedParamNode[] = [];
  collectParams(expr.node, params, lists, named);
  expect(expr.params).toEqual(params);
  expect(expr.lists).toEqual(lists);
  expect(expr.named).toEqual(named);
  expect(expr.shape).toBe(shapeOf(expr.node));
  return show(expr.node);
}

describe("aggregates", () => {
  test("count with no argument counts rows; with one, non-null values", () => {
    expect(shown(count())).toMatchInlineSnapshot(`"count(*)"`);
    expect(shown(count(p.id))).toMatchInlineSnapshot(`"count(p.id)"`);
    expect(shown(countDistinct(p.authorId))).toMatchInlineSnapshot(`"count(DISTINCT p.author_id)"`);
    expect(count().type?.name).toBe("bigint(number)");
    expect(count(p.id).shape).not.toBe(countDistinct(p.id).shape);
  });

  test("sum reads a sum of integers as a number and keeps every other type", () => {
    expect(shown(sum(p.views))).toMatchInlineSnapshot(`"sum(p.views)"`);
    expect(sum(p.views).type?.name).toBe("bigint(number)");
    expect(sum(l.total).type?.name).toBe("bigint");
    expect(sum(l.amount).type?.name).toBe("float");
    expect(sum(l.balance).type?.name).toBe("decimal");
    expect(sum(u.id).type?.name).toBe("bigint(number)");
  });

  test("avg of numbers is cast to a float; avg of decimals stays a decimal", () => {
    expect(shown(avg(u.age))).toMatchInlineSnapshot(`"(cast avg(u.age) :float)"`);
    expect(avg(u.age).type?.name).toBe("float");
    expect(shown(avg(l.balance))).toMatchInlineSnapshot(`"avg(l.balance)"`);
    expect(avg(l.balance).type?.name).toBe("decimal");
  });

  test("min and max keep the argument's type and redaction", () => {
    expect(shown(min(p.createdAt))).toMatchInlineSnapshot(`"min(p.created_at)"`);
    expect(shown(max(u.role))).toMatchInlineSnapshot(`"max(u.role)"`);
    expect(max(u.role).type).toBe(u.role.type);
    expect(max(l.secret).redact).toBe(true);
  });

  test("arrayAgg, jsonAgg and stringAgg", () => {
    expect(shown(arrayAgg(p.title))).toMatchInlineSnapshot(`"arrayAgg(p.title)"`);
    expect(arrayAgg(p.title).type?.name).toBe("array(string)");
    expect(arrayAgg(val(1)).type).toBeUndefined();
    expect(shown(jsonAgg(p.title))).toMatchInlineSnapshot(`"jsonAgg(p.title)"`);
    expect(jsonAgg(p.title).type?.name).toBe("json");
    expect(shown(stringAgg(p.title, ", "))).toMatchInlineSnapshot(`"stringAgg(p.title, $", ":string)"`);
    expect(() => stringAgg(p.title, null as never)).toThrow(QueryError);
  });

  test("filter adds FILTER (WHERE …); a second filter is ANDed", () => {
    expect(shown(sum(p.views).filter(p.published))).toMatchInlineSnapshot(
      `"sum(p.views) FILTER p.published"`,
    );
    expect(shown(count().filter(p.published).filter(p.views.gt(10)))).toMatchInlineSnapshot(
      `"count(*) FILTER (and p.published (gt p.views $10:integer))"`,
    );
    expect(shown(avg(u.age).filter(u.age.gt(param("min", t.integer()))))).toMatchInlineSnapshot(
      `"(cast avg(u.age) FILTER (gt u.age :min:integer) :float)"`,
    );
    expect(() => count().filter(true as never)).toThrow(/filter\(\) takes a boolean expression/);
  });

  test("filter and over keep the type, and the cast of avg", () => {
    const filtered = avg(u.age).filter(p.published);
    expect(filtered.type?.name).toBe("float");
    expect(filtered.node.kind).toBe("cast");
    expect(sum(p.views).over().type?.name).toBe("bigint(number)");
  });

  test("over: the whole result, a named window, or an inline one", () => {
    expect(shown(count().over())).toMatchInlineSnapshot(`"count(*) OVER(partition [] order [])"`);
    expect(shown(count().over("w"))).toMatchInlineSnapshot(`"count(*) OVER w"`);
    expect(
      shown(
        sum(p.views).over({
          partitionBy: [p.authorId],
          orderBy: [p.createdAt.desc(), p.id],
          frame: fragment`ROWS BETWEEN ${1} PRECEDING AND CURRENT ROW`,
        }),
      ),
    ).toMatchInlineSnapshot(
      `"sum(p.views) OVER(partition [p.author_id] order [(desc p.created_at), (asc p.id)] frame fragment["ROWS BETWEEN " $1 " PRECEDING AND CURRENT ROW"])"`,
    );
    expect(shown(avg(u.age).over({}))).toMatchInlineSnapshot(
      `"(cast avg(u.age) OVER(partition [] order []) :float)"`,
    );
    expect(count().over("w").shape).not.toBe(count().over("v").shape);
    expect(count().over("w").shape).not.toBe(count().over().shape);
  });

  test("over is refused twice, or with a malformed window", () => {
    expect(() => count().over("w").over("v")).toThrow(/over\(\) was already called/);
    expect(() => count().over("")).toThrow(QueryError);
    expect(() => count().over(42 as never)).toThrow(/over\(\) takes the name of a window/);
    expect(() => count().over({ partitionBy: ["x" as never] })).toThrow(/over\(\) takes an expression/);
    expect(() => count().over({ frame: p.id })).toThrow(/frame is a fragment/);
  });

  test("an argument that is not an expression is refused", () => {
    expect(() => count("id" as never)).toThrow(/count\(\) takes an expression/);
    expect(() => sum(3 as never)).toThrow(/sum\(\) takes an expression/);
    expect(() => max(undefined as never)).toThrow(/max\(\) takes an expression/);
  });

  test("sum and avg refuse a known non-numeric type", () => {
    expect(() => sum(u.email as never)).toThrow(
      /sum\(\) adds up numbers, and this expression has the type string/,
    );
    expect(() => avg(u.createdAt as never)).toThrow(/avg\(\) adds up numbers/);
    expect(shown(sum(fragment`1`.as<number>()))).toMatchInlineSnapshot(`"sum(fragment["1"])"`);
  });
});

describe("logic", () => {
  test("and and or of several conditions are one node", () => {
    expect(shown(and(u.age.gte(18), u.role.eq("admin"), p.published))).toMatchInlineSnapshot(
      `"(and (gte u.age $18:integer) (eq u.role $"admin":enum) p.published)"`,
    );
    expect(shown(or(u.role.eq("admin"), u.age.gte(65)))).toMatchInlineSnapshot(
      `"(or (eq u.role $"admin":enum) (gte u.age $65:integer))"`,
    );
  });

  test("with no conditions and is true and or is false; with one, it is that condition", () => {
    expect(shown(and())).toBe("TRUE");
    expect(shown(or())).toBe("FALSE");
    const one = u.age.gte(18);
    expect(and(one)).toBe(one);
    expect(or(one)).toBe(one);
  });

  test("not", () => {
    expect(shown(not(p.published))).toMatchInlineSnapshot(`"(not p.published)"`);
  });

  test("anything but an expression is refused", () => {
    expect(() => and(true as never)).toThrow(/and\(\) takes boolean expressions/);
    expect(() => or(u.age.gte(1), "x" as never)).toThrow(/or\(\) takes boolean expressions/);
    expect(() => not(false as never)).toThrow(/not\(\) takes boolean expressions/);
  });
});

describe("coalesce", () => {
  test("plain values are bound with the first argument's type", () => {
    expect(shown(coalesce(u.name, u.email))).toMatchInlineSnapshot(`"coalesce(u.name, u.email)"`);
    expect(shown(coalesce(u.name, "anonymous"))).toMatchInlineSnapshot(
      `"coalesce(u.name, $"anonymous":string)"`,
    );
    expect(shown(coalesce(sum(p.views), 0))).toMatchInlineSnapshot(
      `"coalesce(sum(p.views), $0:bigint(number))"`,
    );
    expect(coalesce(u.name, "x").type).toBe(u.name.type);
  });

  test("needs an expression first and at least two arguments", () => {
    expect(() => (coalesce as (...args: unknown[]) => unknown)("a", u.name)).toThrow(
      /coalesce\(\) takes an expression/,
    );
    expect(() => (coalesce as (...args: unknown[]) => unknown)(u.name)).toThrow(/at least two arguments/);
    expect(() => coalesce(u.name, null as never)).toThrow(QueryError);
  });
});

describe("caseWhen", () => {
  test("branches, then else", () => {
    expect(shown(caseWhen(u.age.lt(18), "minor").else("adult"))).toMatchInlineSnapshot(
      `"(case (when (lt u.age $18:integer) $"minor") (else $"adult"))"`,
    );
    expect(
      shown(caseWhen(u.age.lt(13), "child").when(u.age.lt(18), "teen").else("adult")),
    ).toMatchInlineSnapshot(
      `"(case (when (lt u.age $13:integer) $"child") (when (lt u.age $18:integer) $"teen") (else $"adult"))"`,
    );
  });

  test("without else, it is a CASE with no ELSE", () => {
    const open = caseWhen(u.age.lt(18), "minor");
    expect(shown(open)).toMatchInlineSnapshot(`"(case (when (lt u.age $18:integer) $"minor"))"`);
  });

  test("plain values take the type of an earlier expression branch", () => {
    expect(
      shown(caseWhen(p.published, p.title).when(u.age.lt(1), "none").else("other")),
    ).toMatchInlineSnapshot(
      `"(case (when p.published p.title) (when (lt u.age $1:integer) $"none":string) (else $"other":string))"`,
    );
    expect(caseWhen(u.age.lt(18), "minor").type).toBeUndefined();
    expect(caseWhen(u.age.lt(18), "minor").else(u.email).type).toBe(u.email.type);
    expect(shown(caseWhen(u.age.lt(18), null).else(u.name))).toMatchInlineSnapshot(
      `"(case (when (lt u.age $18:integer) $null) (else u.name))"`,
    );
  });

  test("a branch does not change the case it extends", () => {
    const one = caseWhen(u.age.lt(13), "child");
    one.when(u.age.lt(18), "teen");
    one.else("adult");
    expect(shown(one)).toMatchInlineSnapshot(`"(case (when (lt u.age $13:integer) $"child"))"`);
  });

  test("a condition must be an expression and a value cannot be undefined", () => {
    expect(() => caseWhen(true as never, "x")).toThrow(/caseWhen\(\) takes a boolean expression/);
    expect(() => caseWhen(u.age.lt(1), undefined as never)).toThrow(
      "query.undefinedOperandNullable: caseWhen() was given undefined, which is not a value.",
    );
    expect(() => caseWhen(u.age.lt(1), 1).when(u.age.lt(2), undefined as never)).toThrow(
      "query.undefinedOperandNullable: when() was given undefined, which is not a value.",
    );
    expect(() => caseWhen(u.age.lt(1), 1).when(true as never, 2)).toThrow(
      /^[a-z]+(?:\.\w+)?: when\(\) takes a boolean expression/,
    );
    expect(() => caseWhen(u.age.lt(1), 1).else(undefined as never)).toThrow(QueryError);
  });
});

describe("exists", () => {
  test("wraps a query, whose params come along", () => {
    const sub = postsByViews(10);
    const e = exists(asSubquery(sub));
    expect(shown(e)).toMatchInlineSnapshot(`"(exists from posts sp)"`);
    expect(e.params).toEqual([10]);
    expect(e.shape).toBe(exists(asSubquery(postsByViews(99))).shape);
  });

  test("refuses anything but a query", () => {
    expect(() => exists(u.age.gte(1) as never)).toThrow(/exists\(\) takes a query/);
    expect(() => exists(null as never)).toThrow(/exists\(\) takes a query/);
  });
});

describe("now", () => {
  test("is the database's time, loaded as a timestamp", () => {
    expect(shown(now())).toBe("now()");
    expect(now().type?.name).toBe("timestamp");
  });
});

describe("val", () => {
  test("binds a value, with no type unless one is given", () => {
    expect(shown(val("member"))).toMatchInlineSnapshot(`"$"member""`);
    expect(shown(val(new Date("2026-01-01T00:00:00Z"), t.timestamp()))).toMatchInlineSnapshot(
      `"$Date(2026-01-01T00:00:00.000Z):timestamp"`,
    );
    expect(shown(val(null))).toBe("$null");
    expect(val(1).shape).toBe(val(2).shape);
    expect(val(1).shape).not.toBe(val(1, t.integer()).shape);
  });

  test("refuses undefined and a type that is not a field type", () => {
    expect(() => val(undefined)).toThrow(/val\(\) was given undefined/);
    expect(() => val(1, "integer" as never)).toThrow(/val\(\) takes a field type/);
  });
});

describe("lit", () => {
  test("writes true, false, null and finite numbers", () => {
    expect(shown(lit(true))).toBe("TRUE");
    expect(shown(lit(false))).toBe("FALSE");
    expect(shown(lit(null))).toBe("NULL");
    expect(shown(lit(-1.5))).toBe("-1.5");
    expect(lit(true).type?.name).toBe("boolean");
    expect(lit(1).type).toBeUndefined();
  });

  test("its value is part of the shape, because it is SQL text", () => {
    expect(lit(1).shape).not.toBe(lit(2).shape);
    expect(lit(true).shape).not.toBe(lit(false).shape);
    expect(lit(null).shape).not.toBe(lit(0).shape);
  });

  test("refuses every other value", () => {
    for (const value of ["admin", Number.NaN, Number.POSITIVE_INFINITY, 1n, {}, undefined]) {
      expect(() => lit(value as never)).toThrow(/lit\(\) takes true, false, null or a finite number/);
    }
  });
});

describe("param", () => {
  test("a named placeholder with its type and no value", () => {
    const minAge = param("minAge", t.integer());
    expect(shown(minAge)).toBe(":minAge:integer");
    expect(minAge.params).toEqual([]);
    expect(minAge.type?.name).toBe("integer");
  });

  test("the name and type are part of the shape", () => {
    expect(param("a", t.integer()).shape).toBe(param("a", t.integer()).shape);
    expect(param("a", t.integer()).shape).not.toBe(param("b", t.integer()).shape);
    expect(param("a", t.integer()).shape).not.toBe(param("a", t.string()).shape);
  });

  test("refuses an empty name and a type that is not a field type", () => {
    expect(() => param("", t.integer())).toThrow(/param\(\) takes a name and a field type/);
    expect(() => param("a", undefined as never)).toThrow(/param\(\) takes a field type/);
  });
});

describe("fragment", () => {
  test("static parts are kept as written; interpolations become expressions or params", () => {
    const search = "ann";
    expect(shown(fragment`lower(${u.email})`)).toMatchInlineSnapshot(`"fragment["lower(" u.email ")"]"`);
    expect(shown(fragment`similarity(${u.name}, ${search}) > ${0.3}`)).toMatchInlineSnapshot(
      `"fragment["similarity(" u.name ", " $"ann" ") > " $0.3 ""]"`,
    );
    expect(shown(fragment`coalesce(${u.name}, ${null})`)).toMatchInlineSnapshot(
      `"fragment["coalesce(" u.name ", " $null ")"]"`,
    );
    expect(shown(fragment`now()`)).toBe('fragment["now()"]');
  });

  test("an interpolated query is a subquery", () => {
    expect(shown(fragment`ARRAY(${asSubquery(postsByViews(3))})`)).toMatchInlineSnapshot(
      `"fragment["ARRAY(" (subquery from posts sp) ")"]"`,
    );
  });

  test("values are not part of the shape; the template is", () => {
    const at = (value: number) => fragment`x > ${value}`;
    expect(at(1).shape).toBe(at(2).shape);
    expect(fragment`x > ${1}`.shape).not.toBe(fragment`x >= ${1}`.shape);
  });

  test("calling it as a function is refused, so a string can never become SQL text", () => {
    const message = /fragment is a tagged template/;
    expect(() => (fragment as unknown as (text: string) => unknown)("lower(email)")).toThrow(message);
    expect(() => (fragment as unknown as (text: string[]) => unknown)(["lower(email)"])).toThrow(message);
    // An array dressed up as a template is not frozen.
    const fake = Object.assign(["drop table users"], { raw: ["drop table users"] });
    expect(() => fragment(fake as unknown as TemplateStringsArray)).toThrow(message);
    // A frozen array with the wrong number of parts, or a part that is not a string.
    const frozen = Object.freeze(Object.assign(["a", "b"], { raw: Object.freeze(["a", "b"]) }));
    expect(() => fragment(frozen as unknown as TemplateStringsArray)).toThrow(message);
    const noRaw = Object.freeze(["a"]);
    expect(() => fragment(noRaw as unknown as TemplateStringsArray)).toThrow(message);
    const notText = Object.freeze(Object.assign([1], { raw: Object.freeze(["1"]) }));
    expect(() => fragment(notText as unknown as TemplateStringsArray)).toThrow(message);
  });

  test("an undefined interpolation is refused", () => {
    expect(() => fragment`x = ${undefined as never}`).toThrow(
      "query.undefinedOperandNullable: fragment() was given undefined, which is not a value.",
    );
  });

  test("ident accepts identifiers and refuses everything else", () => {
    expect(shown(fragment`${fragment.ident("search_vector")} @@ ${"q"}`)).toMatchInlineSnapshot(
      `"fragment["" #search_vector " @@ " $"q" ""]"`,
    );
    expect(fragment.ident("a").shape).not.toBe(fragment.ident("b").shape);
    for (const name of ["", "1abc", "a b", 'a"b', "a;drop", "a-b", "über", "a.b"]) {
      expect(() => fragment.ident(name)).toThrow(/fragment.ident\(\) takes an identifier/);
    }
    expect(() => fragment.ident(1 as never)).toThrow(QueryError);
    expect(shown(fragment.ident("_x$1"))).toBe("#_x$1");
  });
});

describe("round 1 review", () => {
  test("a window name must be an identifier", () => {
    expect(shown(count().over("by_author$1"))).toBe("count(*) OVER by_author$1");
    for (const name of ['w" ; drop table x; --', "1w", "a b", ""]) {
      expect(() => count().over(name)).toThrow(
        /over\(\) takes the name of a window declared on the query, an identifier/,
      );
    }
  });

  test("fragment refuses an order item and plain objects, and binds the value kinds it lists", () => {
    expect(() => fragment`${u.name.asc() as never}`).toThrow(/fragment\(\) was given an order item/);
    expect(() => fragment`${{ theme: "dark" } as never}`).toThrow(
      /For a JSON value pass val\(value, t.json\(\)\)/,
    );
    expect(() => fragment`${new Map() as never}`).toThrow(QueryError);
    const when = new Date("2026-01-01T00:00:00Z");
    const bytes = new Uint8Array([1]);
    expect(fragment`${[1, 2]} ${when} ${bytes} ${1n} ${true} ${null}`.params).toEqual([
      [1, 2],
      when,
      bytes,
      1n,
      true,
      null,
    ]);
    const json = fragment`x = ${val({ theme: "dark" }, t.json())}`;
    expect(json.params).toEqual([{ theme: "dark" }]);
    expect(json.node.kind === "fragment" && json.node.args[0]).toMatchObject({
      kind: "param",
      type: { name: "json" },
    });
  });

  test("caseWhen is redacted when a branch is, and binds later plain values redacted", () => {
    const secret = caseWhen(p.published, u.passwordHash);
    expect(secret.redact).toBe(true);
    expect(shown(secret.when(u.age.lt(1), "x").else("y"))).toBe(
      '(case (when p.published u.password_hash) (when (lt u.age $1:integer) $"x":string!) (else $"y":string!))',
    );
    expect(secret.else("y").redact).toBe(true);
    expect(caseWhen(p.published, "a").else(u.passwordHash).redact).toBe(true);
    expect(caseWhen(p.published, "a").else("b").redact).toBe(false);
  });

  test("one named parameter name with two types is refused in every function", () => {
    const message = /The named parameter "n" is used with two types/;
    const n = u.age.gte(param("n", t.integer()));
    const s = u.email.eq(param("n", t.string()));
    expect(() => and(n, s)).toThrow(message);
    expect(() => or(n, s)).toThrow(message);
    expect(() =>
      sum(p.views)
        .filter(n)
        .filter(s as never),
    ).toThrow(message);
    expect(() =>
      count()
        .filter(n)
        .over({ partitionBy: [param("n", t.string())] } as never),
    ).toThrow(message);
    expect(() => caseWhen(n, param("n", t.string()) as never)).toThrow(message);
    expect(() => caseWhen(n, 1).else(param("n", t.string()) as never)).toThrow(message);
    expect(() => fragment`${n} ${s}`).toThrow(message);
    expect(() => stringAgg(p.title.concat(param("n", t.integer()) as never), s as never)).toThrow(message);
    expect(and(n, u.age.lt(param("n", t.integer()))).named).toHaveLength(2);
  });

  test("expressions built by the functions list their named parameters", () => {
    const e = avg(u.age.add(param("shift", t.integer()))).filter(u.age.gt(param("min", t.integer())));
    expect(e.named.map((node) => node.name)).toEqual(["shift", "min"]);
    expect(shown(e)).toMatchInlineSnapshot(
      `"(cast avg((add u.age :shift:integer)) FILTER (gt u.age :min:integer) :float)"`,
    );
    expect(exists(asSubquery(postsByViews(1))).named).toEqual([]);
    expect(param("x", t.integer()).named.map((node) => node.name)).toEqual(["x"]);
  });
});

describe("round 2 review", () => {
  test("fragment refuses symbols, functions, and arrays that hold expressions or objects", () => {
    const message =
      /fragment\(\) binds strings, numbers, bigints, booleans, dates, bytes, null, and arrays of those/;
    expect(() => fragment`f(${Symbol("x") as never})`).toThrow(message);
    expect(() => fragment`f(${(() => 1) as never})`).toThrow(message);
    expect(() => fragment`f(${[u.id, u.email] as never})`).toThrow(/An array of expressions is not bound/);
    expect(() => fragment`f(${[[1], [u.id]] as never})`).toThrow(message);
    expect(() => fragment`f(${[{ a: 1 }] as never})`).toThrow(message);
    expect(() => fragment`f(${[u.name.asc()] as never})`).toThrow(message);
    const when = new Date("2026-01-01T00:00:00Z");
    expect(fragment`f(${[[1, 2], [3, null]]}, ${[when, "a", 1n, true]})`.params).toEqual([
      [
        [1, 2],
        [3, null],
      ],
      [when, "a", 1n, true],
    ]);
  });
});
