// Unit tests for the expression methods: the node each operator builds, how operands
// become parameters, null handling, immutability, and that every expression's `params`,
// `lists` and `shape` agree with walking its node.
import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { QueryError } from "../errors.js";
import { meta, Schema, t } from "../schema/index.js";
import { collectParams, type NamedParamNode, namedParamNode, shapeOf } from "./ast.js";
import {
  type AnyExpr,
  Col,
  Expr,
  isExpr,
  joinNamed,
  NONE,
  type OrderExpr,
  redacted,
  type SomeParams,
} from "./expr.js";
import { asSubquery, columns, postsByViews, show } from "./expr-fixtures.js";
import { caseWhen, coalesce, fragment, lit, now, param, sum, val } from "./functions.js";

const u = columns(User, "u");
const p = columns(Post, "p");

class Ledger extends Schema("ledgers", {
  id: t.integer().primaryKey(),
  meta: t.json(),
  scores: t.array(t.integer()),
  secret: t.string().redact(),
  secretTags: t.array(t.string()).redact(),
}) {}
const l = columns(Ledger, "l");

/** The expression's cached `params`, `lists` and `shape` are what a walk of its node gives. */
function expectConsistent(expr: AnyExpr | OrderExpr<SomeParams>): void {
  const params: unknown[] = [];
  const lists: number[] = [];
  const named: NamedParamNode[] = [];
  collectParams(expr.node, params, lists, named);
  expect(expr.params).toEqual(params);
  expect(expr.lists).toEqual(lists);
  expect(expr.named).toEqual(named);
  expect(expr.shape).toBe(shapeOf(expr.node));
}

function shown(expr: AnyExpr | OrderExpr<SomeParams>): string {
  expectConsistent(expr);
  return show(expr.node);
}

describe("columns", () => {
  test("a column holds its binding, field, type and redaction", () => {
    const field = meta(User).fieldsByName.get("passwordHash");
    const col = new Col("u", field!);
    expect(col.node).toEqual({
      kind: "column",
      binding: "u",
      field: "passwordHash",
      column: "password_hash",
    });
    expect(col.binding).toBe("u");
    expect(col.fieldMeta).toBe(field);
    expect(col.type).toBe(field!.type);
    expect(col.redact).toBe(true);
    expect(col.params).toEqual([]);
    expect(col.lists).toEqual([]);
    expectConsistent(col);
  });

  test("the same field under two aliases has two shapes", () => {
    expect(columns(User, "a").id.shape).not.toBe(columns(User, "b").id.shape);
    expect(columns(User, "a").id.shape).toBe(columns(User, "a").id.shape);
  });

  test("isExpr tells expressions from values", () => {
    expect(isExpr(u.age)).toBe(true);
    expect(isExpr(u.age.gte(1))).toBe(true);
    expect(isExpr(18)).toBe(false);
    expect(isExpr(u.age.asc())).toBe(false);
  });
});

describe("comparison operators", () => {
  test("each builds a binary node with the value as a parameter of the column's type", () => {
    expect(shown(u.age.eq(30))).toMatchInlineSnapshot(`"(eq u.age $30:integer)"`);
    expect(shown(u.age.neq(30))).toMatchInlineSnapshot(`"(neq u.age $30:integer)"`);
    expect(shown(u.age.gt(30))).toMatchInlineSnapshot(`"(gt u.age $30:integer)"`);
    expect(shown(u.age.gte(18))).toMatchInlineSnapshot(`"(gte u.age $18:integer)"`);
    expect(shown(u.age.lt(65))).toMatchInlineSnapshot(`"(lt u.age $65:integer)"`);
    expect(shown(u.age.lte(65))).toMatchInlineSnapshot(`"(lte u.age $65:integer)"`);
    expect(shown(u.name.isDistinctFrom("Ann"))).toMatchInlineSnapshot(
      `"(isDistinctFrom u.name $"Ann":string)"`,
    );
  });

  test("the result is loaded as a boolean and is never redacted", () => {
    const e = u.passwordHash.eq("x");
    expect(e.type?.name).toBe("boolean");
    expect(e.redact).toBe(false);
  });

  test("a value takes the type of the other side", () => {
    expect(shown(u.role.eq("admin"))).toMatchInlineSnapshot(`"(eq u.role $"admin":enum)"`);
    const now = new Date("2026-10-14T12:00:00.000Z");
    expect(shown(u.createdAt.gt(now))).toMatchInlineSnapshot(
      `"(gt u.created_at $Date(2026-10-14T12:00:00.000Z):timestamp)"`,
    );
    const node = u.createdAt.gt(now).node;
    expect(node.kind === "binary" && node.right.kind === "param" && node.right.type).toBe(
      meta(User).fieldsByName.get("createdAt")!.type,
    );
  });

  test("a value compared with a redacted field is redacted, and so is a named parameter", () => {
    expect(shown(u.passwordHash.eq("hash"))).toMatchInlineSnapshot(`"(eq u.password_hash $"hash":string!)"`);
    expect(shown(u.passwordHash.eq(param("hash", t.string())))).toMatchInlineSnapshot(
      `"(eq u.password_hash :hash:string!)"`,
    );
    expect(shown(u.passwordHash.in(["a", "b"]))).toMatchInlineSnapshot(
      `"(in u.password_hash $["a","b"]:string!)"`,
    );
    expect(shown(u.passwordHash.between("a", "b"))).toMatchInlineSnapshot(
      `"(between u.password_hash $"a":string! $"b":string!)"`,
    );
    const named = u.passwordHash.eq(param("hash", t.string()));
    const right = named.node.kind === "binary" ? named.node.right : undefined;
    expect(right).toMatchObject({ kind: "namedParam", redact: true });
    // A named parameter that is redacted already is used as it is.
    const marked = namedParamNode("hash", undefined, true);
    const redacted = new Expr(marked, undefined, false, NONE, NONE, [marked], 0);
    const again = u.passwordHash.eq(redacted as never);
    expect(again.node.kind === "binary" && again.node.right).toBe(redacted.node);
  });

  test("an expression on the right is used as it is", () => {
    expect(shown(u.name.eq(u.email))).toMatchInlineSnapshot(`"(eq u.name u.email)"`);
    expect(shown(u.age.gte(param("minAge", t.integer())))).toMatchInlineSnapshot(
      `"(gte u.age :minAge:integer)"`,
    );
    const explicit = val(18, t.integer());
    const e = u.age.gte(explicit);
    expect(e.node.kind === "binary" && e.node.right).toBe(explicit.node);
  });

  test("between builds one node with both ends as parameters", () => {
    expect(shown(u.age.between(18, 65))).toMatchInlineSnapshot(`"(between u.age $18:integer $65:integer)"`);
    expect(shown(u.age.between(p.views, val(99)))).toMatchInlineSnapshot(`"(between u.age p.views $99)"`);
  });

  test("isNull and isNotNull are unary", () => {
    expect(shown(u.name.isNull())).toMatchInlineSnapshot(`"(isNull u.name)"`);
    expect(shown(u.name.isNotNull())).toMatchInlineSnapshot(`"(isNotNull u.name)"`);
  });
});

describe("null is refused in comparisons", () => {
  const message = /comparison with null is always unknown in SQL.*isNull\(\)/;
  test.each([
    ["eq", () => u.name.eq(null as never)],
    ["neq", () => u.name.neq(null as never)],
    ["gt", () => u.age.gt(null as never)],
    ["gte", () => u.age.gte(null as never)],
    ["lt", () => u.age.lt(null as never)],
    ["lte", () => u.age.lte(null as never)],
    ["between (low)", () => u.age.between(null as never, 1)],
    ["between (high)", () => u.age.between(1, null as never)],
    ["has", () => p.tagList.has(null as never)],
  ])("%s throws QueryError", (_name, build) => {
    expect(build).toThrow(QueryError);
    expect(build).toThrow(message);
  });

  test("an operand that is always null is refused too: lit(null), val(null), or either cast", () => {
    const nulls = [
      () => lit(null),
      () => val(null),
      () => val(null).cast(t.integer()),
      () => lit(null).cast(t.string()),
    ];
    for (const make of nulls) {
      expect(() => u.age.eq(make() as never)).toThrow(message);
      expect(() => u.age.gt(make() as never)).toThrow(message);
      expect(() => u.age.between(make() as never, 5)).toThrow(message);
      expect(() => u.age.between(1, make() as never)).toThrow(message);
      expect(() => u.id.in(make() as never)).toThrow(message);
      expect(() => u.id.notIn(make() as never)).toThrow(message);
      expect(() => u.email.like(make() as never)).toThrow(message);
      expect(() => u.email.notLike(make() as never)).toThrow(message);
      expect(() => u.email.ilike(make() as never)).toThrow(message);
      expect(() => p.tagList.has(make() as never)).toThrow(message);
      expect(() => p.views.add(make() as never)).toThrow(
        "query.nullNotAllowed: add() was given null, which it cannot take.",
      );
      expect(() => p.tagList.contains(make() as never)).toThrow(
        "query.nullNotAllowed: contains() was given null, which it cannot take.",
      );
      expect(() => u.email.concat(make() as never)).toThrow(/^[a-z]+(?:\.\w+)?: concat\(\) was given null/);
    }
  });

  test("the message points at isNull and isDistinctFrom", () => {
    expect(() => u.age.eq(lit(null) as never)).toThrow(
      /use isNull\(\) or isNotNull\(\), or isDistinctFrom\(\)/,
    );
  });

  test("where null means something, an expression that is null is accepted", () => {
    expect(shown(u.name.isDistinctFrom(lit(null)))).toBe("(isDistinctFrom u.name NULL)");
    expect(shown(p.tagList.remove(val(null)))).toBe("arrayRemove(p.tags, $null)");
  });

  test("undefined is named as undefined, not as null", () => {
    expect(() => u.name.eq(undefined as never)).toThrow(
      "query.undefinedOperand: eq() was given undefined, which is not a value.",
    );
    expect(() => u.age.between(1, undefined as never)).toThrow(
      "query.undefinedOperand: between() was given undefined, which is not a value.",
    );
    expect(() => p.views.add(undefined as never)).toThrow(/^[a-z]+(?:\.\w+)?: add\(\) was given undefined/);
    expect(() => u.name.isDistinctFrom(undefined as never)).toThrow(
      "query.undefinedOperandNullable: isDistinctFrom() was given undefined, which is not a value. Pass null for SQL NULL",
    );
  });

  test("the message names the method", () => {
    expect(() => u.name.eq(null as never)).toThrow("query.compareNull: eq() was given null.");
  });

  test("isDistinctFrom takes null, bound as a parameter", () => {
    expect(shown(u.name.isDistinctFrom(null))).toMatchInlineSnapshot(
      `"(isDistinctFrom u.name $null:string)"`,
    );
    expect(() => u.name.isDistinctFrom(undefined as never)).toThrow(QueryError);
  });

  test("the other operators refuse null and undefined with their own message", () => {
    expect(() => p.views.add(null as never)).toThrow(
      "query.nullNotAllowed: add() was given null, which it cannot take.",
    );
    expect(() => u.email.like(null as never)).toThrow("query.compareNull: like() was given null.");
    expect(() => u.email.like(undefined as never)).toThrow(/^[a-z]+(?:\.\w+)?: like\(\) was given undefined/);
    expect(() => u.email.concat("a", null as never)).toThrow(
      /^[a-z]+(?:\.\w+)?: concat\(\) was given null, which it cannot take/,
    );
    expect(() => p.tagList.contains(null as never)).toThrow(QueryError);
    expect(() => p.tagList.append(undefined as never)).toThrow(QueryError);
  });
});

describe("in and notIn", () => {
  test("an array is one list parameter typed with the column's type", () => {
    expect(shown(u.role.in(["admin", "member"]))).toMatchInlineSnapshot(
      `"(in u.role $["admin","member"]:enum)"`,
    );
    expect(shown(u.id.notIn([1, 2, 3]))).toMatchInlineSnapshot(`"(notIn u.id $[1,2,3]:bigint(number))"`);
    expect(u.id.in([1, 2, 3]).lists).toEqual([3]);
  });

  test("an empty list is false for in and true for notIn, with no parameter", () => {
    expect(shown(u.id.in([]))).toBe("FALSE");
    expect(shown(u.id.notIn([]))).toBe("TRUE");
    expect(u.age.add(val(1)).in([]).params).toEqual([]);
  });

  test("an empty list keeps the left side when it uses a named parameter, so the query still needs it", () => {
    const left = coalesce(u.age, param("fallback", t.integer()));
    expect(shown(left.in([]))).toMatchInlineSnapshot(
      `"(and FALSE (isNull coalesce(u.age, :fallback:integer)))"`,
    );
    expect(shown(left.notIn([]))).toMatchInlineSnapshot(
      `"(or TRUE (isNull coalesce(u.age, :fallback:integer)))"`,
    );
    expect(left.in([]).named.map((node) => node.name)).toEqual(["fallback"]);
  });

  test("the list is copied: changing the array afterwards does not change the query", () => {
    const ids = [1, 2];
    const e = u.id.in(ids);
    ids.push(3);
    expect(e.params).toEqual([[1, 2]]);
    expect(e.lists).toEqual([2]);
    // The node holds the same copy, so that walking it still agrees with params.
    expect(e.node.kind === "binary" && e.node.right.kind === "list" && e.node.right.value).toEqual([1, 2]);
    expectConsistent(e);
  });

  test("a list holding null or undefined is refused, each named as what it is", () => {
    expect(() => u.name.in(["a", null] as never)).toThrow(
      "query.listNull: in() was given a list holding null.",
    );
    expect(() => u.name.notIn([null] as never)).toThrow(
      "query.listNull: notIn() was given a list holding null.",
    );
    expect(() => u.age.in([1, undefined] as never)).toThrow(
      "query.listUndefined: in() was given a list holding undefined, which is not a value.",
    );
    expect(() => u.name.notIn([undefined] as never)).toThrow(
      "query.listUndefined: notIn() was given a list holding undefined, which is not a value.",
    );
  });

  test("an expression of array type is used as it is", () => {
    expect(shown(u.email.in(p.tagList))).toMatchInlineSnapshot(`"(in u.email p.tags)"`);
  });

  test("a query is a subquery operand, its params included", () => {
    const sub = postsByViews(100);
    const e = u.id.in(asSubquery<number>(sub));
    expect(shown(e)).toMatchInlineSnapshot(`"(in u.id (subquery from posts sp))"`);
    expect(e.params).toEqual([100]);
    expect(u.age.gte(5).and(u.id.notIn(asSubquery<number>(sub))).params).toEqual([5, 100]);
  });

  test("anything else is refused", () => {
    expect(() => u.id.in(1 as never)).toThrow(
      /in\(\) takes an array of values, an expression of array type, or a query/,
    );
    expect(() => u.id.in({} as never)).toThrow(QueryError);
    const broken = { [Symbol.for("egon.asSubquery")]: () => u.id };
    expect(() => u.id.in(broken as never)).toThrow(/did not produce a subquery/);
  });
});

describe("boolean operators", () => {
  test("and, or and not", () => {
    expect(shown(u.age.gte(18).and(u.role.eq("admin")))).toMatchInlineSnapshot(
      `"(and (gte u.age $18:integer) (eq u.role $"admin":enum))"`,
    );
    expect(shown(u.age.gte(18).or(p.published))).toMatchInlineSnapshot(
      `"(or (gte u.age $18:integer) p.published)"`,
    );
    expect(shown(p.published.not())).toMatchInlineSnapshot(`"(not p.published)"`);
  });

  test("chained calls of one operator make one flat node; mixed ones nest", () => {
    expect(shown(u.age.gte(18).and(p.published).and(u.name.isNull()))).toMatchInlineSnapshot(
      `"(and (gte u.age $18:integer) p.published (isNull u.name))"`,
    );
    expect(shown(u.age.gte(18).or(p.published).and(u.name.isNull()))).toMatchInlineSnapshot(
      `"(and (or (gte u.age $18:integer) p.published) (isNull u.name))"`,
    );
  });

  test("a boolean value is a boolean parameter", () => {
    expect(shown(p.published.and(true))).toMatchInlineSnapshot(`"(and p.published $true:boolean)"`);
  });

  test("anything else is refused", () => {
    expect(() => p.published.and("yes" as never)).toThrow(/and\(\) takes a boolean expression/);
    expect(() => p.published.or(null as never)).toThrow(/or\(\) takes a boolean expression/);
  });
});

describe("text operators", () => {
  test("the pattern is a text parameter, whatever the column's own type", () => {
    expect(shown(u.email.like("%@example.com"))).toMatchInlineSnapshot(
      `"(like u.email $"%@example.com":string)"`,
    );
    expect(shown(u.email.notLike("%@example.com"))).toMatchInlineSnapshot(
      `"(notLike u.email $"%@example.com":string)"`,
    );
    expect(shown(u.name.ilike("%ann%"))).toMatchInlineSnapshot(`"(ilike u.name $"%ann%":string)"`);
    expect(shown(u.role.like("adm%"))).toMatchInlineSnapshot(`"(like u.role $"adm%":string)"`);
  });

  test("concat chains each part; lower and upper are functions", () => {
    expect(shown(u.email.concat(" <", u.name, ">"))).toMatchInlineSnapshot(
      `"(concat (concat (concat u.email $" <":string) u.name) $">":string)"`,
    );
    expect(shown(u.email.lower())).toMatchInlineSnapshot(`"lower(u.email)"`);
    expect(shown(u.email.upper())).toMatchInlineSnapshot(`"upper(u.email)"`);
    expect(u.email.lower().type?.name).toBe("string");
    expect(() => u.email.concat()).toThrow(/concat\(\) needs at least one part/);
  });

  test("a redacted column's pattern is redacted", () => {
    expect(shown(l.secret.like("a%"))).toMatchInlineSnapshot(`"(like l.secret $"a%":string!)"`);
    expect(l.secret.lower().redact).toBe(true);
  });
});

describe("arithmetic operators", () => {
  test("each keeps the column's type, for the operand and the result", () => {
    expect(shown(u.lockVersion.add(1))).toMatchInlineSnapshot(`"(add u.lock_version $1:integer)"`);
    expect(shown(p.views.sub(1))).toMatchInlineSnapshot(`"(sub p.views $1:integer)"`);
    expect(shown(p.views.mul(2))).toMatchInlineSnapshot(`"(mul p.views $2:integer)"`);
    expect(shown(p.views.div(2))).toMatchInlineSnapshot(`"(div p.views $2:integer)"`);
    expect(shown(u.id.mod(2))).toMatchInlineSnapshot(`"(mod u.id $2:bigint(number))"`);
    expect(shown(p.views.neg())).toMatchInlineSnapshot(`"(neg p.views)"`);
    expect(p.views.add(1).type).toBe(p.views.type);
    expect(shown(p.views.add(u.age).mul(2))).toMatchInlineSnapshot(`"(mul (add p.views u.age) $2:integer)"`);
  });
});

describe("array operators", () => {
  test("contains, containedBy and overlaps take an array parameter of the column's type", () => {
    expect(shown(p.tagList.contains(["ts"]))).toMatchInlineSnapshot(
      `"(contains p.tags $["ts"]:array(string))"`,
    );
    expect(shown(p.tagList.containedBy(["ts", "sql"]))).toMatchInlineSnapshot(
      `"(containedBy p.tags $["ts","sql"]:array(string))"`,
    );
    expect(shown(p.tagList.overlaps(["ts"]))).toMatchInlineSnapshot(
      `"(overlaps p.tags $["ts"]:array(string))"`,
    );
    expect(p.tagList.contains(["ts"]).lists).toEqual([]);
  });

  test("has, append and remove take an element of the element type", () => {
    expect(shown(p.tagList.has("ts"))).toMatchInlineSnapshot(`"(has p.tags $"ts":string)"`);
    expect(shown(l.scores.has(3))).toMatchInlineSnapshot(`"(has l.scores $3:integer)"`);
    expect(shown(p.tagList.append("ts"))).toMatchInlineSnapshot(`"arrayAppend(p.tags, $"ts":string)"`);
    expect(shown(p.tagList.remove("draft"))).toMatchInlineSnapshot(`"arrayRemove(p.tags, $"draft":string)"`);
    expect(p.tagList.append("ts").type).toBe(p.tagList.type);
  });

  test("append and remove take null (a null element)", () => {
    expect(shown(p.tagList.remove(null))).toMatchInlineSnapshot(`"arrayRemove(p.tags, $null:string)"`);
  });

  test("an element of a redacted array is redacted", () => {
    expect(shown(l.secretTags.has("x"))).toMatchInlineSnapshot(`"(has l.secret_tags $"x":string!)"`);
  });

  test("an element of an expression with no known type has none", () => {
    const untyped = val(["a"]).as<string[]>();
    expect(shown(untyped.has("a"))).toMatchInlineSnapshot(`"(has $["a"] $"a")"`);
  });
});

describe("JSON operators", () => {
  test("path and pathText bind every key", () => {
    expect(shown(u.settings.path("theme"))).toMatchInlineSnapshot(`"(#> u.settings $"theme")"`);
    expect(shown(l.meta.pathText("limits", 0))).toMatchInlineSnapshot(`"(#>> l.meta $"limits" $0)"`);
    expect(u.settings.path("theme").type?.name).toBe("json");
    expect(u.settings.pathText("theme").type?.name).toBe("string");
  });

  test("key values are params: two paths with different keys share a shape", () => {
    expect(l.meta.path("a", "b").shape).toBe(l.meta.path("c", 1).shape);
    expect(l.meta.path("a").shape).not.toBe(l.meta.path("a", "b").shape);
    expect(l.meta.path("a").shape).not.toBe(l.meta.pathText("a").shape);
  });

  test("a path is refused on a known non-JSON type, without keys, or with a bad key", () => {
    const email = u.email as unknown as Col<unknown>;
    expect(() => email.path("a")).toThrow(
      /path\(\) reads inside a JSON value, and this expression has the type string/,
    );
    expect(() => (u.settings.path as (...keys: unknown[]) => unknown).call(u.settings)).toThrow(
      /path\(\) needs at least one key/,
    );
    expect(() => u.settings.path(1.5)).toThrow(/keys that are strings, or whole numbers/);
    expect(() => u.settings.pathText(true as never)).toThrow(/pathText\(\) takes keys/);
  });

  test("an expression with no known type may hold JSON", () => {
    expect(shown(val({}).path("a"))).toMatchInlineSnapshot(`"(#> \${} $"a")"`);
  });
});

describe("typing", () => {
  test("cast takes a field type, which the result is loaded with", () => {
    const e = u.age.cast(t.string());
    expect(shown(e)).toMatchInlineSnapshot(`"(cast u.age :string)"`);
    expect(e.type?.name).toBe("string");
    expect(l.secret.cast(t.string()).redact).toBe(true);
  });

  test("cast refuses anything but a field type", () => {
    expect(() => u.age.cast("text" as never)).toThrow("query.castType: cast() takes a field type.");
  });

  test("as changes nothing at run time", () => {
    const e = u.age.add(1);
    expect(e.as<string>()).toBe(e);
  });

  test("a cast type with another name is another shape", () => {
    expect(u.age.cast(t.string()).shape).not.toBe(u.age.cast(t.integer()).shape);
  });
});

describe("ordering", () => {
  test("asc and desc, then nullsFirst or nullsLast", () => {
    expect(shown(u.createdAt.desc())).toMatchInlineSnapshot(`"(desc u.created_at)"`);
    expect(shown(u.createdAt.desc().nullsLast())).toMatchInlineSnapshot(`"(desc u.created_at nulls last)"`);
    expect(shown(u.name.asc().nullsFirst())).toMatchInlineSnapshot(`"(asc u.name nulls first)"`);
    expect(shown(u.age.add(param("shift", t.integer())).asc().nullsLast())).toMatchInlineSnapshot(
      `"(asc (add u.age :shift:integer) nulls last)"`,
    );
  });

  test("order items of different directions or nulls have different shapes", () => {
    const shapes = new Set([
      u.name.asc().shape,
      u.name.desc().shape,
      u.name.asc().nullsFirst().shape,
      u.name.asc().nullsLast().shape,
      u.name.desc().nullsLast().shape,
    ]);
    expect(shapes.size).toBe(5);
  });
});

describe("immutability", () => {
  test("operators never change their operands", () => {
    const left = u.age.gte(18);
    const snapshot = JSON.stringify({
      node: left.node,
      params: left.params,
      lists: left.lists,
      shape: left.shape,
    });
    left.and(p.published);
    left.and(p.published).and(u.name.isNull());
    left.or(p.published);
    left.not();
    left.eq(true);
    expect(
      JSON.stringify({ node: left.node, params: left.params, lists: left.lists, shape: left.shape }),
    ).toBe(snapshot);
  });

  test("flattening an and does not change the earlier and", () => {
    const both = u.age.gte(18).and(p.published);
    const before = both.node.kind === "nary" ? both.node.args.length : -1;
    const three = both.and(u.name.isNull());
    expect(both.node.kind === "nary" && both.node.args.length).toBe(before);
    expect(three.node.kind === "nary" && three.node.args.length).toBe(3);
    expect(both.params).toEqual([18]);
  });

  test("params arrays are never shared in a way that lets one expression change another", () => {
    const a = u.age.gte(1);
    const b = a.and(u.age.lte(2));
    const c = a.and(u.age.lte(3));
    expect(a.params).toEqual([1]);
    expect(b.params).toEqual([1, 2]);
    expect(c.params).toEqual([1, 3]);
  });

  test("an order item is not changed by nullsLast", () => {
    const desc = u.createdAt.desc();
    desc.nullsLast();
    expect(desc.node.nulls).toBeUndefined();
  });

  test("every expression of one kind has its own keys in one order", () => {
    const keys = (value: object) => Object.keys(value).join(",");
    expect(keys(u.age.gte(1))).toBe(keys(u.email.lower()));
    expect(keys(u.age.gte(1))).toBe("node,type,redact,params,lists,named,shape");
    expect(keys(u.age)).toBe("node,type,redact,params,lists,named,shape,binding,fieldMeta");
    expect(keys(u.age.asc())).toBe("node,params,lists,named,shape,exprShape");
    expect(u.age.gte(1)).toBeInstanceOf(Expr);
  });
});

describe("redaction of explicit parameters", () => {
  test("val() beside a redacted field is redacted, in either order", () => {
    expect(shown(u.passwordHash.eq(val("secret")))).toBe('(eq u.password_hash $"secret"!)');
    expect(shown(val("secret", t.string()).eq(u.passwordHash))).toBe(
      '(eq $"secret":string! u.password_hash)',
    );
    expect(shown(val<string>("a").between(u.passwordHash, "z"))).toBe('(between $"a"! u.password_hash $"z")');
    expect(shown(u.passwordHash.in(val(["a", "b"]) as never))).toBe('(in u.password_hash $["a","b"]!)');
    expect(shown(val("x").in(l.secretTags as never))).toBe('(in $"x"! l.secret_tags)');
    expect(shown(u.passwordHash.like(val("a%")))).toBe('(like u.password_hash $"a%"!)');
  });

  test("redacted() marks a bare parameter once", () => {
    const once = redacted(val("s"));
    expect(once.node).toMatchObject({ kind: "param", redact: true });
    expect(redacted(once)).toBe(once);
    expect(redacted(u.age)).toBe(u.age);
  });

  test("joinNamed names an untyped parameter in its message", () => {
    const untyped = namedParamNode("n", undefined, false);
    const integer = namedParamNode("n", u.age.type, false);
    expect(() => joinNamed([untyped], [integer])).toThrow(/two types, untyped and integer/);
    expect(() => joinNamed([integer], [untyped])).toThrow(/two types, integer and untyped/);
  });

  test("a redacted parameter is kept as it is, and other expressions are not changed", () => {
    const secret = u.passwordHash.eq("x");
    const right = secret.node.kind === "binary" ? secret.node.right : undefined;
    expect(right).toMatchObject({ kind: "param", redact: true });
    expect(shown(u.passwordHash.eq(u.name))).toBe("(eq u.password_hash u.name)");
    expect(shown(u.name.eq(u.passwordHash))).toBe("(eq u.name u.password_hash)");
  });
});

describe("named parameters", () => {
  test("an expression lists the named parameters of its node", () => {
    const e = u.age.gte(param("minAge", t.integer())).and(u.name.eq(param("name", t.string())));
    expect(e.named.map((node) => node.name)).toEqual(["minAge", "name"]);
    expectConsistent(e);
    expect(u.age.gte(1).named).toEqual([]);
  });

  test("one name may be used twice with one type", () => {
    const n = () => param("n", t.integer());
    const e = u.age.gte(n()).and(p.views.lt(n()));
    expect(e.named.map((node) => node.name)).toEqual(["n", "n"]);
  });

  test("one name with two types is refused when the expressions meet", () => {
    const message = /The named parameter "n" is used with two types, integer and string/;
    const a = u.age.gte(param("n", t.integer()));
    const b = u.email.eq(param("n", t.string()));
    expect(() => a.and(b as never)).toThrow(message);
    expect(() => u.age.add(param("n", t.integer())).eq(param("n", t.string()) as never)).toThrow(message);
    expect(() => u.age.between(param("n", t.integer()), param("n", t.string()) as never)).toThrow(message);
    expect(() => coalesce(u.age.add(param("n", t.integer())), param("n", t.string()) as never)).toThrow(
      message,
    );
  });
});

describe("redaction through value-preserving wrappers (review round 2)", () => {
  test("a parameter under cast, lower, arithmetic or concat beside a redacted field is redacted", () => {
    expect(shown(u.passwordHash.eq(val("s").cast(t.string())))).toBe(
      '(eq u.password_hash (cast $"s"! :string))',
    );
    expect(shown(u.passwordHash.lower().eq(val("s").lower()))).toBe(
      '(eq lower(u.password_hash) lower($"s"!))',
    );
    expect(shown(u.passwordHash.eq(val("a").concat("b")))).toBe(
      '(eq u.password_hash (concat $"a"! $"b":string!))',
    );
    expect(shown(l.secret.eq(val("a").upper().cast(t.string())))).toBe(
      '(eq l.secret (cast upper($"a"!) :string))',
    );
    expect(shown(u.passwordHash.eq(coalesce(val<string | null>(null), "x")))).toBe(
      '(eq u.password_hash coalesce($null!, $"x"!))',
    );
    expect(shown(u.passwordHash.eq(param("p", t.string()).lower()))).toBe(
      "(eq u.password_hash lower(:p:string!))",
    );
  });

  test("in either order", () => {
    expect(shown(val("s").cast(t.string()).eq(u.passwordHash))).toBe(
      '(eq (cast $"s"! :string) u.password_hash)',
    );
    expect(shown(val("s").lower().eq(u.passwordHash.lower()))).toBe(
      '(eq lower($"s"!) lower(u.password_hash))',
    );
  });

  test("a value-preserving wrapper keeps marking; a comparison or aggregate is not entered", () => {
    const viaNeg = redacted(val(1, t.integer()).neg());
    expect(show(viaNeg.node)).toBe("(neg $1:integer!)");
    const viaPath = redacted(val({ a: "s" }).path("a"));
    expect(viaPath.node.kind === "jsonPath" && viaPath.node.expr).toMatchObject({
      kind: "param",
      redact: true,
    });
    const comparison = val<string>("s").eq("t");
    expect(redacted(comparison)).toBe(comparison);
    const notNeg = val(true).not();
    expect(redacted(notNeg)).toBe(notNeg);
    const plainFn = u.email.lower();
    expect(redacted(plainFn)).toBe(plainFn);
    const otherFn = now();
    expect(redacted(otherFn)).toBe(otherFn);
    const otherOp = val<number>(1).add(u.age);
    expect(show(redacted(otherOp).node)).toBe("(add $1! u.age)");
    const neither = u.age.add(u.lockVersion);
    expect(redacted(neither)).toBe(neither);
    const castColumn = u.age.cast(t.string());
    expect(redacted(castColumn)).toBe(castColumn);
    const pathOfColumn = u.settings.path("a");
    expect(redacted(pathOfColumn)).toBe(pathOfColumn);
    const negColumn = u.age.neg();
    expect(redacted(negColumn)).toBe(negColumn);
    const count = redacted(sum(val(1) as never));
    expect(show(count.node)).toBe("sum($1)");
  });

  test("marked expressions stay consistent with their nodes", () => {
    const e = u.passwordHash.eq(param("p", t.string()).lower().concat(val("x")));
    expectConsistent(e);
    expect(e.named[0]?.redact).toBe(true);
  });
});

describe("redaction through CASE (review round 3)", () => {
  test("branch results and ELSE are marked, in either order", () => {
    const c = p.published.eq(true);
    expect(shown(u.passwordHash.eq(caseWhen(c, val("s", t.string())).else("t")))).toBe(
      '(eq u.password_hash (case (when (eq p.published $true:boolean) $"s":string!) (else $"t":string!)))',
    );
    expect(shown(caseWhen(c, val("s", t.string())).else("t").eq(u.passwordHash))).toBe(
      '(eq (case (when (eq p.published $true:boolean) $"s":string!) (else $"t":string!)) u.password_hash)',
    );
  });

  test("a condition's parameter stays unmarked, even a bare one", () => {
    const e = u.passwordHash.eq(caseWhen(param("flag", t.boolean()), val("s", t.string())).else("t"));
    expect(shown(e)).toBe(
      '(eq u.password_hash (case (when :flag:boolean $"s":string!) (else $"t":string!)))',
    );
    expect(e.named).toMatchObject([{ name: "flag", redact: false }]);
    const valued = caseWhen(val(true), "a").eq(u.passwordHash);
    expect(shown(valued)).toBe('(eq (case (when $true $"a"!)) u.password_hash)');
  });

  test("conditions keep their params unmarked", () => {
    const e = u.passwordHash.eq(caseWhen(u.email.eq("visible"), "a").when(p.views.gt(3), "b"));
    expect(shown(e)).toBe(
      '(eq u.password_hash (case (when (eq u.email $"visible":string) $"a"!) (when (gt p.views $3:integer) $"b"!)))',
    );
  });

  test("a CASE with nothing to mark, and a fragment, are left as they are", () => {
    const columns = caseWhen(p.published, u.email).else(u.name);
    expect(redacted(columns)).toBe(columns);
    const open = caseWhen(p.published, u.email);
    expect(redacted(open)).toBe(open);
    const raw = fragment`lower(${"s"})`;
    expect(redacted(raw)).toBe(raw);
  });
});
