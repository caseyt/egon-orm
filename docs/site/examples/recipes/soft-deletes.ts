// @run
// The checked source of recipes/soft-deletes.md. Each `#region` is included in the page by
// name; the rest makes it compile and run (docs:integration checks the `// =>` comments).
// #region setup
import { postgres } from "@egon-orm/postgres";
import { change, createRepo, fragment, from, type QueryWith, Schema, t } from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

// The tables, created by a migration.
const tables = defineMigration({
  up(m) {
    m.createTable("posts", (table) => {
      table.id("id", { type: "integer" });
      table.text("title").notNull();
      table.timestamptz("deleted_at");
    });
    // A unique title among the posts that are not deleted.
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
    migrations: [{ version: 1, name: "tables", migration: tables }],
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
  await createTables();
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
