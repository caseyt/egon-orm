// The egon commands run in process against the fake Postgres of the core migration tests:
// their output (log lines, tables, dry runs, JSON), warnings, failures and what they send.
// The same commands run through the built binary against real Postgres in test/cli.itest.ts.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseError, fragment } from "egon-orm";
import { messages } from "egon-orm/messages";
import { defineMigration, type MigrationSource } from "egon-orm/migration";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type FakeDatabase,
  type FakeDatabaseOptions,
  fakeDatabase,
} from "../../core/src/migration/test-helpers.js";
import { type CliIo, run } from "./cli.js";

const V1 = 20260101000000;
const V2 = 20260201000000;
const V3 = 20260301000000;

function creates(table: string) {
  return defineMigration({
    up(m) {
      m.createTable(table, (t) => t.id());
    },
    down(m) {
      m.dropTable(table);
    },
  });
}

const THREE: readonly MigrationSource[] = [
  { version: V1, name: "create_a", migration: creates("a") },
  { version: V2, name: "create_b", migration: creates("b") },
  {
    version: V3,
    name: "fill_a",
    migration: defineMigration({
      up(m) {
        m.execute(fragment`insert into a (id) values (${7})`);
      },
      down(m) {
        m.execute(fragment`delete from a where id = ${7}`);
      },
    }),
  },
];

interface Setup {
  readonly main: FakeDatabase;
  readonly admin: FakeDatabase;
}

declare global {
  // The config module of each test reads its configuration from here.
  var egonTestConfig: (() => unknown) | undefined;
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "egon-commands-"));
  // Each read of `adapter` is a new adapter over the same fake database: the CLI closes the
  // adapters when a command ends, and a test runs several commands.
  await writeFile(
    join(cwd, "egon.config.mjs"),
    "const make = globalThis.egonTestConfig;\nexport default {\n  get adapter() { return make().adapter; },\n  get migrations() { return make().migrations; },\n  get database() { return make().database; },\n};\n",
  );
});
afterEach(async () => {
  globalThis.egonTestConfig = undefined;
  await rm(cwd, { recursive: true, force: true });
});

function configure(
  migrations: readonly MigrationSource[] = THREE,
  options: FakeDatabaseOptions = {},
  extra: Record<string, unknown> = {},
): Setup {
  const main = fakeDatabase(options);
  const admin = fakeDatabase();
  globalThis.egonTestConfig = () => ({
    adapter: main.newAdapter(),
    migrations: { migrations, ...extra },
    database: { name: "blog_dev", admin: admin.newAdapter() },
  });
  return { main, admin };
}

async function egon(argv: readonly string[], env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    cwd,
    env,
    now: () => new Date("2026-10-12T09:30:00Z"),
  };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

/** Log lines with the durations taken out. */
const lines = (text: string): string => text.replace(/\(\d+\.\d ms\)/g, "(… ms)");

describe("egon migrate", () => {
  test("applies the pending migrations with a line each, then has nothing to do", async () => {
    const { main } = configure();
    const first = await egon(["migrate"]);
    expect(first.code).toBe(0);
    expect(lines(first.stdout)).toMatchInlineSnapshot(`
      "== 20260101000000 create_a: migrating
      == 20260101000000 create_a: migrated (… ms)
      == 20260201000000 create_b: migrating
      == 20260201000000 create_b: migrated (… ms)
      == 20260301000000 fill_a: migrating
      == 20260301000000 fill_a: migrated (… ms)
      Applied 3 migrations.
      "
    `);
    expect(main.versions()).toEqual([V1, V2, V3]);
    expect((await egon(["migrate"])).stdout).toBe("Nothing to migrate: every migration is applied.\n");
  });

  test("--step, --to, and the singular", async () => {
    const { main } = configure();
    expect((await egon(["migrate", "--step", "1"])).stdout).toMatch(/Applied 1 migration\.\n$/);
    expect((await egon(["migrate", "--to", String(V2)])).stdout).toMatch(/create_b: migrated/);
    expect(main.versions()).toEqual([V1, V2]);
  });

  test("--dry-run prints each statement and its parameters, and changes nothing", async () => {
    const { main } = configure();
    const dry = await egon(["migrate", "--dry-run"]);
    expect(dry.stdout).toMatchInlineSnapshot(`
      "-- 20260101000000 create_a (up)
      create table "a" ("id" bigserial primary key);
      -- 20260201000000 create_b (up)
      create table "b" ("id" bigserial primary key);
      -- 20260301000000 fill_a (up)
      insert into a (id) values ($1);
      -- params: [7]
      Dry run: 3 migrations would run; nothing was changed.
      "
    `);
    expect(main.versions()).toEqual([]);
    await egon(["migrate"]);
    expect((await egon(["migrate", "--dry-run"])).stdout).toBe("Nothing to run.\n");
  });

  test("--json prints one object; --dry-run --json includes the statements", async () => {
    configure();
    const dry = JSON.parse((await egon(["migrate", "--dry-run", "--json"])).stdout) as {
      ok: boolean;
      dryRun: boolean;
      migrations: { name: string; statements: unknown[] }[];
    };
    expect(dry).toMatchObject({ ok: true, dryRun: true });
    expect(dry.migrations[2]?.statements).toEqual([{ sql: "insert into a (id) values ($1)", params: [7] }]);
    const applied = await egon(["migrate", "--json"]);
    expect(applied.stderr).toBe("");
    const report = JSON.parse(applied.stdout) as { command: string; migrations: Record<string, unknown>[] };
    expect(report.command).toBe("migrate");
    expect(report.migrations.map((m) => Object.keys(m).sort())).toEqual(
      Array(3).fill(["direction", "durationMs", "name", "version"]),
    );
  });

  test("an out-of-order migration is applied with a warning on stderr", async () => {
    configure(THREE, { applied: [V1, V3] });
    const result = await egon(["migrate"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(
      /^warning: Migration 20260201000000_create_b is older than the latest applied/,
    );
  });
});

describe("egon rollback", () => {
  test("rolls back the latest, --step, --to and --all", async () => {
    const { main } = configure(THREE, { applied: [V1, V2, V3] });
    expect(lines((await egon(["rollback"])).stdout)).toMatchInlineSnapshot(`
      "== 20260301000000 fill_a: rolling back
      == 20260301000000 fill_a: rolled back (… ms)
      Rolled back 1 migration.
      "
    `);
    expect(main.versions()).toEqual([V1, V2]);
    await egon(["migrate"]);
    expect((await egon(["rollback", "--step", "2"])).stdout).toMatch(/Rolled back 2 migrations\.\n$/);
    await egon(["migrate"]);
    expect((await egon(["rollback", "--to", String(V2)])).stdout).toMatch(/Rolled back 2 migrations\.\n$/);
    expect((await egon(["rollback", "--all"])).stdout).toMatch(/Rolled back 1 migration\.\n$/);
    expect((await egon(["rollback"])).stdout).toBe("Nothing to roll back.\n");
  });

  test("--dry-run and --json", async () => {
    const { main } = configure(THREE, { applied: [V1, V2, V3] });
    expect((await egon(["rollback", "--dry-run"])).stdout).toMatch(
      /^-- 20260301000000 fill_a \(down\)\ndelete from a where id = \$1;\n-- params: \[7\]\n/,
    );
    const report = JSON.parse((await egon(["rollback", "--json", "--all"])).stdout) as {
      command: string;
      migrations: { direction: string }[];
    };
    expect(report.command).toBe("rollback");
    expect(report.migrations.map((m) => m.direction)).toEqual(["down", "down", "down"]);
    expect(main.versions()).toEqual([]);
  });
});

describe("egon migrations", () => {
  test("prints the status table, or JSON", async () => {
    configure([THREE[0] as MigrationSource, THREE[2] as MigrationSource], { applied: [V1, V2] });
    expect((await egon(["migrations"])).stdout).toMatchInlineSnapshot(`
      "Status   Version         Name
      up       20260101000000  create_a
      missing  20260201000000  ** no file **
      down     20260301000000  fill_a
      "
    `);
    const json = JSON.parse((await egon(["migrations", "--json"])).stdout) as { migrations: unknown[] };
    expect(json.migrations).toEqual([
      { version: V1, name: "create_a", state: "up" },
      { version: V2, state: "missing" },
      { version: V3, name: "fill_a", state: "down" },
    ]);
  });

  test("with no migrations at all", async () => {
    configure([]);
    expect((await egon(["migrations"])).stdout).toBe("No migrations.\n");
  });

  test("the directory from the config, resolved against the config file", async () => {
    configure([]);
    globalThis.egonTestConfig = () => ({
      adapter: fakeDatabase().adapter,
      migrations: { directory: "nowhere" },
    });
    const result = await egon(["migrations"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Cannot read the migrations directory "${join(cwd, "nowhere")}"`);
  });
});

describe("failures", () => {
  test("a failed migration prints the error and the statement, exit 1; --json prints the error object", async () => {
    configure(THREE, { fail: (sql) => (sql.startsWith('create table "b"') ? new Error("boom") : undefined) });
    const failed = await egon(["migrate"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toBe(
      `error: migration.failed: Migration 20260201000000_create_b failed and was rolled back: boom ${messages["migration.failed"]} See https://egon-orm.github.io/egon-orm/reference/errors/migration#migration-failed\n  in: create table "b" ("id" bigserial primary key)\n`,
    );
    const json = JSON.parse((await egon(["migrate", "--json"])).stdout) as { ok: boolean; error: unknown };
    expect(json).toEqual({
      ok: false,
      error: {
        name: "MigrationError",
        code: "migration",
        message: `migration.failed: Migration 20260201000000_create_b failed and was rolled back: boom ${messages["migration.failed"]} See https://egon-orm.github.io/egon-orm/reference/errors/migration#migration-failed`,
        version: V2,
        sql: 'create table "b" ("id" bigserial primary key)',
      },
    });
  });

  test("the cause of an Egon error is printed when it is itself an Egon error", async () => {
    configure(THREE, { hang: (sql) => sql.startsWith("select pg_advisory_lock") }, { lockTimeoutMs: 5 });
    const result = await egon(["migrate"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /^error: migration\.lockTimeout: Gave up waiting for the migration lock after 5 ms.*\n {2}caused by: database\.timeout: The statement was cancelled because it ran longer than its timeoutMs \(5 ms\)\. .*\n$/,
    );
  });

  test("a driver's own message, under a DatabaseError, is never printed", async () => {
    const secret = new Error(
      "duplicate key value violates unique constraint: Key (email)=(ada@secret.example) already exists",
    );
    const normalized = new DatabaseError(
      "database.rejected",
      "The database rejected the statement (SQLSTATE 23505).",
      {
        cause: secret,
      },
    );
    configure(THREE, { fail: (sql) => (sql.startsWith("select pg_advisory_lock") ? normalized : undefined) });
    const result = await egon(["migrate"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `error: database.rejected: The database rejected the statement (SQLSTATE 23505). ${messages["database.rejected"]} See https://egon-orm.github.io/egon-orm/reference/errors/database#database-rejected\n`,
    );
    expect(result.stderr).not.toContain("secret");
  });

  test("an error that is not Egon's prints its stack", async () => {
    configure(THREE, {
      fail: (sql) => (sql.startsWith("select pg_advisory_lock") ? new RangeError("odd") : undefined),
    });
    const result = await egon(["migrate"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^error: odd\nRangeError: odd\n {4}at /);
  });

  test("a thrown value that is not an Error", async () => {
    globalThis.egonTestConfig = () => {
      throw "not an error";
    };
    const text = await egon(["migrations"]);
    expect(text.stderr).toBe("error: not an error\n");
    const json = JSON.parse((await egon(["migrations", "--json"])).stdout) as { error: { name: string } };
    expect(json.error.name).toBe("Error");
  });
});

describe("egon db", () => {
  test("create, drop and reset run through the admin adapter; reset then migrates", async () => {
    const { main, admin } = configure();
    expect((await egon(["db", "create"])).stdout).toBe('Created the database "blog_dev".\n');
    expect((await egon(["db", "drop"])).stdout).toBe('Dropped the database "blog_dev" (if it existed).\n');
    const reset = await egon(["db", "reset"]);
    expect(lines(reset.stdout)).toMatchInlineSnapshot(`
      "Dropped the database "blog_dev" (if it existed).
      Created the database "blog_dev".
      == 20260101000000 create_a: migrating
      == 20260101000000 create_a: migrated (… ms)
      == 20260201000000 create_b: migrating
      == 20260201000000 create_b: migrated (… ms)
      == 20260301000000 fill_a: migrating
      == 20260301000000 fill_a: migrated (… ms)
      Applied 3 migrations.
      "
    `);
    expect(admin.statements.map((s) => s.sql)).toEqual([
      'create database "blog_dev"',
      'drop database if exists "blog_dev"',
      'drop database if exists "blog_dev"',
      'create database "blog_dev"',
    ]);
    expect(main.versions()).toEqual([V1, V2, V3]);
  });

  test("--json, and --force under NODE_ENV=production", async () => {
    configure();
    const json = JSON.parse(
      (await egon(["db", "reset", "--json", "--force"], { NODE_ENV: "production" })).stdout,
    ) as {
      ok: boolean;
      command: string;
      database: string;
      migrations: { name: string }[];
    };
    expect(json).toMatchObject({ ok: true, command: "db reset", database: "blog_dev" });
    expect(json.migrations.map((m) => m.name)).toEqual(["create_a", "create_b", "fill_a"]);
    const created = JSON.parse((await egon(["db", "create", "--json"])).stdout) as { migrations: unknown[] };
    expect(created.migrations).toEqual([]);
  });
});

describe("egon migrate create, then egon migrate", () => {
  test("the created file, filled in, is a migration the runner applies and rolls back", async () => {
    const main = fakeDatabase();
    globalThis.egonTestConfig = () => ({ adapter: main.newAdapter(), migrations: { directory: "db" } });
    const created = await egon(["migrate", "create", "create_things"]);
    expect(created).toEqual({
      code: 0,
      stdout: `Created ${join("db", "20261012093000_create_things.ts")}\n`,
      stderr: "",
    });
    const file = join(cwd, "db", "20261012093000_create_things.ts");
    const source = await readFile(file, "utf8");
    const filled = source
      .replace("    // the change\n", '    m.createTable("things", (t) => t.id());\n')
      .replace(
        "  down() {\n    // undo the change (write down(m) to use m), or leave a // noop comment\n",
        '  down(m) {\n    m.dropTable("things");\n',
      );
    expect(filled).not.toBe(source);
    await writeFile(file, filled);
    const dry = await egon(["migrate", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/^-- 20261012093000 create_things \(up\)\ncreate table "things" \(/);
    const migrated = await egon(["migrate"]);
    expect(lines(migrated.stdout)).toBe(
      "== 20261012093000 create_things: migrating\n== 20261012093000 create_things: migrated (… ms)\nApplied 1 migration.\n",
    );
    expect((await egon(["rollback"])).code).toBe(0);
    expect(main.work()).toEqual([
      'create table "things" ("id" bigserial primary key)',
      'drop table "things"',
    ]);
  });

  test("the created file as it is loads, applies and rolls back, running nothing", async () => {
    const main = fakeDatabase();
    globalThis.egonTestConfig = () => ({ adapter: main.newAdapter(), migrations: { directory: "db" } });
    expect((await egon(["migrate", "create", "empty"])).code).toBe(0);
    const migrated = await egon(["migrate"]);
    expect(migrated.code).toBe(0);
    expect(migrated.stdout).toMatch(/Applied 1 migration\.\n$/);
    const rolledBack = await egon(["rollback"]);
    expect(rolledBack.code).toBe(0);
    expect(rolledBack.stdout).toMatch(/Rolled back 1 migration\.\n$/);
    expect(main.work()).toEqual([]);
    expect(main.versions()).toEqual([]);
  });
});
