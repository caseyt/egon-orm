// @run
// The checked source of recipes/soft-deletes.md. Each `#region` is included in the page by
// name; the rest makes it compile and run (docs:integration checks the `// =>` comments).
// #region setup
import { postgres } from "@egon-orm/postgres";
import { cast, change, createRepo, fragment, from, type QueryWith, Schema, t } from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

// The tables, created by a migration.
const tables = defineMigration({
  up(m) {
    m.createTable("posts", (table) => {
      table.id({ type: "integer" });
      table.text("title").notNull();
      table.timestamptz("deleted_at");
    });
    // A unique title among the posts that are not deleted: a partial unique index, named
    // posts_title_key, the name uniqueConstraint("title") looks for.
    m.createIndex("posts", ["title"], { unique: true, where: fragment`deleted_at is null` });
  },
  down(m) {
    m.dropTable("posts");
  },
});

/** Creates the tables, in the database that DATABASE_URL names. */
export async function createTables(): Promise<void> {
  const admin = postgres({ connectionString: process.env.DATABASE_URL });
  await createMigrator({
    adapter: admin,
    migrations: [{ version: 20261021001001, name: "soft_deletes_tables", migration: tables }],
  }).up();
  await admin.close();
}
// #endregion setup

// #region schema
class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  deletedAt: t.timestamp().nullable(),
}) {
  // A second live post with the same title is a field error, not an exception.
  static changeset(post: Post | typeof Post, params: unknown) {
    return cast(post, params, ["title"]).validateRequired(["title"]).uniqueConstraint("title");
  }

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

// Restoring can meet the same index: a live post may have taken the title meanwhile. The
// result reports it on the field, { title: ["has already been taken"] }.
export function restore(post: Post) {
  return repo.update(change(post, { deletedAt: null }).uniqueConstraint("title"));
}

// Remove for good what was deleted more than 30 days ago.
export function purge(before = new Date(Date.now() - 30 * 86_400_000)) {
  return repo.deleteAll(from(Post, "p").where(({ p }) => p.deletedAt.lt(before)));
}
// #endregion delete

export async function run(): Promise<void> {
  // #region seed
  await createTables();
  await repo.insertAll(Post, [{ title: "One" }, { title: "Two" }]);
  // #endregion seed

  const one = await repo.getByOrThrow(Post, { title: "One" });
  const deleted = await softDelete(one);
  deleted.isDeleted; // => true
  (await repo.all(posts)).map((p) => p.title); // => ["Two"]
  await repo.count(Post); // => 2

  // #region use
  // While "One" is deleted, its title is free for a new post...
  const again = await repo.insert(Post.changeset(Post, { title: "One" }));
  again.success; // => true
  // ...so the deleted one cannot come back under it.
  const back = await restore(deleted);
  back.success ? null : back.error.errorMessages(); // => { title: ["has already been taken"] }

  const twin = await repo.insert(Post.changeset(Post, { title: "Two" })); // "Two" is live
  twin.success ? null : twin.error.errorMessages(); // => { title: ["has already been taken"] }
  // #endregion use

  await repo.count(posts); // => 2
  (await purge()).count; // => 0

  await repo.close();
}
