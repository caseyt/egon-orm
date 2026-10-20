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
    migrations: [{ version: 1, name: "tables", migration: tables }],
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
  const rows = await repo.all(
    from(Post, "p")
      .where(({ p }) =>
        cursor === null ? p.id.isNotNull() : tuple(p.createdAt, p.id).lt(tuple(cursor.createdAt, cursor.id)),
      )
      .orderBy(({ p }) => [p.createdAt.desc(), p.id.desc()]) // the same columns, in the same order
      .limit(perPage),
  );
  const last = rows.at(-1);
  return { rows, next: last === undefined ? null : { createdAt: last.createdAt, id: last.id } };
}
// #endregion keyset

export async function run(): Promise<void> {
  await createTables();
  const start = Date.UTC(2026, 0, 1);
  await repo.insertAll(
    Post,
    Array.from({ length: 45 }, (_, i) => ({
      title: `Post ${i + 1}`,
      createdAt: new Date(start + (i % 9) * 60_000),
    })),
  );

  const first = await page(1);
  first.total; // => 45
  first.pages; // => 3
  (await page(3)).rows.length; // => 5

  // #region keyset-use
  let cursor: Cursor | null = null;
  let seen = 0;
  do {
    const batch = await after(cursor);
    seen += batch.rows.length;
    cursor = batch.next;
  } while (cursor !== null);
  // #endregion keyset-use
  seen === 45; // => true

  await repo.close();
}
