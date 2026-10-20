import type { TestDatabase } from "./db.js";

/** Options for {@link truncateAll}. */
export interface TruncateOptions {
  /** Table names to leave untouched (for example a migrations bookkeeping table). */
  readonly except?: readonly string[];
}

const quotePostgres = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const quoteMysql = (name: string): string => `\`${name.replaceAll("`", "``")}\``;

/**
 * Empties every table in the test database and resets its sequences / auto-increment
 * counters. Returns the names of the tables it truncated.
 *
 * Integration tests isolate themselves with the sandbox of `egon-orm/testing` (step 16),
 * which rolls each test back and commits nothing. This is for the tests that cannot run in
 * a sandbox because they check what other connections see after a commit (two adapters,
 * real transactions): call it after such a test, or before each one.
 */
export async function truncateAll(db: TestDatabase, options: TruncateOptions = {}): Promise<string[]> {
  const except = new Set(options.except ?? []);

  if (db.dialect === "postgres") {
    const rows = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename",
    );
    const tables = rows.map((row) => row.tablename).filter((name) => !except.has(name));
    if (tables.length > 0) {
      // One statement, so foreign keys between the listed tables are not an issue.
      await db.exec(`TRUNCATE TABLE ${tables.map(quotePostgres).join(", ")} RESTART IDENTITY CASCADE`);
    }
    return tables;
  }

  if (db.dialect === "sqlite") {
    const rows = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    );
    const tables = rows.map((row) => row.name).filter((name) => !except.has(name));
    if (tables.length > 0) {
      await db.exec("PRAGMA foreign_keys = OFF");
      try {
        await db.exec(tables.map((name) => `DELETE FROM ${quotePostgres(name)};`).join(" "));
        // Integer keys declared AUTOINCREMENT count on in sqlite_sequence.
        const sequence = await db.query("SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'");
        if (sequence.length > 0) await db.exec("DELETE FROM sqlite_sequence");
      } finally {
        await db.exec("PRAGMA foreign_keys = ON");
      }
    }
    return tables;
  }

  const rows = await db.query<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables " +
      "WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  const tables = rows.map((row) => row.name).filter((name) => !except.has(name));
  if (tables.length > 0) {
    const statements = tables.map((name) => `TRUNCATE TABLE ${quoteMysql(name)};`).join(" ");
    await db.exec("SET FOREIGN_KEY_CHECKS = 0");
    try {
      await db.exec(statements);
    } finally {
      // Restored even when a TRUNCATE fails, so one failure cannot change later tests.
      await db.exec("SET FOREIGN_KEY_CHECKS = 1");
    }
  }
  return tables;
}
