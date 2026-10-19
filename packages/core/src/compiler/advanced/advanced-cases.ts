// The expected output of the step 09 snapshot matrix (`advanced-queries.ts`), per dialect.
// Every statement was reviewed by hand and is executed on Postgres by `advanced.itest.ts`.
// Step 17 adds the MySQL and SQLite output next to `postgres`. Imported by tests only.
import type { ExpectedSql } from "../sql-fixtures.js";

/** How the cutoff date of the matrix is bound. */
const SINCE = new Date("2026-01-01T00:00:00.000Z");

/** The Postgres SQL and bound parameters of each query of `ADVANCED_QUERIES`, by name. */
export const POSTGRES: Readonly<Record<string, ExpectedSql>> = {
  "a subquery as the source exposes its select keys": {
    sql: "select \"c\".\"authorId\" as \"c0\", \"c\".\"n\" as \"c1\" from (select \"p\".\"author_id\" as \"authorId\", count(*) as \"n\" from \"posts\" as \"p\" where \"p\".\"created_at\" > $1 group by \"p\".\"author_id\") as \"c\" where \"c\".\"n\" > $2",
    params: [SINCE,5],
  },
  "a subquery joined to a table": {
    sql: "select \"u\".\"email\" as \"c0\", \"c\".\"n\" as \"c1\" from \"users\" as \"u\" inner join (select \"p\".\"author_id\" as \"authorId\", count(*) as \"n\" from \"posts\" as \"p\" where \"p\".\"created_at\" > $1 group by \"p\".\"author_id\") as \"c\" on \"c\".\"authorId\" = \"u\".\"id\"",
    params: [SINCE],
  },
  "a left-joined subquery": {
    sql: "select \"u\".\"id\" as \"c0\", \"c\".\"n\" as \"c1\" from \"users\" as \"u\" left join (select \"p\".\"author_id\" as \"authorId\", count(*) as \"n\" from \"posts\" as \"p\" where \"p\".\"created_at\" > $1 group by \"p\".\"author_id\") as \"c\" on \"c\".\"authorId\" = \"u\".\"id\"",
    params: [SINCE],
  },
  "a subquery of whole rows exposes the schema's columns": {
    sql: "select \"r\".\"id\" as \"c0\", \"r\".\"author_id\" as \"c1\", \"r\".\"title\" as \"c2\", \"r\".\"body\" as \"c3\", \"r\".\"published\" as \"c4\", \"r\".\"views\" as \"c5\", \"r\".\"tags\" as \"c6\", \"r\".\"published_at\" as \"c7\", \"r\".\"created_at\" as \"c8\", \"r\".\"updated_at\" as \"c9\" from (select \"p\".\"id\" as \"id\", \"p\".\"author_id\" as \"author_id\", \"p\".\"title\" as \"title\", \"p\".\"body\" as \"body\", \"p\".\"published\" as \"published\", \"p\".\"views\" as \"views\", \"p\".\"tags\" as \"tags\", \"p\".\"published_at\" as \"published_at\", \"p\".\"created_at\" as \"created_at\", \"p\".\"updated_at\" as \"updated_at\" from \"posts\" as \"p\" where \"p\".\"published\") as \"r\" where \"r\".\"views\" > $1",
    params: [10],
  },
  "a subquery's selectedAs name is its column": {
    sql: "select \"s\".\"total_views\" as \"c0\" from (select \"p\".\"author_id\" as \"authorId\", sum(\"p\".\"views\") as \"total_views\" from \"posts\" as \"p\" group by \"p\".\"author_id\") as \"s\"",
    params: [],
  },
  "in with a subquery": {
    sql: "select \"u\".\"id\" as \"c0\" from \"users\" as \"u\" where \"u\".\"id\" in (select \"p\".\"author_id\" as \"c0\" from \"posts\" as \"p\")",
    params: [],
  },
  "exists referring to the outer binding with outerRef": {
    sql: "select \"u\".\"id\" as \"c0\" from \"users\" as \"u\" where exists (select 1 from \"posts\" as \"p\" where \"p\".\"author_id\" = \"u\".\"id\")",
    params: [],
  },
  "not exists referring to the outer binding directly": {
    sql: "select \"u\".\"id\" as \"c0\" from \"users\" as \"u\" where not exists (select 1 from \"posts\" as \"p\" where \"p\".\"author_id\" = \"u\".\"id\")",
    params: [],
  },
  "a scalar subquery in the select": {
    sql: "select \"u\".\"id\" as \"c0\", (select count(*) as \"c0\" from \"posts\" as \"p\" where \"p\".\"author_id\" = \"u\".\"id\") as \"c1\" from \"users\" as \"u\"",
    params: [],
  },
  "named parameters inside and outside a subquery": {
    sql: "select \"s\".\"id\" as \"c0\" from (select \"p\".\"id\" as \"id\", \"p\".\"views\" as \"views\" from \"posts\" as \"p\" where \"p\".\"views\" > $1) as \"s\" where \"s\".\"id\" < $2",
    params: [1,100],
  },
  "a recursive CTE": {
    sql: "with recursive \"tree\" as (select \"c\".\"id\" as \"id\", \"c\".\"parent_id\" as \"parent_id\", \"c\".\"name\" as \"name\" from \"categories\" as \"c\" where \"c\".\"parent_id\" is null union all (select \"c\".\"id\" as \"id\", \"c\".\"parent_id\" as \"parent_id\", \"c\".\"name\" as \"name\" from \"categories\" as \"c\" inner join \"tree\" as \"t\" on \"c\".\"parent_id\" = \"t\".\"id\")) select \"t\".\"id\" as \"c0\", \"t\".\"parent_id\" as \"c1\", \"t\".\"name\" as \"c2\" from \"tree\" as \"t\"",
    params: [],
  },
  "a CTE typed by its query, not materialized": {
    sql: "with \"recent\" as not materialized (select \"p\".\"author_id\" as \"authorId\", count(*) as \"n\" from \"posts\" as \"p\" where \"p\".\"created_at\" > $1 group by \"p\".\"author_id\") select \"r\".\"authorId\" as \"c0\", \"r\".\"n\" as \"c1\" from \"recent\" as \"r\" where \"r\".\"n\" > $2",
    params: [SINCE,2],
  },
  "a materialized CTE joined to a table": {
    sql: "with \"recent\" as materialized (select \"p\".\"author_id\" as \"authorId\", count(*) as \"n\" from \"posts\" as \"p\" where \"p\".\"created_at\" > $1 group by \"p\".\"author_id\") select \"u\".\"email\" as \"c0\", \"r\".\"n\" as \"c1\" from \"users\" as \"u\" inner join \"recent\" as \"r\" on \"r\".\"authorId\" = \"u\".\"id\"",
    params: [SINCE],
  },
  "union": {
    sql: "select \"u\".\"email\" as \"c0\" from \"users\" as \"u\" union (select \"p\".\"title\" as \"c0\" from \"posts\" as \"p\")",
    params: [],
  },
  "union all": {
    sql: "select \"u\".\"email\" as \"c0\" from \"users\" as \"u\" union all (select \"p\".\"title\" as \"c0\" from \"posts\" as \"p\")",
    params: [],
  },
  "intersect": {
    sql: "select \"u\".\"email\" as \"c0\" from \"users\" as \"u\" intersect (select \"p\".\"title\" as \"c0\" from \"posts\" as \"p\")",
    params: [],
  },
  "intersect all": {
    sql: "select \"u\".\"email\" as \"c0\" from \"users\" as \"u\" intersect all (select \"p\".\"title\" as \"c0\" from \"posts\" as \"p\")",
    params: [],
  },
  "except": {
    sql: "select \"u\".\"email\" as \"c0\" from \"users\" as \"u\" except (select \"p\".\"title\" as \"c0\" from \"posts\" as \"p\")",
    params: [],
  },
  "except all": {
    sql: "select \"u\".\"email\" as \"c0\" from \"users\" as \"u\" except all (select \"p\".\"title\" as \"c0\" from \"posts\" as \"p\")",
    params: [],
  },
  "except with orderBy and limit on the combined rows": {
    sql: "select \"u\".\"id\" as \"c0\" from \"users\" as \"u\" except (select \"p\".\"author_id\" as \"c0\" from \"posts\" as \"p\") order by \"c0\" asc limit $1",
    params: [5],
  },
  "intersect after union groups what precedes it": {
    sql: "(select \"u\".\"email\" as \"c0\" from \"users\" as \"u\" union (select \"p\".\"title\" as \"c0\" from \"posts\" as \"p\")) intersect (select \"u\".\"email\" as \"c0\" from \"users\" as \"u\")",
    params: [],
  },
  "a set operation of whole rows": {
    sql: "select \"p\".\"id\" as \"c0\", \"p\".\"author_id\" as \"c1\", \"p\".\"title\" as \"c2\", \"p\".\"body\" as \"c3\", \"p\".\"published\" as \"c4\", \"p\".\"views\" as \"c5\", \"p\".\"tags\" as \"c6\", \"p\".\"published_at\" as \"c7\", \"p\".\"created_at\" as \"c8\", \"p\".\"updated_at\" as \"c9\" from \"posts\" as \"p\" where \"p\".\"published\" union (select \"q\".\"id\" as \"c0\", \"q\".\"author_id\" as \"c1\", \"q\".\"title\" as \"c2\", \"q\".\"body\" as \"c3\", \"q\".\"published\" as \"c4\", \"q\".\"views\" as \"c5\", \"q\".\"tags\" as \"c6\", \"q\".\"published_at\" as \"c7\", \"q\".\"created_at\" as \"c8\", \"q\".\"updated_at\" as \"c9\" from \"posts\" as \"q\" where \"q\".\"views\" > $1)",
    params: [100],
  },
  "a named window, an inline window and a frame": {
    sql: "select \"p\".\"id\" as \"c0\", row_number() over \"byAuthor\" as \"c1\", sum(\"p\".\"views\") over (partition by \"p\".\"author_id\") as \"c2\", sum(\"p\".\"views\") over (order by \"p\".\"id\" asc rows between unbounded preceding and current row) as \"c3\" from \"posts\" as \"p\" window \"byAuthor\" as (partition by \"p\".\"author_id\" order by \"p\".\"created_at\" desc)",
    params: [],
  },
  "every window function": {
    sql: "select row_number() over \"w\" as \"c0\", rank() over \"w\" as \"c1\", dense_rank() over \"w\" as \"c2\", percent_rank() over \"w\" as \"c3\", cume_dist() over \"w\" as \"c4\", ntile($1) over \"w\" as \"c5\", lag(\"p\".\"views\") over \"w\" as \"c6\", lead(\"p\".\"views\", $2) over \"w\" as \"c7\", lag(\"p\".\"views\", $3, $4) over \"w\" as \"c8\", first_value(\"p\".\"title\") over \"w\" as \"c9\", last_value(\"p\".\"title\") over \"w\" as \"c10\", nth_value(\"p\".\"title\", $5) over \"w\" as \"c11\" from \"posts\" as \"p\" window \"w\" as (order by \"p\".\"id\" asc)",
    params: [4,2,1,0,2],
  },
  "a window partitioned by an expression with a named parameter": {
    sql: "select \"p\".\"id\" as \"c0\", max(\"p\".\"views\") over \"bucket\" as \"c1\" from \"posts\" as \"p\" window \"bucket\" as (partition by \"p\".\"views\" % $1)",
    params: [10],
  },
  "ordering by a window function": {
    sql: "select \"p\".\"id\" as \"c0\" from \"posts\" as \"p\" order by rank() over (order by \"p\".\"views\" desc) asc",
    params: [],
  },
  "an update from an object": {
    sql: "update \"posts\" as \"p\" set \"published\" = $1 where \"p\".\"author_id\" = $2",
    params: [true,1],
  },
  "an update from expressions, returning ids": {
    sql: "update \"posts\" as \"p\" set \"title\" = \"p\".\"title\" || $1, \"views\" = \"p\".\"views\" + $2, \"tags\" = array_append(\"p\".\"tags\", $3) where \"p\".\"author_id\" = $4 returning \"p\".\"id\" as \"c0\"",
    params: ["!",1,"hot",1],
  },
  "an update with a join becomes UPDATE … FROM": {
    sql: "update \"posts\" as \"p\" set \"published\" = $1, \"tags\" = $2 from \"users\" as \"u\" where \"p\".\"author_id\" = \"u\".\"id\" and \"u\".\"role\" = $3",
    params: [true,null,"admin"],
  },
  "set twice: the later value wins": {
    sql: "update \"posts\" as \"p\" set \"views\" = $1, \"title\" = $2",
    params: [2,"a"],
  },
  "a delete with a join becomes DELETE … USING, returning rows": {
    sql: "delete from \"comments\" as \"c\" using \"posts\" as \"p\" where \"c\".\"post_id\" = \"p\".\"id\" and not \"p\".\"published\" returning \"c\".\"id\" as \"c0\", \"c\".\"post_id\" as \"c1\"",
    params: [],
  },
  "a delete without a returning": {
    sql: "delete from \"comments\" as \"c\" where \"c\".\"author_id\" is null",
    params: [],
  },
  "row comparison for keyset pagination": {
    sql: "select \"p\".\"id\" as \"c0\" from \"posts\" as \"p\" where (\"p\".\"created_at\", \"p\".\"id\") < ($1, $2) order by \"p\".\"created_at\" desc, \"p\".\"id\" desc limit $3",
    params: [SINCE,10,20],
  },
  "selectedAs in the select, referred to in groupBy and orderBy": {
    sql: "select \"p\".\"author_id\" as \"author\", sum(\"p\".\"views\") as \"total\" from \"posts\" as \"p\" group by \"author\" order by \"total\" desc",
    params: [],
  },
  "dynamic conditions folded from dynamic.true()": {
    sql: "select \"u\".\"id\" as \"c0\" from \"users\" as \"u\" where true and \"u\".\"age\" >= $1 and \"u\".\"role\" = $2",
    params: [18,"member"],
  },
  "a dynamic condition with a named parameter, and a column chosen at run time": {
    sql: "select \"p\".\"id\" as \"c0\" from \"posts\" as \"p\" where \"p\".\"views\" >= $1 order by \"p\".\"title\" asc",
    params: [5],
  },
  "a prepared query": {
    sql: "select \"u\".\"id\" as \"c0\", \"u\".\"email\" as \"c1\", \"u\".\"name\" as \"c2\", \"u\".\"age\" as \"c3\", \"u\".\"role\" as \"c4\", \"u\".\"password_hash\" as \"c5\", \"u\".\"settings\" as \"c6\", \"u\".\"lock_version\" as \"c7\", \"u\".\"created_at\" as \"c8\", \"u\".\"updated_at\" as \"c9\" from \"users\" as \"u\" where \"u\".\"email\" = $1 limit $2",
    params: ["ann@example.com",1],
  },
};
