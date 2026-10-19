// The queries of the step 09 snapshot matrix, built with the public builder: subqueries,
// CTEs, set operations, windows, bulk updates and deletes, row comparison, selectedAs,
// dynamic expressions and prepared queries. `advanced-cases.ts` pairs each with its
// expected SQL; `advanced.sql.test.ts` compares, `advanced.itest.ts` executes them on
// Postgres. Imported by tests only.
import { Comment, Post, User } from "../../../test/support/blog.js";
import {
  count,
  cte,
  cumeDist,
  denseRank,
  dynamic,
  exists,
  field,
  firstValue,
  fragment,
  from,
  lag,
  lastValue,
  lead,
  max,
  not,
  nthValue,
  ntile,
  outerRef,
  param,
  percentRank,
  prepare,
  rank,
  rowNumber,
  Schema,
  scalar,
  selectedAs,
  subquery,
  sum,
  t,
  tuple,
} from "../../index.js";
import type { QueryLike } from "../../query/builder.js";
import type { NamedValues } from "../bind.js";

/** A self-referencing table for the recursive CTE: categories and their parents. */
export class Category extends Schema("categories", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  parentId: t.bigint({ mode: "number" }).nullable(),
  name: t.string(),
}) {}

/** The DDL the execution test adds to the blog fixture. */
export const CATEGORY_DDL = `
CREATE TABLE categories (id bigserial PRIMARY KEY, parent_id bigint REFERENCES categories (id), name text NOT NULL);
`;

/** One query of the matrix: how to compile it, and the named values to bind. */
export interface AdvancedQuery {
  readonly name: string;
  readonly query: QueryLike;
  readonly operation: "all" | "updateAll" | "deleteAll";
  readonly named: NamedValues | undefined;
}

function q(
  name: string,
  query: QueryLike,
  operation: AdvancedQuery["operation"] = "all",
  named?: NamedValues,
): AdvancedQuery {
  return { name, query, operation, named };
}

const since = new Date("2026-01-01T00:00:00.000Z");

const postCounts = from(Post, "p")
  .where(({ p }) => p.createdAt.gt(since))
  .groupBy(({ p }) => p.authorId)
  .select(({ p }) => ({ authorId: p.authorId, n: count() }));

const roots = from(Category, "c").where(({ c }) => c.parentId.isNull());
const children = from(Category, "c").join(cte("tree", Category), "t", ({ c, t }) => c.parentId.eq(t.id));

const emails = from(User, "u").select(({ u }) => ({ email: u.email }));
const titles = from(Post, "p").select(({ p }) => ({ email: p.title }));

const adult = dynamic<{ u: typeof User }>(({ u }) => u.age.gte(18));
const member = dynamic<{ u: typeof User }>(({ u }) => u.role.eq("member"));
const minViews = dynamic({ p: Post }, ({ p }) => p.views.gte(param("minViews", t.integer().nullable())));

export const ADVANCED_QUERIES: readonly AdvancedQuery[] = [
  // --- Subqueries -------------------------------------------------------------
  q(
    "a subquery as the source exposes its select keys",
    from(subquery(postCounts), "c").where(({ c }) => c.n.gt(5)),
  ),
  q(
    "a subquery joined to a table",
    from(User, "u")
      .join(subquery(postCounts), "c", ({ u, c }) => c.authorId.eq(u.id))
      .select(({ u, c }) => ({ email: u.email, posts: c.n })),
  ),
  q(
    "a left-joined subquery",
    from(User, "u")
      .leftJoin(subquery(postCounts), "c", ({ u, c }) => c.authorId.eq(u.id))
      .select(({ u, c }) => ({ id: u.id, posts: c.n })),
  ),
  q(
    "a subquery of whole rows exposes the schema's columns",
    from(subquery(from(Post, "p").where(({ p }) => p.published)), "r").where(({ r }) => r.views.gt(10)),
  ),
  q(
    "a subquery's selectedAs name is its column",
    from(
      subquery(
        from(Post, "p")
          .groupBy(({ p }) => p.authorId)
          .select(({ p }) => ({ authorId: p.authorId, total: selectedAs(sum(p.views), "total_views") })),
      ),
      "s",
    ).select(({ s }) => ({ total: s.total })),
  ),
  q(
    "in with a subquery",
    from(User, "u")
      .where(({ u }) => u.id.in(from(Post, "p").select(({ p }) => p.authorId)))
      .select(({ u }) => u.id),
  ),
  q(
    "exists referring to the outer binding with outerRef",
    from(User, "u")
      .where(() => exists(from(Post, "p").where(({ p }) => p.authorId.eq(outerRef("u", User).id))))
      .select(({ u }) => u.id),
  ),
  q(
    "not exists referring to the outer binding directly",
    from(User, "u")
      .where(({ u }) => not(exists(from(Post, "p").where(({ p }) => p.authorId.eq(u.id)))))
      .select(({ u }) => u.id),
  ),
  q(
    "a scalar subquery in the select",
    from(User, "u").select(({ u }) => ({
      id: u.id,
      posts: scalar(from(Post, "p").where(({ p }) => p.authorId.eq(u.id)).select(() => count())),
    })),
  ),
  q(
    "named parameters inside and outside a subquery",
    from(
      subquery(
        from(Post, "p")
          .where(({ p }) => p.views.gt(param("min", t.integer())))
          .select(({ p }) => ({ id: p.id, views: p.views })),
      ),
      "s",
    )
      .where(({ s }) => s.id.lt(param("max", t.bigint({ mode: "number" }))))
      .select(({ s }) => s.id),
    "all",
    { min: 1, max: 100 },
  ),
  // --- CTEs -----------------------------------------------------------------------
  q(
    "a recursive CTE",
    from(cte("tree", Category), "t").withCte("tree", roots.unionAll(children), { recursive: true }),
  ),
  q(
    "a CTE typed by its query, not materialized",
    from(cte("recent", postCounts), "r")
      .withCte("recent", postCounts, { materialized: false })
      .where(({ r }) => r.n.gt(2)),
  ),
  q(
    "a materialized CTE joined to a table",
    from(User, "u")
      .withCte("recent", postCounts, { materialized: true })
      .join(cte("recent", postCounts), "r", ({ u, r }) => r.authorId.eq(u.id))
      .select(({ u, r }) => ({ email: u.email, n: r.n })),
  ),
  // --- Set operations ---------------------------------------------------------------
  q("union", emails.union(titles)),
  q("union all", emails.unionAll(titles)),
  q("intersect", emails.intersect(titles)),
  q("intersect all", emails.intersectAll(titles)),
  q("except", emails.except(titles)),
  q("except all", emails.exceptAll(titles)),
  q(
    "except with orderBy and limit on the combined rows",
    from(User, "u")
      .select(({ u }) => ({ id: u.id }))
      .except(from(Post, "p").select(({ p }) => ({ id: p.authorId })))
      .orderBy(({ u }) => u.id)
      .limit(5),
  ),
  q("intersect after union groups what precedes it", emails.union(titles).intersect(emails)),
  q(
    "a set operation of whole rows",
    from(Post, "p")
      .where(({ p }) => p.published)
      .union(from(Post, "q").where(({ q }) => q.views.gt(100))),
  ),
  // --- Windows ------------------------------------------------------------------------
  q(
    "a named window, an inline window and a frame",
    from(Post, "p")
      .windows({ byAuthor: ({ p }) => ({ partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] }) })
      .select(({ p }) => ({
        id: p.id,
        n: rowNumber().over("byAuthor"),
        total: sum(p.views).over({ partitionBy: [p.authorId] }),
        running: sum(p.views).over({
          orderBy: [p.id],
          frame: fragment`rows between unbounded preceding and current row`,
        }),
      })),
  ),
  q(
    "every window function",
    from(Post, "p")
      .windows({ w: ({ p }) => ({ orderBy: [p.id] }) })
      .select(({ p }) => ({
        rowNumber: rowNumber().over("w"),
        rank: rank().over("w"),
        denseRank: denseRank().over("w"),
        percentRank: percentRank().over("w"),
        cumeDist: cumeDist().over("w"),
        ntile: ntile(4).over("w"),
        lag: lag(p.views).over("w"),
        lead: lead(p.views, 2).over("w"),
        lagDefault: lag(p.views, 1, 0).over("w"),
        first: firstValue(p.title).over("w"),
        last: lastValue(p.title).over("w"),
        nth: nthValue(p.title, 2).over("w"),
      })),
  ),
  q(
    "a window partitioned by an expression with a named parameter",
    from(Post, "p")
      .windows({ bucket: ({ p }) => ({ partitionBy: [p.views.mod(param("buckets", t.integer()))] }) })
      .select(({ p }) => ({ id: p.id, top: max(p.views).over("bucket") })),
    "all",
    { buckets: 10 },
  ),
  q(
    "ordering by a window function",
    from(Post, "p")
      .select(({ p }) => ({ id: p.id }))
      .orderBy(({ p }) => rank().over({ orderBy: [p.views.desc()] })),
  ),
  // --- Bulk updates and deletes ------------------------------------------------------
  q("an update from an object", from(Post, "p").where(({ p }) => p.authorId.eq(1)).set({ published: true }), "updateAll"),
  q(
    "an update from expressions, returning ids",
    from(Post, "p")
      .where(({ p }) => p.authorId.eq(1))
      .set(({ p }) => ({ title: p.title.concat("!"), views: p.views.add(1), tagList: p.tagList.append("hot") }))
      .returning(({ p }) => p.id),
    "updateAll",
  ),
  q(
    "an update with a join becomes UPDATE … FROM",
    from(Post, "p")
      .join(User, "u", ({ p, u }) => p.authorId.eq(u.id))
      .where(({ u }) => u.role.eq("admin"))
      .set({ published: true, tagList: null }),
    "updateAll",
  ),
  q("set twice: the later value wins", from(Post, "p").set({ views: 1, title: "a" }).set({ views: 2 }), "updateAll"),
  q(
    "a delete with a join becomes DELETE … USING, returning rows",
    from(Comment, "c")
      .join(Post, "p", ({ c, p }) => c.postId.eq(p.id))
      .where(({ p }) => p.published.not())
      .returning(({ c }) => ({ id: c.id, postId: c.postId })),
    "deleteAll",
  ),
  q("a delete without a returning", from(Comment, "c").where(({ c }) => c.authorId.isNull()), "deleteAll"),
  // --- Small ones ---------------------------------------------------------------------
  q(
    "row comparison for keyset pagination",
    from(Post, "p")
      .where(({ p }) => tuple(p.createdAt, p.id).lt(tuple(since, 10)))
      .orderBy(({ p }) => [p.createdAt.desc(), p.id.desc()])
      .limit(20)
      .select(({ p }) => p.id),
  ),
  q(
    "selectedAs in the select, referred to in groupBy and orderBy",
    from(Post, "p")
      .groupBy(() => selectedAs("author"))
      .select(({ p }) => ({ author: selectedAs(p.authorId, "author"), total: selectedAs(sum(p.views), "total") }))
      .orderBy(() => selectedAs("total").desc()),
  ),
  q(
    "dynamic conditions folded from dynamic.true()",
    from(User, "u")
      .where([adult, member].reduce((acc, f) => acc.and(f), dynamic.true()))
      .select(({ u }) => u.id),
  ),
  q(
    "a dynamic condition with a named parameter, and a column chosen at run time",
    from(Post, "p")
      .where(minViews)
      .orderBy(({ p }) => field(p, "title" as string).asc())
      .select(({ p }) => p.id),
    "all",
    { minViews: 5 },
  ),
  q(
    "a prepared query",
    prepare(
      from(User, "u")
        .where(({ u }) => u.email.eq(param("email", t.string())))
        .limit(1),
    ),
    "all",
    { email: "ann@example.com" },
  ),
];
