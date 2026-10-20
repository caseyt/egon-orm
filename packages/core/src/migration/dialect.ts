/**
 * The migration dialect tables: what the DDL emitter and the runner need to know about a
 * database beyond the compiler's SQL table (quoting comes from there,
 * `../compiler/dialect.ts`). Each is a plain object; where databases differ, the emitter
 * reads a field of the table, never the dialect's name (ADR 0003, rule 5).
 *
 * There is one table per database: Postgres, MySQL 8 and SQLite.
 *
 * @module
 */
import { postgresDialect, sqliteDialect } from "../compiler/dialect.js";
import type { Dialect } from "../contracts/adapter.js";
import { MigrationError } from "../errors.js";
import type { ColumnKind, ReferenceAction } from "./types.js";

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
  /** `CREATE INDEX IF NOT EXISTS` and `DROP INDEX IF EXISTS`. */
  readonly indexIfExists: boolean;
  /** `ALTER TABLE … ADD CONSTRAINT` and `… DROP CONSTRAINT` (SQLite has neither). */
  readonly alterConstraints: boolean;
  /** `ALTER TABLE … DROP CONSTRAINT IF EXISTS`. */
  readonly constraintIfExists: boolean;
  /**
   * How a column's type, nullability and default are changed: `"alter"` (one `ALTER COLUMN`
   * action each), `"modify"` (MySQL's `MODIFY COLUMN`, which rewrites the whole column, so
   * `notNull` and `default` must both be given) or `"none"` (SQLite cannot).
   */
  readonly modifyColumn: "alter" | "modify" | "none";
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
  /**
   * The runner's lock. A `session` lock is held by the connection: `acquire` and `release`
   * take the two 32-bit keys as `$1`, `$2`, and every migration runs in its own transaction
   * under it. A `transaction` lock (SQLite's `begin immediate`) is a write transaction held
   * for the whole run: its statements take no parameters, `acquire` is retried while the
   * database is busy, `release` commits it, and each migration runs in a savepoint inside it.
   */
  readonly lock: Readonly<{ kind: "session" | "transaction"; acquire: string; release: string }>;
  /**
   * How to read and set the connection's busy timeout, for a `transaction` lock: the runner
   * sets it to 0 while it tries for the lock (and waits between tries itself, so that a
   * runner in the same process is never blocked), then puts it back. `undefined` for a
   * `session` lock.
   */
  readonly busyTimeout: Readonly<{ read: string; write: (ms: number) => string }> | undefined;
  /** Selects one row when the table (`$1` database schema or `null`, `$2` name) exists. */
  readonly tableExists: string;
  /** Selects one row when the column (`$1` database schema or `null`, `$2` table, `$3` column) exists. */
  readonly columnExists: string;
  /** The current time in UTC, as a value of the tracking table's timestamp column. */
  readonly utcNow: string;
  /** The type of the tracking table's timestamp column. */
  readonly trackingTimestamp: string;
  /** The column type of each kind, in DDL (the compiler's `CAST` names can differ: MySQL casts to `char`). */
  readonly columnTypes: Readonly<Record<ColumnKind, string>>;
  /** Whether a type's precision and scale are written (`timestamptz(3)`); SQLite has no use for them. */
  readonly precision: boolean;
  /** The precision written for a kind when the migration gives none (MySQL: `datetime(6)`, `decimal(65, 30)`). */
  readonly defaultPrecision: Readonly<Partial<Record<ColumnKind, readonly number[]>>>;
  /** The column type an array is stored in, on a database without array columns; `undefined` for `type[]`. */
  readonly arrayType: string | undefined;
  /**
   * Whether "now" as a timestamp column's default carries the column's precision (MySQL:
   * `current_timestamp(3)` for a `datetime(3)`; the two must match).
   */
  readonly nowWithPrecision: boolean;
  /**
   * Where a column's unique constraint and foreign key are written: in the column
   * (`"inline"`), or as constraints of the table (`"table"`: MySQL takes neither in a
   * column). A table-level foreign key gets an index of its own, named as the constraint:
   * MySQL needs one, and would otherwise take over an index the migration creates later,
   * which then could not be dropped.
   */
  readonly columnConstraints: "inline" | "table";
  /** Written after `primary key` for a key the database generates (SQLite: ` autoincrement`). */
  readonly serialKey: string;
  /** `DROP INDEX name ON table` (MySQL) rather than `DROP INDEX name`. */
  readonly dropIndexOnTable: boolean;
  /**
   * Whether a constant default is written in parentheses, as an expression: MySQL takes a
   * constant default for a `json` column only that way.
   */
  readonly parenthesizedDefaults: boolean;
  /**
   * Whether the runner's lock (`lock`) holds off another runner (every table here has one).
   */
  readonly locks: boolean;
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
    indexIfExists: true,
    alterConstraints: true,
    constraintIfExists: true,
    modifyColumn: "alter",
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
    kind: "session",
    acquire: "select pg_advisory_lock($1, $2)",
    release: "select pg_advisory_unlock($1, $2)",
  }),
  busyTimeout: undefined,
  tableExists:
    "select 1 from information_schema.tables where table_schema = coalesce($1, current_schema()) and table_name = $2",
  columnExists:
    "select 1 from information_schema.columns where table_schema = coalesce($1, current_schema()) and table_name = $2 and column_name = $3",
  utcNow: "(now() at time zone 'utc')",
  trackingTimestamp: "timestamp(0)",
  columnTypes: postgresDialect.types,
  precision: true,
  defaultPrecision: Object.freeze({}),
  arrayType: undefined,
  nowWithPrecision: false,
  columnConstraints: "inline",
  serialKey: "",
  dropIndexOnTable: false,
  parenthesizedDefaults: false,
  locks: true,
});

/** One run of text without a quote, for {@link mysqlStringLiteral}. */
function mysqlPart(part: string): string {
  // A hex literal of the UTF-8 bytes, which no escape setting can change.
  return part.includes("\\")
    ? `convert(X'${Buffer.from(part, "utf8").toString("hex")}' using utf8mb4)`
    : `'${part}'`;
}

/**
 * MySQL string literal. Text with neither a quote nor a backslash is `'…'`. A backslash
 * is written as the UTF-8 bytes in hex (`convert(X'5c41' using utf8mb4)`), which reads the same
 * whatever `NO_BACKSLASH_ESCAPES` says. A quote is `char(39 using utf8mb4)` between the
 * runs of text (`concat('it', char(39 using utf8mb4), 's')`): MySQL stores a default or a
 * check constraint as text with `\'` for a quote, and under `NO_BACKSLASH_ESCAPES` cannot
 * read that back.
 */
function mysqlStringLiteral(value: string): string {
  if (!value.includes("'")) return mysqlPart(value);
  const parts: string[] = [];
  const runs = value.split("'");
  for (let i = 0; i < runs.length; i++) {
    if (i > 0) parts.push("char(39 using utf8mb4)");
    const run = runs[i] as string;
    if (run !== "") parts.push(mysqlPart(run));
  }
  return parts.length === 1 ? (parts[0] as string) : `concat(${parts.join(", ")})`;
}

/** SQLite string literal: `'…'` with quotes doubled; SQLite has no escape character. */
function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The MySQL 8 migration table. DDL is not transactional on MySQL (each statement commits),
 * so a migration that fails part-way leaves its earlier statements applied.
 *
 * @example
 * ```ts
 * MYSQL_MIGRATION_DIALECT.serial.bigint; // "bigint auto_increment"
 * ```
 */
export const MYSQL_MIGRATION_DIALECT: MigrationDialect = Object.freeze({
  name: "mysql",
  features: Object.freeze({
    // A database schema is a database on MySQL: CREATE SCHEMA is CREATE DATABASE.
    schemas: true,
    extensions: false,
    concurrentIndexes: false,
    partialIndexes: false,
    includeColumns: false,
    exclusionConstraints: false,
    // MySQL accepts CASCADE on DROP TABLE and does nothing with it.
    dropCascade: false,
    // MySQL writes the index type before ON; not offered.
    indexMethods: Object.freeze([]),
    indexIfExists: false,
    alterConstraints: true,
    constraintIfExists: false,
    modifyColumn: "modify",
  }),
  serial: Object.freeze({ integer: "integer auto_increment", bigint: "bigint auto_increment" }),
  referenceActions: Object.freeze({
    cascade: "cascade",
    restrict: "restrict",
    setNull: "set null",
    setDefault: "set default",
    noAction: "no action",
  }),
  booleans: Object.freeze({ true: "true", false: "false" }),
  now: "current_timestamp",
  stringLiteral: mysqlStringLiteral,
  // A named lock of the session, per database and tracking table (names are server-wide,
  // and at most 64 characters: hence the hash).
  lock: Object.freeze({
    kind: "session",
    acquire: "select get_lock(concat('egon:', sha1(concat(database(), ':', ?, ':', ?))), -1) as locked",
    release: "select release_lock(concat('egon:', sha1(concat(database(), ':', ?, ':', ?)))) as released",
  }),
  busyTimeout: undefined,
  tableExists:
    "select 1 from information_schema.tables where table_schema = coalesce(?, database()) and table_name = ?",
  columnExists:
    "select 1 from information_schema.columns where table_schema = coalesce(?, database()) and table_name = ? and column_name = ?",
  utcNow: "utc_timestamp()",
  trackingTimestamp: "datetime",
  columnTypes: Object.freeze({
    integer: "integer",
    bigint: "bigint",
    float: "double",
    decimal: "decimal",
    boolean: "boolean",
    // TEXT can be neither indexed nor given a default on MySQL; a long text column is
    // m.custom("body", "text").
    text: "varchar(255)",
    uuid: "char(36)",
    binary: "longblob",
    date: "date",
    time: "time",
    timestamp: "datetime",
    timestamptz: "datetime",
    json: "json",
    jsonb: "json",
  }),
  precision: true,
  defaultPrecision: Object.freeze({
    decimal: Object.freeze([65, 30]),
    time: Object.freeze([6]),
    timestamp: Object.freeze([6]),
    timestamptz: Object.freeze([6]),
  }),
  arrayType: "json",
  nowWithPrecision: true,
  columnConstraints: "table",
  serialKey: "",
  dropIndexOnTable: true,
  parenthesizedDefaults: true,
  locks: true,
});

/**
 * The SQLite migration table. SQLite's `ALTER TABLE` adds, renames and drops columns and
 * renames tables; it cannot change a column or a constraint.
 *
 * @example
 * ```ts
 * SQLITE_MIGRATION_DIALECT.serial.bigint; // "integer" (with primary key autoincrement)
 * ```
 */
export const SQLITE_MIGRATION_DIALECT: MigrationDialect = Object.freeze({
  name: "sqlite",
  features: Object.freeze({
    schemas: false,
    extensions: false,
    concurrentIndexes: false,
    partialIndexes: true,
    includeColumns: false,
    exclusionConstraints: false,
    dropCascade: false,
    indexMethods: Object.freeze([]),
    indexIfExists: true,
    alterConstraints: false,
    constraintIfExists: false,
    modifyColumn: "none",
  }),
  // The rowid: an integer key that SQLite generates, never reused with autoincrement.
  serial: Object.freeze({ integer: "integer", bigint: "integer" }),
  referenceActions: Object.freeze({
    cascade: "cascade",
    restrict: "restrict",
    setNull: "set null",
    setDefault: "set default",
    noAction: "no action",
  }),
  booleans: Object.freeze({ true: "true", false: "false" }),
  // A timestamp as the adapter stores one: ISO 8601 text in UTC, with milliseconds.
  now: "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
  stringLiteral: sqliteStringLiteral,
  // SQLite has no lock outside a transaction: the runner holds a write transaction
  // (`begin immediate`) for the whole run, which another runner on the same file, in this
  // process or another, cannot start until it ends.
  lock: Object.freeze({ kind: "transaction", acquire: "begin immediate", release: "commit" }),
  busyTimeout: Object.freeze({
    read: "pragma busy_timeout",
    write: (ms: number) => `pragma busy_timeout = ${Math.max(0, Math.trunc(ms))}`,
  }),
  tableExists: "select 1 from pragma_table_list where schema = coalesce(?, 'main') and name = ?",
  columnExists: "select 1 from pragma_table_info where schema = coalesce(?, 'main') and arg = ? and name = ?",
  utcNow: "strftime('%Y-%m-%d %H:%M:%S', 'now')",
  trackingTimestamp: "text",
  columnTypes: sqliteDialect.types,
  precision: false,
  defaultPrecision: Object.freeze({}),
  arrayType: "text",
  nowWithPrecision: false,
  columnConstraints: "inline",
  serialKey: " autoincrement",
  dropIndexOnTable: false,
  parenthesizedDefaults: false,
  locks: true,
});

const TABLES: Readonly<Partial<Record<Dialect, MigrationDialect>>> = Object.freeze({
  postgres: POSTGRES_MIGRATION_DIALECT,
  mysql: MYSQL_MIGRATION_DIALECT,
  sqlite: SQLITE_MIGRATION_DIALECT,
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
