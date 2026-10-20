/**
 * Turns `better-sqlite3` errors into Egon errors: SQLite's extended result codes into
 * `ConstraintError` and `DatabaseError` codes. The driver's error is always kept as `cause`.
 *
 * @module
 */
import type { ConstraintViolationType } from "egon-orm";
import { ConstraintError, DatabaseError, isEgonError } from "egon-orm";

interface SqliteErrorFields {
  readonly code?: unknown;
}

/** Whether `error` is a `SqliteError` of `better-sqlite3` (from any copy of the package). */
function isSqliteError(error: Error): error is Error & { readonly code: string } {
  const code = (error as Error & SqliteErrorFields).code;
  return error.name === "SqliteError" && typeof code === "string" && code.startsWith("SQLITE_");
}

/** The constraint codes, by the kind of violation they report. */
const CONSTRAINT_CODES: ReadonlyMap<string, ConstraintViolationType> = new Map<
  string,
  ConstraintViolationType
>([
  ["SQLITE_CONSTRAINT_UNIQUE", "unique"],
  ["SQLITE_CONSTRAINT_PRIMARYKEY", "unique"],
  ["SQLITE_CONSTRAINT_FOREIGNKEY", "foreignKey"],
  ["SQLITE_CONSTRAINT_CHECK", "check"],
  ["SQLITE_CONSTRAINT_NOTNULL", "notNull"],
]);

/** `UNIQUE constraint failed: users.email, users.org_id` and `NOT NULL constraint failed: users.email`. */
const COLUMNS_FAILED = /constraint failed: (.+)$/;
/** One `table.column` of such a message. */
const TABLE_COLUMN = /^([^.]+)\.(.+)$/;
/** A check constraint's name; an unnamed one is reported by its expression instead. */
const NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** The table and the columns a unique or not-null message names, in order. */
function failedColumns(message: string): { table: string | undefined; columns: string[] } {
  const listed = COLUMNS_FAILED.exec(message)?.[1];
  if (listed === undefined) return { table: undefined, columns: [] };
  let table: string | undefined;
  const columns: string[] = [];
  for (const part of listed.split(", ")) {
    const match = TABLE_COLUMN.exec(part);
    if (match === null) return { table: undefined, columns: [] };
    table = match[1];
    columns.push(match[2] as string);
  }
  return { table, columns };
}

function violation(
  error: Error & { readonly code: string },
  type: ConstraintViolationType,
  sql: string | undefined,
): ConstraintError {
  let constraint: string | undefined;
  let table: string | undefined;
  let column: string | undefined;
  if (type === "unique" || type === "notNull") {
    const failed = failedColumns(error.message);
    table = failed.table;
    if (failed.columns.length === 1) column = failed.columns[0];
    // SQLite names the columns, not the index. The default constraint names of the other
    // databases are rebuilt from them: <table>_pkey, <table>_<columns>_key.
    if (type === "unique" && table !== undefined && failed.columns.length > 0) {
      constraint =
        error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ? `${table}_pkey` : `${table}_${failed.columns.join("_")}_key`;
    }
  } else if (type === "check") {
    const reported = COLUMNS_FAILED.exec(error.message)?.[1];
    if (reported !== undefined && NAME.test(reported)) constraint = reported;
  }
  // A foreign-key violation says nothing more: SQLite does not report the constraint or the table.
  const details = { type, constraint, table, column, detail: undefined, cause: error };
  return new ConstraintError(sql === undefined ? details : { ...details, sql });
}

/** Result codes whose message names only SQL objects, never values: repeated in ours. */
const SAFE_MESSAGE_CODES: ReadonlySet<string> = new Set(["SQLITE_ERROR", "SQLITE_READONLY", "SQLITE_AUTH"]);

/**
 * Maps an error thrown by `better-sqlite3` to an Egon error, keeping it as `cause` and
 * attaching the statement's `sql` when it is known (never the parameter values):
 *
 * - `SQLITE_CONSTRAINT_UNIQUE`, `_PRIMARYKEY`, `_FOREIGNKEY`, `_CHECK`, `_NOTNULL` become
 *   `ConstraintError`. SQLite reports a unique violation by its columns, not by an index
 *   name, so the constraint is the default name made of them (`users_email_key`, or
 *   `users_pkey` for the primary key); a foreign-key violation names nothing.
 * - `SQLITE_BUSY` and `SQLITE_LOCKED` (another connection holds the database) become
 *   `DatabaseError` with the code `"database"` and `retryable: true`.
 * - `SQLITE_CANTOPEN`, `SQLITE_NOTADB` and a closed database become `"connection"`.
 * - any other SQLite error becomes `DatabaseError` with the code `"database"`.
 *
 * Anything else (an Egon error, an error of the application) is returned unchanged.
 *
 * @example
 * ```ts
 * try {
 *   database.prepare("insert into users (email) values (?)").run(email);
 * } catch (error) {
 *   throw normalizeSqliteError(error, "insert into users (email) values (?)");
 * }
 * ```
 */
export function normalizeSqliteError(error: unknown, sql: string | undefined): unknown {
  if (!(error instanceof Error) || isEgonError(error)) return error;
  const withSql = <T extends object>(details: T): T & { readonly sql?: string } =>
    sql === undefined ? details : { ...details, sql };
  if (!isSqliteError(error)) {
    if (error instanceof TypeError && /database connection is not open/.test(error.message)) {
      return new DatabaseError(
        "The SQLite database is closed.",
        withSql({ code: "connection" as const, cause: error }),
      );
    }
    return error;
  }
  const code = error.code;
  const type = CONSTRAINT_CODES.get(code);
  if (type !== undefined) return violation(error, type, sql);
  if (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_") || code.startsWith("SQLITE_LOCKED")) {
    return new DatabaseError(
      `The database is locked by another connection (${code}). Retrying can succeed.`,
      withSql({ code: "database" as const, retryable: true, cause: error }),
    );
  }
  if (code.startsWith("SQLITE_CANTOPEN") || code === "SQLITE_NOTADB") {
    return new DatabaseError(
      `Could not open the SQLite database (${code}): ${error.message}.`,
      withSql({ code: "connection" as const, cause: error }),
    );
  }
  const said = SAFE_MESSAGE_CODES.has(code)
    ? `: ${error.message}`
    : ". The database's message is on error.cause; it is left out here because it may quote a value";
  return new DatabaseError(
    `The database rejected the statement (${code})${said}.`,
    withSql({ code: "database" as const, cause: error }),
  );
}
