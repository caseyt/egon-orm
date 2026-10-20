// The egon command without a database: help, usage errors, exit codes, the config file,
// the production guard and `migrate create`. The commands that need a database are run
// through the built binary against Postgres in test/cli.itest.ts.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type CliIo, run, statusTable } from "./cli.js";
import { CliError, importUserModule, loadConfig, typescriptHelp } from "./config.js";
import { migrationTemplate } from "./create.js";
import { COMMAND_HELP, MAIN_HELP } from "./help.js";
import { defineConfig, VERSION } from "./index.js";

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function capture(cwd: string, env: Record<string, string | undefined> = {}): Captured {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      cwd,
      env,
      now: () => new Date("2026-10-12T09:30:00Z"),
    },
    out: () => out,
    err: () => err,
  };
}

/** A config module exporting an object that looks like an adapter, and records closing. */
const FAKE_CONFIG = `
globalThis.egonClosed ??= [];
const adapter = (name) => ({
  dialect: "postgres",
  acquire() { throw new Error("no database in unit tests"); },
  execute() { throw new Error("no database in unit tests"); },
  compileFragment() { throw new Error("no database in unit tests"); },
  close: async () => { globalThis.egonClosed.push(name); },
});
export default { adapter: adapter("main"), migrations: { directory: "db/migrations" } };
`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "egon-cli-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("help and version", () => {
  test("egon --help prints the main help, exit 0; egon alone prints it with exit 2", async () => {
    const help = capture(cwd);
    expect(await run(["--help"], help.io)).toBe(0);
    expect(help.out()).toBe(MAIN_HELP);
    const bare = capture(cwd);
    expect(await run([], bare.io)).toBe(2);
    expect(bare.out()).toBe(MAIN_HELP);
  });

  test("the main help text", () => {
    expect(MAIN_HELP).toMatchInlineSnapshot(`
      "Usage: egon <command> [options]

      Commands:
        migrate                Apply pending migrations.
        migrate create <name>  Write a new, empty migration file.
        rollback               Roll back applied migrations (the latest one by default).
        migrations             List migrations and their state.
        db create|drop|reset   Create, drop or recreate the development database.

      Options:
        --config <file>        The config file (default: egon.config.ts, .mts, .js or .mjs
                               in this directory).
        --help                 Show help (also: egon <command> --help).
        --version              Show the version.

      Configuration (egon.config.ts):
        import { defineConfig } from "@egon-orm/cli";
        import { postgres } from "@egon-orm/postgres";

        export default defineConfig({
          adapter: postgres({ connectionString: process.env.DATABASE_URL }),
          migrations: { directory: "migrations" },
        });

      TypeScript config and migration files need a TypeScript loader: Node 22.18 or later
      strips types by itself; otherwise run egon with tsx (node --import tsx) or Bun.
      "
    `);
  });

  test.each([
    [["migrate", "--help"], "migrate"],
    [["rollback", "--help"], "rollback"],
    [["migrations", "--help"], "migrations"],
    [["db", "--help"], "db"],
    [["migrate", "create", "--help"], "migrate create"],
    [["migrate", "create", "a", "--help"], "migrate create"],
    [["migrate", "--config", "x.mjs", "create", "--help"], "migrate create"],
  ])("egon %j prints that command's help", async (argv, command) => {
    const captured = capture(cwd);
    expect(await run(argv, captured.io)).toBe(0);
    expect(captured.out()).toBe(COMMAND_HELP[command]);
  });

  test("the help of migrate names create, and the help of create", () => {
    expect(COMMAND_HELP.migrate).toMatch(
      /^Usage: egon migrate \[options\]\n {7}egon migrate create <name> \[options\]\n/,
    );
    expect(COMMAND_HELP["migrate create"]).toMatchInlineSnapshot(`
      "Usage: egon migrate create <name> [options]

      Writes a new, empty migration file, <version>_<name>.ts, in the migrations directory.
      The version is the current UTC time (YYYYMMDDHHMMSS); the name is lower-case letters,
      digits and underscores. An existing file is never overwritten.

      Options:
        --dir <directory>      Where to write it (default: the configured migrations directory).
        --json                 Print one JSON object instead of the path.
        --config <file>        The config file (default: egon.config.ts in this directory).
      "
    `);
  });

  test("--version", async () => {
    const captured = capture(cwd);
    expect(await run(["--version"], captured.io)).toBe(0);
    expect(captured.out()).toBe(`${VERSION}\n`);
  });
});

describe("usage errors exit with 2", () => {
  test.each([
    [["frobnicate"], /Unknown command "frobnicate"/],
    [["migrate", "--to", "1", "--step", "1"], /at most one of --to and --step/],
    [["migrate", "--step", "0"], /--step takes a positive whole number/],
    [["migrate", "--to", "v2"], /--to takes a positive whole number/],
    [["migrate", "--steps", "1"], /Unknown option '--steps'/],
    [["migrate", "extra"], /migrate takes no arguments other than the subcommand create, not "extra"/],
    [
      ["migrate", "--step", "1", "extra"],
      /migrate takes no arguments other than the subcommand create, not "extra"/,
    ],
    [
      ["migrate", "--", "create", "a"],
      /migrate takes no arguments other than the subcommand create, not "create"/,
    ],
    [["rollback", "--all", "--step", "2"], /at most one of --step and --all/],
    [["rollback", "now"], /rollback takes no arguments/],
    [["migrations", "x"], /migrations takes no arguments/],
    [["db"], /db takes one of create, drop and reset/],
    [["db", "destroy"], /db takes one of create, drop and reset/],
    [["gen"], /Unknown command "gen"/],
    [["gen", "migration", "create_users"], /Unknown command "gen"/],
    [["migrate", "create"], /migrate create takes one name/],
    [["migrate", "create", "a", "b"], /migrate create takes one name/],
    [
      ["migrate", "create", "CreateUsers"],
      /The migration name "CreateUsers" must be lower-case letters, digits and underscores/,
    ],
    [["migrate", "create", "create-users"], /must be lower-case letters, digits and underscores/],
    [["migrate", "create", "a", "--step", "1"], /Unknown option '--step'/],
    [["migrate", "create", "a", "--from-schema", "s.ts"], /Unknown option '--from-schema'/],
    [["migrate", "--dir", "x"], /Unknown option '--dir'/],
  ])("egon %j", async (argv, message) => {
    const captured = capture(cwd);
    expect(await run(argv, captured.io)).toBe(2);
    expect(captured.err()).toMatch(message);
    expect(captured.out()).toBe("");
  });

  test("a usage error of migrate create prints its help; nothing is written", async () => {
    const captured = capture(cwd);
    expect(await run(["migrate", "create"], captured.io)).toBe(2);
    expect(captured.err()).toContain(COMMAND_HELP["migrate create"]);
    expect(await run(["migrate", "create", "Bad"], capture(cwd).io)).toBe(2);
    expect(await readdir(cwd)).toEqual([]);
  });
});

describe("the config file", () => {
  test("without one, a command that needs it fails with exit 1 and says what to create", async () => {
    const captured = capture(cwd);
    expect(await run(["migrations"], captured.io)).toBe(1);
    expect(captured.err()).toMatch(/No config file: create egon\.config\.ts/);
  });

  test("with --json the failure is one JSON object on stdout", async () => {
    const captured = capture(cwd);
    expect(await run(["migrate", "--json"], captured.io)).toBe(1);
    const report = JSON.parse(captured.out()) as { ok: boolean; error: { name: string; message: string } };
    expect(report.ok).toBe(false);
    expect(report.error.name).toBe("CliError");
    expect(report.error.message).toMatch(/No config file/);
  });

  test("is found by name, or given with --config, and must export an adapter", async () => {
    await writeFile(join(cwd, "egon.config.mjs"), FAKE_CONFIG);
    const found = await loadConfig(cwd, undefined);
    expect(found.file).toBe(join(cwd, "egon.config.mjs"));
    expect(found.root).toBe(cwd);
    await writeFile(
      join(cwd, "other.mjs"),
      "export const config = { adapter: { acquire() {}, execute() {} } };",
    );
    expect((await loadConfig(cwd, "other.mjs")).file).toBe(join(cwd, "other.mjs"));
    await expect(loadConfig(cwd, "missing.mjs")).rejects.toThrow(/does not exist/);
    await writeFile(join(cwd, "empty.mjs"), "export const nothing = 1;");
    await expect(loadConfig(cwd, "empty.mjs")).rejects.toThrow(/must export .* an object with an adapter/);
    await writeFile(
      join(cwd, "bad-db.mjs"),
      "export default { adapter: { acquire() {}, execute() {} }, database: { name: 1 } };",
    );
    await expect(loadConfig(cwd, "bad-db.mjs")).rejects.toThrow(
      /database must be \{ name: string, admin: an adapter \}/,
    );
  });

  test("a TypeScript file without a TypeScript loader gets an explanation", async () => {
    const unknown = Object.assign(new TypeError("Unknown file extension"), {
      code: "ERR_UNKNOWN_FILE_EXTENSION",
    });
    const error = await importUserModule("/x/egon.config.ts", () => Promise.reject(unknown)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).toBe(typescriptHelp("/x/egon.config.ts"));
    expect((error as Error).message).toMatch(/Node 22\.18 or later.*tsx.*Bun/);
    const other = new Error("syntax");
    await expect(importUserModule("/x/egon.config.ts", () => Promise.reject(other))).rejects.toBe(other);
    await expect(importUserModule("/x/egon.config.js", () => Promise.reject(unknown))).rejects.toBe(unknown);
  });

  test("defineConfig returns its argument", () => {
    const config = { adapter: {} as never };
    expect(defineConfig(config)).toBe(config);
  });
});

describe("egon db", () => {
  test("refuses to run with NODE_ENV=production unless --force, before reading the config", async () => {
    for (const action of ["create", "drop", "reset"]) {
      const captured = capture(cwd, { NODE_ENV: "production" });
      expect(await run(["db", action], captured.io)).toBe(1);
      expect(captured.err()).toMatch(
        new RegExp(`Refusing to run "egon db ${action}" with NODE_ENV=production`),
      );
    }
    // With --force it goes on, and here stops at the missing config.
    const forced = capture(cwd, { NODE_ENV: "production" });
    expect(await run(["db", "drop", "--force"], forced.io)).toBe(1);
    expect(forced.err()).toMatch(/No config file/);
  });

  test("needs database in the config, and closes the adapter either way", async () => {
    await writeFile(join(cwd, "egon.config.mjs"), FAKE_CONFIG);
    const closed: string[] = [];
    (globalThis as { egonClosed?: string[] }).egonClosed = closed;
    const captured = capture(cwd);
    expect(await run(["db", "create"], captured.io)).toBe(1);
    expect(captured.err()).toMatch(/needs database in the config/);
    expect(closed).toEqual(["main"]);
  });
});

describe("egon migrate create", () => {
  const FILE = join("migrations", "20261012093000_create_users.ts");

  test("writes the empty template, named by the UTC time, into ./migrations without a config", async () => {
    const captured = capture(cwd);
    expect(await run(["migrate", "create", "create_users"], captured.io)).toBe(0);
    expect(captured.out()).toBe(`Created ${FILE}\n`);
    expect(captured.err()).toBe("");
    expect(await readdir(join(cwd, "migrations"))).toEqual(["20261012093000_create_users.ts"]);
    expect(await readFile(join(cwd, FILE), "utf8")).toBe(migrationTemplate());
    expect(migrationTemplate()).toContain('import { defineMigration } from "egon-orm/migration";');
    expect(migrationTemplate()).toContain("export default defineMigration({\n  change(m) {\n  },\n});");
  });

  test("the version is the clock's UTC time", async () => {
    const captured = capture(cwd);
    const io: CliIo = { ...captured.io, now: () => new Date("2027-01-02T03:04:05.999+05:00") };
    expect(await run(["migrate", "create", "a"], io)).toBe(0);
    expect(captured.out()).toBe(`Created ${join("migrations", "20270101220405_a.ts")}\n`);
  });

  test("writes into the configured directory, or --dir, and closes the config's adapter", async () => {
    await writeFile(join(cwd, "egon.config.mjs"), FAKE_CONFIG);
    const closed: string[] = [];
    (globalThis as { egonClosed?: string[] }).egonClosed = closed;
    const configured = capture(cwd);
    expect(await run(["migrate", "create", "a"], configured.io)).toBe(0);
    expect(configured.out()).toBe(`Created ${join("db", "migrations", "20261012093000_a.ts")}\n`);
    expect(await readdir(join(cwd, "db", "migrations"))).toEqual(["20261012093000_a.ts"]);
    expect(closed).toEqual(["main"]);
    const elsewhere = capture(cwd);
    expect(await run(["migrate", "create", "b", "--dir", "elsewhere/deeper"], elsewhere.io)).toBe(0);
    expect(elsewhere.out()).toBe(`Created ${join("elsewhere", "deeper", "20261012093000_b.ts")}\n`);
    expect(await readdir(join(cwd, "elsewhere", "deeper"))).toEqual(["20261012093000_b.ts"]);
    // --dir does not read the config at all.
    expect(closed).toEqual(["main"]);
  });

  test("options may come before create", async () => {
    await writeFile(join(cwd, "other.mjs"), FAKE_CONFIG);
    const captured = capture(cwd);
    expect(await run(["migrate", "--config", "other.mjs", "create", "a", "--json"], captured.io)).toBe(0);
    expect(await readdir(join(cwd, "db", "migrations"))).toEqual(["20261012093000_a.ts"]);
  });

  test("--json prints one object with the version, the name and the absolute path", async () => {
    const captured = capture(cwd);
    expect(await run(["migrate", "create", "create_users", "--json"], captured.io)).toBe(0);
    expect(JSON.parse(captured.out())).toEqual({
      ok: true,
      command: "migrate create",
      version: 20261012093000,
      name: "create_users",
      path: join(cwd, FILE),
    });
    expect(captured.out().endsWith("}\n")).toBe(true);
  });

  test("never overwrites: a file with the same version is refused, with or without the same name", async () => {
    expect(await run(["migrate", "create", "first"], capture(cwd).io)).toBe(0);
    await writeFile(join(cwd, "migrations", "20261012093000_first.ts"), "// edited\n");
    for (const name of ["first", "second"]) {
      const captured = capture(cwd);
      expect(await run(["migrate", "create", name], captured.io)).toBe(1);
      expect(captured.err()).toBe(
        "error: A migration with the version 20261012093000 already exists (20261012093000_first.ts), and egon migrate create never overwrites a file. Wait a second and run it again.\n",
      );
      expect(captured.out()).toBe("");
    }
    expect(await readdir(join(cwd, "migrations"))).toEqual(["20261012093000_first.ts"]);
    expect(await readFile(join(cwd, "migrations", "20261012093000_first.ts"), "utf8")).toBe("// edited\n");
  });

  test("two runs racing in the same second: one writes the file, the other is refused", async () => {
    const runs = [capture(cwd), capture(cwd), capture(cwd)];
    const codes = await Promise.all(runs.map((one) => run(["migrate", "create", "first"], one.io)));
    expect([...codes].sort()).toEqual([0, 1, 1]);
    for (const [index, one] of runs.entries()) {
      if (codes[index] === 1)
        expect(one.err()).toMatch(
          /^error: A migration with the version 20261012093000 already exists \(20261012093000_first\.ts\), and egon migrate create never overwrites a file\./,
        );
    }
    expect(await readdir(join(cwd, "migrations"))).toEqual(["20261012093000_first.ts"]);
  });

  test("a file that cannot be written is reported", async () => {
    const locked = join(cwd, "locked");
    await mkdir(locked);
    await chmod(locked, 0o555);
    try {
      const captured = capture(cwd);
      expect(await run(["migrate", "create", "a", "--dir", "locked"], captured.io)).toBe(1);
      expect(captured.err()).toMatch(/^error: EACCES/);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  test("with --json, the refusal is one JSON object", async () => {
    expect(await run(["migrate", "create", "first"], capture(cwd).io)).toBe(0);
    const captured = capture(cwd);
    expect(await run(["migrate", "create", "first", "--json"], captured.io)).toBe(1);
    const report = JSON.parse(captured.out()) as { ok: boolean; error: { name: string; message: string } };
    expect(report.ok).toBe(false);
    expect(report.error.name).toBe("CliError");
    expect(report.error.message).toMatch(/already exists/);
  });

  test("a broken config is reported, not ignored; a missing --config file too", async () => {
    await writeFile(join(cwd, "egon.config.mjs"), "export default {};");
    const broken = capture(cwd);
    expect(await run(["migrate", "create", "a"], broken.io)).toBe(1);
    expect(broken.err()).toMatch(/must export/);
    await rm(join(cwd, "egon.config.mjs"));
    const missing = capture(cwd);
    expect(await run(["migrate", "create", "a", "--config", "missing.mjs"], missing.io)).toBe(1);
    expect(missing.err()).toMatch(/does not exist/);
    expect(await readdir(cwd)).toEqual([]);
  });
});

describe("the status table", () => {
  test("lines up the columns and marks a missing file", () => {
    expect(
      statusTable([
        { version: 20260101000000, name: "create_users", state: "up" },
        { version: 20260102000000, name: undefined, state: "missing" },
        { version: 20260103000000, name: "add_age", state: "down" },
      ]),
    ).toMatchInlineSnapshot(`
      "Status   Version         Name
      up       20260101000000  create_users
      missing  20260102000000  ** no file **
      down     20260103000000  add_age
      "
    `);
    expect(statusTable([])).toBe("No migrations.\n");
  });

  test("shows a runner's claim, and says what to do about one left behind", () => {
    const table = statusTable([
      { version: -1, name: undefined, state: "claimed" },
      { version: 20260101000000, name: "create_users", state: "up" },
    ]);
    expect(table).toContain("claimed  -1              ** a runner's claim (see below) **");
    expect(table).toContain("Every run waits while the claim is there.");
    expect(table).toContain("delete the row with version -1 from the tracking table.");
  });
});
