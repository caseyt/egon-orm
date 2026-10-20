/**
 * Turns `mysql2` errors into Egon errors: MySQL error numbers into `ConstraintError` and
 * `DatabaseError` codes, network failures into `DatabaseError` with the code
 * `"connection"`. The driver's error is always kept as `cause`.
 *
 * @module
 */
import type { ConstraintViolationType, DatabaseErrorCode } from "egon-orm";
import { ConstraintError, DatabaseError, isEgonError } from "egon-orm";

interface MysqlErrorFields {
  readonly code?: unknown;
  readonly errno?: unknown;
  readonly sqlState?: unknown;
  readonly fatal?: unknown;
}

/** Error numbers of constraint violations, by the kind they report. */
const CONSTRAINT_ERRORS: ReadonlyMap<number, ConstraintViolationType> = new Map<number, ConstraintViolationType>([
  [1062, "unique"], // ER_DUP_ENTRY
  [1586, "unique"], // ER_DUP_ENTRY_WITH_KEY_NAME
  [1451, "foreignKey"], // ER_ROW_IS_REFERENCED_2
  [1452, "foreignKey"], // ER_NO_REFERENCED_ROW_2
  [1216, "foreignKey"], // ER_NO_REFERENCED_ROW
  [1217, "foreignKey"], // ER_ROW_IS_REFERENCED
  [3819, "check"], // ER_CHECK_CONSTRAINT_VIOLATED
  [1048, "notNull"], // ER_BAD_NULL_ERROR
  [1364, "notNull"], // ER_NO_DEFAULT_FOR_FIELD
]);

/** Error numbers with a code of their own. */
const DATABASE_ERRORS: ReadonlyMap<number, DatabaseErrorCode> = new Map<number, DatabaseErrorCode>([
  [1213, "deadlock"], // ER_LOCK_DEADLOCK
  [3024, "timeout"], // ER_QUERY_TIMEOUT (max_execution_time)
  [1040, "connection"], // ER_CON_COUNT_ERROR
  [1045, "connection"], // ER_ACCESS_DENIED_ERROR
  [1053, "connection"], // ER_SERVER_SHUTDOWN
  [1927, "connection"], // ER_CONNECTION_KILLED
  [4031, "connection"], // ER_CLIENT_INTERACTION_TIMEOUT
]);

/** Error numbers whose transaction may succeed when run again. */
const RETRYABLE: ReadonlySet<number> = new Set([1205]); // ER_LOCK_WAIT_TIMEOUT

/**
 * Error numbers whose messages name only SQL objects, never values: their message is
 * repeated in ours. Others (a duplicate entry, a value out of range) may quote a value, so
 * for them the message says where to look instead (`error.cause`).
 */
const SAFE_MESSAGES: ReadonlySet<number> = new Set([
  1044, // ER_DBACCESS_DENIED_ERROR
  1049, // ER_BAD_DB_ERROR
  1050, // ER_TABLE_EXISTS_ERROR
  1051, // ER_BAD_TABLE_ERROR
  1054, // ER_BAD_FIELD_ERROR
  1060, // ER_DUP_FIELDNAME
  1061, // ER_DUP_KEYNAME
  1064, // ER_PARSE_ERROR
  1091, // ER_CANT_DROP_FIELD_OR_KEY
  1142, // ER_TABLEACCESS_DENIED_ERROR
  1146, // ER_NO_SUCH_TABLE
  1205, // ER_LOCK_WAIT_TIMEOUT
  1213, // ER_LOCK_DEADLOCK
  1235, // ER_NOT_SUPPORTED_YET
  1305, // ER_SP_DOES_NOT_EXIST
  1317, // ER_QUERY_INTERRUPTED
  1792, // ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION
  3024, // ER_QUERY_TIMEOUT
  3572, // ER_LOCK_NOWAIT
]);

/** Node.js and driver error codes that mean the database could not be reached or the connection failed. */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_SEQUENCE_TIMEOUT",
  "POOL_TIMEOUT",
  "POOL_CLOSED",
]);

/** Messages of errors `mysql2` raises itself when a connection fails or is gone. */
const CONNECTION_MESSAGES: readonly RegExp[] = [
  /^Can't add new command when connection is in closed state$/,
  /^Connection lost/,
  /^Pool is closed\.?$/,
];

/** `Duplicate entry '…' for key 'users.users_email_key'`: the key is the last quoted part. */
const DUPLICATE_KEY = /for key '([^']*)'$/;
/** `… a foreign key constraint fails (`db`.`books`, CONSTRAINT `books_author_id_fkey` FOREIGN KEY …`. */
const FOREIGN_KEY = /\(`[^`]*`\.`([^`]*)`, CONSTRAINT `([^`]*)`/;
/** `Check constraint 'books_pages_check' is violated.` */
const CHECK = /^Check constraint '([^']*)' is violated/;
/** `Column 'email' cannot be null` and `Field 'email' doesn't have a default value`. */
const COLUMN = /^(?:Column|Field) '([^']*)'/;

function text(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function violation(error: Error, type: ConstraintViolationType, sql: string | undefined): ConstraintError {
  let constraint: string | undefined;
  let table: string | undefined;
  let column: string | undefined;
  const message = error.message;
  if (type === "unique") {
    const key = DUPLICATE_KEY.exec(message)?.[1];
    if (key !== undefined) {
      // MySQL 8 writes the key as <table>.<key name>; the primary key is named PRIMARY.
      const dot = key.indexOf(".");
      table = dot === -1 ? undefined : key.slice(0, dot);
      const name = dot === -1 ? key : key.slice(dot + 1);
      constraint = name === "PRIMARY" && table !== undefined ? `${table}_pkey` : text(name);
    }
  } else if (type === "foreignKey") {
    const match = FOREIGN_KEY.exec(message);
    table = text(match?.[1]);
    constraint = text(match?.[2]);
  } else if (type === "check") {
    constraint = text(CHECK.exec(message)?.[1]);
  } else {
    column = text(COLUMN.exec(message)?.[1]);
  }
  const details = { type, constraint, table, column, detail: undefined, cause: error };
  return new ConstraintError(sql === undefined ? details : { ...details, sql });
}

/**
 * Maps an error thrown by `mysql2` to an Egon error, keeping it as `cause` and attaching
 * the statement's `sql` when it is known (never the parameter values):
 *
 * - `ER_DUP_ENTRY`, `ER_NO_REFERENCED_ROW_2`, `ER_ROW_IS_REFERENCED_2`,
 *   `ER_CHECK_CONSTRAINT_VIOLATED`, `ER_BAD_NULL_ERROR` and `ER_NO_DEFAULT_FOR_FIELD`
 *   become `ConstraintError` with the key, table and column MySQL names (the primary key,
 *   which MySQL calls `PRIMARY`, as `<table>_pkey`);
 * - `ER_LOCK_DEADLOCK` becomes `DatabaseError` with the code `"deadlock"` (retryable),
 *   `ER_LOCK_WAIT_TIMEOUT` a retryable `"database"` error, `ER_QUERY_TIMEOUT` `"timeout"`;
 * - refused, lost and killed connections, wrong credentials and network errors become
 *   `"connection"`;
 * - any other database error becomes `DatabaseError` with the code `"database"`.
 *
 * Anything else (an Egon error, an error of the application) is returned unchanged.
 *
 * @example
 * ```ts
 * try {
 *   await pool.execute("insert into users (email) values (?)", [email]);
 * } catch (error) {
 *   throw normalizeMysqlError(error, "insert into users (email) values (?)");
 * }
 * ```
 */
export function normalizeMysqlError(error: unknown, sql: string | undefined): unknown {
  if (!(error instanceof Error) || isEgonError(error)) return error;
  const fields = error as Error & MysqlErrorFields;
  const code = typeof fields.code === "string" ? fields.code : undefined;
  const withSql = <T extends object>(details: T): T & { readonly sql?: string } =>
    sql === undefined ? details : { ...details, sql };

  if ((code !== undefined && CONNECTION_CODES.has(code)) || CONNECTION_MESSAGES.some((p) => p.test(error.message))) {
    return new DatabaseError(
      `Could not reach the database, or lost the connection to it (${code ?? error.message}). Check that it is running and that the connection settings are right.`,
      withSql({ code: "connection" as const, cause: error }),
    );
  }

  // A server error: mysql2 carries the error number in `errno` and the SQLSTATE in `sqlState`.
  const errno = typeof fields.errno === "number" ? fields.errno : undefined;
  if (errno !== undefined && typeof fields.sqlState === "string") {
    const type = CONSTRAINT_ERRORS.get(errno);
    if (type !== undefined) return violation(error, type, sql);
    const egonCode = DATABASE_ERRORS.get(errno) ?? "database";
    const said = SAFE_MESSAGES.has(errno)
      ? `: ${error.message}`
      : ". The database's message is on error.cause; it is left out here because it may quote a value";
    return new DatabaseError(
      `The database rejected the statement (MySQL error ${errno}, ${code ?? "unknown"})${said}.`,
      withSql({ code: egonCode, ...(RETRYABLE.has(errno) ? { retryable: true } : {}), cause: error }),
    );
  }
  if (fields.fatal === true) {
    return new DatabaseError(
      `Lost the connection to the database, or could not open one: ${error.message}.`,
      withSql({ code: "connection" as const, cause: error }),
    );
  }
  return error;
}
