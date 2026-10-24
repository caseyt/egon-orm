// updateAll and deleteAll with joins: the joins become a FROM or USING list with their
// conditions in WHERE (Postgres, SQLite) or a join clause (MySQL). Every value is bound in
// the order the SQL reads it, wherever its clause is written.
import { Post, Tag } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { QueryAst, QueryOperation } from "../contracts/query.js";
import { from, t } from "../index.js";
import { binaryNode } from "../query/ast.js";
import { bindParams } from "./bind.js";
import { createCompiler } from "./compiler.js";
import { mysqlDialect, postgresDialect, type SqlDialect } from "./dialect.js";
import { col, rebuild, tableOf, typeOf, value } from "./sql-fixtures.js";

const INTEGER = typeOf(t.integer());
const int = (n: number) => value(n, INTEGER);

/**
 * posts p, joined with a subquery over tags that holds the value 1, on a condition that
 * holds 2; then with tags t on a condition that holds 3; where p.views > 4.
 */
function joined(updates: QueryAst["updates"]): QueryAst {
  const tagsOver = rebuild(from(Tag, "x").ast, {
    wheres: [{ kind: "bool", op: "and", expr: binaryNode("gt", col("x", "id"), int(1)) }],
  });
  return rebuild(from(Post, "p").ast, {
    joins: [
      {
        kind: "join",
        type: "inner",
        source: { kind: "subquerySource", query: tagsOver, alias: "s" },
        on: binaryNode("eq", col("s", "id"), binaryNode("add", col("p", "id"), int(2))),
      },
      {
        kind: "join",
        type: "inner",
        source: tableOf(Tag, "t"),
        on: binaryNode("eq", col("t", "id"), binaryNode("add", col("p", "id"), int(3))),
      },
    ],
    wheres: [{ kind: "bool", op: "and", expr: binaryNode("gt", col("p", "views"), int(4)) }],
    updates,
  });
}

const compiled = (dialect: SqlDialect, ast: QueryAst, operation: QueryOperation) => {
  const plan = createCompiler(dialect).compile(ast, operation, undefined);
  return { sql: plan.sql, bound: bindParams(plan.slots, ast.params) };
};

describe("writes with joins bind each value where the SQL reads it", () => {
  const set = [{ kind: "update" as const, field: "views", column: "views", value: int(0) }];

  test("deleteAll on Postgres: USING, the join conditions before the where", () => {
    const { sql, bound } = compiled(postgresDialect, joined([]), "deleteAll");
    expect(sql).toBe(
      'delete from "posts" as "p" using (select "x"."id" as "id", "x"."name" as "name" from "tags" as "x" where "x"."id" > $1) as "s", "tags" as "t" where "s"."id" = "p"."id" + cast($2 as integer) and "t"."id" = "p"."id" + cast($3 as integer) and "p"."views" > $4',
    );
    expect(bound).toEqual([1, 2, 3, 4]);
  });

  test("updateAll on Postgres: FROM, the set values first", () => {
    const { sql, bound } = compiled(postgresDialect, joined(set), "updateAll");
    expect(sql).toMatch(/^update "posts" as "p" set "views" = \$\d+ from \(select /);
    // The SQL reads the set value, then 1, 2, 3 and 4.
    const order = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    expect(order.map((n) => bound[n - 1])).toEqual([0, 1, 2, 3, 4]);
  });

  test("deleteAll on MySQL: delete p from … join …, conditions in the join clause", () => {
    const { sql, bound } = compiled(mysqlDialect, joined([]), "deleteAll");
    expect(sql).toBe(
      "delete `p` from `posts` as `p` inner join (select `x`.`id` as `id`, `x`.`name` as `name` from `tags` as `x` where `x`.`id` > ?) as `s` on `s`.`id` = `p`.`id` + ? inner join `tags` as `t` on `t`.`id` = `p`.`id` + ? where `p`.`views` > ?",
    );
    expect(bound).toEqual([1, 2, 3, 4]);
  });

  test("updateAll on MySQL: the join clause, then set p's columns", () => {
    const { sql, bound } = compiled(mysqlDialect, joined(set), "updateAll");
    expect(sql).toMatch(
      /^update `posts` as `p` inner join .* set `p`\.`views` = \? where `p`\.`views` > \?$/,
    );
    expect(bound).toEqual([1, 2, 3, 0, 4]);
  });
});
