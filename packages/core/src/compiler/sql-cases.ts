// The SQL snapshot matrices: every clause and operator the query layer produces, as
// compiled for each dialect. `*.sql.test.ts` compare the output with these tables;
// `sql.itest.ts` executes every case against Postgres to prove that the SQL is valid.
// Step 17 adds the expected output of MySQL and SQLite next to `postgres`.
//
// Imported by tests only.
import { Comment, Membership, Post, Profile, Tag, User } from "../../test/support/blog.js";
import type { Dialect } from "../contracts/adapter.js";
import type { FragmentNode } from "../contracts/query.js";
import {
  and,
  arrayAgg,
  avg,
  caseWhen,
  coalesce,
  count,
  countDistinct,
  exists,
  fragment,
  from,
  jsonAgg,
  lit,
  max,
  min,
  not,
  now,
  or,
  param,
  stringAgg,
  sum,
  t,
  val,
} from "../index.js";
import {
  aggregateNode,
  binaryNode,
  caseNode,
  existsNode,
  fnNode,
  identNode,
  jsonPathNode,
  listNode,
  literalNode,
  naryNode,
  orderNode,
  STAR,
  selectedAsNode,
  subqueryNode,
  tupleNode,
  unaryNode,
  windowNode,
} from "../query/ast.js";
import { meta } from "../schema/index.js";
import { MYSQL_CASES } from "./sql-cases.mysql.js";
import { SQLITE_CASES } from "./sql-cases.sqlite.js";
import {
  AuditLog,
  bareQuery,
  col,
  Event,
  frag,
  queryCase,
  rebuild,
  type SqlCase,
  selectBinding,
  selectObject,
  selectOne,
  statementCase,
  tableOf,
  typeOf,
  value,
  withDialects,
} from "./sql-fixtures.js";

/** The MySQL and SQLite output of every case, by area and name. */
const DIALECT_TABLES = { mysql: MYSQL_CASES, sqlite: SQLITE_CASES };

const since = new Date("2026-01-01T00:00:00.000Z");
const users = from(User, "u");
const posts = from(Post, "p");

const integer = (n: number) => value(n, typeOf(t.integer()));

/** The body of "a CTE with a fragment body" per dialect: one row, `n`, built from parameter 0. */
const CTE_BODIES: Readonly<Record<Dialect, FragmentNode>> = {
  postgres: frag`select generate_series(1, ${integer(3)}) as n`,
  mysql: frag`select ${integer(3)} as n`,
  sqlite: frag`select ${integer(3)} as n`,
};

/** The source of "a fragment as a source" per dialect, over parameters 0 and 1. */
const SOURCE_FRAGMENTS: Readonly<Record<Dialect, FragmentNode>> = {
  postgres: frag`generate_series(${integer(1)}, ${integer(3)})`,
  mysql: frag`(select ${integer(1)} as x union all select ${integer(3)})`,
  sqlite: frag`(select ${integer(1)} as x union all select ${integer(3)})`,
};

/** A table hint each dialect accepts; only the Postgres one has a parameter. */
const TABLE_HINTS: Readonly<Record<Dialect, FragmentNode>> = {
  postgres: frag`tablesample system (${value(50, typeOf(t.integer()))})`,
  mysql: frag`use index (posts_author_id_index)`,
  sqlite: frag`indexed by posts_author_id_index`,
};

// ---------------------------------------------------------------------------
// Select lists
// ---------------------------------------------------------------------------

export const SELECT_CASES: readonly SqlCase[] = withDialects(
  "select",
  [
    queryCase("a query without a select returns the root's persisted columns", users, {
      sql: 'select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "users" as "u"',
      params: [],
    }),
    queryCase(
      "one selected expression",
      users.select(({ u }) => u.email),
      { sql: 'select "u"."email" as "c0" from "users" as "u"', params: [] },
    ),
    queryCase(
      "an object select, with a constant that is not sent",
      users.select(({ u }) => ({ id: u.id, kind: "user" })),
      { sql: 'select "u"."id" as "c0" from "users" as "u"', params: [] },
    ),
    queryCase(
      "an array select",
      users.select(({ u }) => [u.id, u.email]),
      { sql: 'select "u"."id" as "c0", "u"."email" as "c1" from "users" as "u"', params: [] },
    ),
    queryCase(
      "a whole binding inside an object select",
      posts.joinAssoc("p", "author", "a").select(({ p, a }) => ({ title: p.title, author: a })),
      {
        sql: 'select "p"."title" as "c0", "a"."id" as "c1", "a"."email" as "c2", "a"."name" as "c3", "a"."age" as "c4", "a"."role" as "c5", "a"."password_hash" as "c6", "a"."settings" as "c7", "a"."lock_version" as "c8", "a"."created_at" as "c9", "a"."updated_at" as "c10" from "posts" as "p" inner join "users" as "a" on "a"."id" = "p"."author_id"',
        params: [],
      },
    ),
    queryCase(
      "a whole left-joined binding",
      users.leftJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id)).select(({ u, pr }) => [u.id, pr]),
      {
        sql: 'select "u"."id" as "c0", "pr"."id" as "c1", "pr"."user_id" as "c2", "pr"."bio" as "c3", "pr"."avatar_url" as "c4" from "users" as "u" left join "profiles" as "pr" on "pr"."user_id" = "u"."id"',
        params: [],
      },
    ),
    queryCase(
      "selected values are cast to their type; an untyped one to text",
      users.select(({ u }) => ({
        id: u.id,
        label: val("member"),
        limit: val(5, t.integer()),
        since: param("since", t.timestamp()),
      })),
      {
        sql: 'select "u"."id" as "c0", cast($1 as text) as "c1", cast($2 as integer) as "c2", cast($3 as timestamptz) as "c3" from "users" as "u"',
        params: ["member", 5, since],
      },
      { named: { since } },
    ),
    queryCase(
      "a selected CASE casts its result values",
      users.select(({ u }) => caseWhen(u.age.lt(18), "minor").else("adult")),
      {
        sql: 'select case when "u"."age" < $1 then cast($2 as text) else cast($3 as text) end as "c0" from "users" as "u"',
        params: [18, "minor", "adult"],
      },
    ),
    queryCase(
      "literals are written into the SQL",
      users.select(() => ({ one: lit(1), half: lit(-0.5), yes: lit(true), none: lit(null) })),
      { sql: 'select 1 as "c0", -0.5 as "c1", true as "c2", null as "c3" from "users" as "u"', params: [] },
    ),
    queryCase(
      "distinct",
      users.distinct().select(({ u }) => u.role),
      { sql: 'select distinct "u"."role" as "c0" from "users" as "u"', params: [] },
    ),
    queryCase(
      "distinct on",
      posts.distinct(({ p }) => p.authorId).orderBy(({ p }) => [p.authorId, p.createdAt.desc()]),
      {
        sql: 'select distinct on ("p"."author_id") "p"."id" as "c0", "p"."author_id" as "c1", "p"."title" as "c2", "p"."body" as "c3", "p"."published" as "c4", "p"."views" as "c5", "p"."tags" as "c6", "p"."published_at" as "c7", "p"."created_at" as "c8", "p"."updated_at" as "c9" from "posts" as "p" order by "p"."author_id" asc, "p"."created_at" desc',
        params: [],
      },
    ),
    queryCase(
      "selectMerge adds keys to an object select",
      users.select(({ u }) => ({ id: u.id })).selectMerge(({ u }) => ({ email: u.email })),
      { sql: 'select "u"."id" as "c0", "u"."email" as "c1" from "users" as "u"', params: [] },
    ),
    queryCase(
      "a selected expression with a name of its own",
      rebuild(users.ast, {
        select: selectObject({ total: selectedAsNode("total", col("u", "age")) }),
        orderBys: [orderNode(selectedAsNode("total", undefined), "desc", undefined)],
      }),
      { sql: 'select "u"."age" as "total" from "users" as "u" order by "total" desc', params: [] },
    ),
    queryCase("a schema without a primary key", from(Event, "e"), {
      sql: 'select "e"."name" as "c0", "e"."payload" as "c1" from "events" as "e"',
      params: [],
    }),
    queryCase(
      "a preload is listed on the root row; a join preload adds its columns",
      users.joinAssoc("u", "posts", "p").preload({ posts: "p", profile: true }),
      {
        sql: 'select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9", "p"."id" as "c10", "p"."author_id" as "c11", "p"."title" as "c12", "p"."body" as "c13", "p"."published" as "c14", "p"."views" as "c15", "p"."tags" as "c16", "p"."published_at" as "c17", "p"."created_at" as "c18", "p"."updated_at" as "c19" from "users" as "u" inner join "posts" as "p" on "p"."author_id" = "u"."id"',
        params: [],
      },
    ),
  ],
  DIALECT_TABLES,
);

// ---------------------------------------------------------------------------
// Joins
// ---------------------------------------------------------------------------

export const JOIN_CASES: readonly SqlCase[] = withDialects(
  "joins",
  [
    queryCase(
      "inner join",
      users.join(Post, "p", ({ u, p }) => p.authorId.eq(u.id)).select(({ u, p }) => [u.id, p.id]),
      {
        sql: 'select "u"."id" as "c0", "p"."id" as "c1" from "users" as "u" inner join "posts" as "p" on "p"."author_id" = "u"."id"',
        params: [],
      },
    ),
    queryCase(
      "left join",
      users.leftJoin(Post, "p", ({ u, p }) => p.authorId.eq(u.id)).select(({ u, p }) => [u.id, p.id]),
      {
        sql: 'select "u"."id" as "c0", "p"."id" as "c1" from "users" as "u" left join "posts" as "p" on "p"."author_id" = "u"."id"',
        params: [],
      },
    ),
    queryCase(
      "right join",
      users.rightJoin(Post, "p", ({ u, p }) => p.authorId.eq(u.id)).select(({ u, p }) => [u.id, p.id]),
      {
        sql: 'select "u"."id" as "c0", "p"."id" as "c1" from "users" as "u" right join "posts" as "p" on "p"."author_id" = "u"."id"',
        params: [],
      },
    ),
    queryCase(
      "full join",
      users.fullJoin(Post, "p", ({ u, p }) => p.authorId.eq(u.id)).select(({ u, p }) => [u.id, p.id]),
      {
        sql: 'select "u"."id" as "c0", "p"."id" as "c1" from "users" as "u" full join "posts" as "p" on "p"."author_id" = "u"."id"',
        params: [],
      },
    ),
    queryCase(
      "cross join",
      users.crossJoin(Tag, "tg").select(({ u, tg }) => [u.id, tg.id]),
      {
        sql: 'select "u"."id" as "c0", "tg"."id" as "c1" from "users" as "u" cross join "tags" as "tg"',
        params: [],
      },
    ),
    queryCase(
      "joinAssoc through belongsTo",
      from(Comment, "c")
        .joinAssoc("c", "post", "p")
        .select(({ c, p }) => [c.id, p.title]),
      {
        sql: 'select "c"."id" as "c0", "p"."title" as "c1" from "comments" as "c" inner join "posts" as "p" on "p"."id" = "c"."post_id"',
        params: [],
      },
    ),
    queryCase(
      "joinAssoc through manyToMany with a join table",
      posts.joinAssoc("p", "tags", "tg").select(({ p, tg }) => [p.id, tg.name]),
      {
        sql: 'select "p"."id" as "c0", "tg"."name" as "c1" from "posts" as "p" inner join "posts_tags" as "$tg_join" on "$tg_join"."post_id" = "p"."id" inner join "tags" as "tg" on "tg"."id" = "$tg_join"."tag_id"',
        params: [],
      },
    ),
    queryCase(
      "joinAssoc through manyToMany with a join schema",
      users.joinAssoc("u", "orgs", "o").select(({ u, o }) => [u.id, o.name]),
      {
        sql: 'select "u"."id" as "c0", "o"."name" as "c1" from "users" as "u" inner join "memberships" as "$o_join" on "$o_join"."user_id" = "u"."id" inner join "orgs" as "o" on "o"."id" = "$o_join"."org_id"',
        params: [],
      },
    ),
    queryCase(
      "joinAssoc through a has-through association",
      users.joinAssoc("u", "comments", "c").select(({ u, c }) => [u.id, c.body]),
      {
        sql: 'select "u"."id" as "c0", "c"."body" as "c1" from "users" as "u" inner join "posts" as "$c_0_posts" on "$c_0_posts"."author_id" = "u"."id" inner join "comments" as "c" on "c"."post_id" = "$c_0_posts"."id"',
        params: [],
      },
    ),
    queryCase(
      "leftJoinAssoc with an extra condition",
      users
        .leftJoinAssoc("u", "posts", "p", ({ p }) => p.published)
        .select(({ u, p }) => ({ id: u.id, title: p.title })),
      {
        sql: 'select "u"."id" as "c0", "p"."title" as "c1" from "users" as "u" left join "posts" as "p" on "p"."author_id" = "u"."id" and "p"."published"',
        params: [],
      },
    ),
    queryCase(
      "a join source with a database schema of its own",
      rebuild(users.ast, {
        joins: [
          {
            kind: "join",
            type: "inner",
            source: tableOf(Post, "p", "archive"),
            on: binaryNode("eq", col("p", "author_id"), col("u", "id")),
          },
        ],
        select: selectBinding("p", meta(Post)),
      }),
      {
        sql: 'select "p"."id" as "c0", "p"."author_id" as "c1", "p"."title" as "c2", "p"."body" as "c3", "p"."published" as "c4", "p"."views" as "c5", "p"."tags" as "c6", "p"."published_at" as "c7", "p"."created_at" as "c8", "p"."updated_at" as "c9" from "users" as "u" inner join "archive"."posts" as "p" on "p"."author_id" = "u"."id"',
        params: [],
      },
    ),
    queryCase(
      "a lateral join of a subquery",
      rebuild(users.ast, {
        joins: [
          {
            kind: "join",
            type: "leftLateral",
            source: {
              kind: "subquerySource",
              alias: "top",
              query: rebuild(posts.ast, {
                wheres: [
                  { kind: "bool", op: "and", expr: binaryNode("eq", col("p", "author_id"), col("u", "id")) },
                ],
                select: selectObject({ id: col("p", "id"), views: col("p", "views") }),
                orderBys: [orderNode(col("p", "views"), "desc", "last")],
                limit: value(3, typeOf(t.integer())),
              }),
            },
            on: literalNode(true),
          },
        ],
        select: selectObject({ user: col("u", "id"), post: col("top", "id") }),
      }),
      {
        sql: 'select "u"."id" as "c0", "top"."id" as "c1" from "users" as "u" left join lateral (select "p"."id" as "id", "p"."views" as "views" from "posts" as "p" where "p"."author_id" = "u"."id" order by "p"."views" desc nulls last limit $1) as "top" on true',
        params: [3],
      },
    ),
    queryCase(
      "an inner lateral join",
      rebuild(users.ast, {
        joins: [
          {
            kind: "join",
            type: "innerLateral",
            source: {
              kind: "subquerySource",
              alias: "latest",
              query: rebuild(posts.ast, {
                wheres: [
                  { kind: "bool", op: "and", expr: binaryNode("eq", col("p", "author_id"), col("u", "id")) },
                ],
                select: selectObject({ id: col("p", "id") }),
                limit: value(1, typeOf(t.integer())),
              }),
            },
            on: literalNode(true),
          },
        ],
        select: selectObject({ user: col("u", "id"), post: col("latest", "id") }),
      }),
      {
        sql: 'select "u"."id" as "c0", "latest"."id" as "c1" from "users" as "u" inner join lateral (select "p"."id" as "id" from "posts" as "p" where "p"."author_id" = "u"."id" limit $1) as "latest" on true',
        params: [1],
      },
    ),
  ],
  DIALECT_TABLES,
);

// ---------------------------------------------------------------------------
// Conditions and operators
// ---------------------------------------------------------------------------

export const WHERE_CASES: readonly SqlCase[] = withDialects(
  "where",
  [
    queryCase(
      "comparisons",
      users
        .where(({ u }) => u.id.eq(1))
        .where(({ u }) => u.id.neq(2))
        .where(({ u }) => u.age.gt(3))
        .where(({ u }) => u.age.gte(4))
        .where(({ u }) => u.age.lt(5))
        .where(({ u }) => u.age.lte(6))
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."id" = $1 and "u"."id" <> $2 and "u"."age" > $3 and "u"."age" >= $4 and "u"."age" < $5 and "u"."age" <= $6',
        params: [1, 2, 3, 4, 5, 6],
      },
    ),
    queryCase(
      "is distinct from, is null, is not null",
      users
        .where(({ u }) => u.name.isDistinctFrom(null))
        .where(({ u }) => u.age.isNull())
        .where(({ u }) => u.passwordHash.isNotNull())
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."name" is distinct from $1 and "u"."age" is null and "u"."password_hash" is not null',
        params: [null],
      },
    ),
    queryCase(
      "like, not like, ilike",
      users
        .where(({ u }) => u.email.like("%@example.com"))
        .where(({ u }) => u.email.notLike("admin%"))
        .where(({ u }) => u.name.ilike("ann%"))
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."email" like $1 and "u"."email" not like $2 and "u"."name" ilike $3',
        params: ["%@example.com", "admin%", "ann%"],
      },
    ),
    queryCase(
      "in and not in with a list are one array parameter",
      users
        .where(({ u }) => u.role.in(["admin", "member"]))
        .where(({ u }) => u.id.notIn([7, 8, 9]))
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."role" = any($1) and "u"."id" <> all($2)',
        params: [
          ["admin", "member"],
          [7, 8, 9],
        ],
      },
    ),
    queryCase(
      "in an empty list is false",
      users.where(({ u }) => u.id.in([])).select(({ u }) => u.id),
      { sql: 'select "u"."id" as "c0" from "users" as "u" where false', params: [] },
    ),
    queryCase(
      "in a subquery",
      users
        .where(({ u }) => u.id.in(posts.where(({ p }) => p.views.gt(100)).select(({ p }) => p.authorId)))
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."id" in (select "p"."author_id" as "c0" from "posts" as "p" where "p"."views" > $1)',
        params: [100],
      },
    ),
    queryCase(
      "not in a subquery",
      users.where(({ u }) => u.id.notIn(posts.select(({ p }) => p.authorId))).select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."id" not in (select "p"."author_id" as "c0" from "posts" as "p")',
        params: [],
      },
    ),
    queryCase(
      "in an array expression",
      rebuild(posts.ast, {
        wheres: [
          { kind: "bool", op: "and", expr: binaryNode("in", value("ts"), col("p", "tags", "tagList")) },
        ],
        select: selectOne(col("p", "id")),
      }),
      { sql: 'select "p"."id" as "c0" from "posts" as "p" where $1 = any("p"."tags")', params: ["ts"] },
    ),
    queryCase(
      "between",
      users.where(({ u }) => u.age.between(18, 65)).select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."age" between $1 and $2',
        params: [18, 65],
      },
    ),
    queryCase(
      "and, or and not nest with the parentheses they need",
      users
        .where(({ u }) => or(and(u.age.gte(18), u.role.eq("admin")), not(u.email.like("%@test"))))
        .where(({ u }) => or(u.name.isNull(), u.name.eq("x")))
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where (("u"."age" >= $1 and "u"."role" = $2) or not ("u"."email" like $3)) and ("u"."name" is null or "u"."name" = $4)',
        params: [18, "admin", "%@test", "x"],
      },
    ),
    queryCase(
      "where, where, orWhere is (a and b) or c",
      users
        .where(({ u }) => u.age.gte(18))
        .where(({ u }) => u.role.eq("admin"))
        .orWhere(({ u }) => u.id.eq(1))
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where ("u"."age" >= $1 and "u"."role" = $2) or "u"."id" = $3',
        params: [18, "admin", 1],
      },
    ),
    queryCase(
      "orWhere, then where, groups to the left",
      users
        .where(({ u }) => u.age.gte(18))
        .orWhere(({ u }) => u.id.eq(1))
        .where(({ u }) => u.role.eq("admin"))
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where ("u"."age" >= $1 or "u"."id" = $2) and "u"."role" = $3',
        params: [18, 1, "admin"],
      },
    ),
    queryCase(
      "the object form of where",
      users.where({ role: "admin", name: null, id: [1, 2] }).select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."role" = $1 and "u"."name" is null and "u"."id" = any($2)',
        params: ["admin", [1, 2]],
      },
    ),
    queryCase(
      "an empty where object is true",
      users.where({}).select(({ u }) => u.id),
      { sql: 'select "u"."id" as "c0" from "users" as "u" where true', params: [] },
    ),
    queryCase(
      "arithmetic keeps its grouping",
      posts
        .where(({ p }) =>
          p.views
            .add(1)
            .mul(2)
            .gt(p.views.sub(p.views.mod(3)).div(4)),
        )
        .select(({ p }) => p.views.neg()),
      {
        sql: 'select -"p"."views" as "c0" from "posts" as "p" where ("p"."views" + $1) * cast($2 as integer) > ("p"."views" - "p"."views" % $3) / cast($4 as integer)',
        params: [1, 2, 3, 4],
      },
    ),
    queryCase(
      "text functions and concatenation",
      users
        .where(({ u }) => u.email.lower().eq(u.email.upper().lower()))
        .select(({ u }) => u.email.concat(" <", u.role, ">")),
      {
        sql: 'select "u"."email" || $1 || "u"."role" || $2 as "c0" from "users" as "u" where lower("u"."email") = lower(upper("u"."email"))',
        params: [" <", ">"],
      },
    ),
    queryCase(
      "array operators",
      posts
        .where(({ p }) => p.tagList.contains(["ts"]))
        .where(({ p }) => p.tagList.containedBy(["ts", "js"]))
        .where(({ p }) => p.tagList.overlaps(["sql"]))
        .where(({ p }) => p.tagList.has("orm"))
        .select(({ p }) => ({ added: p.tagList.append("new"), removed: p.tagList.remove("old") })),
      {
        sql: 'select array_append("p"."tags", $1) as "c0", array_remove("p"."tags", $2) as "c1" from "posts" as "p" where "p"."tags" @> $3 and "p"."tags" <@ $4 and "p"."tags" && $5 and $6 = any("p"."tags")',
        params: ["new", "old", ["ts"], ["ts", "js"], ["sql"], "orm"],
      },
    ),
    queryCase(
      "JSON paths bind their keys",
      users
        .where(({ u }) => u.settings.pathText("theme").eq("dark"))
        .select(({ u }) => ({ theme: u.settings.path("theme"), first: u.settings.pathText("tags", 0) })),
      {
        sql: 'select "u"."settings" #> array[$1] as "c0", "u"."settings" #>> array[$2, $3] as "c1" from "users" as "u" where "u"."settings" #>> array[$4] = $5',
        params: ["theme", "tags", 0, "theme", "dark"],
      },
    ),
    queryCase(
      "coalesce, now and cast",
      posts
        .where(({ p }) => coalesce(p.publishedAt, now()).lt(since))
        .select(({ p }) => p.views.cast(t.string())),
      {
        sql: 'select cast("p"."views" as text) as "c0" from "posts" as "p" where coalesce("p"."published_at", now()) < $1',
        params: [since],
      },
    ),
    queryCase(
      "exists",
      users.where(({ u }) => exists(posts.where(({ p }) => p.authorId.eq(u.id)))).select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where exists (select 1 from "posts" as "p" where "p"."author_id" = "u"."id")',
        params: [],
      },
    ),
    queryCase(
      "a fragment with a value and an identifier",
      users
        .where(({ u }) => fragment`length(${u.email}) > ${val(3)}`.as<boolean>())
        .where(() => fragment`${fragment.ident("email")} is not null`.as<boolean>())
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where (length("u"."email") > $1) and ("email" is not null)',
        params: [3],
      },
    ),
    queryCase(
      "a fragment as an operand is parenthesised",
      users.where(({ u }) => fragment`${u.age} + 1`.as<number>().gt(10)).select(({ u }) => u.id),
      { sql: 'select "u"."id" as "c0" from "users" as "u" where ("u"."age" + 1) > $1', params: [10] },
    ),
    queryCase(
      "named parameters",
      users
        .where(({ u }) => u.age.gte(param("minAge", t.integer())))
        .where(({ u }) => u.role.eq(param("role", t.enum(["admin", "member"]))))
        .orWhere(({ u }) => u.age.lt(param("minAge", t.integer())))
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where ("u"."age" >= $1 and "u"."role" = $2) or "u"."age" < $3',
        params: [21, "admin", 21],
      },
      { named: { minAge: 21, role: "admin" } },
    ),
    queryCase(
      "a tuple comparison",
      rebuild(posts.ast, {
        wheres: [
          {
            kind: "bool",
            op: "and",
            expr: binaryNode(
              "gt",
              tupleNode([col("p", "created_at", "createdAt"), col("p", "id")]),
              tupleNode([value(since), value(10)]),
            ),
          },
        ],
        select: selectOne(col("p", "id")),
      }),
      {
        sql: 'select "p"."id" as "c0" from "posts" as "p" where ("p"."created_at", "p"."id") > ($1, $2)',
        params: [since, 10],
      },
    ),
    queryCase(
      "a unary minus of a negative literal keeps its parentheses",
      rebuild(posts.ast, {
        select: selectObject({
          a: unaryNode("neg", literalNode(-1)),
          b: binaryNode("sub", col("p", "views"), literalNode(-1)),
          c: unaryNode("neg", unaryNode("neg", col("p", "views"))),
        }),
      }),
      {
        sql: 'select -(-1) as "c0", "p"."views" - -1 as "c1", -(-"p"."views") as "c2" from "posts" as "p"',
        params: [],
      },
    ),
    queryCase(
      "comparisons nested in comparisons are parenthesised",
      rebuild(users.ast, {
        wheres: [
          {
            kind: "bool",
            op: "and",
            expr: binaryNode(
              "eq",
              binaryNode("gte", col("u", "age"), value(18)),
              unaryNode("isNull", binaryNode("eq", col("u", "name"), col("u", "email"))),
            ),
          },
        ],
        select: selectOne(col("u", "id")),
      }),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where ("u"."age" >= $1) = (("u"."name" = "u"."email") is null)',
        params: [18],
      },
    ),
    queryCase(
      "right-nested arithmetic and concatenation keep their parentheses; left-nested need none",
      rebuild(posts.ast, {
        select: selectObject({
          subRight: binaryNode("sub", col("p", "views"), binaryNode("sub", col("p", "views"), value(1))),
          subLeft: binaryNode("sub", binaryNode("sub", col("p", "views"), col("p", "views")), value(2)),
          divRight: binaryNode("div", col("p", "views"), binaryNode("mul", literalNode(2), literalNode(3))),
          modRight: binaryNode("mod", col("p", "views"), binaryNode("mod", literalNode(7), literalNode(4))),
          mulRight: binaryNode(
            "mul",
            col("p", "views"),
            binaryNode("add", col("p", "views"), literalNode(1)),
          ),
          addLeft: binaryNode("add", binaryNode("mul", col("p", "views"), col("p", "views")), literalNode(1)),
          concatRight: binaryNode(
            "concat",
            col("p", "title"),
            binaryNode("concat", col("p", "title"), value("!")),
          ),
          concatLeft: binaryNode(
            "concat",
            binaryNode("concat", col("p", "title"), value("?")),
            col("p", "title"),
          ),
        }),
      }),
      {
        sql: 'select "p"."views" - ("p"."views" - $1) as "c0", "p"."views" - "p"."views" - $2 as "c1", "p"."views" / (2 * 3) as "c2", "p"."views" % (7 % 4) as "c3", "p"."views" * ("p"."views" + 1) as "c4", "p"."views" * "p"."views" + 1 as "c5", "p"."title" || ("p"."title" || $3) as "c6", "p"."title" || $4 || "p"."title" as "c7" from "posts" as "p"',
        params: [1, 2, "!", "?"],
      },
    ),
    queryCase(
      "comparisons and booleans mixed keep their parentheses",
      rebuild(posts.ast, {
        wheres: [
          {
            kind: "bool",
            op: "and",
            expr: naryNode("or", [
              binaryNode(
                "eq",
                binaryNode("eq", col("p", "id"), value(1)),
                binaryNode("lt", binaryNode("add", col("p", "views"), literalNode(1)), value(2)),
              ),
              naryNode("and", [
                col("p", "published"),
                naryNode("or", [
                  unaryNode("isNull", col("p", "body")),
                  unaryNode("not", col("p", "published")),
                ]),
              ]),
              unaryNode("not", naryNode("and", [col("p", "published"), col("p", "published")])),
            ]),
          },
        ],
        select: selectOne(col("p", "id")),
      }),
      {
        sql: 'select "p"."id" as "c0" from "posts" as "p" where ("p"."id" = $1) = ("p"."views" + 1 < $2) or ("p"."published" and ("p"."body" is null or not "p"."published")) or not ("p"."published" and "p"."published")',
        params: [1, 2],
      },
    ),
    queryCase(
      "a coalesce with a typed argument, compared with an untyped value, is cast and compares as a number",
      users.where(() => coalesce(val(1, t.integer()), val(2)).eq(val(1))).select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where coalesce(cast($1 as integer), $2) = $3',
        params: [1, 2, 1],
      },
    ),
  ],
  DIALECT_TABLES,
);

// ---------------------------------------------------------------------------
// Aggregates and windows
// ---------------------------------------------------------------------------

export const AGGREGATE_CASES: readonly SqlCase[] = withDialects(
  "aggregates",
  [
    queryCase(
      "aggregates",
      posts.select(({ p }) => ({
        all: count(),
        ids: count(p.id),
        authors: countDistinct(p.authorId),
        views: sum(p.views),
        average: avg(p.views),
        first: min(p.createdAt),
        last: max(p.createdAt),
        titles: arrayAgg(p.title),
        json: jsonAgg(p.id),
        joined: stringAgg(p.title, ", "),
      })),
      {
        sql: 'select count(*) as "c0", count("p"."id") as "c1", count(distinct "p"."author_id") as "c2", sum("p"."views") as "c3", cast(avg("p"."views") as double precision) as "c4", min("p"."created_at") as "c5", max("p"."created_at") as "c6", array_agg("p"."title") as "c7", json_agg("p"."id") as "c8", string_agg("p"."title", $1) as "c9" from "posts" as "p"',
        params: [", "],
      },
    ),
    queryCase(
      "group by and having",
      posts
        .groupBy(({ p }) => p.authorId)
        .having(({ p }) => count(p.id).gt(2))
        .select(({ p }) => ({ author: p.authorId, n: count(p.id) })),
      {
        sql: 'select "p"."author_id" as "c0", count("p"."id") as "c1" from "posts" as "p" group by "p"."author_id" having count("p"."id") > $1',
        params: [2],
      },
    ),
    queryCase(
      "an aggregate with a filter",
      posts.select(({ p }) => count(p.id).filter(p.published)),
      {
        sql: 'select count("p"."id") filter (where "p"."published") as "c0" from "posts" as "p"',
        params: [],
      },
    ),
    queryCase(
      "a window function over an inline window",
      posts.select(({ p }) => ({
        id: p.id,
        running: sum(p.views).over({ partitionBy: [p.authorId], orderBy: [p.createdAt.asc()] }),
        total: count().over(),
      })),
      {
        sql: 'select "p"."id" as "c0", sum("p"."views") over (partition by "p"."author_id" order by "p"."created_at" asc) as "c1", count(*) over () as "c2" from "posts" as "p"',
        params: [],
      },
    ),
    queryCase(
      "a named window and a window frame",
      rebuild(posts.ast, {
        select: selectObject({
          id: col("p", "id"),
          rank: aggregateNode("count", [STAR], false, undefined, "w"),
          framed: aggregateNode(
            "sum",
            [col("p", "views")],
            false,
            undefined,
            windowNode(
              [col("p", "author_id", "authorId")],
              [orderNode(col("p", "id"), "asc", undefined)],
              frag`rows between unbounded preceding and current row`,
            ),
          ),
        }),
        windows: [
          {
            kind: "windowDef",
            name: "w",
            spec: windowNode([binaryNode("mod", col("p", "views"), value(10))], [], undefined),
          },
        ],
      }),
      {
        sql: 'select "p"."id" as "c0", count(*) over "w" as "c1", sum("p"."views") over (partition by "p"."author_id" order by "p"."id" asc rows between unbounded preceding and current row) as "c2" from "posts" as "p" window "w" as (partition by "p"."views" % $1)',
        params: [10],
      },
    ),
  ],
  DIALECT_TABLES,
);

// ---------------------------------------------------------------------------
// Ordering, paging, locks and database schemas
// ---------------------------------------------------------------------------

export const CLAUSE_CASES: readonly SqlCase[] = withDialects(
  "clauses",
  [
    queryCase(
      "order by with directions and nulls",
      users
        .orderBy(({ u }) => [u.name.asc().nullsFirst(), u.createdAt.desc().nullsLast(), u.id])
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" order by "u"."name" asc nulls first, "u"."created_at" desc nulls last, "u"."id" asc',
        params: [],
      },
    ),
    queryCase(
      "reverseOrder swaps every direction",
      users
        .orderBy(({ u }) => [u.name.asc().nullsFirst(), u.id.desc()])
        .reverseOrder()
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" order by "u"."name" desc nulls last, "u"."id" asc',
        params: [],
      },
    ),
    queryCase(
      "limit and offset are bound",
      users
        .limit(10)
        .offset(20)
        .select(({ u }) => u.id),
      { sql: 'select "u"."id" as "c0" from "users" as "u" limit $1 offset $2', params: [10, 20] },
    ),
    queryCase(
      "limit and offset as named parameters",
      users
        .limit(param("pageSize", t.integer()))
        .offset(param("skip", t.integer()))
        .select(({ u }) => u.id),
      { sql: 'select "u"."id" as "c0" from "users" as "u" limit $1 offset $2', params: [10, 0] },
      { named: { pageSize: 10, skip: 0 } },
    ),
    ...(
      [
        ["update", {}, "for update"],
        ["update", { skipLocked: true }, "for update skip locked"],
        ["update", { noWait: true }, "for update nowait"],
        ["share", {}, "for share"],
        ["share", { skipLocked: true }, "for share skip locked"],
        ["share", { noWait: true }, "for share nowait"],
        ["noKeyUpdate", {}, "for no key update"],
        ["noKeyUpdate", { skipLocked: true }, "for no key update skip locked"],
        ["noKeyUpdate", { noWait: true }, "for no key update nowait"],
        ["keyShare", {}, "for key share"],
        ["keyShare", { skipLocked: true }, "for key share skip locked"],
        ["keyShare", { noWait: true }, "for key share nowait"],
      ] as const
    ).map(([mode, options, clause]) =>
      queryCase(
        `lock ${mode} ${JSON.stringify(options)}`,
        users.lock(mode, options).select(({ u }) => u.id),
        {
          sql: `select "u"."id" as "c0" from "users" as "u" ${clause}`,
          params: [],
        },
      ),
    ),
    queryCase(
      "a lock given as a fragment",
      users.lock(fragment`for update of ${fragment.ident("u")}`).select(({ u }) => u.id),
      { sql: 'select "u"."id" as "c0" from "users" as "u" for update of "u"', params: [] },
    ),
    queryCase(
      "the schema argument places every table",
      users.joinAssoc("u", "posts", "p"),
      {
        sql: 'select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "tenant_1"."users" as "u" inner join "tenant_1"."posts" as "p" on "p"."author_id" = "u"."id"',
        params: [],
      },
      {
        schema: "tenant_1",
      },
    ),
    queryCase(
      "a query's schema wins over the argument",
      users.schema("archive"),
      {
        sql: 'select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "archive"."users" as "u"',
        params: [],
      },
      {
        schema: "tenant_1",
      },
    ),
    queryCase(
      "a schema's own database schema wins over the query's",
      from(AuditLog, "a").schema("archive"),
      {
        sql: 'select "a"."id" as "c0", "a"."action" as "c1", "a"."user_id" as "c2" from "audit"."audit_logs" as "a"',
        params: [],
      },
      { schema: "tenant_1" },
    ),
    queryCase(
      "a subquery inherits the query's schema",
      users
        .schema("archive")
        .where(({ u }) => u.id.in(posts.select(({ p }) => p.authorId)))
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "archive"."users" as "u" where "u"."id" in (select "p"."author_id" as "c0" from "archive"."posts" as "p")',
        params: [],
      },
    ),
  ],
  DIALECT_TABLES,
);

// ---------------------------------------------------------------------------
// Nested queries: subqueries, sources, CTEs, set operations, hints
// ---------------------------------------------------------------------------

const authorsAst = rebuild(posts.ast, {
  select: selectObject({ author: col("p", "author_id", "authorId") }),
});

// with recursive "n" as ((values …) union all (select … from "n" …)) select sum(…) from "n"
const recursiveTree = (() => {
  const integer = typeOf(t.integer());
  const step = rebuild(bareQuery({ kind: "cteSource", name: "n", meta: undefined, alias: "n" }), {
    wheres: [{ kind: "bool", op: "and", expr: binaryNode("lt", col("n", "i"), value(5, integer)) }],
    select: selectObject({ i: binaryNode("add", col("n", "i"), value(1, integer)) }),
  });
  const body = rebuild(
    bareQuery({ kind: "values", columns: ["i"], rows: [[value(1, integer)]], alias: "v" }),
    {
      select: selectObject({ i: col("v", "i") }),
      combinations: [{ kind: "combination", op: "union", all: true, query: step }],
    },
  );
  return rebuild(bareQuery({ kind: "cteSource", name: "n", meta: undefined, alias: "n" }), {
    ctes: [
      { kind: "cte", name: "n", query: body, operation: "all", recursive: true, materialized: undefined },
    ],
    select: selectOne(aggregateNode("sum", [col("n", "i")], false, undefined, undefined)),
  });
})();

export const NESTED_CASES: readonly SqlCase[] = withDialects(
  "nested",
  [
    queryCase(
      "a scalar subquery in the select list",
      rebuild(users.ast, {
        select: selectObject({
          id: col("u", "id"),
          posts: subqueryNode(
            rebuild(posts.ast, {
              wheres: [
                { kind: "bool", op: "and", expr: binaryNode("eq", col("p", "author_id"), col("u", "id")) },
              ],
              select: selectOne(aggregateNode("count", [STAR], false, undefined, undefined)),
            }),
          ),
        }),
      }),
      {
        sql: 'select "u"."id" as "c0", (select count(*) as "c0" from "posts" as "p" where "p"."author_id" = "u"."id") as "c1" from "users" as "u"',
        params: [],
      },
    ),
    queryCase(
      "a subquery as the source, selected whole",
      rebuild(
        bareQuery({ kind: "subquerySource", query: posts.where(({ p }) => p.views.gt(10)).ast, alias: "s" }),
        {
          select: selectBinding("s", meta(Post)),
        },
      ),
      {
        sql: 'select "s"."id" as "c0", "s"."author_id" as "c1", "s"."title" as "c2", "s"."body" as "c3", "s"."published" as "c4", "s"."views" as "c5", "s"."tags" as "c6", "s"."published_at" as "c7", "s"."created_at" as "c8", "s"."updated_at" as "c9" from (select "p"."id" as "id", "p"."author_id" as "author_id", "p"."title" as "title", "p"."body" as "body", "p"."published" as "published", "p"."views" as "views", "p"."tags" as "tags", "p"."published_at" as "published_at", "p"."created_at" as "created_at", "p"."updated_at" as "updated_at" from "posts" as "p" where "p"."views" > $1) as "s"',
        params: [10],
      },
    ),
    queryCase(
      "a subquery source with an object select, read by name",
      rebuild(bareQuery({ kind: "subquerySource", query: authorsAst, alias: "s" }), {
        select: selectObject({ author: col("s", "author") }),
        groupBys: [col("s", "author")],
      }),
      {
        sql: 'select "s"."author" as "c0" from (select "p"."author_id" as "author" from "posts" as "p") as "s" group by "s"."author"',
        params: [],
      },
    ),
    queryCase(
      "a CTE, materialized and not",
      rebuild(bareQuery({ kind: "cteSource", name: "recent", meta: meta(Post), alias: "r" }), {
        ctes: [
          {
            kind: "cte",
            name: "recent",
            query: posts.where(({ p }) => p.createdAt.gt(since)).ast,
            operation: "all",
            recursive: false,
            materialized: true,
          },
          {
            kind: "cte",
            name: "authors",
            query: authorsAst,
            operation: "all",
            recursive: false,
            materialized: false,
          },
        ],
        wheres: [
          {
            kind: "bool",
            op: "and",
            expr: existsNode(
              rebuild(bareQuery({ kind: "cteSource", name: "authors", meta: undefined, alias: "au" }), {
                wheres: [
                  {
                    kind: "bool",
                    op: "and",
                    expr: binaryNode("eq", col("au", "author"), col("r", "author_id")),
                  },
                ],
              }),
            ),
          },
        ],
        select: selectBinding("r", meta(Post)),
      }),
      {
        sql: 'with "recent" as materialized (select "p"."id" as "id", "p"."author_id" as "author_id", "p"."title" as "title", "p"."body" as "body", "p"."published" as "published", "p"."views" as "views", "p"."tags" as "tags", "p"."published_at" as "published_at", "p"."created_at" as "created_at", "p"."updated_at" as "updated_at" from "posts" as "p" where "p"."created_at" > $1), "authors" as not materialized (select "p"."author_id" as "author" from "posts" as "p") select "r"."id" as "c0", "r"."author_id" as "c1", "r"."title" as "c2", "r"."body" as "c3", "r"."published" as "c4", "r"."views" as "c5", "r"."tags" as "c6", "r"."published_at" as "c7", "r"."created_at" as "c8", "r"."updated_at" as "c9" from "recent" as "r" where exists (select 1 from "authors" as "au" where "au"."author" = "r"."author_id")',
        params: [since],
      },
    ),
    queryCase("a recursive CTE", recursiveTree, {
      sql: 'with recursive "n" as (select "v"."i" as "i" from (values (cast($1 as integer))) as "v" ("i") union all (select "n"."i" + cast($2 as integer) as "i" from "n" as "n" where "n"."i" < $3)) select sum("n"."i") as "c0" from "n" as "n"',
      params: [1, 1, 5],
    }),
    statementCase(
      "a CTE with a fragment body",
      // The fragment is the database's own SQL: a set-returning function on Postgres, a plain select elsewhere.
      (compiler) =>
        compiler.compile(
          rebuild(bareQuery({ kind: "cteSource", name: "series", meta: undefined, alias: "g" }), {
            ctes: [
              {
                kind: "cte",
                name: "series",
                query: CTE_BODIES[compiler.dialect.name],
                operation: "all",
                recursive: false,
                materialized: undefined,
              },
            ],
            select: selectOne(col("g", "n")),
          }),
          "all",
          undefined,
        ),
      [3],
      {
        sql: 'with "series" as (select generate_series(1, cast($1 as integer)) as n) select "g"."n" as "c0" from "series" as "g"',
        params: [3],
      },
    ),
    queryCase(
      "union all with an order and a limit on the result",
      rebuild(users.where(({ u }) => u.age.lt(18)).select(({ u }) => ({ id: u.id })).ast, {
        combinations: [
          {
            kind: "combination",
            op: "union",
            all: true,
            query: rebuild(posts.where(({ p }) => p.views.gt(5)).ast, {
              select: selectObject({ id: col("p", "author_id", "authorId") }),
            }),
          },
        ],
        orderBys: [orderNode(col("u", "id"), "desc", undefined)],
        limit: value(10, typeOf(t.integer())),
      }),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."age" < $1 union all (select "p"."author_id" as "c0" from "posts" as "p" where "p"."views" > $2) order by "c0" desc limit $3',
        params: [18, 5, 10],
      },
    ),
    queryCase(
      "intersect and except",
      rebuild(users.select(({ u }) => u.id).ast, {
        combinations: [
          { kind: "combination", op: "intersect", all: false, query: authorsAst },
          {
            kind: "combination",
            op: "except",
            all: false,
            query: rebuild(from(Comment, "c").ast, { select: selectOne(col("c", "author_id", "authorId")) }),
          },
        ],
      }),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" intersect (select "p"."author_id" as "c0" from "posts" as "p") except (select "c"."author_id" as "c0" from "comments" as "c")',
        params: [],
      },
    ),
    queryCase(
      "an intersect after a union applies to the union",
      rebuild(users.select(({ u }) => u.id).ast, {
        combinations: [
          { kind: "combination", op: "union", all: false, query: authorsAst },
          {
            kind: "combination",
            op: "intersect",
            all: true,
            query: rebuild(from(Comment, "c").ast, { select: selectOne(col("c", "author_id", "authorId")) }),
          },
        ],
      }),
      {
        sql: '(select "u"."id" as "c0" from "users" as "u" union (select "p"."author_id" as "c0" from "posts" as "p")) intersect all (select "c"."author_id" as "c0" from "comments" as "c")',
        params: [],
      },
    ),
    queryCase(
      "a CTE that deletes and returns rows",
      rebuild(bareQuery({ kind: "cteSource", name: "gone", meta: meta(Post), alias: "g" }), {
        ctes: [
          {
            kind: "cte",
            name: "gone",
            query: rebuild(posts.where(({ p }) => p.views.lt(5)).ast, {
              select: selectBinding("p", meta(Post)),
            }),
            operation: "deleteAll",
            recursive: false,
            materialized: undefined,
          },
        ],
        select: selectOne(aggregateNode("count", [STAR], false, undefined, undefined)),
      }),
      {
        sql: 'with "gone" as (delete from "posts" as "p" where "p"."views" < $1 returning "p"."id" as "id", "p"."author_id" as "author_id", "p"."title" as "title", "p"."body" as "body", "p"."published" as "published", "p"."views" as "views", "p"."tags" as "tags", "p"."published_at" as "published_at", "p"."created_at" as "created_at", "p"."updated_at" as "updated_at") select count(*) as "c0" from "gone" as "g"',
        params: [5],
      },
    ),
    queryCase(
      "union of whole rows from two database schemas has no single origin",
      rebuild(users.ast, {
        combinations: [
          { kind: "combination", op: "union", all: false, query: rebuild(users.ast, { schema: "archive" }) },
        ],
      }),
      {
        sql: 'select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "users" as "u" union (select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "archive"."users" as "u")',
        params: [],
      },
    ),
    queryCase(
      "a values list as a source",
      rebuild(
        bareQuery({
          kind: "values",
          columns: ["id", "label"],
          rows: [
            [value(1, typeOf(t.integer())), value("one")],
            [value(2, typeOf(t.integer())), value("two")],
          ],
          alias: "v",
        }),
        { select: selectObject({ id: col("v", "id"), label: col("v", "label") }) },
      ),
      {
        sql: 'select "v"."id" as "c0", "v"."label" as "c1" from (values (cast($1 as integer), cast($2 as text)), (cast($3 as integer), cast($4 as text))) as "v" ("id", "label")',
        params: [1, "one", 2, "two"],
      },
    ),
    statementCase(
      "a fragment as a source",
      // A set-returning function on Postgres; a parenthesised select elsewhere.
      (compiler) =>
        compiler.compile(
          rebuild(
            bareQuery({
              kind: "fragmentSource",
              fragment: SOURCE_FRAGMENTS[compiler.dialect.name],
              columns: ["n"],
              alias: "g",
            }),
            { select: selectOne(col("g", "n")) },
          ),
          "all",
          undefined,
        ),
      [1, 3],
      {
        sql: 'select "g"."n" as "c0" from generate_series(cast($1 as integer), cast($2 as integer)) as "g" ("n")',
        params: [1, 3],
      },
    ),
    statementCase(
      "a table hint",
      // A hint is the database's own syntax: each dialect gets one it accepts.
      (compiler) =>
        compiler.compile(
          rebuild(posts.ast, {
            hints: [TABLE_HINTS[compiler.dialect.name]],
            select: selectOne(aggregateNode("count", [STAR], false, undefined, undefined)),
          }),
          "all",
          undefined,
        ),
      [50],
      {
        sql: 'select count(*) as "c0" from "posts" as "p" tablesample system (cast($1 as integer))',
        params: [50],
      },
    ),
    queryCase(
      "every expression kind built by hand",
      rebuild(users.ast, {
        wheres: [
          {
            kind: "bool",
            op: "and",
            expr: naryNode("and", [
              binaryNode("in", col("u", "id"), listNode([1, 2], typeOf(t.integer()), false)),
              binaryNode(
                "gt",
                fnNode("coalesce", [col("u", "age"), value(0, typeOf(t.integer()))]),
                value(1, typeOf(t.integer())),
              ),
            ]),
          },
        ],
        select: selectObject({
          kind: caseNode(
            [{ when: unaryNode("isNull", col("u", "age")), result: value("unknown") }],
            value("known"),
          ),
          path: jsonPathNode(col("u", "settings"), [value("theme")], false),
          empty: naryNode("or", []),
        }),
      }),
      {
        sql: 'select case when "u"."age" is null then cast($1 as text) else cast($2 as text) end as "c0", "u"."settings" #> array[$3] as "c1", false as "c2" from "users" as "u" where "u"."id" = any($4) and coalesce("u"."age", $5) > $6',
        params: ["unknown", "known", "theme", [1, 2], 0, 1],
      },
    ),
  ],
  DIALECT_TABLES,
);

// ---------------------------------------------------------------------------
// Bulk updates and deletes (queries compiled as updateAll / deleteAll)
// ---------------------------------------------------------------------------

const viewsPlusOne = binaryNode("add", col("p", "views"), value(1, typeOf(t.integer())));

export const BULK_CASES: readonly SqlCase[] = withDialects(
  "bulk",
  [
    queryCase(
      "updateAll with set and where",
      rebuild(posts.where(({ p }) => p.authorId.eq(1)).ast, {
        updates: [
          { kind: "update", field: "views", column: "views", value: viewsPlusOne },
          {
            kind: "update",
            field: "published",
            column: "published",
            value: value(true, typeOf(t.boolean())),
          },
        ],
      }),
      {
        sql: 'update "posts" as "p" set "views" = "p"."views" + $1, "published" = $2 where "p"."author_id" = $3',
        params: [1, true, 1],
      },
      { operation: "updateAll" },
    ),
    queryCase(
      "updateAll with a join and returning",
      rebuild(posts.join(User, "u", ({ p, u }) => u.id.eq(p.authorId)).where(({ u }) => u.age.gte(18)).ast, {
        updates: [{ kind: "update", field: "views", column: "views", value: viewsPlusOne }],
        select: selectOne(col("p", "id")),
      }),
      {
        sql: 'update "posts" as "p" set "views" = "p"."views" + $1 from "users" as "u" where "u"."id" = "p"."author_id" and "u"."age" >= $2 returning "p"."id" as "c0"',
        params: [1, 18],
      },
      { operation: "updateAll" },
    ),
    queryCase(
      "updateAll returning whole rows",
      rebuild(posts.ast, {
        updates: [{ kind: "update", field: "views", column: "views", value: literalNode(0) }],
        select: selectBinding("p", meta(Post)),
      }),
      {
        sql: 'update "tenant_1"."posts" as "p" set "views" = 0 returning "p"."id" as "c0", "p"."author_id" as "c1", "p"."title" as "c2", "p"."body" as "c3", "p"."published" as "c4", "p"."views" as "c5", "p"."tags" as "c6", "p"."published_at" as "c7", "p"."created_at" as "c8", "p"."updated_at" as "c9"',
        params: [],
      },
      { operation: "updateAll", schema: "tenant_1" },
    ),
    queryCase(
      "deleteAll with where",
      posts.where(({ p }) => p.views.lt(1)),
      { sql: 'delete from "posts" as "p" where "p"."views" < $1', params: [1] },
      { operation: "deleteAll" },
    ),
    queryCase(
      "deleteAll with a join and returning",
      rebuild(posts.join(User, "u", ({ p, u }) => u.id.eq(p.authorId)).where(({ u }) => u.age.lt(13)).ast, {
        select: selectOne(col("p", "id")),
      }),
      {
        sql: 'delete from "posts" as "p" using "users" as "u" where "u"."id" = "p"."author_id" and "u"."age" < $1 returning "p"."id" as "c0"',
        params: [13],
      },
      { operation: "deleteAll" },
    ),
  ],
  DIALECT_TABLES,
);

// ---------------------------------------------------------------------------
// Row-level writes, fragments and explain
// ---------------------------------------------------------------------------

const userMeta = meta(User);
const tagMeta = meta(Tag);
const field = (schemaMeta: typeof userMeta, name: string) =>
  schemaMeta.fieldsByName.get(name) as NonNullable<ReturnType<typeof schemaMeta.fieldsByName.get>>;
const [uid, email, name, role, lockVersion] = ["id", "email", "name", "role", "lockVersion"].map((n) =>
  field(userMeta, n),
) as [
  ReturnType<typeof field>,
  ReturnType<typeof field>,
  ReturnType<typeof field>,
  ReturnType<typeof field>,
  ReturnType<typeof field>,
];
const tagName = field(tagMeta, "name");
const tagId = field(tagMeta, "id");

export const WRITE_CASES: readonly SqlCase[] = withDialects(
  "writes",
  [
    statementCase(
      "insert one row and return its key",
      (c) =>
        c.compileInsert(
          userMeta,
          [email, name],
          { source: { kind: "values", rows: 1 }, returning: [uid], onConflict: undefined },
          undefined,
        ),
      ["a@example.com", "Ann"],
      {
        sql: 'insert into "users" ("email", "name") values ($1, $2) returning "id" as "c0"',
        params: ["a@example.com", "Ann"],
      },
    ),
    statementCase(
      "insert three rows",
      (c) =>
        c.compileInsert(
          tagMeta,
          [tagName],
          { source: { kind: "values", rows: 3 }, returning: [], onConflict: undefined },
          undefined,
        ),
      ["one", "two", "three"],
      { sql: 'insert into "tags" ("name") values ($1), ($2), ($3)', params: ["one", "two", "three"] },
    ),
    statementCase(
      "insert a row of defaults",
      (c) =>
        c.compileInsert(
          tagMeta,
          [],
          { source: { kind: "values", rows: 1 }, returning: [tagId], onConflict: undefined },
          undefined,
        ),
      [],
      { sql: 'insert into "tags" default values returning "id" as "c0"', params: [] },
    ),
    statementCase(
      "insert two rows of defaults",
      (c) =>
        c.compileInsert(
          tagMeta,
          [],
          { source: { kind: "values", rows: 2 }, returning: [], onConflict: undefined },
          undefined,
        ),
      [],
      { sql: 'insert into "tags" ("id") values (default), (default)', params: [] },
    ),
    statementCase(
      "insert cells: values, defaults, an expression and a shared placeholder",
      (c) =>
        c.compileInsert(
          userMeta,
          [email, role, name],
          {
            source: {
              kind: "cells",
              rows: [
                [
                  { kind: "value" },
                  { kind: "default" },
                  { kind: "expr", expr: fnNode("upper", [value("bo")]) },
                ],
                [{ kind: "value" }, { kind: "value" }, { kind: "placeholder", name: "who" }],
              ],
            },
            returning: [uid],
            onConflict: undefined,
          },
          undefined,
        ),
      ["b@example.com", "bo", "c@example.com", "admin"],
      {
        sql: 'insert into "users" ("email", "role", "name") values ($1, default, upper($2)), ($3, $4, $5) returning "id" as "c0"',
        params: ["b@example.com", "bo", "c@example.com", "admin", "Cy"],
      },
      { who: "Cy" },
    ),
    statementCase(
      "insert from a query",
      (c) =>
        c.compileInsert(
          tagMeta,
          [tagName],
          {
            source: {
              kind: "query",
              query: users.where(({ u }) => u.id.lte(3)).select(({ u }) => u.email).ast,
            },
            returning: [],
            onConflict: undefined,
          },
          undefined,
        ),
      [3],
      {
        sql: 'insert into "tags" ("name") select "u"."email" as "c0" from "users" as "u" where "u"."id" <= $1',
        params: [3],
      },
    ),
    statementCase(
      "insert or do nothing",
      (c) =>
        c.compileInsert(
          tagMeta,
          [tagName],
          { source: { kind: "values", rows: 1 }, returning: [], onConflict: "nothing" },
          undefined,
        ),
      ["dup"],
      { sql: 'insert into "tags" ("name") values ($1) on conflict do nothing', params: ["dup"] },
    ),
    statementCase(
      "insert or update every column on a field conflict",
      (c) =>
        c.compileInsert(
          userMeta,
          [email, name],
          {
            source: { kind: "values", rows: 1 },
            returning: [uid],
            onConflict: { target: [email], update: "all" },
          },
          undefined,
        ),
      ["d@example.com", "Di"],
      {
        sql: 'insert into "users" ("email", "name") values ($1, $2) on conflict ("email") do update set "email" = "excluded"."email", "name" = "excluded"."name" returning "id" as "c0"',
        params: ["d@example.com", "Di"],
      },
    ),
    statementCase(
      "insert or update named fields on a named constraint",
      (c) =>
        c.compileInsert(
          userMeta,
          [email, name, role],
          {
            source: { kind: "values", rows: 1 },
            returning: [],
            onConflict: { target: { constraint: "users_email_key" }, update: [name] },
          },
          undefined,
        ),
      ["e@example.com", "Ed", "member"],
      {
        sql: 'insert into "users" ("email", "name", "role") values ($1, $2, $3) on conflict on constraint "users_email_key" do update set "name" = "excluded"."name"',
        params: ["e@example.com", "Ed", "member"],
      },
    ),
    statementCase(
      "insert or update all but some on a fragment target",
      (c) =>
        c.compileInsert(
          tagMeta,
          [tagName],
          {
            source: { kind: "values", rows: 1 },
            returning: [tagId],
            onConflict: { target: frag`(${identNode("name")})`, update: "all" },
          },
          undefined,
        ),
      ["frag"],
      {
        sql: 'insert into "tags" ("name") values ($1) on conflict ("name") do update set "name" = "excluded"."name" returning "id" as "c0"',
        params: ["frag"],
      },
      undefined,
    ),
    statementCase(
      "update one row with an optimistic lock",
      (c) => c.compileUpdate(userMeta, [name, lockVersion], [uid, lockVersion], [lockVersion], undefined),
      ["New", 2, 1, 1],
      {
        sql: 'update "users" set "name" = $1, "lock_version" = $2 where "id" = $3 and "lock_version" = $4 returning "lock_version" as "c0"',
        params: ["New", 2, 1, 1],
      },
    ),
    statementCase(
      "update a row of a schema with its own database schema",
      (c) =>
        c.compileUpdate(
          meta(AuditLog),
          [field(meta(AuditLog), "action")],
          [field(meta(AuditLog), "id")],
          [],
          undefined,
        ),
      ["login", 1],
      { sql: 'update "audit"."audit_logs" set "action" = $1 where "id" = $2', params: ["login", 1] },
    ),
    statementCase(
      "delete one row in a given database schema",
      (c) => c.compileDelete(userMeta, [uid], [uid, email], "tenant_1"),
      [1],
      {
        sql: 'delete from "tenant_1"."users" where "id" = $1 returning "id" as "c0", "email" as "c1"',
        params: [1],
      },
    ),
    statementCase(
      "a fragment as a whole statement",
      (c) =>
        c.compileFragment(
          frag`select ${value(1, typeOf(t.integer()))} + ${value(2, typeOf(t.integer()))} as ${identNode("total")}`,
        ),
      [1, 2],
      { sql: 'select cast($1 as integer) + cast($2 as integer) as "total"', params: [1, 2] },
    ),
    statementCase(
      "explain with options",
      (c) =>
        c.compileExplain(users.where(({ u }) => u.id.eq(1)).ast, "all", undefined, {
          analyze: true,
          format: "json",
        }),
      [1],
      {
        sql: 'explain (analyze, format json) select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "users" as "u" where "u"."id" = $1',
        params: [1],
      },
    ),
    statementCase("explain without options", (c) => c.compileExplain(users.ast, "all", undefined, {}), [], {
      sql: 'explain select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "users" as "u"',
      params: [],
    }),
  ],
  DIALECT_TABLES,
);

// ---------------------------------------------------------------------------
// Casts: bound values typed by an operator's other operand or by a column
// ---------------------------------------------------------------------------

const memberships = from(Membership, "m");
const int = (n: number) => val(n, t.integer());
const orgKey = "00000000-0000-4000-8000-000000000001";

export const CAST_CASES: readonly SqlCase[] = withDialects(
  "casts",
  [
    queryCase(
      "arithmetic of a typed value and a plain one in where: both are cast",
      posts.where(({ p }) => p.views.eq(int(3).add(4))).select(({ p }) => p.id),
      {
        sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."views" = cast($1 as integer) + cast($2 as integer)',
        params: [3, 4],
      },
    ),
    queryCase(
      "every arithmetic operator, and unary minus, on typed values in a select",
      users
        .select(() => ({
          add: int(7).add(2),
          sub: int(7).sub(2),
          mul: int(7).mul(2),
          div: int(7).div(2),
          mod: int(7).mod(2),
          neg: int(7).neg(),
        }))
        .limit(1),
      {
        sql: 'select cast($1 as integer) + cast($2 as integer) as "c0", cast($3 as integer) - cast($4 as integer) as "c1", cast($5 as integer) * cast($6 as integer) as "c2", cast($7 as integer) / cast($8 as integer) as "c3", cast($9 as integer) % cast($10 as integer) as "c4", -cast($11 as integer) as "c5" from "users" as "u" limit $12',
        params: [7, 2, 7, 2, 7, 2, 7, 2, 7, 2, 7, 1],
      },
    ),
    queryCase(
      "arithmetic of typed values nested and beside a column: only bound pairs are cast",
      posts
        .where(({ p }) => p.views.lt(int(2).mul(3).add(p.views)))
        .where(({ p }) => p.views.gt(p.views.sub(int(1).add(2))))
        .select(({ p }) => p.id),
      {
        sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."views" < cast($1 as integer) * cast($2 as integer) + "p"."views" and "p"."views" > "p"."views" - (cast($3 as integer) + cast($4 as integer))',
        params: [2, 3, 1, 2],
      },
    ),
    queryCase(
      "a typed named parameter in arithmetic is cast",
      posts.where(({ p }) => p.views.gte(param("base", t.integer()).add(1))).select(({ p }) => p.id),
      {
        sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."views" >= cast($1 as integer) + cast($2 as integer)',
        params: [5, 1],
      },
      { named: { base: 5 } },
    ),
    queryCase(
      "a typed value in a CASE beside a column in arithmetic is cast",
      posts.select(({ p }) => ({ n: p.views.add(caseWhen(p.published, int(10)).else(0)) })),
      {
        sql: 'select "p"."views" + case when "p"."published" then cast($1 as integer) else cast($2 as integer) end as "c0" from "posts" as "p"',
        params: [10, 0],
      },
    ),
    queryCase(
      "updateAll sets a typed arithmetic value",
      posts.where(({ p }) => p.id.eq(1)).set(() => ({ views: int(3).add(1) })),
      {
        sql: 'update "posts" as "p" set "views" = cast($1 as integer) + cast($2 as integer) where "p"."id" = $3',
        params: [3, 1, 1],
      },
      { operation: "updateAll" },
    ),
    statementCase(
      "an insert cell of typed arithmetic",
      (c) =>
        c.compileInsert(
          meta(Post),
          [field(meta(Post), "authorId"), field(meta(Post), "title"), field(meta(Post), "views")],
          {
            source: {
              kind: "cells",
              rows: [[{ kind: "value" }, { kind: "value" }, { kind: "expr", expr: int(3).add(1).node }]],
            },
            returning: [],
            onConflict: undefined,
          },
          undefined,
        ),
      [1, "Cast", 3, 1],
      {
        sql: 'insert into "posts" ("author_id", "title", "views") values ($1, $2, cast($3 as integer) + cast($4 as integer))',
        params: [1, "Cast", 3, 1],
      },
    ),
    queryCase(
      "a CASE of untyped values compared with a column takes the column's type, on either side",
      posts
        .where(({ p }) => p.authorId.eq(caseWhen(p.published, 1).else(2)))
        .where(({ p }) => caseWhen(p.published, 1).else(2).neq(p.authorId))
        .select(({ p }) => p.id),
      {
        sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."author_id" = cast(case when "p"."published" then $1 else $2 end as bigint) and cast(case when "p"."published" then $3 else $4 end as bigint) <> "p"."author_id"',
        params: [1, 2, 1, 2],
      },
    ),
    queryCase(
      "a coalesce of untyped values compared with a column takes the column's type",
      posts.where(({ p }) => p.authorId.gte(coalesce(val(1), val(2)))).select(({ p }) => p.id),
      {
        sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."author_id" >= cast(coalesce($1, $2) as bigint)',
        params: [1, 2],
      },
    ),
    queryCase(
      "between with an untyped CASE takes the column's type",
      posts
        .where(({ p }) => p.authorId.between(caseWhen(p.published, 1).else(0), 5))
        .where(({ p }) => caseWhen(p.published, 1).else(0).between(p.authorId, p.id))
        .select(({ p }) => p.id),
      {
        sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."author_id" between cast(case when "p"."published" then $1 else $2 end as bigint) and $3 and cast(case when "p"."published" then $4 else $5 end as bigint) between "p"."author_id" and "p"."id"',
        params: [1, 0, 5, 1, 0],
      },
    ),
    queryCase(
      "in and not in an untyped coalesce take an array of the column's type",
      posts
        .where(({ p }) => p.authorId.in(coalesce(val([1, 2]), val([3]))))
        .where(({ p }) => p.authorId.notIn(coalesce(val([9]), val([8]))))
        .select(({ p }) => p.id),
      {
        sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."author_id" = any(cast(coalesce($1, $2) as bigint[])) and "p"."author_id" <> all(cast(coalesce($3, $4) as bigint[]))',
        params: [[1, 2], [3], [9], [8]],
      },
    ),
    queryCase(
      "an untyped CASE in an array column takes the element type",
      posts.where(({ p }) => caseWhen(p.published, "ts").else("sql").in(p.tagList)).select(({ p }) => p.id),
      {
        sql: 'select "p"."id" as "c0" from "posts" as "p" where cast(case when "p"."published" then $1 else $2 end as text) = any("p"."tags")',
        params: ["ts", "sql"],
      },
    ),
    queryCase(
      "a uuid column compared with an untyped CASE",
      memberships.where(({ m }) => m.orgId.eq(caseWhen(lit(true), val(orgKey)))).select(({ m }) => m.userId),
      {
        sql: 'select "m"."user_id" as "c0" from "memberships" as "m" where "m"."org_id" = cast(case when true then $1 end as uuid)',
        params: [orgKey],
      },
    ),
    queryCase(
      "a CASE with a typed value compared with a column: the typed values are cast",
      posts
        .where(({ p }) => p.authorId.eq(caseWhen(p.published, val(1, t.bigint({ mode: "number" }))).else(2)))
        .select(({ p }) => p.id),
      {
        sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."author_id" = case when "p"."published" then cast($1 as bigint) else cast($2 as bigint) end',
        params: [1, 2],
      },
    ),
    queryCase(
      "a CASE with a column in it, or a bare value, is left to the column",
      posts
        .where(({ p }) => p.authorId.eq(caseWhen(p.published, p.authorId).else(0)))
        .where(({ p }) => p.authorId.eq(val(1)))
        .select(({ p }) => p.id),
      {
        sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."author_id" = case when "p"."published" then "p"."author_id" else $1 end and "p"."author_id" = $2',
        params: [0, 1],
      },
    ),
    queryCase(
      "a typed value beside arithmetic keeps its own type (review round 1)",
      users
        .select(() => ({
          half: val(7.5, t.float()).div(int(2).add(1)),
          big: val(2 ** 40, t.bigint({ mode: "number" })).add(int(1).add(1)),
        }))
        .limit(1),
      {
        sql: 'select cast($1 as double precision) / (cast($2 as integer) + cast($3 as integer)) as "c0", cast($4 as bigint) + (cast($5 as integer) + cast($6 as integer)) as "c1" from "users" as "u" limit $7',
        params: [7.5, 2, 1, 2 ** 40, 1, 1, 1],
      },
    ),
    queryCase(
      "a typed value beside a column of another type in arithmetic is cast, on either side",
      posts
        .where(({ p }) => p.id.eq(2))
        .select(({ p }) => ({
          half: p.views.div(val(2, t.float())),
          share: val(6, t.float()).div(p.views),
          same: p.views.add(int(1)),
          key: p.authorId.add(int(1)),
        })),
      {
        sql: 'select "p"."views" / cast($1 as double precision) as "c0", cast($2 as double precision) / "p"."views" as "c1", "p"."views" + $3 as "c2", "p"."author_id" + cast($4 as integer) as "c3" from "posts" as "p" where "p"."id" = $5',
        params: [2, 6, 1, 1, 2],
      },
    ),
    queryCase(
      "a typed value of another type beside a column in where, as a named parameter",
      posts
        .where(({ p }) => p.views.div(param("by", t.float())).eq(val(1.5, t.float())))
        .select(({ p }) => p.id),
      {
        sql: 'select "p"."id" as "c0" from "posts" as "p" where "p"."views" / cast($1 as double precision) = $2',
        params: [2, 1.5],
      },
      { named: { by: 2 } },
    ),
    queryCase(
      "updateAll sets a column times a typed value of another type",
      posts.where(({ p }) => p.id.eq(2)).set(({ p }) => ({ views: p.views.mul(val(2, t.float())) })),
      {
        sql: 'update "posts" as "p" set "views" = "p"."views" * cast($1 as double precision) where "p"."id" = $2',
        params: [2, 2],
      },
      { operation: "updateAll" },
    ),
    queryCase(
      "a division of two integers divides as integers on every database; a float keeps /",
      posts
        .where(({ p }) => p.id.eq(2))
        .select(({ p }) => ({
          half: p.views.div(2),
          key: p.authorId.div(int(2)),
          wide: p.views.div(val(2, t.bigint({ mode: "number" }))),
          nested: p.views.add(1).div(2),
          named: p.views.div(param("by", t.integer())),
          float: p.views.div(val(2, t.float())),
        })),
      {
        sql: 'select "p"."views" / $1 as "c0", "p"."author_id" / cast($2 as integer) as "c1", "p"."views" / cast($3 as bigint) as "c2", ("p"."views" + $4) / cast($5 as integer) as "c3", "p"."views" / $6 as "c4", "p"."views" / cast($7 as double precision) as "c5" from "posts" as "p" where "p"."id" = $8',
        params: [2, 2, 2, 1, 2, 2, 2, 2],
      },
      { named: { by: 2 } },
    ),
    queryCase(
      "a CASE or coalesce with no typed value beside a typed value takes its type (review round 1)",
      users
        .where(() => int(3).eq(int(1).add(coalesce(val(null as number | null), val(2)))))
        .where(() =>
          caseWhen(lit(true), int(1))
            .add(caseWhen(lit(true), 2))
            .eq(3),
        )
        .where(() => int(1).eq(coalesce(val(null as number | null), val(1))))
        .where(() => caseWhen(lit(true), int(1)).eq(caseWhen(lit(true), 1)))
        .where(() => int(1).between(caseWhen(lit(true), 0), caseWhen(lit(true), 5)))
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where $1 = cast($2 as integer) + cast(coalesce($3, $4) as integer) and case when true then cast($5 as integer) end + cast(case when true then $6 end as integer) = $7 and cast($8 as integer) = cast(coalesce($9, $10) as integer) and case when true then cast($11 as integer) end = cast(case when true then $12 end as integer) and cast($13 as integer) between cast(case when true then $14 end as integer) and cast(case when true then $15 end as integer)',
        params: [3, 1, null, 2, 1, 2, 3, 1, null, 1, 1, 1, 1, 0, 5],
      },
    ),
    queryCase(
      "untyped values of a widened type compared: text with text, a number with a column",
      users
        .where(() => val("b").gt("a"))
        .where(({ u }) => val(34).eq(u.age))
        .select(({ u }) => u.id),
      {
        sql: 'select "u"."id" as "c0" from "users" as "u" where cast($1 as text) > cast($2 as text) and $3 = "u"."age"',
        params: ["b", "a", 34],
      },
    ),
  ],
  DIALECT_TABLES,
);

/** Every matrix, for the execution test. */
export const ALL_CASES: readonly (readonly [string, readonly SqlCase[]])[] = [
  ["select", SELECT_CASES],
  ["joins", JOIN_CASES],
  ["where", WHERE_CASES],
  ["aggregates", AGGREGATE_CASES],
  ["clauses", CLAUSE_CASES],
  ["nested", NESTED_CASES],
  ["bulk", BULK_CASES],
  ["writes", WRITE_CASES],
  ["casts", CAST_CASES],
];
