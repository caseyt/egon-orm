// A value with no type that is not text is refused where nothing gives it a type (owner
// decision, 2026-10-15). The types already refuse `val(5)` in a select; these tests reach
// the compiler with hand-built trees and casts, as a caller without the types would.
import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { ExprNode, QueryAst } from "../contracts/query.js";
import { caseWhen, coalesce, from, t, val } from "../index.js";
import { caseNode, fnNode, literalNode, naryNode, paramNode } from "../query/ast.js";
import type { Expr } from "../query/expr.js";
import { bindParams } from "./bind.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { bareQuery, col, rebuild, selectObject, selectOne, typeOf, value } from "./sql-fixtures.js";
import { untypedValue } from "./untyped.js";

const users = from(User, "u").ast;

function compile(ast: QueryAst, operation: "all" | "updateAll" = "all") {
  return createCompiler(postgresDialect).compile(ast, operation, undefined);
}

function selecting(node: ExprNode): QueryAst {
  return rebuild(users, { select: selectOne(node) });
}

const untyped = (v: unknown): ExprNode => paramNode(v, undefined, false);

describe("an untyped value that is not text", () => {
  test.each([
    ["a number", 5, "It is a number: give it a type, val(value, t.integer()) or val(value, t.float())."],
    ["a boolean", true, "It is a boolean: give it a type, val(value, t.boolean())."],
    ["a bigint", 5n, "It is a bigint: give it a type, val(value, t.bigint())."],
    ["a Date", new Date(0), "It is a Date: give it a type, val(value, t.timestamp())."],
    ["bytes", new Uint8Array(1), "It is bytes: give it a type, val(value, t.binary())."],
    ["an object", { a: 1 }, "It is an object or array: give it a type, val(value, t.json())."],
  ])("is refused in the select list: %s", (_kind, v, hint) => {
    expect(() => compile(selecting(untyped(v)))).toThrow(
      `A value without a type is in the select list, where nothing gives it one, so the database would return it as text. ${hint}`,
    );
  });

  test("the error names the place but never the value", () => {
    expect(untypedValue("the select list", 123456789).message).not.toContain("123456789");
  });

  test("is refused nested in an object or array select", () => {
    const ast = rebuild(users, {
      select: {
        kind: "select",
        shape: {
          kind: "object",
          keys: ["id", "inner"],
          values: [
            { kind: "expr", expr: col("u", "id"), type: undefined },
            { kind: "tuple", items: [{ kind: "expr", expr: untyped(1), type: undefined }] },
          ],
        },
        constants: [],
      },
    });
    expect(() => compile(ast)).toThrow("A value without a type is in the select list");
  });

  test("is refused as a CASE result or ELSE in a select, unless another result has a type", () => {
    const when = { when: literalNode(true), result: untyped(1) };
    expect(() => compile(selecting(caseNode([when], undefined)))).toThrow(
      "A value without a type is in a result of a CASE in the select list",
    );
    expect(() => compile(selecting(caseNode([when], untyped(2))))).toThrow(
      "A value without a type is in a result of a CASE in the select list",
    );
    // A typed result types the others (review round 3 of the casts follow-up).
    const typedWhen = { when: literalNode(true), result: value(1, typeOf(t.integer())) };
    expect(compile(selecting(caseNode([typedWhen], untyped(2)))).sql).toBe(
      'select case when true then cast($1 as integer) else $2 end as "c0" from "users" as "u"',
    );
  });

  test("is refused in a coalesce of nothing but untyped values; another argument types it", () => {
    expect(() => compile(selecting(fnNode("coalesce", [untyped(1), untyped(2)])))).toThrow(
      "A value without a type is in coalesce() in the select list",
    );
    expect(compile(selecting(fnNode("coalesce", [untyped("a"), untyped(null)]))).sql).toBe(
      'select coalesce(cast($1 as text), cast($2 as text)) as "c0" from "users" as "u"',
    );
    expect(compile(selecting(fnNode("coalesce", [col("u", "age"), untyped(0)]))).sql).toBe(
      'select coalesce("u"."age", $1) as "c0" from "users" as "u"',
    );
  });

  test("is refused in a values cell and a RETURNING list", () => {
    const values = rebuild(bareQuery({ kind: "values", columns: ["a"], rows: [[untyped(1)]], alias: "v" }), {
      select: selectOne(col("v", "a")),
    });
    expect(() => compile(values)).toThrow("A value without a type is in a values list");
    const returning = rebuild(from(Post, "p").ast, {
      updates: [{ kind: "update", field: "views", column: "views", value: literalNode(0) }],
      select: selectObject({ n: untyped(1) }),
    });
    expect(() => compile(returning, "updateAll")).toThrow("A value without a type is in the select list");
  });

  test("is refused when bound to a plan made from a query whose value was text", () => {
    const compiler = createCompiler(postgresDialect);
    const text = selecting(untyped("x"));
    const number = selecting(untyped(5));
    const plan = compiler.compile(text, "all", undefined);
    expect(bindParams(plan.slots, text.params)).toEqual(["x"]);
    // Same shape: the cached plan is found, and binding the number is refused.
    expect(compiler.compile(number, "all", undefined)).toBe(plan);
    expect(() => bindParams(plan.slots, number.params)).toThrow(
      "A value without a type is in the select list",
    );
    expect(bindParams(plan.slots, selecting(untyped(null)).params)).toEqual([null]);
  });

  test("an untyped named parameter takes text or null only", () => {
    const ast = selecting({ kind: "namedParam", name: "label", type: undefined, redact: false });
    const plan = compile(ast);
    expect(plan.sql).toBe('select cast($1 as text) as "c0" from "users" as "u"');
    expect(bindParams(plan.slots, [], { label: "x" })).toEqual(["x"]);
    expect(() => bindParams(plan.slots, [], { label: 1 })).toThrow(
      "A value without a type is in the select list",
    );
  });
});

describe("a CASE or coalesce with no type inside a selected coalesce (review round 2)", () => {
  test("a coalesce whose arguments are an untyped CASE and an untyped value is refused", () => {
    const untypedCase = caseNode([{ when: literalNode(true), result: untyped(1) }], undefined);
    expect(() => compile(selecting(fnNode("coalesce", [untypedCase, untyped(2)])))).toThrow(
      "A value without a type is in a result of a CASE in coalesce() in the select list",
    );
    const nested = fnNode("coalesce", [fnNode("coalesce", [untyped(1), untyped(null)]), untyped(2)]);
    expect(() => compile(selecting(nested))).toThrow("coalesce() in coalesce() in the select list");
  });

  test("text throughout is cast to text", () => {
    const textCase = caseNode([{ when: literalNode(true), result: untyped("a") }], literalNode(null));
    expect(compile(selecting(fnNode("coalesce", [textCase, untyped("b")]))).sql).toBe(
      'select coalesce(case when true then cast($1 as text) else null end, cast($2 as text)) as "c0" from "users" as "u"',
    );
  });
});

describe("comparisons where neither side has a type (review round 2)", () => {
  const where = (expr: ExprNode) =>
    rebuild(users, { wheres: [{ kind: "bool", op: "and", expr }], select: selectOne(col("u", "id")) });
  const binary = (
    op: "gt" | "eq" | "like" | "isDistinctFrom",
    left: ExprNode,
    right: ExprNode,
  ): ExprNode => ({
    kind: "binary",
    op,
    left,
    right,
  });

  test.each(["gt", "eq", "isDistinctFrom"] as const)("%s() of two untyped numbers is refused", (op) => {
    expect(() => compile(where(binary(op, untyped(10), untyped(9))))).toThrow(
      `A value without a type is in a comparison of two values without a type (${op}())`,
    );
  });

  test("text against text is compared as text; text against a number is refused", () => {
    expect(compile(where(binary("gt", untyped("b"), untyped("a")))).sql).toBe(
      'select "u"."id" as "c0" from "users" as "u" where cast($1 as text) > cast($2 as text)',
    );
    expect(() => compile(where(binary("like", untyped("b"), untyped(9))))).toThrow("(like())");
    expect(compile(where(binary("isDistinctFrom", untyped("b"), literalNode(null)))).sql).toContain(
      "where cast($1 as text) is distinct from null",
    );
  });

  test("between and in with no typed side are refused unless text", () => {
    const between: ExprNode = { kind: "between", expr: untyped(5), low: untyped(1), high: untyped(9) };
    expect(() => compile(where(between))).toThrow("(between())");
    const list = (values: unknown[]): ExprNode => ({
      kind: "list",
      value: values,
      type: undefined,
      redact: false,
    });
    expect(() => compile(where(binary("in" as never, untyped(5), list([1, 2]))))).toThrow("(in())");
    expect(() => compile(where(binary("in" as never, untyped("a"), list(["a", 2]))))).toThrow("(in())");
    const plan = compile(where(binary("notIn" as never, untyped("a"), list(["b", null]))));
    expect(plan.sql).toContain("where cast($1 as text) <> all($2)");
    expect(() => bindParams(plan.slots, ["a", ["b", 3]])).toThrow("(notIn())");
  });

  test("a typed side types the other, as before", () => {
    expect(compile(where(binary("gt", value(10, typeOf(t.integer())), untyped(9)))).sql).toContain(
      "where cast($1 as integer) > $2",
    );
    expect(compile(where(binary("gt", col("u", "age"), untyped(9)))).sql).toContain('where "u"."age" > $1');
  });

  test("bound values with a type are cast wherever the SQL has no other type for them", () => {
    const integer = typeOf(t.integer());
    const between: ExprNode = {
      kind: "between",
      expr: value(5, integer),
      low: untyped(1),
      high: value(9, integer),
    };
    expect(compile(where(between)).sql).toContain(
      "where cast($1 as integer) between $2 and cast($3 as integer)",
    );
    const list: ExprNode = { kind: "list", value: [1, 2], type: integer, redact: false };
    expect(compile(where(binary("in" as never, value(5, integer), list))).sql).toContain(
      "where cast($1 as integer) = any($2)",
    );
    const typedCase = caseNode([{ when: literalNode(true), result: value(1, integer) }], undefined);
    expect(compile(selecting(fnNode("coalesce", [typedCase, value(2, integer)]))).sql).toBe(
      'select coalesce(case when true then cast($1 as integer) end, cast($2 as integer)) as "c0" from "users" as "u"',
    );
    // An untyped argument beside a typed one takes its type.
    expect(compile(selecting(fnNode("coalesce", [value(1, integer), untyped(2)]))).sql).toBe(
      'select coalesce(cast($1 as integer), $2) as "c0" from "users" as "u"',
    );
  });

  test("on a dialect that expands lists, a bound left side of in() is cast or checked the same way", () => {
    const expanding = {
      ...postgresDialect,
      name: "mysql" as const,
      placeholder: "positional" as const,
      capabilities: { ...postgresDialect.capabilities, arrayParams: false },
    };
    const run = (ast: QueryAst) => createCompiler(expanding).compile(ast, "all", undefined);
    const integer = typeOf(t.integer());
    const list = (values: unknown[], type?: typeof integer): ExprNode => ({
      kind: "list",
      value: values,
      type,
      redact: false,
    });
    expect(run(where(binary("in" as never, value(5, integer), list([1, 2], integer)))).sql).toContain(
      "where cast(? as integer) in (?, ?)",
    );
    const text = run(where(binary("notIn" as never, untyped("a"), list(["b", "c"]))));
    expect(text.sql).toContain("where cast(? as text) not in (?, ?)");
    expect(() => bindParams(text.slots, ["a", ["b", 3]])).toThrow("(notIn())");
    // An empty expanded list is false, and the left side's value is skipped.
    const empty = where(
      naryNode("and", [
        binary("in" as never, untyped(5), list([])),
        binary("gt", col("u", "age"), untyped(1)),
      ]),
    );
    const plan = run(empty);
    expect(plan.sql).toContain("where false and");
    expect(bindParams(plan.slots, empty.params)).toEqual([1]);
  });

  test("an untyped CASE compared with a column is cast to the column's type", () => {
    const untypedCase = caseNode([{ when: literalNode(true), result: untyped(1) }], untyped(2));
    expect(compile(where(binary("eq", untypedCase, col("u", "age")))).sql).toContain(
      'where cast(case when true then $1 else $2 end as integer) = "u"."age"',
    );
  });

  test("a function other than coalesce types its result: not a bound value", () => {
    const lower = fnNode("lower", [untyped("A")]);
    expect(compile(where(binary("eq", lower, untyped("a")))).sql).toContain("where lower($1) = $2");
  });

  test("a typed named parameter needs a name", () => {
    const nameless: ExprNode = { kind: "namedParam", name: "", type: typeOf(t.integer()), redact: false };
    expect(() => compile(where(binary("eq", col("u", "age"), nameless)))).toThrow(
      "A named parameter has no name.",
    );
  });

  test("not in an empty expanded list of untyped values is true", () => {
    const expanding = {
      ...postgresDialect,
      name: "mysql" as const,
      placeholder: "positional" as const,
      capabilities: { ...postgresDialect.capabilities, arrayParams: false },
    };
    const ast = where(
      binary("notIn" as never, untyped(5), { kind: "list", value: [], type: undefined, redact: false }),
    );
    expect(createCompiler(expanding).compile(ast, "all", undefined).sql).toContain("where true");
  });

  test("a coalesce of untyped values compared with an untyped value is refused", () => {
    const left = fnNode("coalesce", [untyped(1), untyped(2)]);
    expect(() => compile(where(binary("gt", left, untyped(3))))).toThrow("(gt())");
  });

  test("a shared plan refuses a number bound where text was compiled", () => {
    const compiler = createCompiler(postgresDialect);
    const text = where(binary("gt", untyped("b"), untyped("a")));
    const numbers = where(binary("gt", untyped(10), untyped(9)));
    const plan = compiler.compile(text, "all", undefined);
    expect(compiler.compile(numbers, "all", undefined)).toBe(plan);
    expect(() => bindParams(plan.slots, numbers.params)).toThrow("(gt())");
  });
});

describe("what the types refuse is refused by the compiler too", () => {
  // Widened to a plain Expr, which drops the type-only mark: without that these do not
  // compile (query/untyped.test-d.ts).
  test("a CASE started with text whose ELSE is an untyped number", () => {
    const q = from(User, "u").select(
      ({ u }) => caseWhen(u.age.lt(18), "minor").else(5) as Expr<string | number>,
    );
    expect(() => compile(q.ast)).toThrow(
      "A value without a type is in a result of a CASE in the select list",
    );
  });

  test("a coalesce of untyped values", () => {
    const q = from(User, "u").select(() => coalesce(val(1), val(1)) as Expr<number>);
    expect(() => compile(q.ast)).toThrow("A value without a type is in coalesce() in the select list");
  });
});

describe("what stays allowed", () => {
  test("text, null, typed values and literals", () => {
    const ast = rebuild(users, {
      select: selectObject({
        label: untyped("member"),
        none: untyped(null),
        n: value(5, typeOf(t.integer())),
        one: literalNode(1),
      }),
    });
    const plan = compile(ast);
    expect(plan.sql).toBe(
      'select cast($1 as text) as "c0", cast($2 as text) as "c1", cast($3 as integer) as "c2", 1 as "c3" from "users" as "u"',
    );
    expect(bindParams(plan.slots, ast.params)).toEqual(["member", null, 5]);
  });

  test("an untyped value compared with a column is typed by it, and not checked", () => {
    const ast = rebuild(users, {
      wheres: [
        {
          kind: "bool",
          op: "and",
          expr: { kind: "binary", op: "eq", left: col("u", "age"), right: untyped(5) },
        },
      ],
      select: selectOne(col("u", "id")),
    });
    expect(bindParams(compile(ast).slots, ast.params)).toEqual([5]);
  });
});
