// JSON paths on the databases that build the path as text from bound steps (MySQL and
// SQLite): named keys, keys that are not values, and the steps a key becomes.
import { User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { ExprNode, QueryAst } from "../contracts/query.js";
import { QueryError } from "../errors.js";
import { from, t } from "../index.js";
import { jsonPathNode, namedParamNode } from "../query/ast.js";
import { createCompiler } from "./compiler.js";
import { mysqlDialect, type SqlDialect, sqliteDialect } from "./dialect.js";
import { jsonPathStep } from "./emit.js";
import { col, rebuild, selectOne, typeOf, value } from "./sql-fixtures.js";

const TEXT = typeOf(t.string());

function selecting(expr: ExprNode): QueryAst {
  return rebuild(from(User, "u").ast, { select: selectOne(expr) });
}

const compile = (dialect: SqlDialect, path: readonly ExprNode[]) =>
  createCompiler(dialect).compile(
    selecting(jsonPathNode(col("u", "settings"), path, true)),
    "all",
    undefined,
  );

describe("a JSON path built from bound steps", () => {
  test("a named key is one placeholder of the path text, like a value key", () => {
    const keys = [namedParamNode("key", TEXT, false), value("theme")];
    expect(compile(sqliteDialect, keys).sql).toBe(
      `select "u"."settings" ->> ('$' || ? || ?) as "c0" from "users" as "u"`,
    );
    expect(compile(mysqlDialect, keys).sql).toBe(
      "select json_unquote(json_extract(`u`.`settings`, concat('$', ?, ?))) as `c0` from `users` as `u`",
    );
    expect(compile(sqliteDialect, keys).slots[0]).toMatchObject({ kind: "named", name: "key" });
  });

  test("refuses a named key without a name, and a key that is an expression", () => {
    for (const dialect of [sqliteDialect, mysqlDialect]) {
      expect(() => compile(dialect, [namedParamNode("", TEXT, false)])).toThrow(
        "A named parameter has no name.",
      );
      expect(() => compile(dialect, [col("u", "name")])).toThrow(
        `A key of a JSON path on ${dialect.name} must be a value (a string or a whole number), not an expression.`,
      );
    }
  });
});

describe("jsonPathStep", () => {
  test("a whole number from 0, as a number or a bigint, is an index", () => {
    expect(jsonPathStep(0)).toBe("[0]");
    expect(jsonPathStep(12)).toBe("[12]");
    expect(jsonPathStep(0n)).toBe("[0]");
    expect(jsonPathStep(9_007_199_254_740_993n)).toBe("[9007199254740993]");
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -1n, true, null, undefined, {}])(
    "refuses %s",
    (key) => {
      expect(() => jsonPathStep(key)).toThrow(QueryError);
      expect(() => jsonPathStep(key)).toThrow("A key of a JSON path is a string or a whole number from 0.");
    },
  );
});
