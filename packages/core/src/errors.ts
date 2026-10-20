/**
 * Every error Egon throws. Each class has a stable `code`, so callers can branch on
 * `error.code` (or use {@link isEgonError}) without depending on `instanceof`, which
 * fails when two copies of the package are loaded.
 *
 * Messages say what happened, what was expected and how to fix it. They never contain
 * the value of a parameter or of a redacted field.
 *
 * @module
 */
import type { ChangesetLike } from "./contracts/changeset.js";

/**
 * The stable codes of the error classes. {@link DatabaseError} has several, one per kind
 * of failure.
 *
 * @example
 * ```ts
 * const code: ErrorCode = "staleEntry";
 * ```
 */
export type ErrorCode =
  | "noResults"
  | "multipleResults"
  | "invalidChangeset"
  | "staleEntry"
  | "constraint"
  | "query"
  | "cast"
  | "notLoaded"
  | "rollback"
  | DatabaseErrorCode
  | "schemaDefinition"
  | "migration";

/**
 * The codes of a {@link DatabaseError}.
 *
 * - `"database"`: a driver error with no more specific code.
 * - `"connection"`: the database could not be reached, or the connection was lost.
 * - `"serializationFailure"`, `"deadlock"`: the transaction lost a conflict; retrying it is safe.
 * - `"aborted"`: the caller's `AbortSignal` fired.
 * - `"timeout"`: the statement ran longer than its `timeoutMs`.
 *
 * @example
 * ```ts
 * const code: DatabaseErrorCode = "deadlock";
 * ```
 */
export type DatabaseErrorCode =
  | "database"
  | "connection"
  | "serializationFailure"
  | "deadlock"
  | "aborted"
  | "timeout";

/** Marks an error as Egon's across copies of the package (`Symbol.for` is process-wide). */
const BRAND: unique symbol = Symbol.for("egon.error");

/**
 * The base class of every error Egon throws.
 *
 * @example
 * ```ts
 * try {
 *   await work();
 * } catch (error) {
 *   if (error instanceof EgonError) console.error(error.code, error.message);
 *   else throw error;
 * }
 * ```
 */
export abstract class EgonError extends Error {
  /** A stable, machine-readable identifier. It never changes between releases. */
  abstract readonly code: ErrorCode;
  readonly [BRAND] = true;

  /**
   * @param message What happened, what was expected, and how to fix it.
   * @param cause The underlying error, kept as `error.cause`.
   */
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/**
 * Whether `value` is an error thrown by Egon, optionally with a given code. Unlike
 * `instanceof`, it also recognises errors created by another copy of the package (for
 * example two versions installed side by side in one dependency tree).
 *
 * @example
 * ```ts
 * try {
 *   await repo.getOrThrow(User, id);
 * } catch (error) {
 *   if (isEgonError(error, "noResults")) return notFound();
 *   throw error;
 * }
 * ```
 */
export function isEgonError(value: unknown, code?: ErrorCode): value is EgonError {
  if (typeof value !== "object" || value === null || (value as { [BRAND]?: unknown })[BRAND] !== true) {
    return false;
  }
  return code === undefined || (value as EgonError).code === code;
}

/** Appends "in query: …" when the query's text is known. */
function inQuery(query: string | undefined): string {
  return query === undefined ? "" : ` in query: ${query}`;
}

/**
 * A query that had to return a row returned none (`oneOrThrow`, `getOrThrow`, …).
 *
 * @example
 * ```ts
 * throw new NoResultsError({ query: 'from(User, "u").where(u.id = $1)' });
 * ```
 */
export class NoResultsError extends EgonError {
  override readonly name = "NoResultsError" as const;
  readonly code = "noResults" as const;
  /** A rendering of the query, without parameter values. */
  readonly query: string | undefined;

  constructor(details: { readonly query?: string; readonly cause?: unknown } = {}) {
    super(
      `Expected at least one result but got none${inQuery(details.query)}. Use the variant without "OrThrow" (it returns null) if a missing row is not an error.`,
      details.cause,
    );
    this.query = details.query;
  }
}

/**
 * A query that may return at most one row returned more (`one`, `getBy`, …).
 *
 * @example
 * ```ts
 * throw new MultipleResultsError({ count: 3, query: 'from(User, "u")' });
 * ```
 */
export class MultipleResultsError extends EgonError {
  override readonly name = "MultipleResultsError" as const;
  readonly code = "multipleResults" as const;
  /** How many rows came back. */
  readonly count: number;
  /** A rendering of the query, without parameter values. */
  readonly query: string | undefined;

  constructor(details: { readonly count: number; readonly query?: string; readonly cause?: unknown }) {
    super(
      `Expected at most one result but got ${details.count}${inQuery(details.query)}. Narrow the query until it matches a single row, add limit(1), or use all().`,
      details.cause,
    );
    this.count = details.count;
    this.query = details.query;
  }
}

/** Fills the `{key}` placeholders of a changeset error message from its metadata. */
function interpolate(message: string, meta: Readonly<Record<string, unknown>>): string {
  return message.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(meta, key) ? String(meta[key]) : placeholder,
  );
}

/**
 * An `…OrThrow` write was given an invalid changeset. The changeset, with its errors, is
 * on the error.
 *
 * The message lists the errors by field. It contains no field values.
 *
 * @example
 * ```ts
 * try {
 *   await repo.insertOrThrow(User.changeset(User, params));
 * } catch (error) {
 *   if (error instanceof InvalidChangesetError) return render(error.changeset.errors);
 *   throw error;
 * }
 * ```
 */
export class InvalidChangesetError<C extends ChangesetLike = ChangesetLike> extends EgonError {
  override readonly name = "InvalidChangesetError" as const;
  readonly code = "invalidChangeset" as const;
  /** What was being attempted: `"insert"`, `"update"`, … */
  readonly action: string;
  readonly changeset: C;

  constructor(details: { readonly action: string; readonly changeset: C; readonly cause?: unknown }) {
    const lines: string[] = [];
    for (const [field, errors] of Object.entries(details.changeset.errors)) {
      for (const error of errors) lines.push(`  ${field}: ${interpolate(error.message, error.meta)}`);
    }
    const listing =
      lines.length === 0 ? "  (the changeset is marked invalid but lists no errors)" : lines.join("\n");
    super(
      `Could not perform ${details.action} because the changeset is invalid.\n\nErrors:\n${listing}\n\nFix the input, or call the variant without "OrThrow" to get the changeset back as a Result instead of an exception.`,
      details.cause,
    );
    this.action = details.action;
    this.changeset = details.changeset;
  }
}

/**
 * An update or delete matched no row: the row was deleted, or changed since it was read
 * (optimistic locking).
 *
 * @example
 * ```ts
 * throw new StaleEntryError({ action: "update", schema: "User" });
 * ```
 */
export class StaleEntryError extends EgonError {
  override readonly name = "StaleEntryError" as const;
  readonly code = "staleEntry" as const;
  readonly action: string;
  /** The schema's name. */
  readonly schema: string;

  constructor(details: { readonly action: string; readonly schema: string; readonly cause?: unknown }) {
    super(
      `Attempted to ${details.action} a stale ${details.schema} row: no row matched its primary key${
        details.action === "update" ? " and lock version" : ""
      }. It was deleted or changed since it was loaded. Reload it and try again, or pass allowStale: true to ignore this.`,
      details.cause,
    );
    this.action = details.action;
    this.schema = details.schema;
  }
}

/**
 * The kinds of constraint violation a database reports.
 *
 * @example
 * ```ts
 * const type: ConstraintViolationType = "foreignKey";
 * ```
 */
export type ConstraintViolationType = "unique" | "foreignKey" | "check" | "exclusion" | "notNull";

/** The changeset method that turns each kind of violation into a changeset error. */
const CONSTRAINT_HELP: Record<ConstraintViolationType, string> = {
  unique: "uniqueConstraint",
  foreignKey: "foreignKeyConstraint (or noAssocConstraint on the referenced side)",
  check: "checkConstraint",
  exclusion: "exclusionConstraint",
  notNull: "validateRequired",
};

/**
 * The database rejected a write because of a constraint that the changeset did not
 * declare. Declared constraints become changeset errors instead (step 13).
 *
 * @example
 * ```ts
 * throw new ConstraintError({
 *   type: "unique",
 *   constraint: "users_email_key",
 *   table: "users",
 *   column: undefined,
 *   detail: undefined,
 *   cause: driverError,
 * });
 * ```
 */
export class ConstraintError extends EgonError {
  override readonly name = "ConstraintError" as const;
  readonly code = "constraint" as const;
  readonly type: ConstraintViolationType;
  /** The constraint's name, when the database reports it. */
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
  /** The database's own detail line. It may quote row values, so it is not part of `message`. */
  readonly detail: string | undefined;
  /** The statement that failed, when the adapter knows it. Parameter values are never attached. */
  readonly sql: string | undefined;

  constructor(details: {
    readonly type: ConstraintViolationType;
    readonly constraint: string | undefined;
    readonly table: string | undefined;
    readonly column: string | undefined;
    readonly detail: string | undefined;
    /** Replaces the default message (step 13 names the exact call to add). */
    readonly message?: string;
    readonly sql?: string;
    readonly cause?: unknown;
  }) {
    const what =
      details.type === "notNull" ? "not-null" : details.type === "foreignKey" ? "foreign-key" : details.type;
    const name = details.constraint === undefined ? "" : ` "${details.constraint}"`;
    const where =
      details.table === undefined
        ? ""
        : ` on table "${details.table}"${details.column === undefined ? "" : `, column "${details.column}"`}`;
    super(
      details.message ??
        `The database rejected the write: ${what} constraint${name}${where} was violated. To report this as a changeset error instead of an exception, call ${CONSTRAINT_HELP[details.type]} on the changeset before the write.`,
      details.cause,
    );
    this.type = details.type;
    this.constraint = details.constraint;
    this.table = details.table;
    this.column = details.column;
    this.detail = details.detail;
    this.sql = details.sql;
  }
}

/**
 * A query is wrong: it was built incorrectly, uses a feature the dialect lacks, or was
 * executed with the wrong parameters. Detected when the query is built or compiled,
 * before anything is sent to the database.
 *
 * @example
 * ```ts
 * throw new QueryError('FULL JOIN is not supported by sqlite. Use a LEFT JOIN, or UNION two LEFT JOINs.');
 * ```
 */
export class QueryError extends EgonError {
  override readonly name = "QueryError" as const;
  readonly code = "query" as const;
}

/**
 * A value could not be converted to the type it was supposed to have, outside a
 * changeset (inside one, a failed cast is a changeset error, not an exception).
 *
 * @example
 * ```ts
 * throw new CastError('Cannot cast params of type "string" to a changeset: expected a plain object.');
 * ```
 */
export class CastError extends EgonError {
  override readonly name = "CastError" as const;
  readonly code = "cast" as const;
}

/**
 * An association was needed but had not been preloaded.
 *
 * @example
 * ```ts
 * throw new NotLoadedError({ schema: "User", association: "posts" });
 * ```
 */
export class NotLoadedError extends EgonError {
  override readonly name = "NotLoadedError" as const;
  readonly code = "notLoaded" as const;
  /** The owner schema's name. */
  readonly schema: string;
  readonly association: string;

  constructor(details: { readonly schema: string; readonly association: string; readonly cause?: unknown }) {
    super(
      `Association "${details.association}" of ${details.schema} is not loaded. Preload it first: add .preload("${details.association}") to the query, or call repo.preload(rows, "${details.association}").`,
      details.cause,
    );
    this.schema = details.schema;
    this.association = details.association;
  }
}

/**
 * The database or its driver failed. The driver's error is kept as `cause`.
 *
 * `sql` is the statement that failed; parameter values are never attached.
 *
 * @example
 * ```ts
 * try {
 *   await pool.query(sql, params);
 * } catch (cause) {
 *   throw new DatabaseError("Lost the connection to the database while running a statement.", {
 *     code: "connection",
 *     sql,
 *     cause,
 *   });
 * }
 * ```
 */
export class DatabaseError extends EgonError {
  override readonly name = "DatabaseError" as const;
  readonly code: DatabaseErrorCode;
  /** Whether running the same transaction again can succeed. */
  readonly retryable: boolean;
  readonly sql: string | undefined;

  constructor(
    message: string,
    details: {
      readonly code?: DatabaseErrorCode;
      /** Defaults to true for `"serializationFailure"` and `"deadlock"`, false otherwise. */
      readonly retryable?: boolean;
      readonly sql?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, details.cause);
    this.code = details.code ?? "database";
    this.retryable = details.retryable ?? (this.code === "serializationFailure" || this.code === "deadlock");
    this.sql = details.sql;
  }
}

/**
 * A transaction was rolled back where its caller expected a value: `transactionOrThrow`
 * throws it instead of returning `{ success: false, error: reason }`. `reason` is what
 * `repo.transaction` would have returned as `error`: the value given to
 * `tx.rollback(reason)`, a batch's `{ step, error, completed }`, or the error of a
 * statement that failed inside the transaction and was not handled.
 *
 * @example
 * ```ts
 * try {
 *   await repo.transactionOrThrow(async (tx) => {
 *     const order = await tx.insertOrThrow(change(Order, { total }));
 *     if (order.total > limit) tx.rollback("over the limit");
 *     return order;
 *   });
 * } catch (error) {
 *   if (error instanceof RollbackError) return error.reason; // "over the limit"
 *   throw error;
 * }
 * ```
 */
export class RollbackError<R = unknown> extends EgonError {
  override readonly name = "RollbackError" as const;
  readonly code = "rollback" as const;
  /** Why the transaction was rolled back. */
  readonly reason: R;

  constructor(details: { readonly reason: R; readonly message?: string; readonly cause?: unknown }) {
    super(
      details.message ??
        "The transaction was rolled back: tx.rollback(reason) was called, and the reason is error.reason. Call repo.transaction() instead of transactionOrThrow() to get the reason back as a failed Result.",
      details.cause,
    );
    this.reason = details.reason;
  }
}

/**
 * A schema is declared wrongly: no primary key, a duplicate column, an association whose
 * foreign key does not exist. Thrown when the class is defined, or the first time its
 * associations are resolved.
 *
 * @example
 * ```ts
 * throw new SchemaDefinitionError(
 *   'Post.author: belongsTo expects the foreign key field "authorId" on Post, but Post has no such field. Declare it (authorId: t.integer()) or pass { foreignKey }.',
 * );
 * ```
 */
export class SchemaDefinitionError extends EgonError {
  override readonly name = "SchemaDefinitionError" as const;
  readonly code = "schemaDefinition" as const;
}

/**
 * A migration could not be defined, reversed or run: an operation the database lacks, a
 * `change` that cannot be rolled back, a recorded version whose file is missing, the
 * migration lock, or a statement that failed (the driver's error is kept as `cause`).
 *
 * `version` and `migration` name the migration when the error belongs to one; `sql` is
 * the statement that failed, without parameter values.
 *
 * @example
 * ```ts
 * throw new MigrationError(
 *   'remove("age") cannot be reversed without its type. Write remove("age", "integer"), or give the migration a down().',
 *   { version: 20261012093000, migration: "drop_age" },
 * );
 * ```
 */
export class MigrationError extends EgonError {
  override readonly name = "MigrationError" as const;
  readonly code = "migration" as const;
  /** The version of the migration the error belongs to, when there is one. */
  readonly version: number | undefined;
  /** The name of that migration: its file name without the version and the extension. */
  readonly migration: string | undefined;
  /** The statement that failed, when a statement failed. Parameter values are never attached. */
  readonly sql: string | undefined;

  constructor(
    message: string,
    details: {
      readonly version?: number;
      readonly migration?: string;
      readonly sql?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, details.cause);
    this.version = details.version;
    this.migration = details.migration;
    this.sql = details.sql;
  }
}
