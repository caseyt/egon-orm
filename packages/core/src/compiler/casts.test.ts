// Bound values that the SQL gives no type: arithmetic of bound values (typed values are
// cast; untyped ones may only be text), and a CASE or coalesce of bound values beside an
// operand with a type (its typed values are cast; with none, a column on the other side
// of a comparison types it). The snapshot matrix (`casts.sql.test.ts`) pins the common
// forms; these tests cover refusals, shared plans and hand-built trees.
import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { BinaryOp, ExprNode, QueryAst } from "../contracts/query.js";
import { caseWhen, coalesce, from, lit, param, subquery, t, val } from "../index.js";
import { caseNode, fnNode, literalNode, unaryNode } from "../query/ast.js";
import { bindParams } from "./bind.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { bareQuery, col, rebuild, selectOne, typeOf, value } from "./sql-fixtures.js";

const users = from(User, "u").ast;
const integer = typeOf(t.integer());

function compile(ast: QueryAst) {
  return createCompiler(postgresDialect).compile(ast, "all", undefined);
}

const untyped = (v: unknown): ExprNode => value(v);
const typed = (v: number): ExprNode => value(v, integer);
const binary = (op: BinaryOp, left: ExprNode, right: ExprNode): ExprNode => ({
  kind: "binary",
  op,
  left,
  right,
});
const selecting = (node: ExprNode): QueryAst => rebuild(users, { select: selectOne(node) });
const where = (node: ExprNode): QueryAst =>
  rebuild(users, { wheres: [{ kind: "bool", op: "and", expr: node }], select: selectOne(col("u", "id")) });
const untypedCase = (...results: unknown[]): ExprNode =>
  caseNode(
    [{ when: literalNode(true), result: untyped(results[0]) }],
    results.length > 1 ? untyped(results[1]) : undefined,
  );

describe("arithmetic of bound values", () => {
  test.each(["add", "sub", "mul", "div", "mod"] as const)("%s() of two untyped numbers is refused", (op) => {
    expect(() => compile(selecting(binary(op, untyped(3), untyped(1))))).toThrow(
      `Arithmetic (${op}()) on values without a type, where nothing gives them one, so the database cannot choose an operator. Give a value a type: val(value, t.integer()) or val(value, t.float()).`,
    );
  });

  test("the refusal never quotes a value", () => {
    expect(() => compile(selecting(binary("add", untyped(123456789), untyped(1))))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("123456789") }),
    );
  });

  test("unary minus of an untyped value is refused; of a typed one it is cast", () => {
    expect(() => compile(selecting(unaryNode("neg", untyped(3))))).toThrow("Arithmetic (neg())");
    expect(() => compile(selecting(unaryNode("neg", untyped("3"))))).toThrow("Arithmetic (neg())");
    expect(() => compile(selecting(unaryNode("neg", untypedCase(1, 2))))).toThrow("Arithmetic (neg())");
    expect(compile(selecting(unaryNode("neg", typed(3)))).sql).toBe(
      'select -cast($1 as integer) as "c0" from "users" as "u"',
    );
  });

  test("one typed operand types the other, which is left bare", () => {
    expect(compile(selecting(binary("add", typed(3), untyped(1)))).sql).toBe(
      'select cast($1 as integer) + $2 as "c0" from "users" as "u"',
    );
    expect(compile(selecting(binary("mul", untyped(3), typed(1)))).sql).toBe(
      'select $1 * cast($2 as integer) as "c0" from "users" as "u"',
    );
  });

  test("untyped text is refused too: text has no arithmetic", () => {
    expect(() => compile(selecting(binary("add", untyped("a"), untyped("b"))))).toThrow("Arithmetic (add())");
    expect(() => compile(selecting(binary("add", untyped(null), untypedCase("a"))))).toThrow(
      "Arithmetic (add())",
    );
  });

  test("a typed value beside a column is left to the column; beside anything else it keeps its type", () => {
    expect(compile(selecting(binary("add", col("u", "age"), typed(1)))).sql).toBe(
      'select "u"."age" + $1 as "c0" from "users" as "u"',
    );
    expect(compile(selecting(binary("add", typed(1), literalNode(2)))).sql).toBe(
      'select cast($1 as integer) + 2 as "c0" from "users" as "u"',
    );
    expect(compile(selecting(binary("sub", fnNode("lower", [col("u", "name")]), typed(1)))).sql).toBe(
      'select lower("u"."name") - cast($1 as integer) as "c0" from "users" as "u"',
    );
    // An untyped value beside an expression is typed by it.
    expect(compile(selecting(binary("add", binary("add", typed(1), typed(2)), untyped(3)))).sql).toBe(
      'select cast($1 as integer) + cast($2 as integer) + $3 as "c0" from "users" as "u"',
    );
    expect(compile(selecting(unaryNode("neg", col("u", "age")))).sql).toBe(
      'select -"u"."age" as "c0" from "users" as "u"',
    );
  });

  test("concatenation is not cast: the database takes two placeholders as text", () => {
    expect(compile(selecting(binary("concat", typed(1), untyped("x")))).sql).toBe(
      'select $1 || $2 as "c0" from "users" as "u"',
    );
  });

  test("the casts are part of the plan: a query of the same shape with other values reuses it", () => {
    const compiler = createCompiler(postgresDialect);
    const q = (a: number, b: number) =>
      from(Post, "p")
        .where(({ p }) => p.views.eq(val(a, t.integer()).add(b)))
        .select(({ p }) => p.id).ast;
    const first = compiler.compile(q(3, 4), "all", undefined);
    const second = q(10, 20);
    expect(compiler.compile(second, "all", undefined)).toBe(first);
    expect(first.sql).toBe(
      'select "p"."id" as "c0" from "posts" as "p" where "p"."views" = cast($1 as integer) + cast($2 as integer)',
    );
    expect(bindParams(first.slots, second.params)).toEqual([10, 20]);
    expect(compiler.stats().collisions).toBe(0);
  });

  test("an untyped named parameter in arithmetic is refused; a typed one is cast", () => {
    const named: ExprNode = { kind: "namedParam", name: "n", type: undefined, redact: false };
    expect(() => compile(selecting(binary("add", named, untyped(1))))).toThrow("Arithmetic (add())");
    const q = from(Post, "p")
      .where(({ p }) => p.views.gt(param("base", t.integer()).sub(1)))
      .select(({ p }) => p.id);
    expect(compile(q.ast).sql).toContain('"p"."views" > cast($1 as integer) - cast($2 as integer)');
  });

  test("a CASE of typed values beside a column has those values cast; an untyped one is left as it is", () => {
    const typedCase = caseNode([{ when: literalNode(true), result: typed(1) }], untyped(2));
    expect(compile(selecting(binary("add", col("u", "age"), typedCase))).sql).toBe(
      'select "u"."age" + case when true then cast($1 as integer) else $2 end as "c0" from "users" as "u"',
    );
    // Arithmetic takes no type from a column; only a comparison does (status note 10,
    // Known gaps).
    expect(compile(selecting(binary("add", col("u", "age"), untypedCase(1, 2)))).sql).toBe(
      'select "u"."age" + case when true then $1 else $2 end as "c0" from "users" as "u"',
    );
  });

  test("unary minus of a CASE: typed values are cast and type the rest", () => {
    const typedCase = caseNode([{ when: literalNode(true), result: typed(1) }], untyped(2));
    expect(compile(selecting(unaryNode("neg", typedCase))).sql).toBe(
      'select -case when true then cast($1 as integer) else $2 end as "c0" from "users" as "u"',
    );
  });
});

describe("a CASE or coalesce of bound values compared with an operand that has a type", () => {
  test("a coalesce with a typed argument has it cast, beside a column", () => {
    const mixed = fnNode("coalesce", [untyped(null), typed(5)]);
    expect(compile(where(binary("eq", col("u", "age"), mixed))).sql).toContain(
      'where "u"."age" = coalesce($1, cast($2 as integer))',
    );
  });

  test("an untyped CASE compared with an expression that is not a column is left as it is", () => {
    const plusOne = binary("add", col("u", "age"), typed(1));
    expect(compile(where(binary("eq", plusOne, untypedCase(1, 2)))).sql).toContain(
      'where "u"."age" + $1 = case when true then $2 else $3 end',
    );
    const ranged = { kind: "between", expr: untypedCase(1), low: plusOne, high: typed(9) } as const;
    expect(compile(where(ranged)).sql).toContain(
      'where case when true then $1 end between "u"."age" + $2 and $3',
    );
  });

  test("a column of a source with no schema gives no type", () => {
    const values = rebuild(bareQuery({ kind: "values", columns: ["a"], rows: [[typed(1)]], alias: "v" }), {
      wheres: [{ kind: "bool", op: "and", expr: binary("eq", col("v", "a"), untypedCase(1)) }],
      select: selectOne(col("v", "a"), integer),
    });
    expect(compile(values).sql).toContain('where "v"."a" = case when true then $2 end');
  });

  test("a column node whose column is not its field's gives no type", () => {
    expect(compile(where(binary("eq", col("u", "other", "age"), untypedCase(1)))).sql).toContain(
      'where "u"."other" = case when true then $1 end',
    );
  });

  test("a column of an unknown binding is refused, as anywhere", () => {
    expect(() => compile(where(binary("eq", col("x", "age"), untypedCase(1))))).toThrow(
      'refers to the binding "x", which the query does not have',
    );
  });

  test("in an array expression that is not an array column, a CASE takes no element type", () => {
    const inAge = binary("in", untypedCase(1), col("u", "age"));
    expect(compile(where(inAge)).sql).toContain('where case when true then $1 end = any("u"."age")');
    const both = binary("in", untypedCase(1), fnNode("coalesce", [untyped([1]), untyped([2])]));
    expect(compile(where(both)).sql).toContain("where case when true then $1 end = any(coalesce($2, $3))");
  });

  test("a column of a subquery types a CASE compared with it there", () => {
    const q = from(User, "u")
      .where(({ u }) =>
        u.id.in(
          from(Post, "p")
            .where(({ p }) => p.views.eq(caseWhen(p.published, 1).else(0)))
            .select(({ p }) => p.authorId),
        ),
      )
      .select(({ u }) => u.id);
    expect(compile(q.ast).sql).toContain(
      '"p"."views" = cast(case when "p"."published" then $1 else $2 end as integer)',
    );
  });

  test("a subquery source of whole rows types a CASE; one of values does not yet (review round 1)", () => {
    const rows = from(subquery(from(Post, "p")), "s")
      .where(({ s }) => s.authorId.eq(caseWhen(lit(true), 1)))
      .select(({ s }) => s.id);
    expect(compile(rows.ast).sql).toContain(
      'where "s"."author_id" = cast(case when true then $1 end as bigint)',
    );
    const values = from(subquery(from(Post, "p").select(({ p }) => ({ k: p.authorId }))), "s")
      .where(({ s }) => s.k.eq(caseWhen(lit(true), 1)))
      .select(({ s }) => s.k);
    expect(compile(values.ast).sql).toContain('where "s"."k" = case when true then $1 end');
  });
});

describe("a CASE or coalesce with no typed value beside a typed bound value (review round 1)", () => {
  test("takes that value's type, in arithmetic and comparisons", () => {
    expect(
      compile(selecting(binary("add", typed(1), fnNode("coalesce", [untyped(null), untyped(2)])))).sql,
    ).toBe('select cast($1 as integer) + cast(coalesce($2, $3) as integer) as "c0" from "users" as "u"');
    expect(compile(where(binary("eq", untypedCase(1), typed(1)))).sql).toContain(
      "where cast(case when true then $1 end as integer) = cast($2 as integer)",
    );
  });

  test("a typed value inside a CASE types the other side's untyped CASE", () => {
    const typedCase = caseNode([{ when: literalNode(true), result: typed(1) }], undefined);
    expect(compile(selecting(binary("add", typedCase, untypedCase(2)))).sql).toBe(
      'select case when true then cast($1 as integer) end + cast(case when true then $2 end as integer) as "c0" from "users" as "u"',
    );
    const typedCoalesce = fnNode("coalesce", [untyped(null), typed(1)]);
    expect(compile(where(binary("eq", untypedCase(2), typedCoalesce))).sql).toContain(
      "where cast(case when true then $1 end as integer) = coalesce($2, cast($3 as integer))",
    );
  });

  test("between and in a typed list", () => {
    const ranged = { kind: "between", expr: typed(1), low: untypedCase(0), high: untypedCase(5) } as const;
    expect(compile(where(ranged)).sql).toContain(
      "where cast($1 as integer) between cast(case when true then $2 end as integer) and cast(case when true then $3 end as integer)",
    );
    const inList = binary("in", untypedCase(1), {
      kind: "list",
      value: [1, 2],
      type: integer,
      redact: false,
    });
    expect(compile(where(inList)).sql).toContain(
      "where cast(case when true then $1 end as integer) = any($2)",
    );
  });

  test("through the builder", () => {
    const q = from(User, "u")
      .where(() => val(1, t.integer()).eq(coalesce(val(null as number | null), val(1))))
      .select(({ u }) => u.id);
    expect(compile(q.ast).sql).toContain("where cast($1 as integer) = cast(coalesce($2, $3) as integer)");
  });
});

describe("a CASE or coalesce with no typed value nested in one that has a typed value (review round 2)", () => {
  test("a coalesce argument takes the first typed argument's type, in a select", () => {
    expect(compile(selecting(fnNode("coalesce", [untypedCase(1), typed(5)]))).sql).toBe(
      'select coalesce(cast(case when true then $1 end as integer), cast($2 as integer)) as "c0" from "users" as "u"',
    );
  });

  test("and compared with a column", () => {
    const right = fnNode("coalesce", [untypedCase(1), typed(5)]);
    expect(compile(where(binary("eq", col("u", "age"), right))).sql).toContain(
      'where "u"."age" = coalesce(cast(case when true then $1 end as integer), cast($2 as integer))',
    );
  });

  test("a CASE result takes the CASE's first typed value's type", () => {
    const typedCase = caseNode([{ when: literalNode(true), result: typed(1) }], untypedCase(2));
    expect(compile(selecting(typedCase)).sql).toBe(
      'select case when true then cast($1 as integer) else cast(case when true then $2 end as integer) end as "c0" from "users" as "u"',
    );
    const nestedCoalesce = caseNode(
      [{ when: literalNode(true), result: typed(1) }],
      fnNode("coalesce", [untyped(null), untyped(2)]),
    );
    expect(compile(selecting(nestedCoalesce)).sql).toBe(
      'select case when true then cast($1 as integer) else cast(coalesce($2, $3) as integer) end as "c0" from "users" as "u"',
    );
  });
});
