// The SQLite output of every case of the SQL snapshot matrices (`sql-cases.ts`), by area and
// case name: the statement and its bound parameters, or the QueryError's message where SQLite
// lacks a feature the case needs. Every statement is executed on SQLite by the dialect
// package's `compiler.itest.ts`. Imported by tests only.
import type { DialectTable } from "./sql-fixtures.js";

/** How the cutoff date of the matrices is bound. */
const SINCE = new Date("2026-01-01T00:00:00.000Z");

export const SQLITE_CASES: DialectTable = {
  select: {
    "a query without a select returns the root's persisted columns": {
      sql: 'select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "users" as "u"',
      params: [],
    },
    "one selected expression": { sql: 'select "u"."email" as "c0" from "users" as "u"', params: [] },
    "an object select, with a constant that is not sent": {
      sql: 'select "u"."id" as "c0" from "users" as "u"',
      params: [],
    },
    "an array select": {
      sql: 'select "u"."id" as "c0", "u"."email" as "c1" from "users" as "u"',
      params: [],
    },
    "a whole binding inside an object select": {
      sql: 'select "p"."title" as "c0", "a"."id" as "c1", "a"."email" as "c2", "a"."name" as "c3", "a"."age" as "c4", "a"."role" as "c5", "a"."password_hash" as "c6", "a"."settings" as "c7", "a"."lock_version" as "c8", "a"."created_at" as "c9", "a"."updated_at" as "c10" from "posts" as "p" inner join "users" as "a" on "a"."id" = "p"."author_id"',
      params: [],
    },
    "a whole left-joined binding": {
      sql: 'select "u"."id" as "c0", "pr"."id" as "c1", "pr"."user_id" as "c2", "pr"."bio" as "c3", "pr"."avatar_url" as "c4" from "users" as "u" left join "profiles" as "pr" on "pr"."user_id" = "u"."id"',
      params: [],
    },
    "selected values are cast to their type; an untyped one to text": {
      sql: 'select "u"."id" as "c0", cast(? as text) as "c1", cast(? as integer) as "c2", cast(? as text) as "c3" from "users" as "u"',
      params: ["member", 5, SINCE],
    },
    "a selected CASE casts its result values": {
      sql: 'select case when "u"."age" < ? then cast(? as text) else cast(? as text) end as "c0" from "users" as "u"',
      params: [18, "minor", "adult"],
    },
    "literals are written into the SQL": {
      sql: 'select 1 as "c0", -0.5 as "c1", true as "c2", null as "c3" from "users" as "u"',
      params: [],
    },
    distinct: { sql: 'select distinct "u"."role" as "c0" from "users" as "u"', params: [] },
    "distinct on": { error: "DISTINCT ON is not supported by sqlite." },
    "selectMerge adds keys to an object select": {
      sql: 'select "u"."id" as "c0", "u"."email" as "c1" from "users" as "u"',
      params: [],
    },
    "a selected expression with a name of its own": {
      sql: 'select "u"."age" as "total" from "users" as "u" order by "total" desc',
      params: [],
    },
    "a schema without a primary key": {
      sql: 'select "e"."name" as "c0", "e"."payload" as "c1" from "events" as "e"',
      params: [],
    },
    "a preload is listed on the root row; a join preload adds its columns": {
      sql: 'select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9", "p"."id" as "c10", "p"."author_id" as "c11", "p"."title" as "c12", "p"."body" as "c13", "p"."published" as "c14", "p"."views" as "c15", "p"."tags" as "c16", "p"."published_at" as "c17", "p"."created_at" as "c18", "p"."updated_at" as "c19" from "users" as "u" inner join "posts" as "p" on "p"."author_id" = "u"."id"',
      params: [],
    },
  },
  joins: {
    "inner join": {
      sql: 'select "u"."id" as "c0", "p"."id" as "c1" from "users" as "u" inner join "posts" as "p" on "p"."author_id" = "u"."id"',
      params: [],
    },
    "left join": {
      sql: 'select "u"."id" as "c0", "p"."id" as "c1" from "users" as "u" left join "posts" as "p" on "p"."author_id" = "u"."id"',
      params: [],
    },
    "right join": {
      sql: 'select "u"."id" as "c0", "p"."id" as "c1" from "users" as "u" right join "posts" as "p" on "p"."author_id" = "u"."id"',
      params: [],
    },
    "full join": {
      sql: 'select "u"."id" as "c0", "p"."id" as "c1" from "users" as "u" full join "posts" as "p" on "p"."author_id" = "u"."id"',
      params: [],
    },
    "cross join": {
      sql: 'select "u"."id" as "c0", "tg"."id" as "c1" from "users" as "u" cross join "tags" as "tg"',
      params: [],
    },
    "joinAssoc through belongsTo": {
      sql: 'select "c"."id" as "c0", "p"."title" as "c1" from "comments" as "c" inner join "posts" as "p" on "p"."id" = "c"."post_id"',
      params: [],
    },
    "joinAssoc through manyToMany with a join table": {
      sql: 'select "p"."id" as "c0", "tg"."name" as "c1" from "posts" as "p" inner join "posts_tags" as "$tg_join" on "$tg_join"."post_id" = "p"."id" inner join "tags" as "tg" on "tg"."id" = "$tg_join"."tag_id"',
      params: [],
    },
    "joinAssoc through manyToMany with a join schema": {
      sql: 'select "u"."id" as "c0", "o"."name" as "c1" from "users" as "u" inner join "memberships" as "$o_join" on "$o_join"."user_id" = "u"."id" inner join "orgs" as "o" on "o"."id" = "$o_join"."org_id"',
      params: [],
    },
    "joinAssoc through a has-through association": {
      sql: 'select "u"."id" as "c0", "c"."body" as "c1" from "users" as "u" inner join "posts" as "$c_0_posts" on "$c_0_posts"."author_id" = "u"."id" inner join "comments" as "c" on "c"."post_id" = "$c_0_posts"."id"',
      params: [],
    },
    "leftJoinAssoc with an extra condition": {
      sql: 'select "u"."id" as "c0", "p"."title" as "c1" from "users" as "u" left join "posts" as "p" on "p"."author_id" = "u"."id" and "p"."published"',
      params: [],
    },
    "a join source with a database schema of its own": {
      sql: 'select "p"."id" as "c0", "p"."author_id" as "c1", "p"."title" as "c2", "p"."body" as "c3", "p"."published" as "c4", "p"."views" as "c5", "p"."tags" as "c6", "p"."published_at" as "c7", "p"."created_at" as "c8", "p"."updated_at" as "c9" from "users" as "u" inner join "archive"."posts" as "p" on "p"."author_id" = "u"."id"',
      params: [],
    },
    "a lateral join of a subquery": { error: "LATERAL JOIN is not supported by sqlite." },
    "an inner lateral join": { error: "LATERAL JOIN is not supported by sqlite." },
  },
  where: {
    comparisons: {
      sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."id" = ? and "u"."id" <> ? and "u"."age" > ? and "u"."age" >= ? and "u"."age" < ? and "u"."age" <= ?',
      params: [1, 2, 3, 4, 5, 6],
    },
    "is distinct from, is null, is not null": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."name" is distinct from ? and "u"."age" is null and "u"."password_hash" is not null',
      params: [null],
    },
    "like, not like, ilike": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."email" like ? escape \'\\\' and "u"."email" not like ? escape \'\\\' and "u"."name" like ? escape \'\\\'',
      params: ["%@example.com", "admin%", "ann%"],
    },
    "in and not in with a list are one array parameter": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."role" in (?, ?) and "u"."id" not in (?, ?, ?)',
      params: ["admin", "member", 7, 8, 9],
    },
    "in an empty list is false": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where false',
      params: [],
    },
    "in a subquery": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."id" in (select "p"."author_id" as "c0" from "posts" as "p" where "p"."views" > ?)',
      params: [100],
    },
    "not in a subquery": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."id" not in (select "p"."author_id" as "c0" from "posts" as "p")',
      params: [],
    },
    "in an array expression": { error: "in() with an array expression is not supported by sqlite." },
    between: {
      sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."age" between ? and ?',
      params: [18, 65],
    },
    "and, or and not nest with the parentheses they need": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where (("u"."age" >= ? and "u"."role" = ?) or not ("u"."email" like ? escape \'\\\')) and ("u"."name" is null or "u"."name" = ?)',
      params: [18, "admin", "%@test", "x"],
    },
    "where, where, orWhere is (a and b) or c": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where ("u"."age" >= ? and "u"."role" = ?) or "u"."id" = ?',
      params: [18, "admin", 1],
    },
    "orWhere, then where, groups to the left": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where ("u"."age" >= ? or "u"."id" = ?) and "u"."role" = ?',
      params: [18, 1, "admin"],
    },
    "the object form of where": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."role" = ? and "u"."name" is null and "u"."id" in (?, ?)',
      params: ["admin", 1, 2],
    },
    "an empty where object is true": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where true',
      params: [],
    },
    "arithmetic keeps its grouping": {
      sql: 'select -"p"."views" as "c0" from "posts" as "p" where ("p"."views" + ?) * cast(? as integer) > cast(("p"."views" - "p"."views" % ?) / cast(? as integer) as integer)',
      params: [1, 2, 3, 4],
    },
    "text functions and concatenation": {
      sql: 'select "u"."email" || ? || "u"."role" || ? as "c0" from "users" as "u" where lower("u"."email") = lower(upper("u"."email"))',
      params: [" <", ">"],
    },
    "array operators": { error: 'The function "arrayAppend" is not in the sqlite function table.' },
    "JSON paths bind their keys": {
      sql: 'select "u"."settings" -> (\'$\' || ?) as "c0", "u"."settings" ->> (\'$\' || ? || ?) as "c1" from "users" as "u" where "u"."settings" ->> (\'$\' || ?) = ?',
      params: ['."theme"', '."tags"', "[0]", '."theme"', "dark"],
    },
    "coalesce, now and cast": {
      sql: 'select cast("p"."views" as text) as "c0" from "posts" as "p" where coalesce("p"."published_at", strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\')) < ?',
      params: [SINCE],
    },
    exists: {
      sql: 'select "u"."id" as "c0" from "users" as "u" where exists (select 1 from "posts" as "p" where "p"."author_id" = "u"."id")',
      params: [],
    },
    "a fragment with a value and an identifier": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where (length("u"."email") > ?) and ("email" is not null)',
      params: [3],
    },
    "a fragment as an operand is parenthesised": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where ("u"."age" + 1) > ?',
      params: [10],
    },
    "named parameters": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where ("u"."age" >= ? and "u"."role" = ?) or "u"."age" < ?',
      params: [21, "admin", 21],
    },
    "a tuple comparison": {
      sql: 'select "p"."id" as "c0" from "posts" as "p" where ("p"."created_at", "p"."id") > (?, ?)',
      params: [SINCE, 10],
    },
    "a unary minus of a negative literal keeps its parentheses": {
      sql: 'select -(-1) as "c0", "p"."views" - -1 as "c1", -(-"p"."views") as "c2" from "posts" as "p"',
      params: [],
    },
    "comparisons nested in comparisons are parenthesised": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where ("u"."age" >= ?) = (("u"."name" = "u"."email") is null)',
      params: [18],
    },
    "right-nested arithmetic and concatenation keep their parentheses; left-nested need none": {
      sql: 'select "p"."views" - ("p"."views" - ?) as "c0", "p"."views" - "p"."views" - ? as "c1", cast("p"."views" / (2 * 3) as integer) as "c2", "p"."views" % (7 % 4) as "c3", "p"."views" * ("p"."views" + 1) as "c4", "p"."views" * "p"."views" + 1 as "c5", "p"."title" || ("p"."title" || ?) as "c6", "p"."title" || ? || "p"."title" as "c7" from "posts" as "p"',
      params: [1, 2, "!", "?"],
    },
    "comparisons and booleans mixed keep their parentheses": {
      sql: 'select "p"."id" as "c0" from "posts" as "p" where ("p"."id" = ?) = ("p"."views" + 1 < ?) or ("p"."published" and ("p"."body" is null or not "p"."published")) or not ("p"."published" and "p"."published")',
      params: [1, 2],
    },
    "a coalesce with a typed argument, compared with an untyped value, is cast and compares as a number": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where coalesce(cast(? as integer), ?) = ?',
      params: [1, 2, 1],
    },
  },
  aggregates: {
    aggregates: { error: 'The aggregate "arrayAgg" is not in the sqlite aggregate table.' },
    "group by and having": {
      sql: 'select "p"."author_id" as "c0", count("p"."id") as "c1" from "posts" as "p" group by "p"."author_id" having count("p"."id") > ?',
      params: [2],
    },
    "an aggregate with a filter": {
      sql: 'select count("p"."id") filter (where "p"."published") as "c0" from "posts" as "p"',
      params: [],
    },
    "a window function over an inline window": {
      sql: 'select "p"."id" as "c0", sum("p"."views") over (partition by "p"."author_id" order by "p"."created_at" asc) as "c1", count(*) over () as "c2" from "posts" as "p"',
      params: [],
    },
    "a named window and a window frame": {
      sql: 'select "p"."id" as "c0", count(*) over "w" as "c1", sum("p"."views") over (partition by "p"."author_id" order by "p"."id" asc rows between unbounded preceding and current row) as "c2" from "posts" as "p" window "w" as (partition by "p"."views" % ?)',
      params: [10],
    },
  },
  clauses: {
    "order by with directions and nulls": {
      sql: 'select "u"."id" as "c0" from "users" as "u" order by "u"."name" asc nulls first, "u"."created_at" desc nulls last, "u"."id" asc',
      params: [],
    },
    "reverseOrder swaps every direction": {
      sql: 'select "u"."id" as "c0" from "users" as "u" order by "u"."name" desc nulls last, "u"."id" asc',
      params: [],
    },
    "limit and offset are bound": {
      sql: 'select "u"."id" as "c0" from "users" as "u" limit ? offset ?',
      params: [10, 20],
    },
    "limit and offset as named parameters": {
      sql: 'select "u"."id" as "c0" from "users" as "u" limit ? offset ?',
      params: [10, 0],
    },
    "lock update {}": { sql: 'select "u"."id" as "c0" from "users" as "u"', params: [] },
    'lock update {"skipLocked":true}': { sql: 'select "u"."id" as "c0" from "users" as "u"', params: [] },
    'lock update {"noWait":true}': { sql: 'select "u"."id" as "c0" from "users" as "u"', params: [] },
    "lock share {}": { sql: 'select "u"."id" as "c0" from "users" as "u"', params: [] },
    'lock share {"skipLocked":true}': { sql: 'select "u"."id" as "c0" from "users" as "u"', params: [] },
    'lock share {"noWait":true}': { sql: 'select "u"."id" as "c0" from "users" as "u"', params: [] },
    "lock noKeyUpdate {}": { sql: 'select "u"."id" as "c0" from "users" as "u"', params: [] },
    'lock noKeyUpdate {"skipLocked":true}': {
      sql: 'select "u"."id" as "c0" from "users" as "u"',
      params: [],
    },
    'lock noKeyUpdate {"noWait":true}': { sql: 'select "u"."id" as "c0" from "users" as "u"', params: [] },
    "lock keyShare {}": { sql: 'select "u"."id" as "c0" from "users" as "u"', params: [] },
    'lock keyShare {"skipLocked":true}': { sql: 'select "u"."id" as "c0" from "users" as "u"', params: [] },
    'lock keyShare {"noWait":true}': { sql: 'select "u"."id" as "c0" from "users" as "u"', params: [] },
    "a lock given as a fragment": { sql: 'select "u"."id" as "c0" from "users" as "u"', params: [] },
    "the schema argument places every table": {
      sql: 'select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "tenant_1"."users" as "u" inner join "tenant_1"."posts" as "p" on "p"."author_id" = "u"."id"',
      params: [],
    },
    "a query's schema wins over the argument": {
      sql: 'select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "archive"."users" as "u"',
      params: [],
    },
    "a schema's own database schema wins over the query's": {
      sql: 'select "a"."id" as "c0", "a"."action" as "c1", "a"."user_id" as "c2" from "audit"."audit_logs" as "a"',
      params: [],
    },
    "a subquery inherits the query's schema": {
      sql: 'select "u"."id" as "c0" from "archive"."users" as "u" where "u"."id" in (select "p"."author_id" as "c0" from "archive"."posts" as "p")',
      params: [],
    },
  },
  nested: {
    "a scalar subquery in the select list": {
      sql: 'select "u"."id" as "c0", (select count(*) as "c0" from "posts" as "p" where "p"."author_id" = "u"."id") as "c1" from "users" as "u"',
      params: [],
    },
    "a subquery as the source, selected whole": {
      sql: 'select "s"."id" as "c0", "s"."author_id" as "c1", "s"."title" as "c2", "s"."body" as "c3", "s"."published" as "c4", "s"."views" as "c5", "s"."tags" as "c6", "s"."published_at" as "c7", "s"."created_at" as "c8", "s"."updated_at" as "c9" from (select "p"."id" as "id", "p"."author_id" as "author_id", "p"."title" as "title", "p"."body" as "body", "p"."published" as "published", "p"."views" as "views", "p"."tags" as "tags", "p"."published_at" as "published_at", "p"."created_at" as "created_at", "p"."updated_at" as "updated_at" from "posts" as "p" where "p"."views" > ?) as "s"',
      params: [10],
    },
    "a subquery source with an object select, read by name": {
      sql: 'select "s"."author" as "c0" from (select "p"."author_id" as "author" from "posts" as "p") as "s" group by "s"."author"',
      params: [],
    },
    "a CTE, materialized and not": {
      sql: 'with "recent" as materialized (select "p"."id" as "id", "p"."author_id" as "author_id", "p"."title" as "title", "p"."body" as "body", "p"."published" as "published", "p"."views" as "views", "p"."tags" as "tags", "p"."published_at" as "published_at", "p"."created_at" as "created_at", "p"."updated_at" as "updated_at" from "posts" as "p" where "p"."created_at" > ?), "authors" as not materialized (select "p"."author_id" as "author" from "posts" as "p") select "r"."id" as "c0", "r"."author_id" as "c1", "r"."title" as "c2", "r"."body" as "c3", "r"."published" as "c4", "r"."views" as "c5", "r"."tags" as "c6", "r"."published_at" as "c7", "r"."created_at" as "c8", "r"."updated_at" as "c9" from "recent" as "r" where exists (select 1 from "authors" as "au" where "au"."author" = "r"."author_id")',
      params: [SINCE],
    },
    "a recursive CTE": {
      sql: 'with recursive "n" as (select "v"."i" as "i" from (select "column1" as "i" from (values (cast(? as integer)))) as "v" union all select "n"."i" + cast(? as integer) as "i" from "n" as "n" where "n"."i" < ?) select sum("n"."i") as "c0" from "n" as "n"',
      params: [1, 1, 5],
    },
    "a CTE with a fragment body": {
      sql: 'with "series" as (select cast(? as integer) as n) select "g"."n" as "c0" from "series" as "g"',
      params: [3],
    },
    "union all with an order and a limit on the result": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."age" < ? union all select "p"."author_id" as "c0" from "posts" as "p" where "p"."views" > ? order by "c0" desc limit ?',
      params: [18, 5, 10],
    },
    "intersect and except": {
      sql: 'select "u"."id" as "c0" from "users" as "u" intersect select "p"."author_id" as "c0" from "posts" as "p" except select "c"."author_id" as "c0" from "comments" as "c"',
      params: [],
    },
    "an intersect after a union applies to the union": { error: "INTERSECT ALL is not supported by sqlite." },
    "a CTE that deletes and returns rows": {
      error: "A CTE that writes (updateAll or deleteAll in a WITH) is not supported by sqlite.",
    },
    "union of whole rows from two database schemas has no single origin": {
      sql: 'select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "users" as "u" union select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "archive"."users" as "u"',
      params: [],
    },
    "a values list as a source": {
      sql: 'select "v"."id" as "c0", "v"."label" as "c1" from (select "column1" as "id", "column2" as "label" from (values (cast(? as integer), cast(? as text)), (cast(? as integer), cast(? as text)))) as "v"',
      params: [1, "one", 2, "two"],
    },
    "a fragment as a source": {
      error: "A column list after a fragment source's alias is not supported by sqlite.",
    },
    "a table hint": {
      sql: 'select count(*) as "c0" from "posts" as "p" indexed by posts_author_id_index',
      params: [],
    },
    "every expression kind built by hand": {
      sql: 'select case when "u"."age" is null then cast(? as text) else cast(? as text) end as "c0", "u"."settings" -> (\'$\' || ?) as "c1", false as "c2" from "users" as "u" where "u"."id" in (?, ?) and coalesce("u"."age", ?) > ?',
      params: ["unknown", "known", '."theme"', 1, 2, 0, 1],
    },
  },
  bulk: {
    "updateAll with set and where": {
      sql: 'update "posts" as "p" set "views" = "p"."views" + ?, "published" = ? where "p"."author_id" = ?',
      params: [1, true, 1],
    },
    "updateAll with a join and returning": {
      error: "UPDATE … FROM (a join in updateAll) is not supported by sqlite.",
    },
    "updateAll returning whole rows": {
      sql: 'update "tenant_1"."posts" as "p" set "views" = 0 returning "id" as "c0", "author_id" as "c1", "title" as "c2", "body" as "c3", "published" as "c4", "views" as "c5", "tags" as "c6", "published_at" as "c7", "created_at" as "c8", "updated_at" as "c9"',
      params: [],
    },
    "deleteAll with where": { sql: 'delete from "posts" as "p" where "p"."views" < ?', params: [1] },
    "deleteAll with a join and returning": {
      error: "DELETE … USING (a join in deleteAll) is not supported by sqlite.",
    },
  },
  writes: {
    "insert one row and return its key": {
      sql: 'insert into "users" ("email", "name") values (?, ?) returning "id" as "c0"',
      params: ["a@example.com", "Ann"],
    },
    "insert three rows": {
      sql: 'insert into "tags" ("name") values (?), (?), (?)',
      params: ["one", "two", "three"],
    },
    "insert a row of defaults": {
      sql: 'insert into "tags" default values returning "id" as "c0"',
      params: [],
    },
    "insert two rows of defaults": {
      error: "DEFAULT in a VALUES list (several rows of defaults) is not supported by sqlite.",
    },
    "insert cells: values, defaults, an expression and a shared placeholder": {
      error: "DEFAULT in a VALUES list (rows with different fields) is not supported by sqlite.",
    },
    "insert from a query": {
      sql: 'insert into "tags" ("name") select "u"."email" as "c0" from "users" as "u" where "u"."id" <= ?',
      params: [3],
    },
    "insert or do nothing": {
      sql: 'insert into "tags" ("name") values (?) on conflict do nothing',
      params: ["dup"],
    },
    "insert or update every column on a field conflict": {
      sql: 'insert into "users" ("email", "name") values (?, ?) on conflict ("email") do update set "email" = "excluded"."email", "name" = "excluded"."name" returning "id" as "c0"',
      params: ["d@example.com", "Di"],
    },
    "insert or update named fields on a named constraint": {
      error: "An onConflict target that names a constraint ({ constraint }) is not supported by sqlite.",
    },
    "insert or update all but some on a fragment target": {
      sql: 'insert into "tags" ("name") values (?) on conflict ("name") do update set "name" = "excluded"."name" returning "id" as "c0"',
      params: ["frag"],
    },
    "update one row with an optimistic lock": {
      sql: 'update "users" set "name" = ?, "lock_version" = ? where "id" = ? and "lock_version" = ? returning "lock_version" as "c0"',
      params: ["New", 2, 1, 1],
    },
    "update a row of a schema with its own database schema": {
      sql: 'update "audit"."audit_logs" set "action" = ? where "id" = ?',
      params: ["login", 1],
    },
    "delete one row in a given database schema": {
      sql: 'delete from "tenant_1"."users" where "id" = ? returning "id" as "c0", "email" as "c1"',
      params: [1],
    },
    "a fragment as a whole statement": {
      sql: 'select cast(? as integer) + cast(? as integer) as "total"',
      params: [1, 2],
    },
    "explain with options": { error: "explain's analyze option is not supported by sqlite." },
    "explain without options": {
      sql: 'explain query plan select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "users" as "u"',
      params: [],
    },
  },
  casts: {
    "arithmetic of a typed value and a plain one in where: both are cast": {
      sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."views" = cast(? as integer) + cast(? as integer)',
      params: [3, 4],
    },
    "every arithmetic operator, and unary minus, on typed values in a select": {
      sql: 'select cast(? as integer) + cast(? as integer) as "c0", cast(? as integer) - cast(? as integer) as "c1", cast(? as integer) * cast(? as integer) as "c2", cast(cast(? as integer) / cast(? as integer) as integer) as "c3", cast(? as integer) % cast(? as integer) as "c4", -cast(? as integer) as "c5" from "users" as "u" limit ?',
      params: [7, 2, 7, 2, 7, 2, 7, 2, 7, 2, 7, 1],
    },
    "arithmetic of typed values nested and beside a column: only bound pairs are cast": {
      sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."views" < cast(? as integer) * cast(? as integer) + "p"."views" and "p"."views" > "p"."views" - (cast(? as integer) + cast(? as integer))',
      params: [2, 3, 1, 2],
    },
    "a typed named parameter in arithmetic is cast": {
      sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."views" >= cast(? as integer) + cast(? as integer)',
      params: [5, 1],
    },
    "a typed value in a CASE beside a column in arithmetic is cast": {
      sql: 'select "p"."views" + case when "p"."published" then cast(? as integer) else cast(? as integer) end as "c0" from "posts" as "p"',
      params: [10, 0],
    },
    "updateAll sets a typed arithmetic value": {
      sql: 'update "posts" as "p" set "views" = cast(? as integer) + cast(? as integer) where "p"."id" = ?',
      params: [3, 1, 1],
    },
    "an insert cell of typed arithmetic": {
      sql: 'insert into "posts" ("author_id", "title", "views") values (?, ?, cast(? as integer) + cast(? as integer))',
      params: [1, "Cast", 3, 1],
    },
    "a CASE of untyped values compared with a column takes the column's type, on either side": {
      sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."author_id" = cast(case when "p"."published" then ? else ? end as integer) and cast(case when "p"."published" then ? else ? end as integer) <> "p"."author_id"',
      params: [1, 2, 1, 2],
    },
    "a coalesce of untyped values compared with a column takes the column's type": {
      sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."author_id" >= cast(coalesce(?, ?) as integer)',
      params: [1, 2],
    },
    "between with an untyped CASE takes the column's type": {
      sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."author_id" between cast(case when "p"."published" then ? else ? end as integer) and ? and cast(case when "p"."published" then ? else ? end as integer) between "p"."author_id" and "p"."id"',
      params: [1, 0, 5, 1, 0],
    },
    "in and not in an untyped coalesce take an array of the column's type": {
      error: "in() with an array expression is not supported by sqlite.",
    },
    "an untyped CASE in an array column takes the element type": {
      error: "in() with an array expression is not supported by sqlite.",
    },
    "a uuid column compared with an untyped CASE": {
      sql: 'select "m"."user_id" as "c0" from "memberships" as "m" where "m"."org_id" = cast(case when true then ? end as text)',
      params: ["00000000-0000-4000-8000-000000000001"],
    },
    "a CASE with a typed value compared with a column: the typed values are cast": {
      sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."author_id" = case when "p"."published" then cast(? as integer) else cast(? as integer) end',
      params: [1, 2],
    },
    "a CASE with a column in it, or a bare value, is left to the column": {
      sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."author_id" = case when "p"."published" then "p"."author_id" else ? end and "p"."author_id" = ?',
      params: [0, 1],
    },
    "a typed value beside arithmetic keeps its own type (review round 1)": {
      sql: 'select cast(? as real) / (cast(? as integer) + cast(? as integer)) as "c0", cast(? as integer) + (cast(? as integer) + cast(? as integer)) as "c1" from "users" as "u" limit ?',
      params: [7.5, 2, 1, 1099511627776, 1, 1, 1],
    },
    // An integer and a bigint are both `integer` here, so the key's value is not cast.
    "a typed value beside a column of another type in arithmetic is cast, on either side": {
      sql: 'select "p"."views" / cast(? as real) as "c0", cast(? as real) / "p"."views" as "c1", "p"."views" + ? as "c2", "p"."author_id" + ? as "c3" from "posts" as "p" where "p"."id" = ?',
      params: [2, 6, 1, 1, 2],
    },
    "a typed value of another type beside a column in where, as a named parameter": {
      sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."views" / cast(? as real) = ?',
      params: [2, 1.5],
    },
    "updateAll sets a column times a typed value of another type": {
      sql: 'update "posts" as "p" set "views" = "p"."views" * cast(? as real) where "p"."id" = ?',
      params: [2, 2],
    },
    "a division of two integers divides as integers on every database; a float keeps /": {
      sql: 'select cast("p"."views" / ? as integer) as "c0", cast("p"."author_id" / ? as integer) as "c1", cast("p"."views" / ? as integer) as "c2", cast(("p"."views" + ?) / cast(? as integer) as integer) as "c3", cast("p"."views" / ? as integer) as "c4", "p"."views" / cast(? as real) as "c5" from "posts" as "p" where "p"."id" = ?',
      params: [2, 2, 2, 1, 2, 2, 2, 2],
    },
    "a CASE or coalesce with no typed value beside a typed value takes its type (review round 1)": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where ? = cast(? as integer) + cast(coalesce(?, ?) as integer) and case when true then cast(? as integer) end + cast(case when true then ? end as integer) = ? and cast(? as integer) = cast(coalesce(?, ?) as integer) and case when true then cast(? as integer) end = cast(case when true then ? end as integer) and cast(? as integer) between cast(case when true then ? end as integer) and cast(case when true then ? end as integer)',
      params: [3, 1, null, 2, 1, 2, 3, 1, null, 1, 1, 1, 1, 0, 5],
    },
    "untyped values of a widened type compared: text with text, a number with a column": {
      sql: 'select "u"."id" as "c0" from "users" as "u" where cast(? as text) > cast(? as text) and ? = "u"."age"',
      params: ["b", "a", 34],
    },
  },
};
