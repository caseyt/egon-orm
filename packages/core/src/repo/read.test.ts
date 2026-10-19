// Unit tests for the derived queries of read.ts that need no adapter: which selects
// `exists` and `aggregate` must read through a subquery.
import { Post, User } from "@egon-orm/test-support";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { ExprNode, QueryAst } from "../contracts/query.js";
import { QueryError } from "../errors.js";
import {
  aggregateNode,
  betweenNode,
  binaryNode,
  caseNode,
  castNode,
  columnNode,
  fnNode,
  fragmentNode,
  jsonPathNode,
  literalNode,
  naryNode,
  paramNode,
  selectedAsNode,
  subqueryNode,
  tupleNode,
  unaryNode,
  windowNode,
} from "../query/ast.js";
import { from } from "../query/builder.js";
import { selectNode } from "../query/select.js";
import { integerType } from "../types/index.js";
import { aggregateAst, encodeKey, existsAst } from "./read.js";

const COUNT: ExprNode = aggregateNode("count", [], false, undefined, undefined);
const WINDOW_COUNT: ExprNode = aggregateNode("count", [], false, undefined, windowNode([], [], undefined));
const AGE: ExprNode = columnNode("u", "age", "age");
const ONE = literalNode(1);

/** `from(User, "u")` selecting `expr`, as a bare AST. */
function selecting(expr: ExprNode): QueryAst {
  return { ...from(User, "u").ast, select: selectNode({ kind: "expr", expr, type: undefined }, []) };
}

const wrapped = (ast: QueryAst): boolean => existsAst(ast).from.kind === "subquerySource";

/** Every way an expression can hold another one. */
const FORMS: readonly [string, (inner: ExprNode) => ExprNode][] = [
  ["unary", (inner) => unaryNode("neg", inner)],
  ["binary, left", (inner) => binaryNode("add", inner, ONE)],
  ["binary, right", (inner) => binaryNode("add", ONE, inner)],
  ["between", (inner) => betweenNode(AGE, ONE, inner)],
  ["nary", (inner) => naryNode("and", [literalNode(true), inner])],
  ["fn", (inner) => fnNode("coalesce", [AGE, inner])],
  ["tuple", (inner) => tupleNode([AGE, inner])],
  ["cast", (inner) => castNode(inner, integerType())],
  ["json path, subject", (inner) => jsonPathNode(inner, [], false)],
  ["json path, path", (inner) => jsonPathNode(AGE, [inner], true)],
  ["case, condition", (inner) => caseNode([{ when: binaryNode("gt", inner, ONE), result: ONE }], undefined)],
  ["case, result", (inner) => caseNode([{ when: literalNode(true), result: inner }], undefined)],
  ["case, else", (inner) => caseNode([{ when: literalNode(true), result: ONE }], inner)],
  ["selected as", (inner) => selectedAsNode("n", inner)],
  [
    "window function over it",
    (inner) => aggregateNode("sum", [inner], false, undefined, windowNode([], [], undefined)),
  ],
];

describe("which selects aggregate", () => {
  test.for(FORMS)("an aggregate inside %s is found", ([, wrap]) => {
    expect(wrapped(selecting(wrap(COUNT)))).toBe(true);
  });

  test.for(FORMS)("a plain column inside %s is not an aggregate", ([, wrap]) => {
    expect(wrapped(selecting(wrap(AGE)))).toBe(false);
  });

  test("a window function alone does not aggregate, nor a subquery's aggregate", () => {
    expect(wrapped(selecting(WINDOW_COUNT))).toBe(false);
    const inner = {
      ...from(Post, "p").ast,
      select: selectNode({ kind: "expr", expr: COUNT, type: undefined }, []),
    };
    expect(wrapped(selecting(subqueryNode(inner)))).toBe(false);
    expect(wrapped(selecting(selectedAsNode("n", undefined)))).toBe(false);
    expect(wrapped(selecting(caseNode([{ when: literalNode(true), result: ONE }], undefined)))).toBe(false);
  });

  test("a fragment, or an expression kind it does not know, cannot be checked", () => {
    expect(wrapped(selecting(fragmentNode(["now()"], [])))).toBe(true);
    expect(wrapped(selecting({ kind: "custom" } as unknown as ExprNode))).toBe(true);
  });

  test("parameter values are never walked: a cyclic value, a value shaped like a node", () => {
    const cyclic: Record<string, unknown> = { kind: "aggregate" };
    cyclic.self = cyclic;
    expect(wrapped(selecting(paramNode(cyclic, undefined, false)))).toBe(false);
    expect(wrapped(selecting(paramNode({ kind: "aggregate", over: undefined }, undefined, false)))).toBe(
      false,
    );
    expect(wrapped(selecting(paramNode([{ kind: "fragment" }], undefined, false)))).toBe(false);
  });
});

describe("a wrapped aggregate over a field", () => {
  const select = (expr: ExprNode, key = "views"): QueryAst => ({
    ...from(Post, "p").ast,
    select: selectNode(
      {
        kind: "object",
        keys: [key, "x"],
        values: [
          { kind: "expr", expr: columnNode("p", "views", "views"), type: undefined },
          { kind: "expr", expr, type: undefined },
        ],
      },
      [],
    ),
  });

  test("a fragment in the select wraps, and the field's column is still found", () => {
    const ast = aggregateAst(select(fragmentNode(["now()"], [])), "sum", "views");
    expect(ast.from.kind).toBe("subquerySource");
  });

  test("the error says why it was wrapped, and what to do", () => {
    expect(() => aggregateAst(select(fragmentNode(["now()"], []), "other"), "sum", "views")).toThrow(
      /its select has a fragment, whose SQL cannot be checked for aggregates.*Otherwise compute the aggregate in the query's own select/,
    );
    expect(() => aggregateAst(select(COUNT, "other"), "sum", "views")).toThrow(/\(its select aggregates\)/);
    const limited = { ...from(Post, "p").limit(2).ast };
    const noKey = { ...limited, select: selectNode({ kind: "expr", expr: AGE, type: undefined }, []) };
    expect(() => aggregateAst(noKey, "sum", "views")).toThrow(QueryError);
    for (const [reason, ast] of [
      ["it has a limit", from(Post, "p").limit(2).ast],
      ["it has an offset", from(Post, "p").offset(2).ast],
      ["it is distinct", from(Post, "p").distinct().ast],
      ["it has a groupBy", from(Post, "p").groupBy(({ p }) => p.authorId).ast],
      ["it locks its rows", from(Post, "p").lock("update").ast],
      [
        "it has a having",
        {
          ...from(Post, "p").ast,
          havings: [{ kind: "bool", op: "and", expr: binaryNode("gt", COUNT, ONE) }],
        },
      ],
      [
        "it has a set operation",
        {
          ...from(Post, "p").ast,
          combinations: [{ kind: "combination", op: "union", all: false, query: from(Post, "q").ast }],
        },
      ],
    ] as const) {
      const titled = {
        ...ast,
        select: selectNode({ kind: "expr", expr: columnNode("p", "title", "title"), type: undefined }, []),
      };
      expect(() => aggregateAst(titled, "max", "views")).toThrow(`(${reason})`);
    }
  });
});

describe("key encodings", () => {
  test("values are compared by content", () => {
    expect(encodeKey(Uint8Array.from([1, 255]))).toBe(encodeKey(Uint8Array.from([1, 255])));
    expect(encodeKey(new Date(5))).toBe(encodeKey(new Date(5)));
    expect(encodeKey(["a", ["b"]])).toBe(encodeKey(["a", ["b"]]));
    expect(encodeKey({ a: 1n })).toBe(encodeKey({ a: 1n }));
  });

  test("different values never share an encoding", () => {
    const pairs: [unknown, unknown][] = [
      [["a,b"], ["a", "b"]],
      [[], [""]],
      [["a"], "a"],
      [1, "1"],
      [1, 1n],
      [true, "true"],
      [null, "null"],
      [undefined, "n;"],
      [Uint8Array.from([1]), "01"],
      [new Date(1), 1],
      [{ a: 1 }, '{"a":1}'],
      [[["a"], "b"], [["a", "b"]]],
    ];
    for (const [a, b] of pairs) expect(encodeKey(a)).not.toBe(encodeKey(b));
  });

  test("concatenated encodings of a composite key are unambiguous", () => {
    const value = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.bigInt(),
      fc.boolean(),
      fc.constant(null),
      fc.uint8Array({ maxLength: 4 }),
      fc.array(fc.oneof(fc.string({ maxLength: 3 }), fc.integer()), { maxLength: 3 }),
    );
    const normal = (key: readonly unknown[]): string =>
      JSON.stringify(key, (_k, inner: unknown) =>
        typeof inner === "bigint"
          ? `big:${inner}`
          : inner instanceof Uint8Array
            ? `bytes:${[...inner].join(",")}`
            : typeof inner === "string"
              ? `str:${inner}`
              : inner,
      );
    fc.assert(
      fc.property(
        fc.array(value, { minLength: 1, maxLength: 3 }),
        fc.array(value, { minLength: 1, maxLength: 3 }),
        (a, b) => {
          const same = a.map(encodeKey).join("") === b.map(encodeKey).join("");
          expect(same).toBe(normal(a) === normal(b));
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
