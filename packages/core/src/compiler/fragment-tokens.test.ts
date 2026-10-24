// A placeholder in a fragment stays a token of its own: next to a word character or `$`,
// `$1` would read as another placeholder (`$10`), part of an identifier (`a$1`) or a dollar
// quote (`$$1`). The emitter adds a space only where one is needed.
import { User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { ExprNode } from "../contracts/query.js";
import { from } from "../index.js";
import { fragmentNode, paramNode } from "../query/ast.js";
import { createCompiler } from "./compiler.js";
import { mysqlDialect, postgresDialect, type SqlDialect } from "./dialect.js";
import { col, rebuild, selectOne } from "./sql-fixtures.js";

const untyped = (n: number) => paramNode(n, undefined, false);

/** The SQL of `select <fragment> from users u`, the fragment's text only. */
function written(dialect: SqlDialect, strings: readonly string[], args: readonly ExprNode[]): string {
  const ast = rebuild(from(User, "u").ast, { select: selectOne(fragmentNode(strings, args)) });
  const sql = createCompiler(dialect).compile(ast, "all", undefined).sql;
  return sql.replace(/^select /, "").replace(/ as ["`]c0["`] from .*$/, "");
}

describe("placeholders in a fragment", () => {
  test("after a word character or $, a space comes first", () => {
    expect(written(postgresDialect, ["a", ""], [untyped(1)])).toBe("a $1");
    expect(written(postgresDialect, ["_", ""], [untyped(1)])).toBe("_ $1");
    expect(written(postgresDialect, ["9", ""], [untyped(1)])).toBe("9 $1");
    expect(written(postgresDialect, ["$", ""], [untyped(1)])).toBe("$ $1");
  });

  test("after punctuation, a space, or at the start, none is added", () => {
    expect(written(postgresDialect, ["f(", ")"], [untyped(1)])).toBe("f($1)");
    expect(written(postgresDialect, ["a ", " b"], [untyped(1)])).toBe("a $1 b");
    expect(written(postgresDialect, ["", "+1"], [untyped(1)])).toBe("$1+1");
  });

  test("before a word character, a placeholder that ends in a digit is followed by a space", () => {
    expect(written(postgresDialect, ["(", "x)"], [untyped(1)])).toBe("($1 x)");
    expect(written(postgresDialect, ["(", "0)"], [untyped(1)])).toBe("($1 0)");
    expect(written(postgresDialect, ["(", ")"], [untyped(1)])).toBe("($1)");
    expect(written(postgresDialect, ["(", ""], [untyped(1)])).toBe("($1");
  });

  test("the digits 0 and 9 at the end of a placeholder count as digits", () => {
    const ten = Array.from({ length: 10 }, (_, i) => untyped(i));
    // $9 is the ninth placeholder, $10 the tenth.
    const strings = ["(", ",", ",", ",", ",", ",", ",", ",", ",", "y,", "x)"];
    expect(written(postgresDialect, strings, ten)).toBe("($1,$2,$3,$4,$5,$6,$7,$8,$9 y,$10 x)");
  });

  test("a ? placeholder and a column need no space", () => {
    expect(written(mysqlDialect, ["a", "b"], [untyped(1)])).toBe("a?b");
    expect(written(postgresDialect, ["a", "b"], [col("u", "id")])).toBe('a"u"."id"b');
  });
});
