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
import { fragment } from "../query/functions.js";
import { defineMigration } from "./define.js";
import type { MigrationSource } from "./loader.js";
import { createMigrator, type MigrationEvent } from "./migrator.js";

const EMPTY: RawResult = { rows: [], rowCount: 0, insertId: undefined };

interface Script {
  /** How many times `begin immediate` finds the database busy before it succeeds. */
  busy?: number;
  /** What `pragma busy_timeout` reads. */
  timeout?: unknown;
  /** Makes a statement fail. */
  fail?: (sql: string) => Error | undefined;
  /** How many times another runner's claim is found before it is gone (the tracking table exists). */
  claims?: number;
  /** The versions in the tracking table, read back by the runner. */
  versions?: readonly number[];
}

function scripted(script: Script = {}) {
  const sent: string[] = [];
  let busy = script.busy ?? 0;
  let claims = script.claims ?? 0;
  const connection: DriverConnection = {
    async query(sql: string): Promise<RawResult> {
      sent.push(sql);
      const failure = script.fail?.(sql);
      if (failure !== undefined) throw failure;
      if (sql === "pragma busy_timeout") {
        return { rows: [{ timeout: script.timeout ?? 5000 }], rowCount: 1, insertId: undefined };
      }
      if (script.claims !== undefined && /^select 1 from pragma_table_(list|info)/.test(sql)) {
        return { rows: [{ one: 1 }], rowCount: 1, insertId: undefined };
      }
      if (script.versions !== undefined && sql.startsWith('select "version"')) {
        const rows = script.versions.map((version) => ({ version }));
        return { rows, rowCount: rows.length, insertId: undefined };
      }
      if (sql.startsWith("select 1 from") && sql.includes('where "version"')) {
        if (claims === 0) return EMPTY;
        claims--;
        return { rows: [{ one: 1 }], rowCount: 1, insertId: undefined };
      }
      if (sql === "begin immediate" && busy > 0) {
        busy--;
        throw new DatabaseError(
          "database.rejected",
          "The database is locked by another connection (SQLITE_BUSY).",
          {
            code: "database",
            retryable: true,
          },
        );
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
      up(m) {
        m.createTable("a", (t) => t.id());
      },
      down(m) {
        m.dropTable("a");
      },
    }),
  },
];

describe("a transaction lock", () => {
  test("holds a write transaction for the run; each migration is a savepoint in it", async () => {
    const { adapter, sent } = scripted();
    await createMigrator({ adapter, migrations: ONE }).up();
    const lock = sent.indexOf("begin immediate");
    expect(sent.slice(0, lock + 1)).toEqual([
      "pragma busy_timeout",
      "pragma busy_timeout = 0",
      "begin immediate",
    ]);
    // Then it looks for another runner's claim (none: the tracking table does not exist yet).
    expect(sent[lock + 1]).toMatch(/^select 1 from pragma_table_list/);
    expect(sent[lock + 2]).toBe("pragma busy_timeout = 5000");
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

describe("a migration without a transaction under a transaction lock", () => {
  const OUTSIDE: readonly MigrationSource[] = [
    {
      version: 20260101000000,
      name: "vacuum",
      migration: defineMigration({
        transaction: false,
        up(m) {
          m.execute(fragment`vacuum`);
        },
        down() {},
      }),
    },
  ];

  test("runs outside the lock: claim, commit, run, lock again, drop the claim, record", async () => {
    const { adapter, sent } = scripted();
    await createMigrator({ adapter, migrations: OUTSIDE }).up();
    const at = sent.indexOf("vacuum");
    const claim = sent.findIndex((sql) => sql.startsWith("insert into") && sent.indexOf(sql) < at);
    expect(claim).toBeGreaterThan(-1);
    expect(sent[claim + 1]).toBe("commit");
    expect(sent.slice(at + 1).filter((sql) => sql === "begin immediate")).toHaveLength(1);
    const after = sent.slice(at + 1);
    expect(after.findIndex((sql) => sql.startsWith("delete from"))).toBeLessThan(
      after.findIndex((sql) => sql.startsWith("insert into")),
    );
    expect(sent).not.toContain('savepoint "egon_migration"');
    expect(sent.at(-1)).toBe("commit");
  });

  test("a failure still takes the lock back and drops the claim", async () => {
    const { adapter, sent } = scripted({
      fail: (sql) => (sql === "vacuum" ? new Error("disk full") : undefined),
    });
    const error = await createMigrator({ adapter, migrations: OUTSIDE })
      .up()
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/it ran without a transaction/);
    const after = sent.slice(sent.indexOf("vacuum") + 1);
    expect(after).toContain("begin immediate");
    expect(after.some((sql) => sql.startsWith("delete from"))).toBe(true);
    expect(after.some((sql) => sql.startsWith("insert into"))).toBe(false);
  });

  test("a claim it cannot remove is not kept quiet: a warning and the error say how to clear it", async () => {
    let failed = false;
    const { adapter } = scripted({
      fail: (sql) => {
        if (sql === "vacuum") {
          failed = true;
          return new Error("disk full");
        }
        return failed && sql === "begin immediate" ? new Error("disk I/O error") : undefined;
      },
    });
    const events: MigrationEvent[] = [];
    const error = await createMigrator({ adapter, migrations: OUTSIDE, log: (event) => events.push(event) })
      .up()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toMatch(
      /could not then take its lock back and remove its claim \(disk I\/O error\).*delete the row with version -1/,
    );
    const warnings = events.filter((event) => event.kind === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ version: 20260101000000 });
  });

  test("another runner that finds a claim gives the lock back and waits until it is gone", async () => {
    const { adapter, sent } = scripted({ claims: 2 });
    const events: MigrationEvent[] = [];
    await createMigrator({ adapter, migrations: ONE, log: (event) => events.push(event) }).up();
    expect(sent.filter((sql) => sql === "begin immediate")).toHaveLength(3);
    expect(sent.filter((sql) => sql === "rollback")).toHaveLength(2);
    // Said once, with what to do when the claim is stale (no lockTimeoutMs: the wait has no end).
    const warnings = events.filter((event) => event.kind === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ version: undefined });
    expect((warnings[0] as { message: string }).message).toMatch(
      /Waiting for a claim .*delete the row with version -1, and this run carries on/,
    );
  });

  test("status reports a claim apart from the migrations", async () => {
    const { adapter } = scripted({ claims: 0, versions: [-1, 20260101000000] });
    expect(await createMigrator({ adapter, migrations: ONE }).status()).toEqual([
      { version: -1, name: undefined, state: "claimed" },
      { version: 20260101000000, name: "create_a", state: "up" },
    ]);
  });

  test("a claim that stays makes it give up after lockTimeoutMs, saying how to clear it", async () => {
    const { adapter } = scripted({ claims: 1_000 });
    const error = await createMigrator({ adapter, migrations: ONE, lockTimeoutMs: 60 })
      .up()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toMatch(/delete the row with version -1/);
  });
});
