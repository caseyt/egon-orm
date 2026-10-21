// @run
// The checked source of recipes/pagination.md. Each `#region` is included in the page by
// name; the rest makes it compile and run (docs:integration checks the `// =>` comments).
// #region setup
import { postgres } from "@egon-orm/postgres";
import { createRepo, from, Schema, t, tuple } from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  createdAt: t.timestamp(),
}) {}

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

// The tables, created by a migration.
const tables = defineMigration({
  up(m) {
    m.createTable("posts", (table) => {
      table.id({ type: "integer" });
      table.text("title").notNull();
      table.timestamptz("created_at").notNull();
    });
    // The order of the pages; Postgres reads it backwards for created_at desc, id desc.
    m.createIndex("posts", ["created_at", "id"]);
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
    migrations: [{ version: 20261021000901, name: "pagination_tables", migration: tables }],
  }).up();
  await admin.close();
}
// #endregion setup

// #region offset
export async function page(number: number, perPage = 20) {
  const base = from(Post, "p").orderBy(({ p }) => [p.createdAt.desc(), p.id.desc()]);

  const [rows, total] = await Promise.all([
    repo.all(base.limit(perPage).offset((number - 1) * perPage)),
    repo.count(base), // the order is dropped for the count
  ]);
  return { rows, total, pages: Math.ceil(total / perPage) };
}
// #endregion offset

// #region keyset
type Cursor = { createdAt: Date; id: number };

export async function after(cursor: Cursor | null, perPage = 20) {
  let query = from(Post, "p")
    .orderBy(({ p }) => [p.createdAt.desc(), p.id.desc()]) // the same columns as the where
    .limit(perPage);
  // The first page has no cursor, so no condition.
  if (cursor !== null) {
    const { createdAt, id } = cursor;
    query = query.where(({ p }) => tuple(p.createdAt, p.id).lt(tuple(createdAt, id)));
  }
  const rows = await repo.all(query);
  const last = rows.at(-1);
  // A short page is the last one: no cursor, so the caller does not ask for an empty page.
  const next =
    last === undefined || rows.length < perPage ? null : { createdAt: last.createdAt, id: last.id };
  return { rows, next };
}
// #endregion keyset

export async function run(): Promise<void> {
  // #region seed
  await createTables();
  const start = Date.UTC(2026, 0, 1);
  await repo.insertAll(
    Post,
    Array.from({ length: 45 }, (_, i) => ({
      title: `Post ${i + 1}`,
      createdAt: new Date(start + (i % 9) * 60_000),
    })),
  );
  // #endregion seed

  const first = await page(1);
  first.total; // => 45
  first.pages; // => 3
  (await page(3)).rows.length; // => 5

  // #region keyset-use
  let cursor: Cursor | null = null;
  let seen = 0;
  let queries = 0;
  do {
    const batch = await after(cursor);
    queries += 1;
    seen += batch.rows.length;
    cursor = batch.next;
  } while (cursor !== null);
  ({ seen, queries }); // => { seen: 45, queries: 3 }
  // #endregion keyset-use

  await repo.close();
}
