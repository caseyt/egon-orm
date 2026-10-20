// The runner's `transaction` lock (SQLite's `begin immediate`) over a scripted adapter: what
// it sends, how it waits for a busy database, and that each migration is a savepoint inside
// the run's transaction. What the statements do to a real SQLite file is the conformance
// suite's (packages/sqlite/test/migration-conformance.itest.ts).
import { describe, expect, test } from "vitest";
import { createAdapter } from "../adapter/adapter.js";
import type { DriverConnection, DriverCursor, DriverWrapper } from "../adapter/driver.js";
import { SQLITE_CAPABILITIES } from "../compiler/dialect.js";
import type { RawResult } from "../contracts/adapter.js";
import { DatabaseError, MigrationError } from "../errors.js";
import { defineMigration } from "./define.js";
import type { MigrationSource } from "./loader.js";
import { createMigrator } from "./migrator.js";

const EMPTY: RawResult = { rows: [], rowCount: 0, insertId: undefined };

interface Script {
  /** How many times `begin immediate` finds the database busy before it succeeds. */
  busy?: number;
  /** What `pragma busy_timeout` reads. */
  timeout?: unknown;
  /** Makes a statement fail. */
  fail?: (sql: string) => Error | undefined;
}

function scripted(script: Script = {}) {
  const sent: string[] = [];
  let busy = script.busy ?? 0;
  const connection: DriverConnection = {
    async query(sql: string): Promise<RawResult> {
      sent.push(sql);
      const failure = script.fail?.(sql);
      if (failure !== undefined) throw failure;
      if (sql === "pragma busy_timeout") {
        return { rows: [{ timeout: script.timeout ?? 5000 }], rowCount: 1, insertId: undefined };
      }
      if (sql === "begin immediate" && busy > 0) {
        busy--;
        throw new DatabaseError("The database is locked by another connection (SQLITE_BUSY).", {
          code: "database",
          retryable: true,
        });
      }
      return EMPTY;
    },
    async cursor(): Promise<DriverCursor> {
      throw new Error("no cursors here");
    },
    async cancel(): Promise<void> {},
    inTransaction: () => false,
  };
  const driver: DriverWrapper = {
    init(): void {},
    acquire: async () => connection,
    release: async () => undefined,
    destroy: async () => undefined,
    stats: () => ({ size: 1, idle: 1, waiting: 0 }),
    saturated: () => false,
  };
  const adapter = createAdapter({
    dialect: "sqlite",
    capabilities: SQLITE_CAPABILITIES,
    quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
    driver: () => driver,
    driverCodecs: {},
    normalizeError: (error) => error,
  });
  return { adapter, sent };
}

const ONE: readonly MigrationSource[] = [
  {
    version: 20260101000000,
    name: "create_a",
    migration: defineMigration({
      change(m) {
        m.createTable("a", (t) => t.id());
      },
    }),
  },
];

describe("a transaction lock", () => {
  test("holds a write transaction for the run; each migration is a savepoint in it", async () => {
    const { adapter, sent } = scripted();
    await createMigrator({ adapter, migrations: ONE }).up();
    const lock = sent.indexOf("begin immediate");
    expect(sent.slice(0, lock + 2)).toEqual([
      "pragma busy_timeout",
      "pragma busy_timeout = 0",
      "begin immediate",
      "pragma busy_timeout = 5000",
    ]);
    expect(sent).toContain('savepoint "egon_migration"');
    expect(sent).toContain('release savepoint "egon_migration"');
    expect(sent).not.toContain("begin");
    expect(sent.at(-1)).toBe("commit");
  });

  test("waits while the database is busy, without blocking, and then takes it", async () => {
    const { adapter, sent } = scripted({ busy: 3 });
    await createMigrator({ adapter, migrations: ONE }).up();
    expect(sent.filter((sql) => sql === "begin immediate")).toHaveLength(4);
  });

  test("gives up after lockTimeoutMs, and puts the busy timeout back", async () => {
    const { adapter, sent } = scripted({ busy: 1_000, timeout: 1234 });
    const error = await createMigrator({ adapter, migrations: ONE, lockTimeoutMs: 60 })
      .up()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toMatch(/Gave up waiting for the migration lock after 60 ms/);
    expect(sent).toContain("pragma busy_timeout = 1234");
    expect(sent).not.toContain("commit");
  });

  test("a busy timeout it cannot read is left as it is; another error ends the run", async () => {
    const { adapter, sent } = scripted({
      timeout: "unknown",
      fail: (sql) => (sql === "begin immediate" ? new Error("disk I/O error") : undefined),
    });
    await expect(createMigrator({ adapter, migrations: ONE }).up()).rejects.toThrow("disk I/O error");
    expect(sent.filter((sql) => sql.startsWith("pragma busy_timeout ="))).toEqual([
      "pragma busy_timeout = 0",
    ]);
  });

  test("a failing migration rolls back to its savepoint, and the run commits what came before", async () => {
    const { adapter, sent } = scripted({
      fail: (sql) => (sql.startsWith('create table "a"') ? new Error("table a exists") : undefined),
    });
    await expect(createMigrator({ adapter, migrations: ONE }).up()).rejects.toThrow(MigrationError);
    expect(sent).toContain('rollback to savepoint "egon_migration"');
    expect(sent.at(-1)).toBe("commit");
  });
});
