// The checked sources of the code blocks in guide/repo.md (the reading half) and
// guide/getting-started.md (connecting and querying). Each `#region` is included in the
// page by name; everything outside a region is the scaffolding that makes the regions
// compile.
import { postgres } from "@egon-orm/postgres";
import {
  belongsTo,
  count,
  createRepo,
  fragment,
  from,
  hasMany,
  param,
  type RepoQueryEvent,
  Schema,
  t,
  timestamps,
} from "egon-orm";

class User extends Schema("users", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });
}

class Post extends Schema("posts", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  authorId: t.bigint({ mode: "number" }),
  title: t.string(),
  published: t.boolean().default(false),
  views: t.integer().default(0),
  ...timestamps(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
}

class Membership extends Schema("memberships", {
  orgId: t.uuid().primaryKey(),
  userId: t.bigint({ mode: "number" }).primaryKey(),
}) {}

declare const orgId: string;
declare const userId: number;
declare const metrics: { observe(name: string, ms: number): void };
declare function sendNewsletter(user: User): Promise<void>;

// #region create
export const repo = createRepo({
  adapter: postgres({ connectionString: process.env.DATABASE_URL }),
});
// #endregion create

export async function health() {
  // #region health
  await repo.ping(); // checks the connection
  repo.poolStats(); // { size, idle, waiting }
  repo.planCacheStats(); // { hits, misses, collisions, size }
  await repo.close(); // waits for running queries, then closes the pool
  // #endregion health
}

export async function reading() {
  // #region reading
  const user = await repo.get(User, 1); // User | null
  const member = await repo.get(Membership, { orgId, userId }); // composite key
  const ada = await repo.getBy(User, { email: "ada@example.com" });
  const newest = await repo.first(from(Post, "p").orderBy(({ p }) => p.createdAt.desc()));
  const total = await repo.count(from(Post, "p").where({ published: true })); // number
  const views = await repo.aggregate(Post, "sum", "views"); // number | null
  const latest = await repo.aggregate(Post, "max", "createdAt"); // Date | null
  // #endregion reading
  return { user, member, ada, newest, total, views, latest };
}

export async function params() {
  const q = from(User, "u");
  // #region params
  const adults = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));

  await repo.all(q, { timeoutMs: 500 }); // no named parameters
  await repo.all(adults, { minAge: 18 }); // named parameters
  await repo.all(adults, { minAge: 18 }, { timeoutMs: 500 });
  // #endregion params
}

export async function streaming() {
  // #region stream
  for await (const user of repo.stream(from(User, "u"), { batchSize: 500 })) {
    await sendNewsletter(user);
  }
  // #endregion stream
}

export async function reloading() {
  const user = await repo.getOrThrow(User, 1);
  const other = await repo.getOrThrow(User, 2);
  // #region reload
  const fresh = await repo.reload(user); // User | null
  const both = await repo.reload([user, other]); // (User | null)[], in the same order
  // #endregion reload
  return { fresh, both };
}

export async function rawSql() {
  const q = from(User, "u").where(({ u }) => u.age.gte(18));
  // #region raw
  repo.toSql(q); // { sql, params }
  await repo.explain(q); // the plan, as text
  await repo.explain(q, { format: "json", analyze: true }); // the database's structured plan
  await repo.raw(fragment`select now() as now`); // { rows, rowCount }
  // #endregion raw
}

export function logging() {
  // #region logging
  const logged = createRepo({ adapter: postgres(), log: true });

  logged.on("query", (event: RepoQueryEvent) => {
    // event.sql, event.durationMs, event.queueMs, event.decodeMs, event.rowCount,
    // event.operation, event.source, event.context, event.error
    metrics.observe(event.operation, event.durationMs);
  });
  logged.on("poolExhausted", ({ waiting }) => metrics.observe("waiting", waiting));
  // #endregion logging
}

export async function gettingStarted() {
  // #region query
  const ada = await repo.getBy(User, { email: "ada@example.com" }); // User | null

  const busy = await repo.all(
    from(User, "u")
      .joinAssoc("u", "posts", "p")
      .where(({ p }) => p.published)
      .groupBy(({ u }) => u.id)
      .select(({ u, p }) => ({ email: u.email, posts: count(p.id) })),
  ); // { email: string; posts: number }[]

  const withPosts = await repo.all(from(User, "u").preload("posts"));
  withPosts[0]?.posts[0]?.title; // string
  // #endregion query
  return { ada, busy };
}
