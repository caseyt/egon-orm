/**
 * The migration runner: `createMigrator`. It applies and rolls back migrations on one
 * dedicated connection, under a lock that makes concurrent runners (two instances of a
 * deploy) take turns, and records each applied version in a tracking table.
 *
 * @module
 */
import { sqlDialectOf } from "../adapter/compiler.js";
import { redactParams } from "../adapter/telemetry.js";
import { quoteIdentifier, type SqlDialect } from "../compiler/dialect.js";
import type { Adapter, Connection, ParamSlot } from "../contracts/adapter.js";
import { DatabaseError, isEgonError, MigrationError } from "../errors.js";
import { MigrationBuilder } from "./builder.js";
import { type DdlContext, emitOperation, type MigrationStatement, table as tableSql } from "./ddl.js";
import { type MigrationDialect, migrationDialectOf } from "./dialect.js";
import { checkVersion, loadMigrations, type MigrationSource, migrationList } from "./loader.js";
import { lockKeys } from "./lock.js";
import { reverseOperations } from "./reverse.js";
import type { Operation } from "./types.js";

/**
 * Options of {@link createMigrator}. Give exactly one of `directory` and `migrations`.
 *
 * @example
 * ```ts
 * import { postgres } from "@egon-orm/postgres";
 *
 * const options: MigratorOptions = {
 *   adapter: postgres({ connectionString: process.env.DATABASE_URL }),
 *   directory: "./migrations",
 * };
 * ```
 */
export interface MigratorOptions {
  /** The database to migrate: the same adapter the repo uses, or one of its own. */
  readonly adapter: Adapter;
  /** The directory of migration files, resolved against the working directory. */
  readonly directory?: string;
  /** The migrations, in memory: for bundlers and deployments without a file system. */
  readonly migrations?: readonly MigrationSource[];
  /** The tracking table. Default `"schema_migrations"`. */
  readonly table?: string;
  /** The database schema of the tracking table. Default: the connection's current one. */
  readonly schema?: string;
  /**
   * The tracking table's timestamp column. Default `"created_at"`. To adopt an existing
   * tracking table whose column is called `inserted_at`, pass `"inserted_at"`.
   */
  readonly timestampColumn?: string;
  /** How long to wait for the migration lock before giving up, in milliseconds. Default: no limit. */
  readonly lockTimeoutMs?: number;
  /** The `timeoutMs` of every migration statement. Default: no limit. */
  readonly timeoutMs?: number;
  /** Receives a line of progress for every migration, and warnings. */
  readonly log?: (event: MigrationEvent) => void;
}

/**
 * What the runner reports while it works.
 *
 * - `migrating`: a migration is about to run.
 * - `migrated`: it ran and its version was recorded (or, going down, removed).
 * - `warning`: something to know about that did not stop the run, such as a pending
 *   migration older than the latest applied one.
 *
 * @example
 * ```ts
 * const log = (event: MigrationEvent): void => {
 *   if (event.kind === "migrated") process.stdout.write(`${event.version} ${event.name} (${event.durationMs} ms)\n`);
 * };
 * ```
 */
export type MigrationEvent =
  | {
      readonly kind: "migrating";
      readonly direction: "up" | "down";
      readonly version: number;
      readonly name: string;
    }
  | {
      readonly kind: "migrated";
      readonly direction: "up" | "down";
      readonly version: number;
      readonly name: string;
      readonly durationMs: number;
    }
  | { readonly kind: "warning"; readonly message: string; readonly version: number | undefined };

/**
 * One migration that was run (or, in a dry run, would be).
 *
 * @example
 * ```ts
 * declare const run: MigrationRun;
 * for (const statement of run.statements) process.stdout.write(`${statement.sql};\n`);
 * ```
 */
export interface MigrationRun {
  readonly version: number;
  readonly name: string;
  readonly direction: "up" | "down";
  /** How long it took, in milliseconds; 0 in a dry run. */
  readonly durationMs: number;
  /** Its statements, in order. A redacted parameter shows as `**redacted**`. */
  readonly statements: readonly { readonly sql: string; readonly params: readonly unknown[] }[];
}

/**
 * The state of one migration: `up` (applied), `down` (pending), or `missing` (recorded
 * as applied, but no migration with that version is known; it has no name then).
 *
 * @example
 * ```ts
 * const row: MigrationStatus = { version: 20261012093000, name: "create_users", state: "up" };
 * ```
 */
export interface MigrationStatus {
  readonly version: number;
  readonly name: string | undefined;
  readonly state: "up" | "down" | "missing";
}

/**
 * Options of {@link Migrator.up}: at most one of `to` and `step`.
 *
 * @example
 * ```ts
 * const options: UpOptions = { step: 1, dryRun: true };
 * ```
 */
export interface UpOptions {
  /** Apply the pending migrations up to and including this version. */
  readonly to?: number;
  /** Apply this many pending migrations. */
  readonly step?: number;
  /** Return the SQL of what would run, and run nothing. */
  readonly dryRun?: boolean;
}

/**
 * Options of {@link Migrator.down}: at most one of `to`, `step` and `all`. Without any,
 * the latest applied migration is rolled back (`step: 1`).
 *
 * @example
 * ```ts
 * const options: DownOptions = { to: 20261012093000 };
 * ```
 */
export interface DownOptions {
  /** Roll back the applied migrations down to and including this version. */
  readonly to?: number;
  /** Roll back this many applied migrations. Default 1. */
  readonly step?: number;
  /** Roll back every applied migration. */
  readonly all?: boolean;
  /** Return the SQL of what would run, and run nothing. */
  readonly dryRun?: boolean;
}

/**
 * Applies, rolls back and reports migrations. Each call loads the migrations afresh.
 *
 * @example
 * ```ts
 * declare const migrator: Migrator;
 * await migrator.up();
 * const pending = (await migrator.status()).filter((row) => row.state === "down");
 * ```
 */
export interface Migrator {
  /**
   * Applies pending migrations, oldest first, each in its own transaction where the
   * database has transactional DDL, and returns what ran. A pending migration older than
   * the latest applied one is applied too, with a `warning` event.
   *
   * @throws MigrationError when a migration fails (after rolling it back where it ran in
   * a transaction), cannot be loaded or emitted, or the lock cannot be taken.
   */
  up(options?: UpOptions): Promise<MigrationRun[]>;
  /**
   * Rolls back applied migrations, newest first, and returns what ran.
   *
   * @throws MigrationError as `up` does; also when a migration in the range cannot be
   * reversed, or is recorded but missing (a missing migration blocks rolling back past it).
   */
  down(options?: DownOptions): Promise<MigrationRun[]>;
  /** Every known and every recorded migration, by version. */
  status(): Promise<MigrationStatus[]>;
}

/** How long a runner waits between tries for a `transaction` lock that another runner holds. */
const LOCK_RETRY_MS = 25;

/**
 * The version a runner records, under a `transaction` lock, while it runs a migration
 * without a transaction (outside the lock): its claim. Real versions are positive.
 */
const CLAIM = -1;

/** The savepoint a migration runs in under a `transaction` lock. */
const MIGRATION_SAVEPOINT = "egon_migration";

const DEFAULT_TABLE = "schema_migrations";
const DEFAULT_TIMESTAMP = "created_at";
const OPTION_KEYS = [
  "adapter",
  "directory",
  "migrations",
  "table",
  "schema",
  "timestampColumn",
  "lockTimeoutMs",
  "timeoutMs",
  "log",
];

function checkKeys(where: string, options: object, keys: readonly string[]): void {
  for (const key of Object.keys(options)) {
    if (!keys.includes(key)) {
      throw new TypeError(`${where}: unknown option "${key}". The options are ${keys.join(", ")}.`);
    }
  }
}

function checkName(where: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    throw new TypeError(`${where} must be a non-empty string without NUL characters.`);
  }
  return value;
}

function checkMs(where: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${where} must be a non-negative number of milliseconds.`);
  }
  return value;
}

function checkStep(where: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${where}: step must be a positive whole number.`);
  }
  return value;
}

/**
 * Creates a migration runner over an adapter.
 *
 * @example
 * ```ts
 * import { createMigrator } from "egon-orm/migration";
 * import { postgres } from "@egon-orm/postgres";
 *
 * const adapter = postgres({ connectionString: process.env.DATABASE_URL });
 * const migrator = createMigrator({ adapter, directory: "./migrations" });
 * await migrator.up();
 * await adapter.close();
 * ```
 *
 * @throws TypeError when an option is unknown or has the wrong type, or not exactly one
 * of `directory` and `migrations` is given.
 * @throws MigrationError when the adapter's dialect has no migration support.
 */
export function createMigrator(options: MigratorOptions): Migrator {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("createMigrator() takes an options object: createMigrator({ adapter, directory }).");
  }
  checkKeys("createMigrator()", options, OPTION_KEYS);
  const adapter = options.adapter;
  if (
    typeof adapter !== "object" ||
    adapter === null ||
    typeof adapter.acquire !== "function" ||
    typeof adapter.compileFragment !== "function"
  ) {
    throw new TypeError("createMigrator(): adapter must be an adapter, such as postgres({ … }).");
  }
  if ((options.directory === undefined) === (options.migrations === undefined)) {
    throw new TypeError("createMigrator(): give exactly one of directory and migrations.");
  }
  if (options.log !== undefined && typeof options.log !== "function") {
    throw new TypeError("createMigrator(): log must be a function.");
  }
  const syntax = sqlDialectOf(adapter.dialect);
  if (syntax === undefined) {
    throw new MigrationError(
      `Migrations are not supported on ${String(adapter.dialect)} by this build of egon-orm.`,
    );
  }
  const directory =
    options.directory === undefined ? undefined : checkName("createMigrator(): directory", options.directory);
  const list = options.migrations === undefined ? undefined : migrationList(options.migrations);
  const settings: Settings = {
    adapter,
    syntax,
    dialect: migrationDialectOf(adapter.dialect),
    sources: list === undefined ? () => loadMigrations(directory as string) : () => Promise.resolve(list),
    table: {
      name: checkName("createMigrator(): table", options.table ?? DEFAULT_TABLE),
      schema:
        options.schema === undefined ? undefined : checkName("createMigrator(): schema", options.schema),
    },
    timestampColumn: checkName(
      "createMigrator(): timestampColumn",
      options.timestampColumn ?? DEFAULT_TIMESTAMP,
    ),
    lockTimeoutMs: checkMs("createMigrator(): lockTimeoutMs", options.lockTimeoutMs),
    timeoutMs: checkMs("createMigrator(): timeoutMs", options.timeoutMs),
    log: options.log,
  };
  return new DatabaseMigrator(settings);
}

interface Settings {
  readonly adapter: Adapter;
  readonly syntax: SqlDialect;
  readonly dialect: MigrationDialect;
  readonly sources: () => Promise<readonly MigrationSource[]>;
  readonly table: { readonly name: string; readonly schema: string | undefined };
  readonly timestampColumn: string;
  readonly lockTimeoutMs: number | undefined;
  readonly timeoutMs: number | undefined;
  readonly log: ((event: MigrationEvent) => void) | undefined;
}

/** A migration chosen to run, with its direction. */
interface Planned {
  readonly source: MigrationSource;
  readonly direction: "up" | "down";
}

const VERSION_SLOT: readonly ParamSlot[] = Object.freeze([
  Object.freeze({ kind: "inline", index: 0, toDb: undefined, redact: false } as const),
]);

class DatabaseMigrator implements Migrator {
  readonly #settings: Settings;
  readonly #ddl: DdlContext;
  readonly #lockKey: readonly [number, number];

  constructor(settings: Settings) {
    this.#settings = settings;
    const adapter = settings.adapter;
    this.#ddl = {
      syntax: settings.syntax,
      dialect: settings.dialect,
      compileFragment: (node) => adapter.compileFragment(node),
    };
    this.#lockKey = lockKeys(settings.table.schema, settings.table.name);
  }

  up(options?: UpOptions): Promise<MigrationRun[]> {
    const where = "migrator.up()";
    const checked = options ?? {};
    checkKeys(where, checked, ["to", "step", "dryRun"]);
    if (checked.to !== undefined && checked.step !== undefined) {
      throw new TypeError(`${where}: give at most one of to and step.`);
    }
    const to = checked.to === undefined ? undefined : checkVersion(where, checked.to);
    const step = checked.step === undefined ? undefined : checkStep(where, checked.step);
    return this.#run(dryRunOf(where, checked.dryRun), (known, applied) => {
      const done = new Set(applied);
      let pending = known.filter((source) => !done.has(source.version));
      if (to !== undefined) pending = pending.filter((source) => source.version <= to);
      if (step !== undefined) pending = pending.slice(0, step);
      const latest = applied.length === 0 ? 0 : (applied[applied.length - 1] as number);
      for (const source of pending) {
        if (source.version < latest) {
          this.#emit({
            kind: "warning",
            message: `Migration ${source.version}_${source.name} is older than the latest applied migration (${latest}); it is applied now, out of order.`,
            version: source.version,
          });
        }
      }
      return pending.map((source) => ({ source, direction: "up" as const }));
    });
  }

  down(options?: DownOptions): Promise<MigrationRun[]> {
    const where = "migrator.down()";
    const checked = options ?? {};
    checkKeys(where, checked, ["to", "step", "all", "dryRun"]);
    const given = [checked.to, checked.step, checked.all].filter((value) => value !== undefined).length;
    if (given > 1) throw new TypeError(`${where}: give at most one of to, step and all.`);
    if (checked.all !== undefined && checked.all !== true) {
      throw new TypeError(`${where}: all must be true when given.`);
    }
    const to = checked.to === undefined ? undefined : checkVersion(where, checked.to);
    const step = checked.step === undefined ? 1 : checkStep(where, checked.step);
    return this.#run(dryRunOf(where, checked.dryRun), (known, applied) => {
      const byVersion = new Map(known.map((source) => [source.version, source]));
      const newestFirst = [...applied].reverse();
      const chosen =
        checked.all === true
          ? newestFirst
          : to !== undefined
            ? newestFirst.filter((version) => version >= to)
            : newestFirst.slice(0, step);
      return chosen.map((version) => {
        const source = byVersion.get(version);
        if (source === undefined) {
          throw new MigrationError(
            `Cannot roll back past version ${version}: it is recorded as applied, but there is no migration with that version. Restore its file, or remove the version from the tracking table if it is really gone.`,
            { version },
          );
        }
        return { source, direction: "down" as const };
      });
    });
  }

  async status(): Promise<MigrationStatus[]> {
    const known = await this.#sources();
    const connection = await this.#settings.adapter.acquire();
    let applied: readonly number[];
    try {
      applied = await this.#applied(connection, false);
    } finally {
      await connection.release();
    }
    const done = new Set(applied);
    const rows: MigrationStatus[] = known.map((source) => ({
      version: source.version,
      name: source.name,
      state: done.has(source.version) ? "up" : "down",
    }));
    const names = new Set(known.map((source) => source.version));
    for (const version of applied) {
      if (!names.has(version)) rows.push({ version, name: undefined, state: "missing" });
    }
    return rows.sort((a, b) => a.version - b.version);
  }

  // --- running -----------------------------------------------------------------------

  async #run(
    dryRun: boolean,
    choose: (known: readonly MigrationSource[], applied: readonly number[]) => Planned[],
  ): Promise<MigrationRun[]> {
    const known = await this.#sources();
    const connection = await this.#settings.adapter.acquire();
    let healthy = true;
    let locked = false;
    try {
      if (!dryRun) {
        try {
          await this.#lock(connection);
        } catch (error) {
          // The lock may have been granted although the call failed (a timeout that fired as
          // the lock was granted). Closing the session is the one sure way to release it.
          healthy = false;
          throw error;
        }
        locked = true;
      }
      const applied = await this.#applied(connection, !dryRun);
      const runs: MigrationRun[] = [];
      for (const planned of choose(known, applied)) {
        const prepared = await this.#prepare(planned);
        if (dryRun) {
          runs.push(report(planned, prepared.statements, 0));
          continue;
        }
        const outcome = await this.#execute(connection, planned, prepared);
        healthy = outcome.healthy;
        if (outcome.error !== undefined) throw outcome.error;
        runs.push(report(planned, prepared.statements, outcome.durationMs));
      }
      return runs;
    } finally {
      if (healthy && locked) {
        try {
          await this.#statement(
            connection,
            this.#settings.dialect.lock.release,
            this.#lockParams(),
            undefined,
          );
        } catch {
          healthy = false;
        }
      }
      // Closing the session releases its lock too.
      if (healthy) await connection.release();
      else await connection.destroy();
    }
  }

  async #sources(): Promise<readonly MigrationSource[]> {
    return this.#settings.sources();
  }

  /** The parameters of the lock's statements: the keys of a session lock, none for a transaction lock. */
  #lockParams(): readonly unknown[] {
    return this.#settings.dialect.lock.kind === "session" ? this.#lockKey : [];
  }

  async #lock(connection: Connection): Promise<void> {
    const { lockTimeoutMs } = this.#settings;
    if (this.#settings.dialect.lock.kind === "transaction") return this.#lockWithTransaction(connection);
    try {
      await this.#statement(connection, this.#settings.dialect.lock.acquire, this.#lockKey, lockTimeoutMs);
    } catch (cause) {
      if (cause instanceof DatabaseError && cause.code === "timeout") {
        throw new MigrationError(
          `Gave up waiting for the migration lock after ${lockTimeoutMs} ms: another runner is migrating the same database (tracking table "${this.#settings.table.name}").`,
          { cause },
        );
      }
      throw cause;
    }
  }

  /**
   * Takes a `transaction` lock: starts the write transaction, trying again every
   * {@link LOCK_RETRY_MS} while the database is busy (another runner holds it) until
   * `lockTimeoutMs`, with the connection's own busy timeout set to 0 meanwhile, so that the
   * waiting never blocks the process.
   *
   * A runner that holds the lock gives it up only to run a migration without a transaction,
   * after recording a claim ({@link CLAIM}). Another runner that gets the lock while the
   * claim is there gives it back at once and keeps waiting, as if the database were busy.
   * The runner that made the claim takes the lock again with `ownClaim`, which ignores it.
   */
  async #lockWithTransaction(
    connection: Connection,
    lockTimeoutMs: number | undefined = this.#settings.lockTimeoutMs,
    ownClaim = false,
  ): Promise<void> {
    const { dialect } = this.#settings;
    const busy = dialect.busyTimeout;
    let previous: number | undefined;
    if (busy !== undefined) {
      const row = (await this.#statement(connection, busy.read, [], undefined)).rows[0];
      const value = row === undefined ? Number.NaN : Number(Object.values(row)[0]);
      previous = Number.isSafeInteger(value) ? value : undefined;
      await this.#statement(connection, busy.write(0), [], undefined);
    }
    const deadline = lockTimeoutMs === undefined ? undefined : performance.now() + lockTimeoutMs;
    let claimSeen = false;
    try {
      for (;;) {
        let cause: unknown;
        try {
          await this.#statement(connection, dialect.lock.acquire, [], undefined);
          if (ownClaim || !(await this.#claimed(connection))) return;
          // Another runner is running a migration without a transaction: wait for it.
          claimSeen = true;
          await this.#statement(connection, dialect.lock.abandon ?? "rollback", [], undefined);
        } catch (error) {
          if (!(error instanceof DatabaseError && error.retryable)) throw error;
          cause = error;
        }
        if (deadline !== undefined && performance.now() >= deadline) {
          const stale = claimSeen
            ? ` If no runner is running, one stopped while it ran a migration without a transaction: check what that migration did, then delete the row with version ${CLAIM} from "${this.#settings.table.name}".`
            : "";
          throw new MigrationError(
            `Gave up waiting for the migration lock after ${lockTimeoutMs} ms: another runner is migrating the same database (tracking table "${this.#settings.table.name}").${stale}`,
            cause === undefined ? {} : { cause },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    } finally {
      if (busy !== undefined && previous !== undefined) {
        await this.#statement(connection, busy.write(previous), [], undefined);
      }
    }
  }

  /** Whether another runner has a claim in the tracking table (it is running a migration without a transaction). */
  async #claimed(connection: Connection): Promise<boolean> {
    const { dialect, table } = this.#settings;
    const exists = await this.#statement(
      connection,
      dialect.tableExists,
      [table.schema ?? null, table.name],
      undefined,
    );
    if (exists.rowCount === 0) return false;
    const found = await connection.execute(
      `select 1 from ${tableSql(table, this.#ddl)} where ${this.#quoted("version")} = ${this.#placeholder(1)}`,
      [String(CLAIM)],
      { slots: VERSION_SLOT, context: { operation: "migration" } },
    );
    return found.rowCount > 0;
  }

  /**
   * Gives up a `transaction` lock to run a migration without a transaction: records the
   * claim, then commits, so that another runner sees the claim as soon as it can get the
   * lock, and waits.
   */
  async #claim(connection: Connection): Promise<void> {
    await this.#record(connection, CLAIM, "up");
    await this.#statement(connection, this.#settings.dialect.lock.release, [], undefined);
  }

  /** Takes the `transaction` lock back after a migration without a transaction, and removes the claim. */
  async #unclaim(connection: Connection): Promise<void> {
    // No timeout: other runners only take the lock for a moment while the claim is there.
    await this.#lockWithTransaction(connection, undefined, true);
    await this.#record(connection, CLAIM, "down");
  }

  #quoted(name: string): string {
    return quoteIdentifier(this.#settings.syntax, name);
  }

  #placeholder(index: number): string {
    return this.#settings.syntax.placeholder === "numbered" ? `$${index}` : "?";
  }

  /** The applied versions, oldest first. With `create`, the tracking table is created when it is missing. */
  async #applied(connection: Connection, create: boolean): Promise<readonly number[]> {
    const { dialect, table, timestampColumn } = this.#settings;
    const name = tableSql(table, this.#ddl);
    const exists = await this.#statement(
      connection,
      dialect.tableExists,
      [table.schema ?? null, table.name],
      undefined,
    );
    if (exists.rowCount === 0) {
      if (!create) return [];
      await this.#statement(
        connection,
        `create table ${name} (${this.#quoted("version")} bigint primary key, ${this.#quoted(timestampColumn)} ${dialect.trackingTimestamp})`,
        [],
        undefined,
      );
      return [];
    }
    if (create) {
      const column = await this.#statement(
        connection,
        dialect.columnExists,
        [table.schema ?? null, table.name, timestampColumn],
        undefined,
      );
      if (column.rowCount === 0) {
        throw new MigrationError(
          `The tracking table "${table.name}" has no column "${timestampColumn}". If it was created by another tool, pass its timestamp column: createMigrator({ timestampColumn: "inserted_at" }) (or whatever it is called).`,
        );
      }
    }
    const result = await this.#statement(
      connection,
      `select ${this.#quoted("version")} as ${this.#quoted("version")} from ${name} order by 1`,
      [],
      undefined,
    );
    const versions = result.rows.map((row) => {
      const version = Number(row.version);
      if (!Number.isSafeInteger(version)) {
        throw new MigrationError(
          `The tracking table "${table.name}" holds a version that is not a safe whole number: ${String(row.version)}.`,
        );
      }
      return version;
    });
    // A claim is not an applied version.
    return versions.filter((version) => version !== CLAIM);
  }

  /** The operations and statements of one migration in one direction. */
  async #prepare(
    planned: Planned,
  ): Promise<{ operations: readonly Operation[]; statements: MigrationStatement[] }> {
    const { source, direction } = planned;
    const { migration } = source;
    const context = { version: source.version, migration: source.name };
    try {
      const builder = new MigrationBuilder(this.#settings.syntax.identifierMaxBytes);
      let operations: readonly Operation[];
      if (migration.change !== undefined) {
        await migration.change(builder);
        operations = direction === "up" ? builder.operations : reverseOperations(builder.operations, context);
      } else if (direction === "up") {
        await (migration.up as (m: MigrationBuilder) => void | Promise<void>)(builder);
        operations = builder.operations;
      } else {
        if (migration.down === undefined) {
          throw new MigrationError(
            `Migration ${source.version}_${source.name} cannot be rolled back: it has up() and no down(). Add a down() that undoes it.`,
            context,
          );
        }
        await migration.down(builder);
        operations = builder.operations;
      }
      const statements: MigrationStatement[] = [];
      for (const op of operations) statements.push(...emitOperation(op, this.#ddl));
      return { operations, statements };
    } catch (error) {
      if (isEgonError(error, "migration") && (error as MigrationError).version !== undefined) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new MigrationError(`Migration ${source.version}_${source.name}: ${message}`, {
        ...context,
        cause: error,
      });
    }
  }

  async #execute(
    connection: Connection,
    planned: Planned,
    prepared: { operations: readonly Operation[]; statements: MigrationStatement[] },
  ): Promise<{ healthy: boolean; durationMs: number; error: MigrationError | undefined }> {
    const { source, direction } = planned;
    const context = { version: source.version, migration: source.name };
    const transaction = source.migration.transaction && this.#settings.adapter.capabilities.ddlTransactions;
    if (transaction && prepared.operations.some(isConcurrent)) {
      return {
        healthy: true,
        durationMs: 0,
        error: new MigrationError(
          `Migration ${source.version}_${source.name} builds or drops an index concurrently, which cannot run inside a transaction. Add transaction: false to its defineMigration().`,
          context,
        ),
      };
    }
    this.#emit({ kind: "migrating", direction, version: source.version, name: source.name });
    const start = performance.now();
    let current: string | undefined;
    // Under a transaction lock the run is already one transaction: a migration's own is a
    // savepoint in it.
    const nested = this.#settings.dialect.lock.kind === "transaction";
    const begin = () => (nested ? connection.savepoint(MIGRATION_SAVEPOINT) : connection.begin());
    const commit = () => (nested ? connection.releaseSavepoint(MIGRATION_SAVEPOINT) : connection.commit());
    const rollback = async () => {
      if (!nested) return connection.rollback();
      await connection.rollbackTo(MIGRATION_SAVEPOINT);
      await connection.releaseSavepoint(MIGRATION_SAVEPOINT);
    };
    // A migration without a transaction cannot run inside the run's transaction (SQLite's
    // vacuum refuses to, and its foreign_keys pragma is ignored there): the runner records a
    // claim and gives the lock up while it runs, then takes it back and records the version.
    let claimed = false;
    try {
      if (transaction) await begin();
      else if (nested) {
        await this.#claim(connection);
        claimed = true;
      }
      for (const statement of prepared.statements) {
        current = statement.sql;
        await connection.execute(statement.sql, statement.params, {
          slots: statement.slots,
          ...(this.#settings.timeoutMs === undefined ? {} : { timeoutMs: this.#settings.timeoutMs }),
          context: { operation: "migration", version: source.version, name: source.name, direction },
        });
      }
      current = undefined;
      if (claimed) {
        claimed = false;
        await this.#unclaim(connection);
      }
      await this.#record(connection, source.version, direction);
      if (transaction) await commit();
    } catch (cause) {
      let healthy = true;
      if (transaction) {
        try {
          await rollback();
        } catch {
          healthy = false;
        }
      }
      if (claimed) {
        try {
          await this.#unclaim(connection);
        } catch {
          healthy = false;
        }
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      const outcome = transaction
        ? "failed and was rolled back"
        : "failed; it ran without a transaction, so the statements before the failing one stay applied";
      return {
        healthy,
        durationMs: 0,
        error: new MigrationError(`Migration ${source.version}_${source.name} ${outcome}: ${message}`, {
          ...context,
          ...(current === undefined ? {} : { sql: current }),
          cause,
        }),
      };
    }
    const durationMs = performance.now() - start;
    this.#emit({ kind: "migrated", direction, version: source.version, name: source.name, durationMs });
    return { healthy: true, durationMs, error: undefined };
  }

  async #record(connection: Connection, version: number, direction: "up" | "down"): Promise<void> {
    const { table, timestampColumn, dialect } = this.#settings;
    const name = tableSql(table, this.#ddl);
    const sql =
      direction === "up"
        ? `insert into ${name} (${this.#quoted("version")}, ${this.#quoted(timestampColumn)}) values (${this.#placeholder(1)}, ${dialect.utcNow})`
        : `delete from ${name} where ${this.#quoted("version")} = ${this.#placeholder(1)}`;
    await connection.execute(sql, [String(version)], {
      slots: VERSION_SLOT,
      context: { operation: "migration", version },
    });
  }

  #statement(connection: Connection, sql: string, params: readonly unknown[], timeoutMs: number | undefined) {
    return connection.execute(sql, params, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      context: { operation: "migration" },
    });
  }

  #emit(event: MigrationEvent): void {
    this.#settings.log?.(event);
  }
}

function dryRunOf(where: string, value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TypeError(`${where}: dryRun must be a boolean.`);
  return value;
}

function isConcurrent(op: Operation): boolean {
  return (op.op === "createIndex" || op.op === "dropIndex") && op.index.concurrently;
}

function report(
  planned: Planned,
  statements: readonly MigrationStatement[],
  durationMs: number,
): MigrationRun {
  return {
    version: planned.source.version,
    name: planned.source.name,
    direction: planned.direction,
    durationMs,
    statements: statements.map((statement) => ({
      sql: statement.sql,
      params: statement.params.length === 0 ? [] : redactParams(statement.params, statement.slots),
    })),
  };
}
