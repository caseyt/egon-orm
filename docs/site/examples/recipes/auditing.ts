// @run
// The checked source of recipes/auditing.md. Each `#region` is included in the page by name;
// the rest makes it compile and run (docs:integration checks the `// =>` comments).
// #region setup
import { postgres } from "@egon-orm/postgres";
import { type Changeset, cast, change, createBatch, createRepo, from, Schema, t, timestamps } from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

class Account extends Schema("accounts", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  plan: t.enum(["free", "pro"]).default("free"),
}) {
  static changeset(account: Account | typeof Account, params: unknown) {
    return cast(account, params, ["email", "plan"]).validateRequired(["email"]);
  }
}

// The tables, created by a migration.
const tables = defineMigration({
  up(m) {
    m.createTable("accounts", (table) => {
      table.id("id", { type: "integer" });
      table.text("email").notNull();
      table.text("plan").notNull().default("free");
    });
    m.createTable("audit_entries", (table) => {
      table.id("id", { type: "integer" });
      table.integer("actor_id").notNull();
      table.text("action").notNull();
      table.text("table_name").notNull();
      table.integer("row_id").notNull();
      table.jsonb("changes").notNull();
      table.timestamps();
    });
  },
  down(m) {
    m.dropTable("audit_entries");
    m.dropTable("accounts");
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
class AuditEntry extends Schema("audit_entries", {
  id: t.integer().primaryKey().dbGenerated(),
  actorId: t.integer(),
  action: t.string(),
  table: t.string().column("table_name"),
  rowId: t.integer(),
  changes: t.json<Record<string, unknown>>(), // what the changeset changed
  ...timestamps(),
}) {}
// #endregion schema

// #region audited
// An update and its audit entry, as one batch: both are written, or neither.
export function auditedUpdate(actorId: number, changeset: Changeset<typeof Account, false>) {
  return createBatch()
    .update("row", changeset)
    .insert("audit", ({ row }) =>
      change(AuditEntry, {
        actorId,
        action: "update",
        table: "accounts",
        rowId: row.id,
        changes: { ...changeset.changes },
      }),
    );
}
// #endregion audited

export async function run(): Promise<void> {
  await createTables();
  const account = await repo.insertOrThrow(Account.changeset(Account, { email: "ada@example.com" }));
  const adminId = 7;

  // #region use
  const result = await repo.transaction(auditedUpdate(adminId, Account.changeset(account, { plan: "pro" })));

  if (!result.success) {
    result.error.step; // "row" | "audit": which write failed, and nothing was written
  }
  // #endregion use
  result.success; // => true

  // #region read
  const history = await repo.all(
    from(AuditEntry, "e")
      .where({ table: "accounts", rowId: account.id })
      .orderBy(({ e }) => e.createdAt.desc()),
  );
  // #endregion read
  history.map((e) => e.changes); // => [{ plan: "pro" }]

  const invalid = await repo.transaction(auditedUpdate(adminId, Account.changeset(account, { email: "" })));
  invalid.success ? null : invalid.error.step; // => "row"
  await repo.count(AuditEntry); // => 1

  await repo.close();
}
