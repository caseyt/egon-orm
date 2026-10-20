// The runner over a fake Postgres (test-helpers.ts): which migrations it picks, in which
// order, what it sends for each (lock, transaction, tracking table), and what it does when
// something fails. What the statements do to a real database is the conformance suite's.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createAdapter } from "../adapter/adapter.js";
import { POSTGRES_CAPABILITIES } from "../compiler/dialect.js";
import { MigrationError } from "../errors.js";
import { fragment } from "../query/functions.js";
import { defineMigration, type Migration } from "./define.js";
import type { MigrationSource } from "./loader.js";
import { createMigrator, type MigrationEvent, type MigratorOptions } from "./migrator.js";
import { type FakeDatabase, type FakeDatabaseOptions, fakeDatabase } from "./test-helpers.js";

const V1 = 20260101000000;
const V2 = 20260201000000;
const V3 = 20260301000000;

/** A reversible migration that creates the table `name`. */
function creates(name: string): Migration {
  return defineMigration({
    change(m) {
      m.createTable(name, (t) => t.id());
    },
  });
}

const THREE: readonly MigrationSource[] = [
  { version: V1, name: "create_a", migration: creates("a") },
  { version: V2, name: "create_b", migration: creates("b") },
  { version: V3, name: "create_c", migration: creates("c") },
];

function setup(
  migrations: readonly MigrationSource[] = THREE,
  db: FakeDatabaseOptions = {},
  options: Partial<MigratorOptions> = {},
): { fake: FakeDatabase; events: MigrationEvent[]; migrator: ReturnType<typeof createMigrator> } {
  const fake = fakeDatabase(db);
  const events: MigrationEvent[] = [];
  const migrator = createMigrator({
    adapter: fake.adapter,
    migrations,
    log: (event) => events.push(event),
    ...options,
  });
  return { fake, events, migrator };
}

async function rejection(promise: Promise<unknown>): Promise<MigrationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError);
    return error as MigrationError;
  }
  throw new Error("expected a rejection");
}

describe("up", () => {
  test("creates the tracking table, takes the lock, runs each migration in a transaction and records it", async () => {
    const { fake, events, migrator } = setup();
    const runs = await migrator.up();
    expect(runs.map((run) => [run.version, run.name, run.direction])).toEqual([
      [V1, "create_a", "up"],
      [V2, "create_b", "up"],
      [V3, "create_c", "up"],
    ]);
    expect(runs.every((run) => run.durationMs >= 0)).toBe(true);
    expect(runs[0]?.statements).toEqual([
      { sql: 'create table "a" ("id" bigserial primary key)', params: [] },
    ]);
    expect(fake.versions()).toEqual([V1, V2, V3]);
    expect(fake.locked()).toBe(false);
    expect(fake.released).toHaveLength(1);
    expect(fake.destroyed).toHaveLength(0);
    const sent = fake.statements.map((s) => s.sql);
    // A table it just created holds no versions, so it does not read them.
    expect(sent.slice(0, 3)).toEqual([
      "select pg_advisory_lock($1, $2)",
      "select 1 from information_schema.tables where table_schema = coalesce($1, current_schema()) and table_name = $2",
      'create table "schema_migrations" ("version" bigint primary key, "created_at" timestamp(0))',
    ]);
    expect(sent.slice(3, 7)).toEqual([
      "begin",
      'create table "a" ("id" bigserial primary key)',
      `insert into "schema_migrations" ("version", "created_at") values ($1, (now() at time zone 'utc'))`,
      "commit",
    ]);
    expect(sent.at(-1)).toBe("select pg_advisory_unlock($1, $2)");
    expect(fake.statements[5]?.params).toEqual([String(V1)]);
    expect(events.map((event) => event.kind)).toEqual([
      "migrating",
      "migrated",
      "migrating",
      "migrated",
      "migrating",
      "migrated",
    ]);
  });

  test("the lock keys are bound parameters, two 32-bit integers, and depend on the table", async () => {
    const one = setup();
    await one.migrator.up();
    const other = setup(THREE, {}, { table: "other_migrations" });
    await other.migrator.up();
    const keys = (fake: FakeDatabase): readonly unknown[] =>
      fake.statements.find((s) => s.sql.startsWith("select pg_advisory_lock"))?.params ?? [];
    const [a1, a2] = keys(one.fake);
    const [b1, b2] = keys(other.fake);
    expect(a1).toBe(b1);
    expect(a2).not.toBe(b2);
    for (const key of [a1, a2, b2])
      expect(Number.isInteger(key) && (key as number) === ((key as number) | 0)).toBe(true);
  });

  test("applies nothing when everything is applied", async () => {
    const { fake, migrator } = setup(THREE, { applied: [V1, V2, V3] });
    expect(await migrator.up()).toEqual([]);
    expect(fake.work()).toEqual([]);
  });

  test("step and to limit what is applied", async () => {
    const { fake, migrator } = setup();
    expect((await migrator.up({ step: 1 })).map((run) => run.version)).toEqual([V1]);
    expect((await migrator.up({ to: V2 })).map((run) => run.version)).toEqual([V2]);
    expect(fake.versions()).toEqual([V1, V2]);
  });

  test("a pending migration older than the latest applied one is applied, with a warning", async () => {
    const { fake, events, migrator } = setup(THREE, { applied: [V1, V3] });
    const runs = await migrator.up();
    expect(runs.map((run) => run.version)).toEqual([V2]);
    expect(fake.versions()).toEqual([V1, V2, V3]);
    const warning = events.find((event) => event.kind === "warning");
    expect(warning).toMatchObject({ kind: "warning", version: V2 });
    expect(warning?.kind === "warning" && warning.message).toMatch(/older than the latest applied migration/);
  });

  test("a failing migration is rolled back, not recorded, and stops the run", async () => {
    const failure = new Error('relation "b" already exists');
    const { fake, migrator } = setup(THREE, {
      fail: (sql) => (sql.startsWith('create table "b"') ? failure : undefined),
    });
    const error = await rejection(migrator.up());
    expect(error.version).toBe(V2);
    expect(error.migration).toBe("create_b");
    expect(error.sql).toBe('create table "b" ("id" bigserial primary key)');
    expect(error.cause).toBe(failure);
    expect(error.message).toBe(
      'Migration 20260201000000_create_b failed and was rolled back: relation "b" already exists',
    );
    expect(fake.versions()).toEqual([V1]);
    expect(fake.work()).toEqual([
      'create table "a" ("id" bigserial primary key)',
      'create table "b" ("id" bigserial primary key)',
    ]);
    expect(fake.statements.map((s) => s.sql)).toContain("rollback");
    expect(fake.locked()).toBe(false);
    expect(fake.destroyed).toEqual([]);
  });

  test("without a transaction a failure says the migration may be partly applied", async () => {
    const migrations: MigrationSource[] = [
      {
        version: V1,
        name: "two_tables",
        migration: defineMigration({
          transaction: false,
          up(m) {
            m.createTable("x", (t) => t.id());
            m.createTable("y", (t) => t.id());
          },
        }),
      },
    ];
    const { fake, migrator } = setup(migrations, {
      fail: (sql) => (sql.startsWith('create table "y"') ? new Error("no") : undefined),
    });
    const error = await rejection(migrator.up());
    expect(error.message).toMatch(
      /ran without a transaction, so the statements before the failing one stay applied/,
    );
    expect(fake.statements.map((s) => s.sql)).not.toContain("begin");
    expect(fake.statements.map((s) => s.sql)).not.toContain("rollback");
  });

  test("a database without transactional DDL runs migrations without a transaction", async () => {
    const { fake, migrator } = setup(THREE, {
      capabilities: { ...POSTGRES_CAPABILITIES, ddlTransactions: false },
    });
    await migrator.up();
    expect(fake.statements.map((s) => s.sql)).not.toContain("begin");
    expect(fake.versions()).toEqual([V1, V2, V3]);
  });

  test("a concurrent index in a transaction is refused before anything runs; transaction: false allows it", async () => {
    const index = (transaction: boolean): Migration =>
      defineMigration({
        transaction,
        change(m) {
          m.createIndex("users", ["email"], { concurrently: true });
        },
      });
    const refused = setup([{ version: V1, name: "index_email", migration: index(true) }]);
    const error = await rejection(refused.migrator.up());
    expect(error.message).toMatch(/cannot run inside a transaction. Add transaction: false/);
    expect(refused.fake.work()).toEqual([]);
    expect(refused.fake.locked()).toBe(false);
    const allowed = setup([{ version: V1, name: "index_email", migration: index(false) }]);
    await allowed.migrator.up();
    expect(allowed.fake.work()).toEqual([
      'create index concurrently "users_email_index" on "users" ("email")',
    ]);
  });

  test("a failed rollback destroys the connection, which releases the lock", async () => {
    const { fake, migrator } = setup(THREE, {
      failRollback: true,
      fail: (sql) => (sql.startsWith('create table "a"') ? new Error("boom") : undefined),
    });
    await rejection(migrator.up());
    expect(fake.destroyed).toHaveLength(1);
    expect(fake.released).toHaveLength(0);
    expect(fake.statements.map((s) => s.sql)).not.toContain("select pg_advisory_unlock($1, $2)");
    expect(fake.locked()).toBe(false);
  });

  test("a failed unlock destroys the connection", async () => {
    const { fake, migrator } = setup(THREE, { failUnlock: true });
    await migrator.up();
    expect(fake.destroyed).toHaveLength(1);
    expect(fake.locked()).toBe(false);
  });

  test("an error while emitting names the migration, and nothing of it runs", async () => {
    const migrations: MigrationSource[] = [
      {
        version: V1,
        name: "bad_index",
        migration: defineMigration({
          up(m) {
            m.createIndex("users", ["email"], { using: "rtree" });
          },
        }),
      },
    ];
    const { fake, migrator } = setup(migrations);
    const error = await rejection(migrator.up());
    expect(error.message).toMatch(/^Migration 20260101000000_bad_index: The index method "rtree"/);
    expect(error.version).toBe(V1);
    expect(fake.work()).toEqual([]);
  });

  test("an error thrown by the migration's own code is wrapped with its version", async () => {
    const thrown = new RangeError("oops");
    const migrations: MigrationSource[] = [
      {
        version: V1,
        name: "throws",
        migration: defineMigration({
          up() {
            throw thrown;
          },
        }),
      },
    ];
    const error = await rejection(setup(migrations).migrator.up());
    expect(error.message).toBe("Migration 20260101000000_throws: oops");
    expect(error.cause).toBe(thrown);
  });

  test("an async migration is awaited before its statements are written", async () => {
    const migrations: MigrationSource[] = [
      {
        version: V1,
        name: "later",
        migration: defineMigration({
          async change(m) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            m.createTable("later", (t) => t.id());
          },
        }),
      },
    ];
    const { fake, migrator } = setup(migrations);
    await migrator.up();
    expect(fake.work()).toEqual(['create table "later" ("id" bigserial primary key)']);
  });
});

describe("down", () => {
  test("rolls back the latest migration by default, running the inverse of change", async () => {
    const { fake, migrator } = setup(THREE, { applied: [V1, V2, V3] });
    const runs = await migrator.down();
    expect(runs.map((run) => [run.version, run.direction])).toEqual([[V3, "down"]]);
    expect(fake.work()).toEqual(['drop table "c"']);
    expect(fake.versions()).toEqual([V1, V2]);
    const sent = fake.statements.map((s) => s.sql);
    expect(sent).toContain('delete from "schema_migrations" where "version" = $1');
  });

  test("step, to (inclusive) and all", async () => {
    const step = setup(THREE, { applied: [V1, V2, V3] });
    expect((await step.migrator.down({ step: 2 })).map((run) => run.version)).toEqual([V3, V2]);
    const to = setup(THREE, { applied: [V1, V2, V3] });
    expect((await to.migrator.down({ to: V2 })).map((run) => run.version)).toEqual([V3, V2]);
    const all = setup(THREE, { applied: [V1, V2, V3] });
    expect((await all.migrator.down({ all: true })).map((run) => run.version)).toEqual([V3, V2, V1]);
    expect(all.fake.versions()).toEqual([]);
  });

  test("nothing to roll back is not an error", async () => {
    const { migrator } = setup();
    expect(await migrator.down()).toEqual([]);
  });

  test("a recorded version whose migration is missing blocks rolling back past it, before anything runs", async () => {
    const { fake, migrator } = setup([THREE[0] as MigrationSource, THREE[2] as MigrationSource], {
      applied: [V1, V2, V3],
    });
    const error = await rejection(migrator.down({ step: 2 }));
    expect(error.message).toMatch(
      /Cannot roll back past version 20260201000000: it is recorded as applied, but there is no migration/,
    );
    expect(fake.work()).toEqual([]);
    expect(fake.versions()).toEqual([V1, V2, V3]);
    // The migrations newer than it can still be rolled back.
    expect((await migrator.down({ step: 1 })).map((run) => run.version)).toEqual([V3]);
  });

  test("up without down cannot be rolled back", async () => {
    const migrations = [{ version: V1, name: "one_way", migration: defineMigration({ up() {} }) }];
    const { fake, migrator } = setup(migrations, { applied: [V1] });
    const error = await rejection(migrator.down());
    expect(error.message).toMatch(/has up\(\) and no down\(\)/);
    expect(fake.versions()).toEqual([V1]);
  });

  test("down() runs what it records", async () => {
    const migrations = [
      {
        version: V1,
        name: "data",
        migration: defineMigration({
          up(m) {
            m.execute(fragment`update users set role = ${"member"} where role is null`);
          },
          down(m) {
            m.execute(fragment`update users set role = null where role = ${"member"}`);
          },
        }),
      },
    ];
    const { fake, migrator } = setup(migrations, { applied: [V1] });
    await migrator.down();
    expect(fake.work()).toEqual(["update users set role = null where role = $1"]);
    expect(fake.statements.find((s) => s.sql.startsWith("update"))?.params).toEqual(["member"]);
  });

  test("a change that cannot be reversed is refused at rollback, and nothing of it runs", async () => {
    const migrations = [
      {
        version: V1,
        name: "drop_age",
        migration: defineMigration({
          change(m) {
            m.alterTable("users", (t) => t.remove("age"));
          },
        }),
      },
    ];
    const { fake, migrator } = setup(migrations);
    await migrator.up();
    expect(fake.work()).toEqual(['alter table "users" drop column "age"']);
    const error = await rejection(migrator.down());
    expect(error.message).toMatch(
      /^Migration 20260101000000_drop_age cannot be rolled back: .*remove\("age"\) has no type/,
    );
    expect(fake.versions()).toEqual([V1]);
  });
});

describe("dry run", () => {
  test("returns the SQL of each pending migration and runs nothing, not even the lock", async () => {
    const migrations: MigrationSource[] = [
      ...THREE.slice(0, 2),
      {
        version: V3,
        name: "data",
        migration: defineMigration({
          up(m) {
            m.execute(fragment`update users set role = ${"member"}`);
          },
        }),
      },
    ];
    const { fake, migrator } = setup(migrations, { applied: [V1] });
    const runs = await migrator.up({ dryRun: true });
    expect(runs).toEqual([
      {
        version: V2,
        name: "create_b",
        direction: "up",
        durationMs: 0,
        statements: [{ sql: 'create table "b" ("id" bigserial primary key)', params: [] }],
      },
      {
        version: V3,
        name: "data",
        direction: "up",
        durationMs: 0,
        statements: [{ sql: "update users set role = $1", params: ["member"] }],
      },
    ]);
    expect(fake.work()).toEqual([]);
    expect(fake.versions()).toEqual([V1]);
    expect(fake.statements.some((s) => s.sql.includes("pg_advisory"))).toBe(false);
  });

  test("does not create the tracking table", async () => {
    const { fake, migrator } = setup();
    expect(await migrator.up({ dryRun: true })).toHaveLength(3);
    expect(fake.tracking()).toBe(false);
  });

  test("works for a rollback", async () => {
    const { fake, migrator } = setup(THREE, { applied: [V1, V2] });
    const runs = await migrator.down({ dryRun: true, step: 2 });
    expect(runs.map((run) => run.statements[0]?.sql)).toEqual(['drop table "b"', 'drop table "a"']);
    expect(fake.versions()).toEqual([V1, V2]);
  });
});

describe("status", () => {
  test("lists known migrations as up or down and recorded ones without a migration as missing", async () => {
    const { migrator } = setup([THREE[0] as MigrationSource, THREE[2] as MigrationSource], {
      applied: [V1, V2],
    });
    expect(await migrator.status()).toEqual([
      { version: V1, name: "create_a", state: "up" },
      { version: V2, name: undefined, state: "missing" },
      { version: V3, name: "create_c", state: "down" },
    ]);
  });

  test("before the tracking table exists everything is down, and the table is not created", async () => {
    const { fake, migrator } = setup();
    expect((await migrator.status()).map((row) => row.state)).toEqual(["down", "down", "down"]);
    expect(fake.tracking()).toBe(false);
  });
});

describe("the tracking table", () => {
  test("can live in a database schema", async () => {
    const { fake, migrator } = setup(THREE, {}, { schema: "ops" });
    await migrator.up({ step: 1 });
    const sent = fake.statements.map((s) => s.sql);
    expect(sent).toContain(
      'create table "ops"."schema_migrations" ("version" bigint primary key, "created_at" timestamp(0))',
    );
    expect(fake.statements[1]?.params).toEqual(["ops", "schema_migrations"]);
  });

  test("an existing table without the timestamp column is refused with the option to pass", async () => {
    const { fake, migrator } = setup(THREE, { applied: [V1], columns: ["version", "inserted_at"] });
    const error = await rejection(migrator.up());
    expect(error.message).toMatch(/has no column "created_at".*timestampColumn: "inserted_at"/);
    expect(fake.work()).toEqual([]);
  });

  test("an existing table with another timestamp column is adopted when it is named", async () => {
    const { fake, migrator } = setup(
      THREE,
      { applied: [V1], columns: ["version", "inserted_at"] },
      { timestampColumn: "inserted_at" },
    );
    expect((await migrator.up()).map((run) => run.version)).toEqual([V2, V3]);
    expect(fake.statements.map((s) => s.sql)).toContain(
      `insert into "schema_migrations" ("version", "inserted_at") values ($1, (now() at time zone 'utc'))`,
    );
  });

  test("a version that is not a safe whole number is refused", async () => {
    const { migrator } = setup(THREE, { applied: [Number.MAX_SAFE_INTEGER + 2] });
    await expect(migrator.status()).rejects.toThrow(/not a safe whole number/);
  });
});

describe("two runners at once", () => {
  test("take turns: each version is applied once", async () => {
    const fake = fakeDatabase();
    const one = createMigrator({ adapter: fake.adapter, migrations: THREE });
    const two = createMigrator({ adapter: fake.adapter, migrations: THREE });
    const [a, b] = await Promise.all([one.up(), two.up()]);
    expect([...(a ?? []), ...(b ?? [])].map((run) => run.version).sort()).toEqual([V1, V2, V3]);
    expect(fake.work()).toEqual([
      'create table "a" ("id" bigserial primary key)',
      'create table "b" ("id" bigserial primary key)',
      'create table "c" ("id" bigserial primary key)',
    ]);
  });

  test("gives up after lockTimeoutMs while the other holds the lock", async () => {
    const fake = fakeDatabase();
    const holder = await fake.adapter.acquire();
    await holder.execute("select pg_advisory_lock($1, $2)", [0, 0]);
    const migrator = createMigrator({ adapter: fake.adapter, migrations: THREE, lockTimeoutMs: 5 });
    const error = await rejection(migrator.up());
    expect(error.message).toMatch(/Gave up waiting for the migration lock after 5 ms/);
    // The connection that waited is closed, never pooled (holder 1, waiter 2).
    expect(fake.destroyed).toEqual([2]);
    await holder.release();
  });

  test("a lock statement that fails otherwise is passed on", async () => {
    const failure = new Error("permission denied");
    const fake = fakeDatabase({
      fail: (sql) => (sql.startsWith("select pg_advisory_lock") ? failure : undefined),
    });
    const migrator = createMigrator({ adapter: fake.adapter, migrations: THREE });
    await expect(migrator.up()).rejects.toBe(failure);
    // Destroyed, not returned to the pool: the lock may have been granted after all.
    expect(fake.destroyed).toHaveLength(1);
    expect(fake.released).toHaveLength(0);
  });
});

describe("telemetry", () => {
  test("every statement is reported with a migration context, and timeoutMs is passed on", async () => {
    const fake = fakeDatabase();
    const contexts: unknown[] = [];
    fake.adapter.on("query", (event) => contexts.push(event.context));
    await createMigrator({ adapter: fake.adapter, migrations: THREE.slice(0, 1), timeoutMs: 1000 }).up();
    expect(contexts).toContainEqual({
      operation: "migration",
      version: V1,
      name: "create_a",
      direction: "up",
    });
    // Everything but begin and commit, which the connection sends without a context.
    expect(contexts.filter((context) => context === undefined)).toHaveLength(2);
    expect(
      contexts.every(
        (context) => context === undefined || (context as { operation?: unknown }).operation === "migration",
      ),
    ).toBe(true);
  });
});

describe("timeoutMs", () => {
  test("stops a migration statement that runs too long, and the migration is rolled back", async () => {
    const { fake, migrator } = setup(
      THREE,
      { hang: (sql) => sql.startsWith('create table "b"') },
      { timeoutMs: 5 },
    );
    const error = await rejection(migrator.up());
    expect(error.version).toBe(V2);
    expect((error.cause as { code?: unknown }).code).toBe("timeout");
    expect(fake.versions()).toEqual([V1]);
  });
});

describe("a directory", () => {
  test("is loaded on every call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "egon-migrator-"));
    try {
      const fake = fakeDatabase();
      const migrator = createMigrator({ adapter: fake.adapter, directory });
      expect(await migrator.status()).toEqual([]);
      await writeFile(
        join(directory, "20260101000000_first.mjs"),
        'export default { [Symbol.for("egon.migration")]: true, change: (m) => m.createTable("t", (t) => t.id()), up: undefined, down: undefined, transaction: true };\n',
      );
      expect((await migrator.up()).map((run) => run.name)).toEqual(["first"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("options", () => {
  const adapter = fakeDatabase().adapter;
  test.each<[string, unknown]>([
    ["no options", undefined],
    ["an unknown option", { adapter, migrations: [], prefix: "x" }],
    ["no adapter", { migrations: [] }],
    ["an adapter that is not one", { adapter: {}, migrations: [] }],
    ["both directory and migrations", { adapter, migrations: [], directory: "m" }],
    ["neither directory nor migrations", { adapter }],
    ["an empty directory name", { adapter, directory: "" }],
    ["a log that is not a function", { adapter, migrations: [], log: true }],
    ["an empty table name", { adapter, migrations: [], table: "" }],
    ["an empty schema", { adapter, migrations: [], schema: "" }],
    ["an empty timestamp column", { adapter, migrations: [], timestampColumn: "" }],
    ["a negative lockTimeoutMs", { adapter, migrations: [], lockTimeoutMs: -1 }],
    ["a timeoutMs that is not a number", { adapter, migrations: [], timeoutMs: "1s" }],
  ])("createMigrator refuses %s", (_name, options) => {
    expect(() => createMigrator(options as never)).toThrow(TypeError);
  });

  test("a dialect without migration support is refused", () => {
    // Every dialect of the Dialect type has migrations; an unknown name stands for one that would not.
    const mysql = createAdapter({
      dialect: "oracle" as never,
      capabilities: POSTGRES_CAPABILITIES,
      quoteIdentifier: (name) => `"${name}"`,
      driver: () => {
        throw new Error("not used");
      },
      driverCodecs: {},
      normalizeError: (error) => error,
    });
    expect(() => createMigrator({ adapter: mysql, migrations: [] })).toThrow(MigrationError);
  });

  test.each<[string, unknown]>([
    ["an unknown option", { force: true }],
    ["to and step", { to: V1, step: 1 }],
    ["a step of zero", { step: 0 }],
    ["a version that is not one", { to: "latest" }],
    ["a dryRun that is not a boolean", { dryRun: 1 }],
  ])("up refuses %s", (_name, options) => {
    expect(() => setup().migrator.up(options as never)).toThrow(TypeError);
  });

  test.each<[string, unknown]>([
    ["to and all", { to: V1, all: true }],
    ["step and all", { step: 1, all: true }],
    ["all: false", { all: false }],
    ["a fractional step", { step: 1.5 }],
  ])("down refuses %s", (_name, options) => {
    expect(() => setup().migrator.down(options as never)).toThrow(TypeError);
  });
});
