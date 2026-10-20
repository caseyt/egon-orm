// @run
// The checked source of recipes/soft-deletes.md. Each `#region` is included in the page by
// name; the rest makes it compile and run (docs:integration checks the `// =>` comments).
import { postgres } from "@egon-orm/postgres";
import { change, createRepo, from, type QueryWith, Schema, t } from "egon-orm";
import { createTables } from "./support.js";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

// #region schema
class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  deletedAt: t.timestamp().nullable(),
}) {
  get isDeleted(): boolean {
    return this.deletedAt !== null;
  }
}
// #endregion schema

// #region scope
// A reusable scope: any query with a binding `p` of Post.
const live = <Q extends QueryWith<{ p: typeof Post }>>(q: Q): Q => q.where(({ p }) => p.deletedAt.isNull());

export const posts = from(Post, "p").pipe(live); // the base query every listing starts from
// #endregion scope

// #region delete
export function softDelete(post: Post) {
  return repo.updateOrThrow(change(post, { deletedAt: new Date() }));
}

export function restore(post: Post) {
  return repo.updateOrThrow(change(post, { deletedAt: null }));
}

// Remove for good what was deleted more than 30 days ago.
export function purge(before = new Date(Date.now() - 30 * 86_400_000)) {
  return repo.deleteAll(from(Post, "p").where(({ p }) => p.deletedAt.lt(before)));
}
// #endregion delete

export async function run(): Promise<void> {
  await createTables(`
    create table posts (id serial primary key, title text not null, deleted_at timestamptz);
    -- a unique title among the posts that are not deleted
    create unique index posts_title_key on posts (title) where deleted_at is null;
  `);
  await repo.insertAll(Post, [{ title: "One" }, { title: "Two" }]);

  const one = await repo.getByOrThrow(Post, { title: "One" });
  const deleted = await softDelete(one);
  deleted.isDeleted; // => true
  (await repo.all(posts)).map((p) => p.title); // => ["Two"]
  await repo.count(Post); // => 2

  await restore(deleted);
  await repo.count(posts); // => 2
  (await purge()).count; // => 0

  await repo.close();
}
