import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { QueryAst, QueryNode, SelectShape } from "../contracts/query.js";
import { from, t } from "../index.js";
import {
  aggregateNode,
  betweenNode,
  binaryNode,
  caseNode,
  castNode,
  fnNode,
  identNode,
  jsonPathNode,
  listNode,
  literalNode,
  naryNode,
  orderNode,
  paramNode,
  STAR,
  selectedAsNode,
  tupleNode,
  unaryNode,
  windowNode,
} from "../query/ast.js";
import { meta } from "../schema/index.js";
import { sameShape } from "./same-shape.js";
import { ALL_CASES } from "./sql-cases.js";
import { col, frag, rebuild, tableOf, typeOf, value } from "./sql-fixtures.js";

/** A deep copy of an AST: every node and array is a new object, types and schema metadata are shared. */
function copy<T>(node: T): T {
  if (Array.isArray(node)) return node.map(copy) as T;
  if (typeof node !== "object" || node === null) return node;
  const kind = (node as { kind?: unknown }).kind;
  // Types and metadata have no `kind`; a type's `db` does, but it is only reached through a type.
  if (typeof kind !== "string") return node;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(node)) {
    out[key] = key === "type" || key === "meta" || key === "params" ? inner : copy(inner);
  }
  return out as T;
}

describe("sameShape", () => {
  test("every AST of the matrices equals a deep copy of itself", () => {
    let compared = 0;
    for (const [, cases] of ALL_CASES) {
      for (const sqlCase of cases) {
        const asts: QueryAst[] = [];
        const probe = { compile: (ast: QueryAst) => asts.push(ast) };
        try {
          sqlCase.compile(probe as never);
        } catch {
          // Not a query case.
        }
        for (const ast of asts) {
          expect(sameShape(ast, copy(ast))).toBe(true);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(80);
  });

  test("parameter values, list lengths, select constants and preload queries do not count", () => {
    expect(sameShape(value(1), value(2))).toBe(true);
    expect(sameShape(listNode([1], undefined, false), listNode([1, 2, 3], undefined, false))).toBe(true);
    const a = from(User, "u").select(({ u }) => ({ id: u.id, kind: "a" })).ast;
    const b = from(User, "u").select(({ u }) => ({ id: u.id, kind: "b" })).ast;
    expect(sameShape(a, b)).toBe(true);
    const p1 = from(User, "u").preload("posts", (q) => q.where(({ posts }) => posts.views.gt(1))).ast;
    const p2 = from(User, "u").preload("posts", (q) => q.where(({ posts }) => posts.title.eq("x"))).ast;
    expect(sameShape(p1, p2)).toBe(true);
  });

  test("a type is compared by identity, not by name", () => {
    const one = typeOf(t.enum(["a"]));
    const other = typeOf(t.enum(["b"]));
    expect(one.name).toBe(other.name);
    expect(sameShape(paramNode(1, one, false), paramNode(1, other, false))).toBe(false);
    expect(sameShape(castNode(value(1), one), castNode(value(1), one))).toBe(true);
    expect(sameShape(castNode(value(1), one), castNode(value(1), other))).toBe(false);
  });

  test("schema metadata is compared by identity", () => {
    const other = { ...meta(User) };
    expect(sameShape(tableOf(User, "u"), { ...tableOf(User, "u"), meta: other })).toBe(false);
  });

  // Each pair differs in exactly one structural detail.
  const differing: readonly (readonly [string, QueryNode, QueryNode])[] = [
    ["kind", value(1), literalNode(1)],
    ["column", col("u", "id"), col("u", "age")],
    ["column binding", col("u", "id"), col("v", "id")],
    ["param redact", paramNode(1, undefined, false), paramNode(1, undefined, true)],
    [
      "named param name",
      { kind: "namedParam", name: "a", type: undefined, redact: false },
      { kind: "namedParam", name: "b", type: undefined, redact: false },
    ],
    ["literal", literalNode(1), literalNode(2)],
    ["unary op", unaryNode("isNull", col("u", "id")), unaryNode("isNotNull", col("u", "id"))],
    ["unary operand", unaryNode("isNull", col("u", "id")), unaryNode("isNull", col("u", "age"))],
    ["binary op", binaryNode("eq", col("u", "id"), value(1)), binaryNode("neq", col("u", "id"), value(1))],
    [
      "binary right",
      binaryNode("eq", col("u", "id"), value(1)),
      binaryNode("eq", col("u", "id"), col("u", "age")),
    ],
    [
      "between",
      betweenNode(col("u", "age"), value(1), value(2)),
      betweenNode(col("u", "age"), value(1), col("u", "id")),
    ],
    ["nary op", naryNode("and", [value(1)]), naryNode("or", [value(1)])],
    ["nary length", naryNode("and", [value(1)]), naryNode("and", [value(1), value(2)])],
    ["fn name", fnNode("lower", [col("u", "email")]), fnNode("upper", [col("u", "email")])],
    [
      "aggregate distinct",
      aggregateNode("count", [STAR], false, undefined, undefined),
      aggregateNode("count", [STAR], true, undefined, undefined),
    ],
    [
      "aggregate filter",
      aggregateNode("count", [STAR], false, undefined, undefined),
      aggregateNode("count", [STAR], false, literalNode(true), undefined),
    ],
    [
      "aggregate named window",
      aggregateNode("count", [STAR], false, undefined, "w"),
      aggregateNode("count", [STAR], false, undefined, "v"),
    ],
    [
      "aggregate window kind",
      aggregateNode("count", [STAR], false, undefined, "w"),
      aggregateNode("count", [STAR], false, undefined, windowNode([], [], undefined)),
    ],
    ["window frame", windowNode([], [], undefined), windowNode([], [], frag`rows 1 preceding`)],
    [
      "window order",
      windowNode([], [orderNode(col("u", "id"), "asc", undefined)], undefined),
      windowNode([], [orderNode(col("u", "id"), "desc", undefined)], undefined),
    ],
    ["ident", identNode("a"), identNode("b")],
    ["fragment strings", frag`a ${value(1)}`, frag`b ${value(1)}`],
    ["fragment string count", frag`a`, frag`a ${value(1)}`],
    ["cast operand", castNode(value(1), typeOf(t.integer())), castNode(col("u", "id"), typeOf(t.integer()))],
    [
      "case branch",
      caseNode([{ when: literalNode(true), result: value(1) }], undefined),
      caseNode([{ when: literalNode(false), result: value(1) }], undefined),
    ],
    [
      "case result",
      caseNode([{ when: literalNode(true), result: value(1) }], undefined),
      caseNode([{ when: literalNode(true), result: literalNode(1) }], undefined),
    ],
    [
      "case else",
      caseNode([{ when: literalNode(true), result: value(1) }], undefined),
      caseNode([{ when: literalNode(true), result: value(1) }], value(2)),
    ],
    [
      "case length",
      caseNode([{ when: literalNode(true), result: value(1) }], undefined),
      caseNode([], undefined),
    ],
    [
      "json path text",
      jsonPathNode(col("u", "settings"), [value("a")], true),
      jsonPathNode(col("u", "settings"), [value("a")], false),
    ],
    [
      "subquery",
      { kind: "subquery", query: from(User, "u").ast },
      { kind: "subquery", query: from(Post, "p").ast },
    ],
    [
      "exists",
      { kind: "exists", query: from(User, "u").ast },
      { kind: "exists", query: from(User, "u").limit(1).ast },
    ],
    ["tuple", tupleNode([value(1)]), tupleNode([value(1), value(2)])],
    ["selected name", selectedAsNode("a", undefined), selectedAsNode("b", undefined)],
    ["selected expr", selectedAsNode("a", undefined), selectedAsNode("a", value(1))],
    ["order nulls", orderNode(col("u", "id"), "asc", undefined), orderNode(col("u", "id"), "asc", "last")],
    ["table schema", tableOf(User, "u"), tableOf(User, "u", "archive")],
    ["table alias", tableOf(User, "u"), tableOf(User, "v")],
    [
      "cte source",
      { kind: "cteSource", name: "a", meta: undefined, alias: "x" },
      { kind: "cteSource", name: "b", meta: undefined, alias: "x" },
    ],
    [
      "subquery source",
      { kind: "subquerySource", query: from(User, "u").ast, alias: "s" },
      { kind: "subquerySource", query: from(User, "u").ast, alias: "t" },
    ],
    [
      "values columns",
      { kind: "values", columns: ["a"], rows: [[value(1)]], alias: "v" },
      { kind: "values", columns: ["b"], rows: [[value(1)]], alias: "v" },
    ],
    [
      "values rows",
      { kind: "values", columns: ["a"], rows: [[value(1)]], alias: "v" },
      { kind: "values", columns: ["a"], rows: [[value(1)], [value(2)]], alias: "v" },
    ],
    [
      "values cells",
      { kind: "values", columns: ["a"], rows: [[value(1)]], alias: "v" },
      { kind: "values", columns: ["a"], rows: [[literalNode(1)]], alias: "v" },
    ],
    [
      "fragment source columns",
      { kind: "fragmentSource", fragment: frag`f()`, columns: ["a"], alias: "g" },
      { kind: "fragmentSource", fragment: frag`f()`, columns: ["b"], alias: "g" },
    ],
    [
      "join type",
      { kind: "join", type: "inner", source: tableOf(Post, "p"), on: undefined },
      { kind: "join", type: "left", source: tableOf(Post, "p"), on: undefined },
    ],
    [
      "join on",
      { kind: "join", type: "inner", source: tableOf(Post, "p"), on: undefined },
      { kind: "join", type: "inner", source: tableOf(Post, "p"), on: literalNode(true) },
    ],
    [
      "bool op",
      { kind: "bool", op: "and", expr: literalNode(true) },
      { kind: "bool", op: "or", expr: literalNode(true) },
    ],
    ["distinct on", { kind: "distinct", on: [] }, { kind: "distinct", on: [col("u", "id")] }],
    ["lock clause", { kind: "lock", clause: "FOR UPDATE" }, { kind: "lock", clause: "FOR SHARE" }],
    ["lock kind", { kind: "lock", clause: "FOR UPDATE" }, { kind: "lock", clause: frag`FOR UPDATE` }],
    ["lock fragment", { kind: "lock", clause: frag`a` }, { kind: "lock", clause: frag`b` }],
    [
      "combination all",
      { kind: "combination", op: "union", all: false, query: from(User, "u").ast },
      { kind: "combination", op: "union", all: true, query: from(User, "u").ast },
    ],
    [
      "cte recursive",
      {
        kind: "cte",
        name: "c",
        query: from(User, "u").ast,
        operation: "all",
        recursive: false,
        materialized: undefined,
      },
      {
        kind: "cte",
        name: "c",
        query: from(User, "u").ast,
        operation: "all",
        recursive: true,
        materialized: undefined,
      },
    ],
    [
      "cte materialized",
      {
        kind: "cte",
        name: "c",
        query: from(User, "u").ast,
        operation: "all",
        recursive: false,
        materialized: undefined,
      },
      {
        kind: "cte",
        name: "c",
        query: from(User, "u").ast,
        operation: "all",
        recursive: false,
        materialized: false,
      },
    ],
    [
      "cte body kind",
      {
        kind: "cte",
        name: "c",
        query: from(User, "u").ast,
        operation: "all",
        recursive: false,
        materialized: undefined,
      },
      {
        kind: "cte",
        name: "c",
        query: frag`select 1`,
        operation: "all",
        recursive: false,
        materialized: undefined,
      },
    ],
    [
      "window def",
      { kind: "windowDef", name: "w", spec: windowNode([], [], undefined) },
      { kind: "windowDef", name: "v", spec: windowNode([], [], undefined) },
    ],
    [
      "preload from",
      { kind: "preload", assoc: "posts", from: undefined, query: undefined, nested: [] },
      { kind: "preload", assoc: "posts", from: "p", query: undefined, nested: [] },
    ],
    [
      "preload nested",
      { kind: "preload", assoc: "posts", from: undefined, query: undefined, nested: [] },
      {
        kind: "preload",
        assoc: "posts",
        from: undefined,
        query: undefined,
        nested: [{ kind: "preload", assoc: "comments", from: undefined, query: undefined, nested: [] }],
      },
    ],
    [
      "update column",
      { kind: "update", field: "a", column: "a", value: value(1) },
      { kind: "update", field: "a", column: "b", value: value(1) },
    ],
    ["query clause", from(User, "u").ast, from(User, "u").limit(1).ast],
    ["query schema", from(User, "u").ast, from(User, "u").schema("archive").ast],
  ];

  test.each(differing)("a different %s is a different shape", (_name, a, b) => {
    expect(sameShape(a, b)).toBe(false);
    expect(sameShape(b, a)).toBe(false);
  });

  test("two queries with equal shape hashes and one different clause are told apart", () => {
    const a = from(User, "u").where(({ u }) => u.age.gt(1)).ast;
    const b = from(User, "u").where(({ u }) => u.age.lt(1)).ast;
    expect(sameShape(a, { ...b, shape: a.shape })).toBe(false);
  });

  const selects: readonly (readonly [string, SelectShape, SelectShape])[] = [
    [
      "expr type",
      { kind: "expr", expr: value(1), type: undefined },
      { kind: "expr", expr: value(1), type: typeOf(t.integer()) },
    ],
    [
      "binding alias",
      { kind: "binding", binding: "u", meta: meta(User) },
      { kind: "binding", binding: "v", meta: meta(User) },
    ],
    [
      "binding schema",
      { kind: "binding", binding: "u", meta: meta(User) },
      { kind: "binding", binding: "u", meta: meta(Post) },
    ],
    ["constant position", { kind: "constant", index: 0 }, { kind: "constant", index: 1 }],
    [
      "object keys",
      { kind: "object", keys: ["a"], values: [{ kind: "constant", index: 0 }] },
      { kind: "object", keys: ["b"], values: [{ kind: "constant", index: 0 }] },
    ],
    [
      "object values",
      { kind: "object", keys: ["a"], values: [{ kind: "constant", index: 0 }] },
      { kind: "object", keys: ["a"], values: [{ kind: "constant", index: 1 }] },
    ],
    [
      "object length",
      { kind: "object", keys: ["a"], values: [{ kind: "constant", index: 0 }] },
      { kind: "object", keys: ["a"], values: [] },
    ],
    [
      "tuple items",
      { kind: "tuple", items: [{ kind: "constant", index: 0 }] },
      { kind: "tuple", items: [{ kind: "constant", index: 1 }] },
    ],
    [
      "tuple length",
      { kind: "tuple", items: [{ kind: "constant", index: 0 }] },
      { kind: "tuple", items: [] },
    ],
    ["shape kind", { kind: "tuple", items: [] }, { kind: "object", keys: [], values: [] }],
    ["unknown kind", { kind: "mystery" } as never, { kind: "mystery" } as never],
  ];

  test.each(selects)("a select with a different %s is a different shape", (_name, a, b) => {
    const node = (shape: SelectShape): QueryNode => ({ kind: "select", shape, constants: [] });
    expect(sameShape(node(a), node(b))).toBe(false);
  });

  test("an unknown node kind is never the same", () => {
    expect(sameShape({ kind: "mystery" } as never, { kind: "mystery" } as never)).toBe(false);
    expect(sameShape({ kind: "query" } as never, { kind: "query" } as never)).toBe(true);
  });

  test("equal shapes of every kind compare equal", () => {
    const base = rebuild(from(User, "u").ast, {});
    expect(sameShape(base, copy(base))).toBe(true);
    expect(sameShape(frag`a ${value(1)}`, frag`a ${value(2)}`)).toBe(true);
  });
});
