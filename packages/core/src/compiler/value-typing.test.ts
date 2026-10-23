// Bound values the SQL gives no type: which ones are cast, and to what. A typed value is
// cast to its type and types the values beside it; an untyped CASE or coalesce beside it
// takes the first typed value's type, wherever that value sits (a later branch, the ELSE,
// a later argument).
import { User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { ExprNode } from "../contracts/query.js";
import { from, t } from "../index.js";
import {
  betweenNode,
  binaryNode,
  caseNode,
  fnNode,
  fragmentNode,
  literalNode,
  namedParamNode,
  paramNode,
  tupleNode,
} from "../query/ast.js";
import { createCompiler } from "./compiler.js";
import { mysqlDialect, postgresDialect, type SqlDialect, sqliteDialect } from "./dialect.js";
import { col, rebuild, selectOne, typeOf } from "./sql-fixtures.js";

const INT = typeOf(t.integer());
const typed = (n: number) => paramNode(n, INT, false);
const untyped = (n: number) => paramNode(n, undefined, false);

const selected = (dialect: SqlDialect, node: ExprNode) =>
  createCompiler(dialect)
    .compile(rebuild(from(User, "u").ast, { select: selectOne(node) }), "all", undefined)
    .sql.replace(/^select /, "")
    .replace(/ as ["`]c0["`] from .*$/, "");
const where = (node: ExprNode) =>
  createCompiler(postgresDialect)
    .compile(
      rebuild(from(User, "u").ast, {
        wheres: [{ kind: "bool", op: "and", expr: node }],
        select: selectOne(col("u", "id")),
      }),
      "all",
      undefined,
    )
    .sql.replace(/^.* where /, "");

describe("bound values without a SQL type", () => {
  test("a CASE whose ELSE is typed, and a coalesce whose second argument is typed, type the other side", () => {
    const elseTyped = caseNode([{ when: literalNode(true), result: untyped(1) }], typed(2));
    const coalesceTyped = fnNode("coalesce", [untyped(1), typed(2)]);
    expect(where(binaryNode("eq", elseTyped, untyped(3)))).toBe(
      "case when true then $1 else cast($2 as integer) end = $3",
    );
    expect(where(binaryNode("eq", coalesceTyped, untyped(3)))).toBe("coalesce($1, cast($2 as integer)) = $3");
    // An untyped coalesce or CASE on the other side is cast to that type.
    expect(where(binaryNode("eq", elseTyped, fnNode("coalesce", [untyped(3), untyped(4)])))).toBe(
      "case when true then $1 else cast($2 as integer) end = cast(coalesce($3, $4) as integer)",
    );
    expect(
      where(
        binaryNode(
          "eq",
          coalesceTyped,
          caseNode([{ when: literalNode(true), result: untyped(3) }], untyped(4)),
        ),
      ),
    ).toBe("coalesce($1, cast($2 as integer)) = cast(case when true then $3 else $4 end as integer)");
  });

  test("a BETWEEN of bound values casts the typed one, whichever it is", () => {
    expect(where(betweenNode(typed(5), untyped(1), untyped(9)))).toBe(
      "cast($1 as integer) between $2 and $3",
    );
    expect(where(betweenNode(untyped(5), typed(1), untyped(9)))).toBe(
      "$1 between cast($2 as integer) and $3",
    );
    expect(where(betweenNode(untyped(5), untyped(1), typed(9)))).toBe(
      "$1 between $2 and cast($3 as integer)",
    );
  });

  test("in a fragment, a typed value, positional or named, is cast; an untyped one is not", () => {
    expect(selected(postgresDialect, fragmentNode(["f(", ")"], [typed(1)]))).toBe("f(cast($1 as integer))");
    expect(selected(postgresDialect, fragmentNode(["f(", ")"], [namedParamNode("n", INT, false)]))).toBe(
      "f(cast($1 as integer))",
    );
    expect(
      selected(postgresDialect, fragmentNode(["f(", ")"], [namedParamNode("n", undefined, false)])),
    ).toBe("f($1)");
  });
});

describe("forms that differ by database", () => {
  test("a tuple of one item is row(x) on Postgres and (x) elsewhere", () => {
    const one = tupleNode([col("u", "id")]);
    expect(selected(postgresDialect, one)).toBe('row("u"."id")');
    expect(selected(mysqlDialect, one)).toBe("(`u`.`id`)");
    expect(selected(sqliteDialect, one)).toBe('("u"."id")');
  });

  test("a literal limit is accepted where limits take only values (MySQL)", () => {
    const ast = rebuild(from(User, "u").ast, { limit: literalNode(5), select: selectOne(col("u", "id")) });
    expect(createCompiler(mysqlDialect).compile(ast, "all", undefined).sql).toBe(
      "select `u`.`id` as `c0` from `users` as `u` limit 5",
    );
  });

  test("now is the dialect's fixed text only when called without arguments", () => {
    expect(selected(mysqlDialect, fnNode("now", []))).toBe("current_timestamp(6)");
    expect(selected(mysqlDialect, fnNode("now", [col("u", "id")]))).toBe("now(`u`.`id`)");
  });
});
