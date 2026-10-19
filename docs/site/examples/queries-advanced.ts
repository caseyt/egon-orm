// The checked sources of the code blocks in guide/queries-advanced.md. Each `#region` is
// included in the page by name; everything outside a region is the scaffolding that makes
// the regions compile. The SQL in the comments is what the Postgres adapter emits.
//
// The repo arrives with a later step, so `repo` is declared here with the shape its read
// and bulk-write methods will have.
import {
  count,
  cte,
  dynamic,
  exists,
  field,
  fragment,
  from,
  lag,
  not,
  outerRef,
  param,
  prepare,
  type QueryLike,
  type QueryParams,
  type QueryResult,
  rowNumber,
  Schema,
  scalar,
  selectedAs,
  subquery,
  sum,
  t,
  timestamps,
  tuple,
} from "egon-orm";

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  ...timestamps(),
}) {}

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
  published: t.boolean().default(false),
  views: t.integer().default(0),
  tags: t.array(t.string()).default([]),
  ...timestamps(),
}) {}

class Category extends Schema("categories", {
  id: t.integer().primaryKey().dbGenerated(),
  parentId: t.integer().nullable(),
  name: t.string(),
}) {}

type Args<Q extends QueryLike> = keyof QueryParams<Q> extends never ? [] : [params: QueryParams<Q>];
declare const repo: {
  all<Q extends QueryLike>(query: Q, ...params: Args<Q>): Promise<QueryResult<Q>[]>;
  one<Q extends QueryLike>(query: Q, ...params: Args<Q>): Promise<QueryResult<Q>>;
  updateAll<Q extends QueryLike>(query: Q, ...params: Args<Q>): Promise<QueryResult<Q>[]>;
};
declare const email: string;
declare const sortColumn: string;
declare const cursor: { readonly createdAt: Date; readonly id: number };

export function subqueries() {
  // #region subqueries
  const postCounts = from(Post, "p")
    .groupBy(({ p }) => p.authorId)
    .select(({ p }) => ({ authorId: p.authorId, n: count() }));

  // As a source: the binding exposes the subquery's select keys
  from(subquery(postCounts), "c").where(({ c }) => c.n.gt(5));
  // select "c"."authorId" as "c0", "c"."n" as "c1"
  // from (select "p"."author_id" as "authorId", count(*) as "n" from "posts" as "p" group by "p"."author_id") as "c"
  // where "c"."n" > $1

  // In a join
  from(User, "u").join(subquery(postCounts), "c", ({ u, c }) => c.authorId.eq(u.id));

  // IN
  from(User, "u").where(({ u }) => u.id.in(from(Post, "p").select(({ p }) => p.authorId)));
  // … where "u"."id" in (select "p"."author_id" as "c0" from "posts" as "p")

  // EXISTS, referring to the outer query
  from(User, "u").where(({ u }) => exists(from(Post, "p").where(({ p }) => p.authorId.eq(u.id))));
  // … where exists (select 1 from "posts" as "p" where "p"."author_id" = "u"."id")

  // A single value in the select: null when the subquery returns no row
  from(User, "u").select(({ u }) => ({
    user: u,
    posts: scalar(
      from(Post, "p")
        .where(({ p }) => p.authorId.eq(u.id))
        .select(() => count()),
    ), // number | null
  }));
  // #endregion subqueries
}

export function outerRefs() {
  // #region outer-ref
  const byThisUser = from(Post, "p").where(({ p }) => p.authorId.eq(outerRef("u", User).id));
  from(User, "u").where(() => exists(byThisUser));
  // #endregion outer-ref
}

export function ctes() {
  // #region ctes
  const roots = from(Category, "c").where(({ c }) => c.parentId.isNull());
  const children = from(Category, "c").join(cte("tree", Category), "t", ({ c, t }) => c.parentId.eq(t.id));

  const tree = from(cte("tree", Category), "t").withCte("tree", roots.unionAll(children), {
    recursive: true,
  });
  // with recursive "tree" as (
  //   select "c"."id" as "id", "c"."parent_id" as "parent_id", "c"."name" as "name" from "categories" as "c"
  //   where "c"."parent_id" is null
  //   union all (select … from "categories" as "c" inner join "tree" as "t" on "c"."parent_id" = "t"."id")
  // ) select "t"."id" as "c0", "t"."parent_id" as "c1", "t"."name" as "c2" from "tree" as "t"
  // #endregion ctes
  return tree;
}

export function setOperations() {
  // #region set-operations
  const emails = from(User, "u").select(({ u }) => ({ email: u.email }));
  const titles = from(Post, "p").select(({ p }) => ({ email: p.title }));

  emails.union(titles); //        union         (removes duplicates)
  emails.unionAll(titles); //     union all
  emails.intersect(titles); //    intersect
  emails.intersectAll(titles); // intersect all
  emails.except(titles); //       except
  emails.exceptAll(titles); //    except all

  emails
    .union(titles)
    .orderBy(({ u }) => u.email)
    .limit(10);
  // select "u"."email" as "c0" from "users" as "u"
  // union (select "p"."title" as "c0" from "posts" as "p")
  // order by "c0" asc limit $1
  // #endregion set-operations
}

export function windows() {
  // #region windows
  from(Post, "p")
    .windows({ w: ({ p }) => ({ partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] }) })
    .select(({ p }) => ({
      id: p.id,
      rank: rowNumber().over("w"),
      total: sum(p.views).over({ partitionBy: [p.authorId] }),
      previous: lag(p.views).over("w"),
      running: sum(p.views).over({
        orderBy: [p.createdAt],
        frame: fragment`rows between unbounded preceding and current row`,
      }),
    }));
  // select "p"."id" as "c0", row_number() over "w" as "c1",
  //   sum("p"."views") over (partition by "p"."author_id") as "c2", lag("p"."views") over "w" as "c3",
  //   sum("p"."views") over (order by "p"."created_at" asc rows between unbounded preceding and current row) as "c4"
  // from "posts" as "p" window "w" as (partition by "p"."author_id" order by "p"."created_at" desc)
  // #endregion windows
}

export function dynamicConditions() {
  // #region dynamic
  const filters = [
    dynamic<{ u: typeof User }>(({ u }) => u.age.gte(18)),
    dynamic<{ u: typeof User }>(({ u }) => u.role.eq("member")),
  ];

  const all = filters.reduce((acc, f) => acc.and(f), dynamic.true());
  from(User, "u").where(all);
  // … where true and "u"."age" >= $1 and "u"."role" = $2
  // #endregion dynamic
  // #region dynamic-value
  const minViews = dynamic({ p: Post }, ({ p }) => p.views.gte(param("minViews", t.integer())));
  const newestFirst = dynamic({ p: Post }, ({ p }) => p.createdAt.desc());
  from(Post, "p").where(minViews).orderBy(newestFirst); // needs { minViews: number }
  // #endregion dynamic-value
  // #region field
  from(User, "u").orderBy(({ u }) => field(u, sortColumn).asc());
  // #endregion field
}

export async function bulkUpdates() {
  // #region bulk
  // Plain values
  from(Post, "p")
    .where(({ p }) => p.authorId.eq(1))
    .set({ published: true });
  // update "posts" as "p" set "published" = $1 where "p"."author_id" = $2

  // Expressions
  const publish = from(Post, "p")
    .where(({ p }) => p.authorId.eq(1))
    .set(({ p }) => ({ views: p.views.add(1), tags: p.tags.append("featured") }))
    .returning(({ p }) => p.id);
  // update "posts" as "p" set "views" = "p"."views" + $1, "tags" = array_append("p"."tags", $2)
  // where "p"."author_id" = $3 returning "p"."id" as "c0"

  const ids = await repo.updateAll(publish); // number[]
  // #endregion bulk
  // #region bulk-join
  from(Post, "p")
    .join(User, "u", ({ p, u }) => p.authorId.eq(u.id))
    .where(({ u }) => u.role.eq("admin"))
    .set({ published: true });
  // update "posts" as "p" set "published" = $1 from "users" as "u"
  // where "p"."author_id" = "u"."id" and "u"."role" = $2
  // #endregion bulk-join
  return ids;
}

export async function prepared() {
  // #region prepare
  const byEmail = prepare(
    from(User, "u")
      .where(({ u }) => u.email.eq(param("email", t.string())))
      .limit(1),
  );

  await repo.one(byEmail, { email });
  // #endregion prepare
}

export function otherTools() {
  // #region selected-as
  from(Post, "p")
    .groupBy(({ p }) => p.authorId)
    .select(({ p }) => ({ authorId: p.authorId, total: selectedAs(sum(p.views), "total") }))
    .orderBy(() => selectedAs("total").desc());
  // select "p"."author_id" as "c0", sum("p"."views") as "total" from "posts" as "p"
  // group by "p"."author_id" order by "total" desc
  // #endregion selected-as
  // #region keyset
  from(Post, "p")
    .where(({ p }) => tuple(p.createdAt, p.id).lt(tuple(cursor.createdAt, cursor.id)))
    .orderBy(({ p }) => [p.createdAt.desc(), p.id.desc()])
    .limit(20);
  // … where ("p"."created_at", "p"."id") < ($1, $2) order by "p"."created_at" desc, "p"."id" desc limit $3
  // #endregion keyset
}

export function recipes() {
  // #region top-n
  const ranked = from(Post, "p").select(({ p }) => ({
    id: p.id,
    rn: rowNumber().over({ partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] }),
  }));

  from(Post, "p").where(({ p }) =>
    p.id.in(
      from(subquery(ranked), "r")
        .where(({ r }) => r.rn.lte(3))
        .select(({ r }) => r.id),
    ),
  );
  // #endregion top-n
  // #region no-match
  from(User, "u").where(({ u }) => not(exists(from(Post, "p").where(({ p }) => p.authorId.eq(u.id)))));
  // #endregion no-match
  // #region update-from-cte
  // Update the rows that exist, from a CTE that computes the new values once.
  const totals = from(Post, "p")
    .groupBy(({ p }) => p.authorId)
    .select(({ p }) => ({ authorId: p.authorId, views: sum(p.views) }));
  from(User, "u")
    .withCte("totals", totals)
    .join(cte("totals", totals), "t", ({ u, t }) => t.authorId.eq(u.id))
    .where(({ t }) => t.views.gt(1000))
    .set({ role: "admin" });
  // #endregion update-from-cte
}
