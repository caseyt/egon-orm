// The checked sources of the code blocks in guide/queries.md. Each `#region` is included
// in the page by name; everything outside a region is the scaffolding that makes the
// regions compile.
//
// `repo` is declared with the real `Repo` type: the result type comes from the query, and
// the named parameters are required exactly when the query has some.
import {
  count,
  fragment,
  from,
  hasMany,
  hasNamedBinding,
  or,
  param,
  type QueryLike,
  type QueryWith,
  type Repo,
  Schema,
  t,
  timestamps,
} from "egon-orm";

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  deletedAt: t.timestamp().nullable(),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });
}

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
  published: t.boolean().default(false),
  views: t.integer().default(0),
  tags: t.array(t.string()).nullable(),
  ...timestamps(),
}) {}

class Profile extends Schema("profiles", {
  id: t.integer().primaryKey().dbGenerated(),
  userId: t.integer(),
  bio: t.string().nullable(),
}) {}

declare const repo: Repo;
declare const filters: { role?: "admin" | "member"; minAge?: number };
declare const someQuery: QueryLike;

export async function overview() {
  // #region overview
  const q = from(User, "u")
    .joinAssoc("u", "posts", "p")
    .where(({ u, p }) => u.age.gte(18).and(p.published))
    .groupBy(({ u }) => u.id)
    .having(({ p }) => count(p.id).gt(3))
    .orderBy(({ u }) => u.createdAt.desc())
    .limit(10)
    .select(({ u, p }) => ({ id: u.id, email: u.email, posts: count(p.id) }));

  const rows = await repo.all(q); // { id: number; email: string; posts: number }[]
  // #endregion overview
  return rows;
}

export function bindings() {
  // #region bindings
  from(User, "u")
    .join(Post, "p", ({ u, p }) => p.authorId.eq(u.id))
    .where(({ u, p }) => u.age.gte(18).and(p.published));
  // #endregion bindings
}

export function selfJoin() {
  // #region self-join
  // Pairs of users with the same name: two bindings of one schema.
  from(User, "a").join(User, "b", ({ a, b }) => a.name.eq(b.name).and(a.id.neq(b.id)));
  // #endregion self-join
}

export function whereAndOrWhere() {
  // #region where
  from(User, "u")
    .where(({ u }) => u.age.gte(18))
    .where(({ u }) => u.role.eq("member"))
    .orWhere(({ u }) => u.role.eq("admin"));
  // WHERE (u.age >= $1 AND u.role = $2) OR u.role = $3
  // #endregion where
  // #region or
  from(User, "u").where(({ u }) => or(u.role.eq("admin"), u.age.gte(65)));
  // #endregion or
}

export function objectForm() {
  // #region object-form
  from(User, "u").where({ role: "admin", name: null, id: [1, 2, 3] });
  // WHERE u.role = $1 AND u.name IS NULL AND u.id = ANY($2)
  // #endregion object-form
  // #region object-form-arrays
  from(Post, "p").where({ tags: ["sql", "ts"] }); // WHERE p.tags = $1: the whole array
  from(Post, "p").where(({ p }) => p.tags.contains(["sql"])); // the array holds "sql"
  // #endregion object-form-arrays
  // #region dynamic
  let q = from(User, "u");
  if (filters.role) q = q.where({ role: filters.role });
  if (filters.minAge !== undefined) {
    const minAge = filters.minAge;
    q = q.where(({ u }) => u.age.gte(minAge));
  }
  // #endregion dynamic
  return q;
}

export function joins() {
  // #region joins
  from(User, "u").join(Post, "p", ({ u, p }) => p.authorId.eq(u.id)); //      INNER JOIN
  from(User, "u").leftJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id)); // LEFT JOIN
  from(Post, "p").rightJoin(User, "u", ({ u, p }) => p.authorId.eq(u.id)); //   RIGHT JOIN
  from(User, "u").fullJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id)); // FULL JOIN
  from(User, "u").crossJoin(Post, "p"); //                                     CROSS JOIN
  from(User, "u").joinAssoc("u", "posts", "p"); //                              through the association
  from(User, "u").joinAssoc("u", "posts", "p", ({ p }) => p.published); //      with an extra ON condition
  // #endregion joins
}

export async function nullability() {
  // #region nullability
  const q = from(User, "u")
    .leftJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id))
    .select(({ u, pr }) => ({ user: u, bio: pr.bio, profile: pr }));
  const rows = await repo.all(q); // { user: User; bio: string | null; profile: Profile | null }[]
  // #endregion nullability
  return rows;
}

export function selectShapes() {
  const q = from(User, "u").joinAssoc("u", "posts", "p");
  // #region select
  q.select(({ u }) => u.email); //                                 string
  q.select(({ u }) => u); //                                       User
  q.select(({ u, p }) => ({ user: u, title: p.title })); //        { user: User; title: string }
  q.select(({ u, p }) => [u.id, count(p.id)] as const); //         [number, number]
  q.select(({ u }) => ({ id: u.id, kind: "user" })); //            plain values are returned as they are
  // #endregion select
  // #region select-merge
  from(Post, "p")
    .select(({ p }) => ({ id: p.id, title: p.title }))
    .selectMerge(({ p }) => ({ views: p.views })); // { id: number; title: string; views: number }
  // #endregion select-merge
}

export function grouping() {
  // #region group
  from(Post, "p")
    .groupBy(({ p }) => p.authorId)
    .having(({ p }) => count(p.id).gt(3))
    .select(({ p }) => ({ authorId: p.authorId, posts: count(p.id) }));
  // #endregion group
  // #region order
  from(User, "u").orderBy(({ u }) => [u.createdAt.desc().nullsLast(), u.id]); // a bare column sorts ascending
  from(User, "u")
    .orderBy(({ u }) => u.createdAt)
    .reverseOrder(); //              ORDER BY created_at DESC
  // #endregion order
  // #region distinct
  from(User, "u").distinct();
  from(User, "u")
    .distinct(({ u }) => [u.email])
    .orderBy(({ u }) => [u.email, u.createdAt.desc()]); // DISTINCT ON (email)
  // #endregion distinct
}

export function paging() {
  // #region paging
  from(User, "u")
    .orderBy(({ u }) => u.id)
    .limit(20)
    .offset(40); // LIMIT $1 OFFSET $2
  // #endregion paging
}

export function locks() {
  const q = from(Post, "p");
  // #region locks
  q.lock("update");
  q.lock("update", { skipLocked: true });
  q.lock("share", { noWait: true });
  q.lock(fragment`FOR UPDATE OF ${fragment.ident("p")}`);
  // #endregion locks
}

export function otherClauses() {
  const q = from(User, "u")
    .orderBy(({ u }) => u.id)
    .limit(10);
  // #region other
  q.schema("tenant_1"); // the database schema for this query
  q.exclude("orderBy"); // the same query without its orderBy
  q.exclude("limit");
  // #endregion other
}

export function values() {
  // #region values
  const active = from(User, "u").where(({ u }) => u.deletedAt.isNull());

  const admins = active.where({ role: "admin" });
  const recent = active.orderBy(({ u }) => u.createdAt.desc()).limit(10);
  // #endregion values
  return [admins, recent];
}

export function scopes() {
  // #region scopes
  const published = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) => q.where(({ p }) => p.published);

  const paginate = <Q extends QueryWith>(q: Q, page: number, size = 20) =>
    q.limit(size).offset((page - 1) * size);

  from(Post, "p")
    .pipe(published)
    .pipe((q) => paginate(q, 2));
  // #endregion scopes
  // #region has-named-binding
  if (hasNamedBinding(someQuery, "p", Post)) {
    someQuery.where(({ p }) => p.published);
  }
  // #endregion has-named-binding
}

export async function namedParams() {
  // #region params
  const adults = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));

  await repo.all(adults, { minAge: 18 }); // the params object is required and typed
  // #endregion params
}

export function debugging() {
  // #region to-string
  from(User, "u")
    .where(({ u }) => u.age.gte(18))
    .orderBy(({ u }) => u.id)
    .limit(10)
    .toString();
  // "from users as u where u.age >= ? order by u.id limit ?"
  // #endregion to-string
}
