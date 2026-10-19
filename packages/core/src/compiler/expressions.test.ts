import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { InsertPlanOptions, ParamSlot } from "../contracts/adapter.js";
import type { ExprNode, QueryAst } from "../contracts/query.js";
import type { FieldMeta } from "../contracts/schema.js";
import { from, t } from "../index.js";
import {
  aggregateNode,
  binaryNode,
  caseNode,
  literalNode,
  naryNode,
  orderNode,
  selectedAsNode,
  tupleNode,
  windowNode,
} from "../query/ast.js";
import { meta } from "../schema/index.js";
import { bindParams } from "./bind.js";
import { PlanCache } from "./cache.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { newContext } from "./emit.js";
import { registerNodeEmitter } from "./registry.js";
import { sameShape } from "./same-shape.js";
import { col, rebuild, selectObject, selectOne, tableSource, typeOf, value } from "./sql-fixtures.js";
import { emitInsert } from "./write.js";

function sql(ast: QueryAst): string {
  return createCompiler(postgresDialect).compile(ast, "all", undefined).sql;
}

function where(expr: ExprNode): QueryAst {
  return rebuild(from(User, "u").ast, {
    wheres: [{ kind: "bool", op: "and", expr }],
    select: selectOne(col("u", "id")),
  });
}

describe("expressions outside the select list", () => {
  test("a typed CASE compared with a bare value is cast, since nothing else types the two", () => {
    const node = caseNode([{ when: literalNode(true), result: value(1, typeOf(t.integer())) }], undefined);
    expect(sql(where(binaryNode("eq", node, value(2))))).toContain(
      "where case when true then cast($1 as integer) end = $2",
    );
  });

  test("a CASE in the select list with no ELSE", () => {
    expect(
      sql(
        rebuild(from(User, "u").ast, {
          select: selectOne(caseNode([{ when: literalNode(true), result: value("x") }], undefined)),
        }),
      ),
    ).toBe('select case when true then cast($1 as text) end as "c0" from "users" as "u"');
  });

  test("a selected name used inside a condition is its expression", () => {
    expect(sql(where(binaryNode("gt", selectedAsNode("n", col("u", "age")), value(1))))).toContain(
      'where "u"."age" > $1',
    );
  });

  test("a one-item tuple is a row constructor", () => {
    expect(sql(where(binaryNode("gt", tupleNode([col("u", "id")]), tupleNode([value(1)]))))).toContain(
      'where row("u"."id") > row($1)',
    );
  });

  test("not in an array expression", () => {
    expect(sql(where(binaryNode("notIn", value(1), col("u", "id"))))).toContain('where $1 <> all("u"."id")');
  });

  test("an empty and is true", () => {
    expect(sql(where(naryNode("and", [])))).toContain("where true");
  });

  test("two named windows are separated by a comma", () => {
    const spec = windowNode([], [], undefined);
    const ast = rebuild(from(Post, "p").ast, {
      select: selectObject({ a: aggregateNode("count", [col("p", "id")], false, undefined, "w1") }),
      windows: [
        { kind: "windowDef", name: "w1", spec },
        { kind: "windowDef", name: "w2", spec },
      ],
    });
    expect(sql(ast)).toBe(
      'select count("p"."id") over "w1" as "c0" from "posts" as "p" window "w1" as (), "w2" as ()',
    );
  });

  test("the order of a set operation names selected expressions and selected names", () => {
    const ast = rebuild(from(User, "u").ast, {
      select: selectObject({ n: selectedAsNode("n", col("u", "age")), id: col("u", "id") }),
      combinations: [
        {
          kind: "combination",
          op: "union",
          all: false,
          query: from(User, "u").select(({ u }) => ({ n: u.age, id: u.id })).ast,
        },
      ],
      orderBys: [
        orderNode(selectedAsNode("n", undefined), "desc", undefined),
        orderNode(col("u", "id"), "asc", undefined),
      ],
    });
    expect(sql(ast).endsWith(' order by "n" desc, "c1" asc')).toBe(true);
  });

  test("the order of a set operation matches a selected expression by structure, whatever its values", () => {
    const base = rebuild(from(User, "u").ast, {
      select: selectObject({ x: binaryNode("add", col("u", "age"), value(1)) }),
      combinations: [
        {
          kind: "combination",
          op: "union",
          all: false,
          query: from(User, "u").select(({ u }) => ({ x: u.age.add(1) })).ast,
        },
      ],
    });
    const sorted = (by: number) =>
      rebuild(base, {
        orderBys: [orderNode(binaryNode("add", col("u", "age"), value(by)), "asc", undefined)],
      });
    const plan = createCompiler(postgresDialect).compile(sorted(1), "all", undefined);
    expect(plan.sql.endsWith(' order by "c0" asc')).toBe(true);
    // The order expression is not written, and its value is skipped.
    expect(bindParams(plan.slots, sorted(1).params)).toEqual([1, 1]);
    // Another value: the same shape, so the same plan, warm or cold.
    expect(sql(sorted(2))).toBe(plan.sql);
  });

  test("an order that matches two selected expressions of one shape is refused, warm or cold", () => {
    // select { a: age + 1, b: age + 2 } union all itself, order by age + n
    const branch = rebuild(from(User, "u").ast, {
      select: selectObject({
        a: binaryNode("add", col("u", "age"), value(1)),
        b: binaryNode("add", col("u", "age"), value(2)),
      }),
    });
    const sorted = (by: number) =>
      rebuild(branch, {
        combinations: [{ kind: "combination", op: "union", all: true, query: branch }],
        orderBys: [orderNode(binaryNode("add", col("u", "age"), value(by)), "desc", undefined)],
      });
    const message = /names an expression the query selects more than once/;
    const warm = createCompiler(postgresDialect);
    for (const by of [1, 2, 3]) {
      expect(() => warm.compile(sorted(by), "all", undefined)).toThrow(message);
      expect(() => sql(sorted(by))).toThrow(message);
    }
    // Named with selectedAs, it is unambiguous.
    const named = rebuild(branch, {
      select: selectObject({
        a: binaryNode("add", col("u", "age"), value(1)),
        b: selectedAsNode("b", binaryNode("add", col("u", "age"), value(2))),
      }),
    });
    const ok = rebuild(named, {
      combinations: [{ kind: "combination", op: "union", all: true, query: branch }],
      orderBys: [orderNode(selectedAsNode("b", undefined), "desc", undefined)],
    });
    expect(sql(ok).endsWith(' order by "b" desc')).toBe(true);
  });

  test("an identifier that is not a string is refused", () => {
    expect(() =>
      sql(rebuild(from(User, "u").ast, { from: tableSource(5 as never, "u", meta(User)) })),
    ).toThrow("An identifier is not a string.");
  });

  test("a registered emitter is consulted only for a string kind", () => {
    expect(() => sql(where({ kind: 5 } as never))).toThrow('Unknown expression node kind "5".');
  });
});

describe("comparisons the cache relies on", () => {
  test("a registered kind compares with its own function; an unknown one never matches", () => {
    registerNodeEmitter("testPair", {
      precedence: 11,
      emit: () => "1",
      sameShape: (a: { readonly n: number }, b: { readonly n: number }) => a.n === b.n,
    });
    expect(sameShape({ kind: "testPair", n: 1 } as never, { kind: "testPair", n: 1 } as never)).toBe(true);
    expect(sameShape({ kind: "testPair", n: 1 } as never, { kind: "testPair", n: 2 } as never)).toBe(false);
    expect(sameShape({ kind: 3 } as never, { kind: 3 } as never)).toBe(false);
  });

  test("shared select shapes and shared subqueries are the same at once", () => {
    const query = from(User, "u").ast;
    const shape = { kind: "constant" as const, index: 0 };
    expect(
      sameShape({ kind: "select", shape, constants: [1] }, { kind: "select", shape, constants: [2] }),
    ).toBe(true);
    expect(sameShape({ kind: "subquery", query }, { kind: "subquery", query })).toBe(true);
  });

  test("list lengths of a different count never match", () => {
    const cache = new PlanCache({ capacity: 2, keyLists: true, keyOf: () => 1 });
    const ast = from(User, "u").ast;
    const plan = createCompiler(postgresDialect).compile(ast, "all", undefined);
    cache.set(ast, "all", undefined, 0, [1], plan);
    expect(cache.get(from(User, "u").limit(1).ast, "all", undefined, 0, [1, 2])).toBeUndefined();
  });

  test("bindParams remembers each plan's names", () => {
    const slots: ParamSlot[] = [{ kind: "named", name: "a", toDb: undefined, redact: false }];
    expect(bindParams(slots, [], { a: 1 })).toEqual([1]);
    expect(bindParams(slots, [], { a: 2 })).toEqual([2]);
  });

  test("an except that is not a list makes its own key and is refused", () => {
    const users = meta(User);
    const email = users.fieldsByName.get("email") as FieldMeta;
    expect(() =>
      createCompiler(postgresDialect).compileInsert(
        users,
        [email],
        {
          source: { kind: "values", rows: 1 },
          returning: [],
          onConflict: { target: [email], update: { except: "email" } as never },
        },
        undefined,
      ),
    ).toThrow('onConflict\'s update is "all", a list of fields or { except }.');
  });

  test("emitInsert refuses an unknown source by itself", () => {
    const users = meta(User);
    const options = {
      source: { kind: "csv" },
      returning: [],
      onConflict: undefined,
    } as unknown as InsertPlanOptions;
    expect(() =>
      emitInsert(
        newContext(postgresDialect, { typeOverrides: () => undefined }),
        users,
        [],
        options,
        undefined,
      ),
    ).toThrow("An insert's source is values, cells or a query.");
  });
});
