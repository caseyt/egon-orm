// @run
// The checked source of recipes/optimistic-locking.md. Each `#region` is included in the page
// by name; the rest makes it compile and run (docs:integration checks the `// =>` comments).
// #region setup
import { postgres } from "@egon-orm/postgres";
import { cast, createRepo, Schema, StaleEntryError, t } from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

// The tables, created by a migration.
const tables = defineMigration({
  up(m) {
    m.createTable("pages", (table) => {
      table.id({ type: "integer" });
      table.text("body").notNull();
      table.integer("lock_version").notNull().default(1);
    });
  },
  down(m) {
    m.dropTable("pages");
  },
});

/** Creates the tables, in the database that DATABASE_URL names. */
export async function createTables(): Promise<void> {
  const admin = postgres({ connectionString: process.env.DATABASE_URL });
  await createMigrator({
    adapter: admin,
    migrations: [{ version: 20261021000801, name: "optimistic_locking_tables", migration: tables }],
  }).up();
  await admin.close();
}
// #endregion setup

// #region schema
class Page extends Schema("pages", {
  id: t.integer().primaryKey().dbGenerated(),
  body: t.string(),
  lockVersion: t.integer().default(1),
}) {
  static changeset(page: Page, params: unknown) {
    return cast(page, params, ["body"]).optimisticLock("lockVersion");
  }
}
// #endregion schema

// #region save
// Reports a conflict on the form instead of throwing.
export function save(page: Page, params: unknown) {
  return repo.update(Page.changeset(page, params), {
    staleError: { field: "body", message: "was changed by someone else; reload and try again" },
  });
}
// #endregion save

export async function run(): Promise<void> {
  // #region seed
  await createTables();
  const page = await repo.insertOrThrow(cast(Page, { body: "Draft" }, ["body"]));
  // #endregion seed

  // #region conflict
  const mine = await repo.getOrThrow(Page, page.id); // lockVersion 1
  const theirs = await repo.getOrThrow(Page, page.id); // lockVersion 1

  await repo.updateOrThrow(Page.changeset(theirs, { body: "Their edit" })); // lockVersion is now 2

  try {
    await repo.updateOrThrow(Page.changeset(mine, { body: "My edit" })); // where lock_version = 1: no row
  } catch (error) {
    if (!(error instanceof StaleEntryError)) throw error;
    // reload, show the other edit, and let the user decide
  }
  // #endregion conflict

  const result = await save(mine, { body: "My edit" });
  result.success ? null : result.error.errorMessages(); // => { body: ["was changed by someone else; reload and try again"] }
  (await repo.getOrThrow(Page, page.id)).lockVersion; // => 2

  // #region unchanged
  const current = await repo.getOrThrow(Page, page.id); // lockVersion 2
  const saved = await repo.updateOrThrow(Page.changeset(current, { body: current.body })); // no query
  saved.lockVersion; // => 2
  (await repo.getOrThrow(Page, page.id)).lockVersion; // => 2
  // #endregion unchanged

  await repo.close();
}
