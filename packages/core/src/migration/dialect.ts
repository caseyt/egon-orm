/**
 * The migration dialect tables: what the DDL emitter and the runner need to know about a
 * database beyond the compiler's SQL table (quoting and type names come from there,
 * `../compiler/dialect.ts`). Each is a plain object; where databases differ, the emitter
 * reads a field of the table, never the dialect's name (ADR 0003, rule 5).
 *
 * This step ships the Postgres table; step 17 adds MySQL and SQLite.
 *
 * @module
 */
import type { Dialect } from "../contracts/adapter.js";
import { MigrationError } from "../errors.js";
import type { ReferenceAction } from "./types.js";

/**
 * The DDL features a database may lack. The emitter refuses a feature the table says is
 * missing with `MigrationError`, before anything is sent.
 *
 * @example
 * ```ts
 * declare const features: DdlFeatures;
 * if (!features.concurrentIndexes) throw new MigrationError("CREATE INDEX CONCURRENTLY is not supported.");
 * ```
 */
export interface DdlFeatures {
  /** `CREATE SCHEMA`, and tables in a database schema. */
  readonly schemas: boolean;
  /** `CREATE EXTENSION`. */
  readonly extensions: boolean;
  /** `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY`. */
  readonly concurrentIndexes: boolean;
  /** `CREATE INDEX … WHERE …`. */
  readonly partialIndexes: boolean;
  /** `CREATE INDEX … INCLUDE (…)`. */
  readonly includeColumns: boolean;
  /** `EXCLUDE` constraints. */
  readonly exclusionConstraints: boolean;
  /** `DROP … CASCADE`. */
  readonly dropCascade: boolean;
  /** The index methods `using` accepts, in lower case. */
  readonly indexMethods: readonly string[];
}

/**
 * A database as the migration code sees it.
 *
 * Every SQL text in here is fixed program text. The statements that take values (the
 * lock keys, a version, a table name to look up) take them as bound parameters, written
 * with the dialect's placeholders.
 *
 * @example
 * ```ts
 * declare const dialect: MigrationDialect;
 * const literal = dialect.stringLiteral("it's"); // "'it''s'" on Postgres
 * ```
 */
export interface MigrationDialect {
  readonly name: Dialect;
  readonly features: DdlFeatures;
  /** The column type of a key the database generates, by the integer kind it holds. */
  readonly serial: Readonly<{ integer: string; bigint: string }>;
  /** The SQL of each `onDelete` / `onUpdate` action. */
  readonly referenceActions: Readonly<Record<ReferenceAction, string>>;
  /** The keywords of the two boolean constants. */
  readonly booleans: Readonly<{ true: string; false: string }>;
  /** The expression for "now", for `timestamps()` defaults. */
  readonly now: string;
  /**
   * Writes a string constant as a SQL literal (DDL takes no bound parameters). It must
   * return a literal that the database reads back as exactly `value`; `value` is
   * well-formed text without NUL (anything else is refused before).
   *
   * The statement text reaches the server in the connection's client encoding, which the
   * writer assumes to be UTF-8 (the `pg` driver sets `client_encoding` to UTF-8 when it
   * connects). Under an encoding such as SJIS or GBK, where a multibyte character can end
   * in the byte of a backslash or a quote, escaping by characters is not safe.
   */
  readonly stringLiteral: (value: string) => string;
  /** The runner's lock: statements taking the two 32-bit keys as `$1`, `$2`. */
  readonly lock: Readonly<{ acquire: string; release: string }>;
  /** Selects one row when the table (`$1` database schema or `null`, `$2` name) exists. */
  readonly tableExists: string;
  /** Selects one row when the column (`$1` database schema or `null`, `$2` table, `$3` column) exists. */
  readonly columnExists: string;
  /** The current time in UTC, as a value of the tracking table's timestamp column. */
  readonly utcNow: string;
  /** The type of the tracking table's timestamp column. */
  readonly trackingTimestamp: string;
}

/** Postgres string literal: `'…'` with quotes doubled, as `E'…'` when there is a backslash. */
function postgresStringLiteral(value: string): string {
  const quoted = value.replaceAll("'", "''");
  // In an E'…' string a backslash is always an escape, whatever standard_conforming_strings
  // says, so doubling every backslash makes each one stand for itself. Without a backslash
  // the plain form has only the quote to escape under either setting. This holds for a
  // UTF-8 client encoding (see MigrationDialect.stringLiteral).
  return value.includes("\\") ? `E'${quoted.replaceAll("\\", "\\\\")}'` : `'${quoted}'`;
}

/**
 * The Postgres migration table.
 *
 * @example
 * ```ts
 * POSTGRES_MIGRATION_DIALECT.serial.bigint; // "bigserial"
 * ```
 */
export const POSTGRES_MIGRATION_DIALECT: MigrationDialect = Object.freeze({
  name: "postgres",
  features: Object.freeze({
    schemas: true,
    extensions: true,
    concurrentIndexes: true,
    partialIndexes: true,
    includeColumns: true,
    exclusionConstraints: true,
    dropCascade: true,
    indexMethods: Object.freeze(["btree", "hash", "gist", "gin", "spgist", "brin"]),
  }),
  serial: Object.freeze({ integer: "serial", bigint: "bigserial" }),
  referenceActions: Object.freeze({
    cascade: "cascade",
    restrict: "restrict",
    setNull: "set null",
    setDefault: "set default",
    noAction: "no action",
  }),
  booleans: Object.freeze({ true: "true", false: "false" }),
  now: "now()",
  stringLiteral: postgresStringLiteral,
  // A session-level advisory lock: held by the connection until released or closed, and
  // outside every transaction, so the migrations' own transactions are not affected.
  lock: Object.freeze({
    acquire: "select pg_advisory_lock($1, $2)",
    release: "select pg_advisory_unlock($1, $2)",
  }),
  tableExists:
    "select 1 from information_schema.tables where table_schema = coalesce($1, current_schema()) and table_name = $2",
  columnExists:
    "select 1 from information_schema.columns where table_schema = coalesce($1, current_schema()) and table_name = $2 and column_name = $3",
  utcNow: "(now() at time zone 'utc')",
  trackingTimestamp: "timestamp(0)",
});

const TABLES: Readonly<Partial<Record<Dialect, MigrationDialect>>> = Object.freeze({
  postgres: POSTGRES_MIGRATION_DIALECT,
});

/**
 * The migration table of `dialect`.
 *
 * @example
 * ```ts
 * migrationDialectOf("postgres").now; // "now()"
 * ```
 *
 * @throws MigrationError when this build has no migration table for the dialect.
 */
export function migrationDialectOf(dialect: Dialect): MigrationDialect {
  const table = Object.hasOwn(TABLES, dialect) ? TABLES[dialect] : undefined;
  if (table === undefined) {
    throw new MigrationError(
      `Migrations are not supported on ${String(dialect)} by this build of egon-orm: it has no migration dialect table for it.`,
    );
  }
  return table;
}
