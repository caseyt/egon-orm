/**
 * Turns `pg` errors into Egon errors: SQLSTATE codes into `ConstraintError` and
 * `DatabaseError` codes, network failures into `DatabaseError` with the code
 * `"connection"`. The driver's error is always kept as `cause`.
 *
 * @module
 */
import type { ConstraintViolationType, DatabaseErrorCode } from "egon-orm";
import { ConstraintError, DatabaseError, isEgonError } from "egon-orm";

/** Integrity-constraint SQLSTATEs, by the kind of violation they report. */
const CONSTRAINT_STATES: ReadonlyMap<string, ConstraintViolationType> = new Map<
  string,
  ConstraintViolationType
>([
  ["23505", "unique"],
  ["23503", "foreignKey"],
  ["23514", "check"],
  ["23P01", "exclusion"],
  ["23502", "notNull"],
]);

/** SQLSTATEs with a code of their own, besides whole classes. */
const DATABASE_STATES: ReadonlyMap<string, DatabaseErrorCode> = new Map<string, DatabaseErrorCode>([
  ["40001", "serializationFailure"],
  ["40P01", "deadlock"],
  // query_canceled: a statement_timeout (statementTimeoutMs), or a cancel sent by another session.
  ["57014", "timeout"],
  ["57P01", "connection"], // admin_shutdown, also pg_terminate_backend
  ["57P02", "connection"], // crash_shutdown
  ["57P03", "connection"], // cannot_connect_now
  ["53300", "connection"], // too_many_connections
]);

/**
 * The SQLSTATE classes whose messages name only SQL objects, never values: their message
 * is repeated in ours. Other classes (data exceptions above all) may quote a value, so for
 * them the message says where to look instead (`error.cause`).
 */
const SAFE_MESSAGE_CLASSES: ReadonlySet<string> = new Set([
  "0A", // feature not supported
  "25", // invalid transaction state
  "34", // invalid cursor name
  "3B", // savepoint exception
  "3D", // invalid catalog name
  "3F", // invalid schema name
  "40", // transaction rollback
  "42", // syntax error or access rule violation
  "53", // insufficient resources
  "55", // object not in prerequisite state
  "57", // operator intervention
]);

/** Node.js error codes that mean the database could not be reached or the socket failed. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
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
]);

/** Messages of errors `pg` and `pg-pool` raise themselves when a connection fails or is gone. */
const CONNECTION_MESSAGES: readonly RegExp[] = [
  /^Connection terminated/,
  /^timeout exceeded when trying to connect$/,
  /^Client has encountered a connection error and is not queryable$/,
  /^Client was closed and is not queryable$/,
  /^Cannot use a pool after calling end on the pool$/,
  /^The server does not support SSL connections$/,
];

interface PgErrorFields {
  readonly code?: unknown;
  readonly severity?: unknown;
  readonly constraint?: unknown;
  readonly table?: unknown;
  readonly column?: unknown;
  readonly detail?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function withSql<T extends object>(details: T, sql: string | undefined): T & { readonly sql?: string } {
  return sql === undefined ? details : { ...details, sql };
}

/**
 * Maps an error thrown by `pg` to an Egon error, keeping it as `cause` and attaching the
 * statement's `sql` when it is known (never the parameter values):
 *
 * - `23505`, `23503`, `23514`, `23P01`, `23502` become `ConstraintError` with the
 *   constraint, table, column and detail Postgres reports;
 * - `40001` and `40P01` become `DatabaseError` with the code `"serializationFailure"` or
 *   `"deadlock"` (`retryable: true`); `57014` becomes `"timeout"`;
 * - SQLSTATE class `08`, class `28`, `57P01`–`57P03`, `53300`, network errors and the
 *   driver's own connection errors become `"connection"`;
 * - any other database error becomes `DatabaseError` with the code `"database"`.
 *
 * Anything else (an Egon error, an error of the application) is returned unchanged.
 *
 * @example
 * ```ts
 * try {
 *   await pool.query("insert into users (email) values ($1)", [email]);
 * } catch (error) {
 *   throw normalizePgError(error, "insert into users (email) values ($1)");
 * }
 * ```
 */
export function normalizePgError(error: unknown, sql: string | undefined): unknown {
  if (!(error instanceof Error) || isEgonError(error)) return error;
  const fields = error as Error & PgErrorFields;
  const code = typeof fields.code === "string" ? fields.code : undefined;

  if (code !== undefined && NETWORK_CODES.has(code)) {
    return new DatabaseError(
      "database.unreachable",
      `Could not reach the database, or lost the connection to it (${code}).`,
      withSql({ code: "connection" as const, cause: error }, sql),
    );
  }

  // A server error: pg's DatabaseError carries the SQLSTATE in `code` and a `severity`.
  if (code !== undefined && /^[0-9A-Z]{5}$/.test(code) && typeof fields.severity === "string") {
    const violation = CONSTRAINT_STATES.get(code);
    if (violation !== undefined) {
      return new ConstraintError(
        withSql(
          {
            type: violation,
            constraint: text(fields.constraint),
            table: text(fields.table),
            column: text(fields.column),
            detail: text(fields.detail),
            cause: error,
          },
          sql,
        ),
      );
    }
    const klass = code.slice(0, 2);
    const special = DATABASE_STATES.get(code);
    const egonCode: DatabaseErrorCode =
      special ?? (klass === "08" || klass === "28" ? "connection" : "database");
    const said = SAFE_MESSAGE_CLASSES.has(klass)
      ? `: ${error.message}`
      : ". The database's message is on error.cause; it is left out here because it may quote a value";
    return new DatabaseError(
      "database.rejected",
      `The database rejected the statement (SQLSTATE ${code})${said}.`,
      withSql({ code: egonCode, cause: error }, sql),
    );
  }

  if (CONNECTION_MESSAGES.some((pattern) => pattern.test(error.message))) {
    return new DatabaseError(
      "database.connectionFailed",
      `Lost the connection to the database, or could not open one: ${error.message}.`,
      withSql({ code: "connection" as const, cause: error }, sql),
    );
  }
  return error;
}
