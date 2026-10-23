// How where/orWhere chains and and/or nodes are written, and the ORDER BY of a combined
// query, which names output columns and skips the values of its expressions.
import { User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { ExprNode, QueryAst } from "../contracts/query.js";
import { from, t, val } from "../index.js";
import { naryNode, orderNode } from "../query/ast.js";
import { bindParams } from "./bind.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { col, rebuild, selectOne, typeOf, value } from "./sql-fixtures.js";

const sql = (ast: QueryAst) => createCompiler(postgresDialect).compile(ast, "all", undefined).sql;
const where = (q: { readonly ast: QueryAst }) => sql(q.ast).replace(/^.* where /, "");

describe("where and orWhere chains", () => {
  const users = from(User, "u").select(({ u }) => u.id);

  test("a chain of one operator is one flat list", () => {
    expect(
      where(
        users
          .where(({ u }) => u.age.isNull())
          .where(({ u }) => u.name.isNull())
          .where(({ u }) => u.email.isNull()),
      ),
    ).toBe('"u"."age" is null and "u"."name" is null and "u"."email" is null');
    expect(
      where(
        users
          .where(({ u }) => u.age.isNull())
          .orWhere(({ u }) => u.name.isNull())
          .orWhere(({ u }) => u.email.isNull()),
      ),
    ).toBe('"u"."age" is null or "u"."name" is null or "u"."email" is null');
  });

  test("a change of operator groups what came before", () => {
    expect(
      where(
        users
          .where(({ u }) => u.age.isNull())
          .where(({ u }) => u.name.isNull())
          .orWhere(({ u }) => u.email.isNull()),
      ),
    ).toBe('("u"."age" is null and "u"."name" is null) or "u"."email" is null');
    expect(
      where(
        users
          .where(({ u }) => u.age.isNull())
          .orWhere(({ u }) => u.name.isNull())
          .where(({ u }) => u.email.isNull()),
      ),
    ).toBe('("u"."age" is null or "u"."name" is null) and "u"."email" is null');
  });
});

describe("and and or nodes", () => {
  const isNull = (column: string): ExprNode => ({ kind: "unary", op: "isNull", operand: col("u", column) });
  const selecting = (node: ExprNode) =>
    sql(rebuild(from(User, "u").ast, { select: selectOne(node) })).replace(/^select | as "c0" from .*$/g, "");

  test("one argument is written as it is; an and inside an and needs no parentheses", () => {
    const either = naryNode("or", [isNull("a"), isNull("b")]);
    expect(selecting(naryNode("and", [either]))).toBe('"u"."a" is null or "u"."b" is null');
    expect(selecting(naryNode("and", [naryNode("and", [isNull("a"), isNull("b")]), isNull("c")]))).toBe(
      '"u"."a" is null and "u"."b" is null and "u"."c" is null',
    );
    expect(selecting(naryNode("or", [naryNode("and", [isNull("a"), isNull("b")]), isNull("c")]))).toBe(
      '("u"."a" is null and "u"."b" is null) or "u"."c" is null',
    );
  });
});

describe("the ORDER BY of a combined query", () => {
  const branch = (n: number) =>
    from(User, "u")
      .where(({ u }) => u.id.gt(n))
      .select(({ u }) => ({ older: u.age.add(val(n, t.integer())) })).ast;
  const selected = (ast: QueryAst): ExprNode => {
    const shape = ast.select?.shape;
    if (shape?.kind !== "object" || shape.values[0]?.kind !== "expr") throw new Error("not an object select");
    return shape.values[0].expr;
  };
  const combined = (order: ExprNode) =>
    rebuild(branch(1), {
      combinations: [{ kind: "combination", op: "union", all: false, query: branch(2) }],
      orderBys: [orderNode(order, "asc", undefined)],
      limit: value(5, typeOf(t.integer())),
    });

  test("names the output column, matched by structure, and skips the values of its expression", () => {
    const expr = selected(branch(1));
    if (expr.kind !== "binary") throw new Error("not arithmetic");
    // The selected expression with another value: the same structure, so the same column.
    const other: ExprNode = {
      ...expr,
      right: { kind: "param", value: 99, type: typeOf(t.integer()), redact: false },
    };
    for (const order of [expr, other]) {
      const ast = combined(order);
      const plan = createCompiler(postgresDialect).compile(ast, "all", undefined);
      expect(plan.sql).toMatch(/ order by "c0" asc limit \$(\d+)$/);
      const bound = bindParams(plan.slots, ast.params);
      expect(bound).not.toContain(99);
      const limit = Number(/limit \$(\d+)$/.exec(plan.sql)?.[1]);
      expect(bound[limit - 1]).toBe(5);
    }
  });

  test("refuses an expression the query does not select", () => {
    expect(() => sql(combined(col("u", "email")))).toThrow("can only use expressions the query selects");
  });
});
