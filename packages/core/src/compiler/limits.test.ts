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

describe("set operations: grouping, and the branches SQLite reads from a subquery", () => {
  const a = from(User, "a")
    .where(({ a }) => a.id.gt(0))
    .select(({ a }) => a.id);
  const b = from(User, "b")
    .where(({ b }) => b.id.gt(0))
    .select(({ b }) => b.id);
  const c = from(User, "c")
    .where(({ c }) => c.id.gt(0))
    .select(({ c }) => c.id);
  const w = from(User, "w")
    .where(({ w }) => w.id.gt(0))
    .select(({ w }) => w.id);
  const branch = (alias: string) =>
    `select "${alias}"."id" as "c0" from "users" as "${alias}" where "${alias}"."id" > `;

  test("an INTERSECT after a UNION or an EXCEPT applies to the whole, so that whole is grouped", () => {
    expect(sql(postgresDialect, a.union(b).intersect(c))).toBe(
      `(${branch("a")}$1 union (${branch("b")}$2)) intersect (${branch("c")}$3)`,
    );
    expect(sql(postgresDialect, a.except(b).intersect(c))).toBe(
      `(${branch("a")}$1 except (${branch("b")}$2)) intersect (${branch("c")}$3)`,
    );
    expect(sql(postgresDialect, a.intersect(b).intersect(c))).toBe(
      `${branch("a")}$1 intersect (${branch("b")}$2) intersect (${branch("c")}$3)`,
    );
    expect(sql(postgresDialect, a.union(b).union(c))).toBe(
      `${branch("a")}$1 union (${branch("b")}$2) union (${branch("c")}$3)`,
    );
  });

  test("SQLite applies set operations left to right, without parentheses", () => {
    expect(sql(sqliteDialect, a.union(b).intersect(c))).toBe(
      `${branch("a")}? union ${branch("b")}? intersect ${branch("c")}?`,
    );
  });

  test("SQLite reads a branch with an order, an offset, a CTE or set operations of its own from a subquery", () => {
    const sub = (inner: string) => `${branch("a")}? union select * from (${inner})`;
    expect(sql(sqliteDialect, a.union(b.orderBy(({ b: x }) => x.id)))).toBe(
      sub(`${branch("b")}? order by "b"."id" asc`),
    );
    expect(sql(sqliteDialect, a.union(b.offset(1)))).toBe(sub(`${branch("b")}? limit -1 offset ?`));
    expect(sql(sqliteDialect, a.union(b.withCte("x", w)))).toBe(
      sub(`with "x" as (${branch("w")}?) ${branch("b")}?`),
    );
    expect(sql(sqliteDialect, a.union(b.union(c)))).toBe(sub(`${branch("b")}? union ${branch("c")}?`));
  });
});
