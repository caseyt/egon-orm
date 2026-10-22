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
import { basename, dirname, isAbsolute, join } from "node:path";
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

/** What the test writes into the created migration's up(m) { … }, in place of its comment. */
const LIBRARY = `    m.createTable("authors", (t) => {
      t.id();
      t.text("email").notNull();
      t.text("nickname");
      t.timestamps();
    });
    m.createTable("books", (t) => {
      t.id();
      t.references("author_id", "authors").notNull();
      t.text("title").notNull();
      t.integer("pages").notNull().default(100);
    });
    m.createIndex("authors", ["email"], { unique: true });
`;

/** What the test writes into the created migration's down(m) { … } (adding the m): the undoing of LIBRARY. */
const UNDO_LIBRARY = `    m.dropIndex("authors", ["email"], { unique: true });
    m.dropTable("books");
    m.dropTable("authors");
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

  test("migrate create writes a migration; migrate, migrations, rollback run it", async () => {
    expect((await egon(["migrate", "create", "--help"])).stdout).toBe(COMMAND_HELP["migrate create"]);
    const gen = await egon(["gen", "migration", "create_library"]);
    expect(gen.code).toBe(2);
    expect(gen.stderr).toMatch(/Unknown command "gen"/);

    const created = await egon(["migrate", "create", "create_library"]);
    expect(created.code).toBe(0);
    expect(created.stderr).toBe("");
    expect(created.stdout).toMatch(/^Created migrations\/\d{14}_create_library\.ts\n$/);
    const [file] = await readdir(join(project, "migrations"));
    expect(created.stdout).toBe(`Created migrations/${file}\n`);
    const path = join(project, "migrations", file as string);
    const source = await readFile(path, "utf8");
    expect(source).toBe(
      'import { defineMigration } from "egon-orm/migration";\n\nexport const migration = defineMigration({\n  up(m) {\n    // the change\n  },\n  down() {\n    // undo the change (write down(m) to use m), or leave a // noop comment\n  },\n});\n',
    );
    // --json and --dir: one object naming the file, written elsewhere.
    const asJson = await egon(["migrate", "create", "create_other", "--dir", "drafts", "--json"]);
    expect(asJson.code).toBe(0);
    const report = JSON.parse(asJson.stdout) as { ok: boolean; command: string; name: string; path: string };
    expect(report).toMatchObject({ ok: true, command: "migrate create", name: "create_other" });
    expect(await readFile(report.path, "utf8")).toBe(source);
    expect(isAbsolute(report.path)).toBe(true);
    expect(await readdir(join(project, "drafts"))).toEqual([basename(report.path)]);
    expect(basename(report.path)).toMatch(/^\d{14}_create_other\.ts$/);
    expect(await readdir(join(project, "migrations"))).toEqual([file]);
    const filled = source
      .replace("    // the change\n", LIBRARY)
      .replace(
        "  down() {\n    // undo the change (write down(m) to use m), or leave a // noop comment\n",
        `  down(m) {\n${UNDO_LIBRARY}`,
      );
    expect(filled).toContain(LIBRARY);
    expect(filled).toContain(UNDO_LIBRARY);
    await writeFile(path, filled);

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
    expect(dryBack.stdout).toMatch(
      /^-- \d{14} create_library \(down\)\ndrop index "authors_email_key";\ndrop table "books";\ndrop table "authors";\n/,
    );
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
  down(m) {
    m.dropTable("half_done");
  },
});
`,
    );
    try {
      const failed = await egon(["migrate"]);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toMatch(
        /^error: migration\.failed: Migration 29990101000000_broken failed and was rolled back: The database rejected the statement \(SQLSTATE 22012\)\..*\n {2}in: select 1 \/ 0\n/,
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

  test("the created file, with up written and down left as it is, compiles under strict and noUnusedParameters", async () => {
    // A user always writes up(m), and may leave down() as a noop, so that is what is
    // compiled: against the built egon-orm, as an installed package would be.
    const created = await egon(["migrate", "create", "typed_noop", "--dir", "typecheck", "--json"]);
    expect(created.code).toBe(0);
    const { path } = JSON.parse(created.stdout) as { path: string };
    const dir = join(project, "typecheck");
    try {
      const source = await readFile(path, "utf8");
      const written = source.replace("    // the change\n", '    m.createTable("things", (t) => t.id());\n');
      expect(written).not.toBe(source);
      await writeFile(path, written);
      // The same file with the m parameter kept on an untouched down: the check must see it.
      const unusedDown = join(dir, "unused_down.ts");
      await writeFile(unusedDown, written.replace("  down() {", "  down(m) {"));
      const tsc = join(
        dirname(createRequire(join(ROOT, "package.json")).resolve("typescript/package.json")),
        "bin/tsc",
      );
      const check = (file: string) =>
        spawnNode(
          [
            tsc,
            "--noEmit",
            "--strict",
            "--noUnusedParameters",
            "--skipLibCheck",
            "false",
            "--module",
            "nodenext",
            "--moduleResolution",
            "nodenext",
            "--target",
            "es2022",
            file,
          ],
          project,
        );
      expect(await check(path)).toEqual({ code: 0, stdout: "", stderr: "" });
      const refused = await check(unusedDown);
      expect(refused.code).not.toBe(0);
      expect(refused.stdout).toMatch(
        /unused_down\.ts\(\d+,\d+\): error TS6133: 'm' is declared but its value is never read\./,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a migration file without down() is refused when it is loaded, naming the file; nothing runs", async () => {
    const file = join(project, "migrations", "29990101000000_one_way.ts");
    await writeFile(
      file,
      `import { defineMigration } from "egon-orm/migration";

export default defineMigration({
  up(m) {
    m.createTable("one_way", (t) => t.id());
  },
} as never);
`,
    );
    try {
      for (const args of [["migrate"], ["migrations"], ["rollback"]]) {
        const refused = await egon(args);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toMatch(
          // The egon command prints full messages: the advice is there again.
          /^error: migration\.loadFailed: Cannot load the migration file ".*29990101000000_one_way\.ts": defineMigration\(\) was given no down\(\)\. The cause is .+ See https:\/\/\S+\n {2}caused by: migration\.missingSteps: defineMigration\(\) was given no down\(\)\. A migration has both up\(m\) and down\(m\); when there is nothing to undo, write down\(\) \{\} with a \/\/ noop comment\. See https:\/\/\S+\n$/,
        );
      }
      expect(await tables()).not.toContain("one_way");
    } finally {
      await rm(file);
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
