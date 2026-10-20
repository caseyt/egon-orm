/**
 * The configuration file, `egon.config.ts`: what it holds, and how the CLI finds and
 * loads it.
 *
 * @module
 */
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Adapter } from "egon-orm";
import type { MigrationSource, MigratorOptions } from "egon-orm/migration";

/**
 * Where the migrations are and how they are tracked: the options of `createMigrator`
 * besides the adapter. `directory` is resolved against the config file's directory and
 * defaults to `"migrations"`.
 *
 * @example
 * ```ts
 * const migrations: MigrationsConfig = { directory: "db/migrations", table: "schema_migrations" };
 * ```
 */
export type MigrationsConfig = Omit<MigratorOptions, "adapter" | "log" | "migrations" | "directory"> & {
  readonly directory?: string;
  /** The migrations in memory, instead of a directory. */
  readonly migrations?: readonly MigrationSource[];
};

/**
 * What `egon.config.ts` exports (as its default export, or as `config`).
 *
 * @example
 * ```ts
 * import { defineConfig } from "@egon-orm/cli";
 * import { postgres } from "@egon-orm/postgres";
 *
 * export default defineConfig({
 *   adapter: postgres({ connectionString: process.env.DATABASE_URL }),
 *   migrations: { directory: "migrations" },
 *   database: {
 *     name: "blog_dev",
 *     admin: postgres({ connectionString: process.env.ADMIN_DATABASE_URL }),
 *   },
 * });
 * ```
 */
export interface EgonConfig {
  /** The database the migrations run against. The CLI closes it when the command ends. */
  readonly adapter: Adapter;
  readonly migrations?: MigrationsConfig;
  /**
   * For `egon db create | drop | reset`: the database's name, and an adapter connected to
   * another database of the same server (on Postgres, usually `postgres`) to run
   * `CREATE DATABASE` and `DROP DATABASE` through. The CLI closes it too.
   */
  readonly database?: { readonly name: string; readonly admin: Adapter };
}

/**
 * Types a configuration object; returns it unchanged.
 *
 * @example
 * ```ts
 * import { defineConfig } from "@egon-orm/cli";
 * import { postgres } from "@egon-orm/postgres";
 *
 * export default defineConfig({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });
 * ```
 */
export function defineConfig(config: EgonConfig): EgonConfig {
  return config;
}

/**
 * The file names the CLI looks for, in order, when no `--config` is given.
 *
 * @example
 * ```ts
 * CONFIG_FILES[0]; // "egon.config.ts"
 * ```
 */
export const CONFIG_FILES: readonly string[] = [
  "egon.config.ts",
  "egon.config.mts",
  "egon.config.js",
  "egon.config.mjs",
];

/**
 * A problem the user can fix: printed without a stack, exit code 1.
 *
 * @example
 * ```ts
 * throw new CliError("No config file: create egon.config.ts.");
 * ```
 */
export class CliError extends Error {
  override readonly name = "CliError";
}

/**
 * The explanation for a TypeScript file this process cannot load.
 *
 * @example
 * ```ts
 * throw new CliError(typescriptHelp("/app/egon.config.ts"));
 * ```
 */
export function typescriptHelp(file: string): string {
  return `Cannot load the TypeScript file "${file}": this Node has no TypeScript loader. Use Node 22.18 or later (it strips types by itself; on 22.12 to 22.17 pass --experimental-strip-types), or run egon through tsx: node --import tsx node_modules/@egon-orm/cli/dist/bin.js …, or with Bun. Or write the file in JavaScript (egon.config.mjs).`;
}

/**
 * How a module is imported; replaced in tests.
 *
 * @example
 * ```ts
 * const load: ImportModule = (url) => import(url);
 * ```
 */
export type ImportModule = (url: string) => Promise<Record<string, unknown>>;

const importModule: ImportModule = (url) => import(url) as Promise<Record<string, unknown>>;

/**
 * Imports a module of the user's: a config file or a schema file. A TypeScript file the
 * process cannot load gets an explanation of what to install.
 *
 * @example
 * ```ts
 * const module = await importUserModule("/app/src/schemas.ts");
 * ```
 */
export async function importUserModule(
  path: string,
  load: ImportModule = importModule,
): Promise<Record<string, unknown>> {
  try {
    return await load(pathToFileURL(path).href);
  } catch (error) {
    const code = (error as { readonly code?: unknown } | null)?.code;
    if (/\.m?ts$/.test(path) && code === "ERR_UNKNOWN_FILE_EXTENSION") {
      throw new CliError(typescriptHelp(path), { cause: error });
    }
    throw error;
  }
}

/**
 * A loaded configuration, and the directory its relative paths are resolved against.
 *
 * @example
 * ```ts
 * declare const loaded: LoadedConfig;
 * const migrations = resolve(loaded.root, loaded.config.migrations?.directory ?? "migrations");
 * ```
 */
export interface LoadedConfig {
  readonly config: EgonConfig;
  readonly file: string;
  readonly root: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isAdapter(value: unknown): value is Adapter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly acquire?: unknown }).acquire === "function" &&
    typeof (value as { readonly execute?: unknown }).execute === "function"
  );
}

/**
 * Finds and loads the configuration: `--config <file>`, else the first of
 * {@link CONFIG_FILES} in `cwd`.
 *
 * @throws CliError when there is no config file, or it exports no configuration.
 *
 * @example
 * ```ts
 * const { config, root } = await loadConfig(process.cwd(), undefined);
 * ```
 */
export async function loadConfig(
  cwd: string,
  configPath: string | undefined,
  load: ImportModule = importModule,
): Promise<LoadedConfig> {
  let file: string | undefined;
  if (configPath !== undefined) {
    file = resolve(cwd, configPath);
    if (!(await exists(file))) throw new CliError(`The config file "${file}" does not exist.`);
  } else {
    for (const name of CONFIG_FILES) {
      const candidate = resolve(cwd, name);
      if (await exists(candidate)) {
        file = candidate;
        break;
      }
    }
    if (file === undefined) {
      throw new CliError(
        `No config file: create egon.config.ts (or .mts, .js, .mjs) in ${cwd}, or pass --config <file>. Run egon --help for an example.`,
      );
    }
  }
  const module = await importUserModule(file, load);
  const config = (module.default ?? module.config) as Partial<EgonConfig> | undefined;
  if (typeof config !== "object" || config === null || !isAdapter(config.adapter)) {
    throw new CliError(
      `The config file "${file}" must export (as default, or as "config") an object with an adapter: defineConfig({ adapter: postgres({ … }) }).`,
    );
  }
  const database = config.database;
  if (database !== undefined && (typeof database.name !== "string" || !isAdapter(database.admin))) {
    throw new CliError(`The config file "${file}": database must be { name: string, admin: an adapter }.`);
  }
  return { config: config as EgonConfig, file, root: dirname(file) };
}
