// Two forms the databases write differently: an OFFSET without a LIMIT (MySQL and SQLite
// need a LIMIT before an OFFSET), and the operand of a set operation that has clauses of
// its own (SQLite takes no parentheses there).
import { User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { QueryAst } from "../contracts/query.js";
import { from } from "../index.js";
import { createCompiler } from "./compiler.js";
import { mysqlDialect, postgresDialect, type SqlDialect, sqliteDialect } from "./dialect.js";

const sql = (dialect: SqlDialect, query: { readonly ast: QueryAst }) =>
  createCompiler(dialect).compile(query.ast, "all", undefined).sql;

describe("an offset without a limit", () => {
  const query = from(User, "u")
    .offset(5)
    .select(({ u }) => u.id);

  test("is written with the largest limit where a limit must come first", () => {
    expect(sql(postgresDialect, query)).toBe('select "u"."id" as "c0" from "users" as "u" offset $1');
    expect(sql(sqliteDialect, query)).toBe('select "u"."id" as "c0" from "users" as "u" limit -1 offset ?');
    expect(sql(mysqlDialect, query)).toBe(
      "select `u`.`id` as `c0` from `users` as `u` limit 18446744073709551615 offset ?",
    );
  });

  test("with a limit, only the limit given is written", () => {
    const limited = from(User, "u")
      .limit(2)
      .offset(5)
      .select(({ u }) => u.id);
    expect(sql(sqliteDialect, limited)).toBe('select "u"."id" as "c0" from "users" as "u" limit ? offset ?');
    expect(sql(mysqlDialect, limited)).toBe("select `u`.`id` as `c0` from `users` as `u` limit ? offset ?");
  });
});

describe("a set operation whose second query has a limit of its own", () => {
  const query = from(User, "u")
    .select(({ u }) => u.id)
    .union(
      from(User, "v")
        .limit(1)
        .select(({ v }) => v.id),
    );

  test("is read from a subquery on SQLite and parenthesized elsewhere", () => {
    expect(sql(sqliteDialect, query)).toBe(
      'select "u"."id" as "c0" from "users" as "u" union select * from (select "v"."id" as "c0" from "users" as "v" limit ?)',
    );
    expect(sql(postgresDialect, query)).toBe(
      'select "u"."id" as "c0" from "users" as "u" union (select "v"."id" as "c0" from "users" as "v" limit $1)',
    );
  });
});
