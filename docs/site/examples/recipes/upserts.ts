// @run
// The checked source of recipes/upserts.md. Each `#region` is included in the page by name;
// the rest makes it compile and run (docs:integration checks the `// =>` comments).
import { postgres } from "@egon-orm/postgres";
import { change, createRepo, Schema, t, timestamps } from "egon-orm";
import { createTables } from "./support.js";

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

export async function run(): Promise<void> {
  await createTables(`
    create table settings (key text primary key, value jsonb not null,
      created_at timestamptz not null, updated_at timestamptz not null);
    create table daily_views (page_id integer, day date, views integer not null, primary key (page_id, day));
  `);

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
  // Count a view per page and day, many rows in one statement.
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

  await repo.close();
}
