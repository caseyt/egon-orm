// The built `egon` binary, run as a user runs it: a temporary project whose node_modules
// link to the built packages, an egon.config.ts, migration files in TypeScript, and a
// Postgres database of its own. Every command is spawned as a separate process and checked
// by its exit code and output.
//
// The packages are built first (core, postgres, cli), because the binary and the project
// load the built dist/ files, as an installed package would.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTestDatabase,
  type TestDatabase,
  type TestDatabaseHandle,
  uniqueDatabaseName,
} from "@egon-orm/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { COMMAND_HELP, MAIN_HELP } from "../src/help.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = join(ROOT, "packages/cli/dist/bin.js");

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnNode(args: readonly string[], cwd: string, env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...args],
      { cwd, env: { ...process.env, NODE_ENV: "test", ...env }, timeout: 120_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** Builds one package with tsup, as `pnpm build` does. */
async function build(pkg: string): Promise<void> {
  const tsup = join(
    dirname(createRequire(join(ROOT, "package.json")).resolve("tsup/package.json")),
    "dist/cli-default.js",
  );
  const result = await spawnNode([tsup], join(ROOT, "packages", pkg));
  if (result.code !== 0) throw new Error(`building ${pkg} failed:\n${result.stdout}\n${result.stderr}`);
}

let project: string;
let handle: TestDatabaseHandle;
let db: TestDatabase;
const scratchDatabase = uniqueDatabaseName("clidb");

function egon(
  args: readonly string[],
  options: { env?: Record<string, string>; node?: readonly string[] } = {},
) {
  return spawnNode([...(options.node ?? []), BIN, ...args], project, options.env);
}

async function tables(target: TestDatabase = db): Promise<string[]> {
  const rows = await target.query<{ name: string }>(
    "select table_name as name from information_schema.tables where table_schema = 'public' order by 1",
  );
  return rows.map((row) => row.name);
}

function config(database: string, extra = ""): string {
  const { host, port, user, password } = db.settings;
  const settings = JSON.stringify({ host, port, user, password });
  return `import { defineConfig } from "@egon-orm/cli";
import { postgres } from "@egon-orm/postgres";

const server = ${settings};

export default defineConfig({
  adapter: postgres({ ...server, database: ${JSON.stringify(database)} }),
  migrations: { directory: "migrations" },
  ${extra}
});
`;
}

const SCHEMAS = `import { belongsTo, Schema, t, timestamps } from "egon-orm";

export class Author extends Schema("authors", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
  nickname: t.string().nullable(),
  ...timestamps(),
}) {}

export class Book extends Schema("books", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  authorId: t.bigint({ mode: "number" }),
  title: t.string(),
  pages: t.integer().default(100),
}) {
  static author = belongsTo(() => Author);
}
`;

beforeAll(async () => {
  for (const pkg of ["core", "postgres", "cli"]) await build(pkg);
  project = await mkdtemp(join(tmpdir(), "egon-cli-project-"));
  await mkdir(join(project, "node_modules", "@egon-orm"), { recursive: true });
  await symlink(join(ROOT, "packages/core"), join(project, "node_modules/egon-orm"));
  await symlink(join(ROOT, "packages/postgres"), join(project, "node_modules/@egon-orm/postgres"));
  await symlink(join(ROOT, "packages/cli"), join(project, "node_modules/@egon-orm/cli"));
  await symlink(join(ROOT, "node_modules/tsx"), join(project, "node_modules/tsx"));
  await writeFile(
    join(project, "package.json"),
    '{ "name": "cli-project", "private": true, "type": "module" }\n',
  );
  handle = await createTestDatabase("postgres", { label: "cli" });
  db = handle.db;
  await writeFile(join(project, "egon.config.ts"), config(db.name));
  await writeFile(join(project, "schemas.ts"), SCHEMAS);
}, 240_000);

afterAll(async () => {
  await handle?.db.query(`drop database if exists "${scratchDatabase}"`).catch(() => undefined);
  await handle?.drop();
  if (project !== undefined) await rm(project, { recursive: true, force: true });
});

describe("egon, the built binary", () => {
  test("--help prints the help and exits 0; no command exits 2", async () => {
    const help = await egon(["--help"]);
    expect(help).toEqual({ code: 0, stdout: MAIN_HELP, stderr: "" });
    expect((await egon(["migrate", "--help"])).stdout).toBe(COMMAND_HELP.migrate);
    expect((await egon([])).code).toBe(2);
    const unknown = await egon(["deploy"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/Unknown command "deploy"/);
  });

  test("gen migration --from-schema writes a scaffold; migrate, migrations, rollback run it", async () => {
    const generated = await egon([
      "gen",
      "migration",
      "create_library",
      "--from-schema",
      "schemas.ts",
      "--export",
      "Author,Book",
    ]);
    expect(generated.code).toBe(0);
    expect(generated.stdout).toMatch(/^Created migrations\/\d{14}_create_library\.ts\n/);
    expect(generated.stdout).toMatch(/one-time scaffold from the schema, not a diff/);
    const [file] = await readdir(join(project, "migrations"));
    const source = await readFile(join(project, "migrations", file as string), "utf8");
    expect(source).toContain('m.createTable("authors", (t) => {');
    expect(source).toContain('t.references("author_id", "authors").notNull();');
    expect(source).toContain('t.integer("pages").notNull().default(100);');
    // An index the schema cannot say: added by hand, as the scaffold asks.
    await writeFile(
      join(project, "migrations", file as string),
      source.replace("  },\n});", '    m.createIndex("authors", ["email"], { unique: true });\n  },\n});'),
    );

    const dry = await egon(["migrate", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/^-- \d{14} create_library \(up\)\ncreate table "authors" \(/);
    expect(dry.stdout).toContain('create unique index "authors_email_key" on "authors" ("email");');
    expect(dry.stdout).toMatch(/Dry run: 1 migration would run; nothing was changed\.\n$/);
    expect(await tables()).toEqual([]);

    const migrated = await egon(["migrate"]);
    expect(migrated.code).toBe(0);
    expect(migrated.stdout).toMatch(
      /^== \d{14} create_library: migrating\n== \d{14} create_library: migrated \(\d+\.\d ms\)\nApplied 1 migration\.\n$/,
    );
    expect(await tables()).toEqual(["authors", "books", "schema_migrations"]);

    const status = await egon(["migrations"]);
    expect(status.stdout).toMatch(/^Status {2}Version {9}Name\nup {6}\d{14} {2}create_library\n$/);
    const json = JSON.parse((await egon(["migrations", "--json"])).stdout) as {
      ok: boolean;
      migrations: { version: number; name: string; state: string }[];
    };
    expect(json.ok).toBe(true);
    expect(json.migrations.map((row) => [row.name, row.state])).toEqual([["create_library", "up"]]);

    expect((await egon(["migrate"])).stdout).toBe("Nothing to migrate: every migration is applied.\n");

    const dryBack = await egon(["rollback", "--dry-run"]);
    expect(dryBack.stdout).toContain('drop index "authors_email_key";');
    expect(await tables()).toEqual(["authors", "books", "schema_migrations"]);

    const back = JSON.parse((await egon(["rollback", "--json"])).stdout) as {
      ok: boolean;
      command: string;
      migrations: { direction: string }[];
    };
    expect(back).toMatchObject({ ok: true, command: "rollback", migrations: [{ direction: "down" }] });
    expect(await tables()).toEqual(["schema_migrations"]);
    expect((await egon(["rollback"])).stdout).toBe("Nothing to roll back.\n");

    expect((await egon(["migrate", "--json"])).code).toBe(0);
    const all = await egon(["rollback", "--all"]);
    expect(all.stdout).toMatch(/Rolled back 1 migration\.\n$/);
  });

  test("a failing migration exits 1, names the statement, and leaves nothing behind", async () => {
    const file = join(project, "migrations", "29990101000000_broken.ts");
    await writeFile(
      file,
      `import { fragment } from "egon-orm";
import { defineMigration } from "egon-orm/migration";

export default defineMigration({
  up(m) {
    m.createTable("half_done", (t) => t.id());
    m.execute(fragment\`select 1 / 0\`);
  },
});
`,
    );
    try {
      const failed = await egon(["migrate"]);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toMatch(
        /^error: Migration 29990101000000_broken failed and was rolled back: The database rejected the statement \(SQLSTATE 22012\)\..*\n {2}in: select 1 \/ 0\n/,
      );
      const json = JSON.parse((await egon(["migrate", "--json"])).stdout) as {
        ok: boolean;
        error: { code: string; version: number; sql: string };
      };
      expect(json).toMatchObject({
        ok: false,
        error: { code: "migration", version: 29990101000000, sql: "select 1 / 0" },
      });
      expect(await tables()).not.toContain("half_done");
    } finally {
      await rm(file);
      await egon(["rollback", "--all"]);
    }
  });

  test("TypeScript files need a TypeScript loader: without one egon explains, with tsx it runs", async () => {
    const without = await egon(["migrations"], { node: ["--no-experimental-strip-types"] });
    expect(without.code).toBe(1);
    expect(without.stderr).toMatch(
      /Cannot load the TypeScript file ".*egon\.config\.ts": this Node has no TypeScript loader/,
    );
    const withTsx = await egon(["migrations"], {
      node: ["--no-experimental-strip-types", "--import", "tsx"],
    });
    expect(withTsx.stderr).toBe("");
    expect(withTsx.code).toBe(0);
  });

  test("db create, reset and drop, with the production guard", async () => {
    const admin = `database: { name: ${JSON.stringify(scratchDatabase)}, admin: postgres({ ...server, database: ${JSON.stringify(db.settings.database)} }) },`;
    await writeFile(join(project, "db.config.ts"), config(scratchDatabase, admin));
    const exists = async (): Promise<boolean> =>
      (await db.query("select 1 from pg_database where datname = $1", [scratchDatabase])).length === 1;

    const refused = await egon(["db", "create", "--config", "db.config.ts"], {
      env: { NODE_ENV: "production" },
    });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/Refusing to run "egon db create" with NODE_ENV=production/);
    expect(await exists()).toBe(false);

    const created = await egon(["db", "create", "--config", "db.config.ts"]);
    expect(created).toMatchObject({ code: 0, stdout: `Created the database "${scratchDatabase}".\n` });
    expect(await exists()).toBe(true);

    const reset = JSON.parse((await egon(["db", "reset", "--config", "db.config.ts", "--json"])).stdout) as {
      ok: boolean;
      migrations: { name: string }[];
    };
    expect(reset.ok).toBe(true);
    expect(reset.migrations.map((run) => run.name)).toEqual(["create_library"]);

    const guarded = await egon(["db", "drop", "--config", "db.config.ts"], {
      env: { NODE_ENV: "production" },
    });
    expect(guarded.code).toBe(1);
    expect(await exists()).toBe(true);
    const dropped = await egon(["db", "drop", "--config", "db.config.ts", "--force"], {
      env: { NODE_ENV: "production" },
    });
    expect(dropped.code).toBe(0);
    expect(await exists()).toBe(false);
  });
});
