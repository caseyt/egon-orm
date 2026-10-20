/**
 * What SQLite can do, and how it quotes an identifier.
 *
 * @module
 */
import type { Capabilities } from "egon-orm";

/**
 * The capabilities of SQLite (3.39 and later, as bundled by `better-sqlite3`). Row locks
 * are accepted and ignored (`lockModes` is empty and the compiler writes nothing for them):
 * there is one connection, and SQLite has one writer at a time.
 *
 * @example
 * ```ts
 * SQLITE_CAPABILITIES.returning; // true
 * SQLITE_CAPABILITIES.isolationLevels; // []
 * ```
 */
export const SQLITE_CAPABILITIES: Capabilities = Object.freeze({
  returning: true,
  onConflict: true,
  conflictTarget: true,
  // `ilike` is written as LIKE, which SQLite compares case-insensitively for ASCII letters.
  ilike: false,
  lateralJoin: false,
  fullJoin: true,
  distinctOn: false,
  arrays: false,
  arrayParams: false,
  jsonb: false,
  nullsOrder: true,
  // SQLite has UPDATE … FROM (3.33) but no DELETE … USING; neither is offered.
  updateJoin: false,
  cteMaterialized: true,
  // SQLite has no CTE that writes.
  writingCtes: false,
  // SQLite has UNION ALL only.
  intersectExceptAll: false,
  insertDefaultValues: true,
  defaultInValues: false,
  aggregateFilter: true,
  // The driver runs a statement synchronously: nothing can stop it once it has started.
  cancel: false,
  readOnlyTransactions: false,
  deferrableTransactions: false,
  // One handle, used by one caller at a time.
  multipleConnections: false,
  serializationFailures: false,
  nonFiniteFloats: false,
  exactDecimals: false,
  explainOptions: false,
  limitExpressions: true,
  // A foreign-key violation names neither the constraint nor the table.
  foreignKeyNames: false,
  conflictConstraint: false,
  longIdentifiers: true,
  lockModes: Object.freeze([]),
  isolationLevels: Object.freeze([]),
  savepoints: true,
  ddlTransactions: true,
  stream: true,
  // SQLITE_MAX_VARIABLE_NUMBER of the SQLite that better-sqlite3 builds.
  maxParams: 32_766,
});

/**
 * Quotes an identifier for SQLite: wraps it in double quotes and doubles every double
 * quote inside it, so that any string is one identifier and never more SQL.
 *
 * @example
 * ```ts
 * quoteIdentifier('my "table"'); // '"my ""table"""'
 * ```
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
