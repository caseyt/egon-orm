// @run
// The checked source of recipes/upserts.md. Each `#region` is included in the page by name;
// the rest makes it compile and run (docs:integration checks the `// =>` comments).
// #region setup
import { postgres } from "@egon-orm/postgres";
import { change, createRepo, from, Schema, t, timestamps } from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

class Setting extends Schema("settings", {
  key: t.string().primaryKey(),
  value: t.json<unknown>(),
  ...timestamps(),
}) {}

class DailyView extends Schema("daily_views", {
  pageId: t.integer().primaryKey(),
  day: t.date().primaryKey(),
  views: t.integer(),
}) {}

// The tables, created by a migration.
const tables = defineMigration({
  up(m) {
    m.createTable("settings", (table) => {
      table.text("key").notNull().primaryKey();
      table.jsonb("value").notNull();
      table.timestamps();
    });
    m.createTable("daily_views", (table) => {
      table.integer("page_id").notNull().primaryKey(); // a composite key: page and day
      table.date("day").notNull().primaryKey();
      table.integer("views").notNull();
    });
  },
  down(m) {
    m.dropTable("daily_views");
    m.dropTable("settings");
  },
});

/** Creates the tables, in the database that DATABASE_URL names. */
export async function createTables(): Promise<void> {
  const admin = postgres({ connectionString: process.env.DATABASE_URL });
  await createMigrator({
    adapter: admin,
    migrations: [{ version: 20261021001201, name: "upserts_tables", migration: tables }],
  }).up();
  await admin.close();
}
// #endregion setup

// #region counter
export async function countView(pageId: number, day: string) {
  const inserted = await repo.insertOrThrow(change(DailyView, { pageId, day, views: 1 }), {
    onConflict: "nothing",
  });
  if (inserted === null) {
    await repo.updateAll(
      from(DailyView, "v")
        .where({ pageId, day })
        .set(({ v }) => ({ views: v.views.add(1) })),
    );
  }
}
// #endregion counter

export async function run(): Promise<void> {
  // #region seed
  await createTables();
  // #endregion seed

  // #region one
  // Insert the setting, or replace its value (and updatedAt) if the key exists.
  const saved = await repo.insertOrThrow(change(Setting, { key: "theme", value: "dark" }), {
    onConflict: { target: ["key"], update: ["value", "updatedAt"] },
  });
  // #endregion one
  saved.value; // => "dark"
  const replaced = await repo.insertOrThrow(change(Setting, { key: "theme", value: "light" }), {
    onConflict: { target: ["key"], update: ["value", "updatedAt"] },
  });
  replaced.value; // => "light"

  // #region nothing
  // Insert unless it exists; data is null when it did.
  const created = await repo.insert(change(Setting, { key: "theme", value: "blue" }), {
    onConflict: "nothing",
  });
  if (created.success && created.data === null) {
    // the key was taken: nothing was written
  }
  // #endregion nothing
  created.success && created.data; // => null

  // #region bulk
  // An analytics import: store the latest totals per page and day, many rows in one
  // statement. A row that is already there takes the imported values.
  await repo.insertAll(
    DailyView,
    [
      { pageId: 1, day: "2026-10-20", views: 1 },
      { pageId: 2, day: "2026-10-20", views: 1 },
    ],
    { onConflict: { target: ["pageId", "day"], update: "all" } },
  );
  // #endregion bulk
  await repo.count(DailyView); // => 2

  await countView(3, "2026-10-21"); // a new row: views 1
  await countView(3, "2026-10-21"); // the same row: views 2
  const counted = await repo.getOrThrow(DailyView, { pageId: 3, day: "2026-10-21" });
  counted.views; // => 2

  await repo.close();
}
