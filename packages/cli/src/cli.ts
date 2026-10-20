/**
 * The `egon` command: argument parsing, the commands, and their output.
 *
 * @module
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Adapter, type AnySchema, isEgonError, isSchema, meta } from "egon-orm";
import {
  createDatabase,
  createMigrator,
  dropDatabase,
  type MigrationEvent,
  type MigrationRun,
  type MigrationStatus,
  type Migrator,
} from "egon-orm/migration";
import { CliError, type EgonConfig, importUserModule, type LoadedConfig, loadConfig } from "./config.js";
import {
  MIGRATION_NAME,
  migrationTemplate,
  scaffoldFromSchemas,
  scaffoldHeader,
  versionAt,
} from "./generate.js";
import { COMMAND_HELP, MAIN_HELP } from "./help.js";
import { VERSION } from "./version.js";

/**
 * What the CLI talks to: its output streams, its environment and its clock. The binary
 * passes the process's; tests pass their own.
 *
 * @example
 * ```ts
 * const io: CliIo = {
 *   stdout: (text) => process.stdout.write(text),
 *   stderr: (text) => process.stderr.write(text),
 *   cwd: process.cwd(),
 *   env: process.env,
 *   now: () => new Date(),
 * };
 * ```
 */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
}

/** Exit codes: success, a failure, a usage error. */
const OK = 0;
const FAILED = 1;
const USAGE = 2;

class UsageError extends Error {
  override readonly name = "UsageError";
}

type Values = Record<string, string | boolean | undefined>;

const COMMON = { config: { type: "string" }, help: { type: "boolean" }, json: { type: "boolean" } } as const;

function parse(
  command: string,
  args: readonly string[],
  options: Record<string, { type: "string" | "boolean" }>,
): { values: Values; positionals: string[] } {
  try {
    return parseArgs({
      args: [...args],
      options: { ...COMMON, ...options },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${COMMAND_HELP[command] ?? MAIN_HELP}`);
  }
}

function positiveInteger(flag: string, value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  ) {
    throw new UsageError(`--${flag} takes a positive whole number, not ${JSON.stringify(value)}.`);
  }
  return Number(value);
}

function atMostOne(values: Values, flags: readonly string[]): void {
  const given = flags.filter((flag) => values[flag] !== undefined);
  if (given.length > 1)
    throw new UsageError(`Give at most one of ${given.map((flag) => `--${flag}`).join(" and ")}.`);
}

/**
 * Runs `egon` with `argv` (the arguments after the program name) and returns the exit
 * code: 0 on success, 1 on a failure, 2 on a usage error.
 *
 * @example
 * ```ts
 * import { run } from "@egon-orm/cli";
 *
 * process.exitCode = await run(["migrate", "--step", "1"]);
 * ```
 */
export async function run(argv: readonly string[], io: CliIo = processIo()): Promise<number> {
  const [first, ...rest] = argv;
  let json = rest.includes("--json");
  try {
    if (first === undefined || first === "--help" || first === "-h" || first === "help") {
      io.stdout(MAIN_HELP);
      return first === undefined ? USAGE : OK;
    }
    if (first === "--version" || first === "-v") {
      io.stdout(`${VERSION}\n`);
      return OK;
    }
    switch (first) {
      case "gen":
        return await gen(rest, io);
      case "migrate":
        return await migrate(rest, io);
      case "rollback":
        return await rollback(rest, io);
      case "migrations":
        return await migrations(rest, io);
      case "db":
        return await db(rest, io);
      default:
        throw new UsageError(`Unknown command "${first}".\n\n${MAIN_HELP}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message.trimEnd()}\n`);
      return USAGE;
    }
    json &&= first !== "gen";
    report(io, json, error);
    return FAILED;
  }
}

/** Prints a failure: the message (and, for a migration, which one); JSON with --json. */
function report(io: CliIo, json: boolean, error: unknown): void {
  const egon = isEgonError(error) ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    const details = error as { readonly version?: unknown; readonly sql?: unknown };
    io.stdout(
      `${JSON.stringify({
        ok: false,
        error: {
          name: error instanceof Error ? error.name : "Error",
          code: egon?.code,
          message,
          version: typeof details?.version === "number" ? details.version : undefined,
          sql: typeof details?.sql === "string" ? details.sql : undefined,
        },
      })}\n`,
    );
    return;
  }
  io.stderr(`error: ${message}\n`);
  const sql = (error as { readonly sql?: unknown } | null)?.sql;
  if (typeof sql === "string") io.stderr(`  in: ${sql}\n`);
  const cause = (error as { readonly cause?: unknown } | null)?.cause;
  if (
    egon === undefined &&
    !(error instanceof CliError) &&
    error instanceof Error &&
    error.stack !== undefined
  ) {
    io.stderr(`${error.stack}\n`);
  } else if (isEgonError(cause) && !message.includes(cause.message)) {
    // Only an Egon error's message: a driver's own message (the cause of a DatabaseError or
    // ConstraintError) may quote a value, and the adapter leaves it out on purpose.
    io.stderr(`  caused by: ${cause.message}\n`);
  }
}

function processIo(): CliIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    cwd: process.cwd(),
    env: process.env,
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------------------
// The configuration and the migrator
// ---------------------------------------------------------------------------

/** Runs `work` with the loaded config, closing its adapters afterwards. */
async function withConfig<T>(
  io: CliIo,
  values: Values,
  work: (loaded: LoadedConfig) => Promise<T>,
): Promise<T> {
  const loaded = await loadConfig(io.cwd, values.config as string | undefined);
  try {
    return await work(loaded);
  } finally {
    const adapters = new Set<Adapter>([loaded.config.adapter]);
    if (loaded.config.database !== undefined) adapters.add(loaded.config.database.admin);
    await Promise.all([...adapters].map((adapter) => adapter.close()));
  }
}

function migratorFor(loaded: LoadedConfig, log: ((event: MigrationEvent) => void) | undefined): Migrator {
  const { migrations: list, directory, ...options } = loaded.config.migrations ?? {};
  return createMigrator({
    ...options,
    adapter: loaded.config.adapter,
    ...(list === undefined
      ? { directory: resolve(loaded.root, directory ?? "migrations") }
      : { migrations: list }),
    ...(log === undefined ? {} : { log }),
  });
}

/** Log lines for a migration run, or nothing with --json (warnings still go to stderr). */
function logger(io: CliIo, json: boolean): (event: MigrationEvent) => void {
  return (event) => {
    if (event.kind === "warning") {
      io.stderr(`warning: ${event.message}\n`);
      return;
    }
    if (json) return;
    const label = `${event.version} ${event.name}`;
    if (event.kind === "migrating")
      io.stdout(`== ${label}: ${event.direction === "up" ? "migrating" : "rolling back"}\n`);
    else
      io.stdout(
        `== ${label}: ${event.direction === "up" ? "migrated" : "rolled back"} (${event.durationMs.toFixed(1)} ms)\n`,
      );
  };
}

function printRuns(
  io: CliIo,
  command: string,
  json: boolean,
  dryRun: boolean,
  runs: readonly MigrationRun[],
): void {
  if (json) {
    io.stdout(
      `${JSON.stringify({
        ok: true,
        command,
        dryRun,
        migrations: runs.map((run) => ({
          version: run.version,
          name: run.name,
          direction: run.direction,
          durationMs: tenths(run.durationMs),
          ...(dryRun ? { statements: run.statements } : {}),
        })),
      })}\n`,
    );
    return;
  }
  if (dryRun) {
    for (const run of runs) {
      io.stdout(`-- ${run.version} ${run.name} (${run.direction})\n`);
      for (const statement of run.statements) {
        io.stdout(`${statement.sql};\n`);
        if (statement.params.length > 0)
          io.stdout(`-- params: ${JSON.stringify(statement.params, bigints)}\n`);
      }
    }
    io.stdout(
      runs.length === 0
        ? "Nothing to run.\n"
        : `Dry run: ${runs.length} migration${runs.length === 1 ? "" : "s"} would run; nothing was changed.\n`,
    );
    return;
  }
  const verb = command === "migrate" ? "Applied" : "Rolled back";
  io.stdout(
    runs.length === 0
      ? command === "migrate"
        ? "Nothing to migrate: every migration is applied.\n"
        : "Nothing to roll back.\n"
      : `${verb} ${runs.length} migration${runs.length === 1 ? "" : "s"}.\n`,
  );
}

/** Milliseconds rounded to a tenth. */
function tenths(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function bigints(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function migrate(args: readonly string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse("migrate", args, {
    to: { type: "string" },
    step: { type: "string" },
    "dry-run": { type: "boolean" },
  });
  if (values.help === true) return help(io, "migrate");
  if (positionals.length > 0) throw new UsageError(`migrate takes no arguments.\n\n${COMMAND_HELP.migrate}`);
  atMostOne(values, ["to", "step"]);
  const to = positiveInteger("to", values.to);
  const step = positiveInteger("step", values.step);
  const dryRun = values["dry-run"] === true;
  const json = values.json === true;
  return withConfig(io, values, async (loaded) => {
    const runs = await migratorFor(loaded, logger(io, json)).up({
      ...(to === undefined ? {} : { to }),
      ...(step === undefined ? {} : { step }),
      dryRun,
    });
    printRuns(io, "migrate", json, dryRun, runs);
    return OK;
  });
}

async function rollback(args: readonly string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse("rollback", args, {
    to: { type: "string" },
    step: { type: "string" },
    all: { type: "boolean" },
    "dry-run": { type: "boolean" },
  });
  if (values.help === true) return help(io, "rollback");
  if (positionals.length > 0)
    throw new UsageError(`rollback takes no arguments.\n\n${COMMAND_HELP.rollback}`);
  atMostOne(values, ["to", "step", "all"]);
  const to = positiveInteger("to", values.to);
  const step = positiveInteger("step", values.step);
  const dryRun = values["dry-run"] === true;
  const json = values.json === true;
  return withConfig(io, values, async (loaded) => {
    const runs = await migratorFor(loaded, logger(io, json)).down({
      ...(to === undefined ? {} : { to }),
      ...(step === undefined ? {} : { step }),
      ...(values.all === true ? { all: true } : {}),
      dryRun,
    });
    printRuns(io, "rollback", json, dryRun, runs);
    return OK;
  });
}

/**
 * The status table: one line per migration.
 *
 * @example
 * ```ts
 * statusTable([{ version: 20261012093000, name: "create_users", state: "up" }]);
 * // Status  Version         Name
 * // up      20261012093000  create_users
 * ```
 */
export function statusTable(rows: readonly MigrationStatus[]): string {
  if (rows.length === 0) return "No migrations.\n";
  const lines = [
    ["Status", "Version", "Name"],
    ...rows.map((row) => [row.state, String(row.version), row.name ?? "** no file **"]),
  ];
  const widths = [0, 1].map((column) => Math.max(...lines.map((line) => (line[column] as string).length)));
  return `${lines
    .map(
      (line) =>
        `${(line[0] as string).padEnd(widths[0] as number)}  ${(line[1] as string).padEnd(widths[1] as number)}  ${line[2]}`,
    )
    .join("\n")}\n`;
}

async function migrations(args: readonly string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse("migrations", args, {});
  if (values.help === true) return help(io, "migrations");
  if (positionals.length > 0)
    throw new UsageError(`migrations takes no arguments.\n\n${COMMAND_HELP.migrations}`);
  return withConfig(io, values, async (loaded) => {
    const rows = await migratorFor(loaded, undefined).status();
    if (values.json === true)
      io.stdout(`${JSON.stringify({ ok: true, command: "migrations", migrations: rows })}\n`);
    else io.stdout(statusTable(rows));
    return OK;
  });
}

async function db(args: readonly string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse("db", args, { force: { type: "boolean" } });
  if (values.help === true) return help(io, "db");
  const [action, ...extra] = positionals;
  if (action === undefined || !["create", "drop", "reset"].includes(action) || extra.length > 0) {
    throw new UsageError(`db takes one of create, drop and reset.\n\n${COMMAND_HELP.db}`);
  }
  if (io.env.NODE_ENV === "production" && values.force !== true) {
    throw new CliError(
      `Refusing to run "egon db ${action}" with NODE_ENV=production: it ${action === "create" ? "creates" : "destroys"} a whole database. Pass --force if you mean it.`,
    );
  }
  const json = values.json === true;
  return withConfig(io, values, async (loaded) => {
    const database = loaded.config.database;
    if (database === undefined) {
      throw new CliError(
        `egon db ${action} needs database in the config: database: { name: "…", admin: postgres({ … }) } (an adapter connected to another database of the same server).`,
      );
    }
    const done: string[] = [];
    const say = (line: string): void => {
      done.push(line);
      if (!json) io.stdout(`${line}\n`);
    };
    if (action === "drop" || action === "reset") {
      await dropDatabase(database.admin, database.name, { ifExists: true });
      say(`Dropped the database "${database.name}" (if it existed).`);
    }
    if (action === "create" || action === "reset") {
      await createDatabase(database.admin, database.name);
      say(`Created the database "${database.name}".`);
    }
    let runs: MigrationRun[] = [];
    if (action === "reset") {
      runs = await migratorFor(loaded, logger(io, json)).up();
      say(`Applied ${runs.length} migration${runs.length === 1 ? "" : "s"}.`);
    }
    if (json) {
      io.stdout(
        `${JSON.stringify({ ok: true, command: `db ${action}`, database: database.name, migrations: runs.map((run) => ({ version: run.version, name: run.name, durationMs: tenths(run.durationMs) })) })}\n`,
      );
    }
    return OK;
  });
}

async function gen(args: readonly string[], io: CliIo): Promise<number> {
  const [kind, ...rest] = args;
  if (kind === "--help" || kind === undefined) {
    io.stdout(COMMAND_HELP["gen migration"] as string);
    return kind === undefined ? USAGE : OK;
  }
  if (kind !== "migration") throw new UsageError(`egon gen makes migrations: egon gen migration <name>.`);
  const { values, positionals } = parse("gen migration", rest, {
    "from-schema": { type: "string" },
    export: { type: "string" },
    dir: { type: "string" },
  });
  if (values.help === true) return help(io, "gen migration");
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0) {
    throw new UsageError(`gen migration takes one name.\n\n${COMMAND_HELP["gen migration"]}`);
  }
  if (!MIGRATION_NAME.test(name)) {
    throw new UsageError(
      `The migration name "${name}" must be lower-case letters, digits and underscores: for example create_users.`,
    );
  }
  if (values.export !== undefined && values["from-schema"] === undefined) {
    throw new UsageError("--export goes with --from-schema.");
  }
  const directory = await generationDirectory(io, values);
  let body = "";
  let header = "";
  let notes: readonly string[] = [];
  const schemaFile = values["from-schema"];
  if (typeof schemaFile === "string") {
    const path = resolve(io.cwd, schemaFile);
    const schemas = pickSchemas(path, await importUserModule(path), values.export as string | undefined);
    const scaffold = scaffoldFromSchemas(schemas);
    body = scaffold.body;
    notes = scaffold.notes;
    header = scaffoldHeader(
      schemaFile,
      schemas.map((schema) => meta(schema).name),
    );
  }
  const version = versionAt(io.now());
  await mkdir(directory, { recursive: true });
  const taken = (await readdir(directory)).find((file) => file.startsWith(`${version}_`));
  if (taken !== undefined) {
    throw new CliError(
      `A migration with the version ${version} already exists (${taken}). Wait a second and run it again.`,
    );
  }
  const file = resolve(directory, `${version}_${name}.ts`);
  await writeFile(file, header + migrationTemplate(body), { flag: "wx" });
  io.stdout(`Created ${relative(io.cwd, file) || file}\n`);
  if (typeof schemaFile === "string") {
    io.stdout(
      "This is a one-time scaffold from the schema, not a diff: check it before running it. Unique indexes are not part of a schema; add them by hand.\n",
    );
    for (const note of notes) io.stdout(`note: ${note}\n`);
  }
  return OK;
}

/** Where `gen migration` writes: `--dir`, else the configured directory, else `migrations`. */
async function generationDirectory(io: CliIo, values: Values): Promise<string> {
  if (typeof values.dir === "string") return resolve(io.cwd, values.dir);
  let loaded: LoadedConfig | undefined;
  try {
    loaded = await loadConfig(io.cwd, values.config as string | undefined);
  } catch (error) {
    // Without a config file the default directory is used; a broken config is reported.
    if (
      values.config !== undefined ||
      !(error instanceof CliError) ||
      !error.message.startsWith("No config file")
    ) {
      throw error;
    }
    return resolve(io.cwd, "migrations");
  }
  const config: EgonConfig = loaded.config;
  try {
    return resolve(loaded.root, config.migrations?.directory ?? "migrations");
  } finally {
    const adapters = new Set<Adapter>([config.adapter]);
    if (config.database !== undefined) adapters.add(config.database.admin);
    await Promise.all([...adapters].map((adapter) => adapter.close()));
  }
}

/** The schema classes of a module, or those named by --export. */
function pickSchemas(
  path: string,
  module: Record<string, unknown>,
  exportNames: string | undefined,
): AnySchema[] {
  const found = Object.entries(module).filter(
    ([, value]) => isSchema(value) && meta(value as AnySchema).source !== null,
  );
  if (exportNames !== undefined) {
    const names = exportNames.split(",").map((name) => name.trim());
    return names.map((name) => {
      const value = module[name];
      if (!isSchema(value)) throw new CliError(`"${path}" has no schema class exported as "${name}".`);
      return value as AnySchema;
    });
  }
  if (found.length === 0) throw new CliError(`"${path}" exports no schema class with a table.`);
  if (found.length > 1) {
    throw new CliError(
      `"${path}" exports ${found.length} schema classes (${found.map(([name]) => name).join(", ")}): choose with --export ${found.map(([name]) => name).join(",")}`,
    );
  }
  return [(found[0] as [string, unknown])[1] as AnySchema];
}

function help(io: CliIo, command: string): number {
  io.stdout(COMMAND_HELP[command] as string);
  return OK;
}
