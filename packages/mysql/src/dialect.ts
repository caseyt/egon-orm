/**
 * What MySQL can do, and how it quotes an identifier.
 *
 * @module
 */
import type { Capabilities } from "egon-orm";

/**
 * The capabilities of MySQL 8.0.31 and later (8.4 is tested). The gaps the compiler
 * refuses with `QueryError`: `RETURNING` (the repo reads a written row back), a conflict
 * target for upserts, full joins, `DISTINCT ON`, arrays, `NULLS FIRST / LAST`,
 * `MATERIALIZED` on a CTE and `FILTER` on an aggregate.
 *
 * @example
 * ```ts
 * MYSQL_CAPABILITIES.returning; // false
 * MYSQL_CAPABILITIES.ddlTransactions; // false: DDL commits implicitly
 * ```
 */
export const MYSQL_CAPABILITIES: Capabilities = Object.freeze({
  returning: false,
  onConflict: true,
  // ON DUPLICATE KEY UPDATE applies to any unique index; none can be named.
  conflictTarget: false,
  // `ilike` is written as LIKE, which the column's collation decides (case-insensitive by default).
  ilike: false,
  lateralJoin: true,
  fullJoin: false,
  distinctOn: false,
  arrays: false,
  arrayParams: false,
  jsonb: false,
  nullsOrder: false,
  updateJoin: true,
  cteMaterialized: false,
  insertDefaultValues: true,
  defaultInValues: true,
  aggregateFilter: false,
  cancel: true,
  readOnlyTransactions: true,
  deferrableTransactions: false,
  multipleConnections: true,
  // InnoDB resolves conflicts with row locks: a lock wait, or a deadlock.
  serializationFailures: false,
  nonFiniteFloats: false,
  // A decimal column has a fixed scale: 1.0 is read back as 1.00 from a decimal(10, 2).
  exactDecimals: false,
  explainOptions: true,
  // LIMIT and OFFSET take a value or a placeholder only.
  limitExpressions: false,
  foreignKeyNames: true,
  conflictConstraint: false,
  // MySQL refuses an identifier longer than 64 characters.
  longIdentifiers: false,
  lockModes: Object.freeze(
    ["FOR UPDATE", "FOR SHARE"].flatMap((mode) => [mode, `${mode} SKIP LOCKED`, `${mode} NOWAIT`]),
  ),
  isolationLevels: Object.freeze(["read committed", "repeatable read", "serializable"] as const),
  savepoints: true,
  // A DDL statement commits the transaction it runs in.
  ddlTransactions: false,
  stream: true,
  // The protocol counts the parameters of a prepared statement in 16 bits.
  maxParams: 65_535,
});

/**
 * Quotes an identifier for MySQL: wraps it in backticks and doubles every backtick inside
 * it, so that any string is one identifier and never more SQL.
 *
 * @example
 * ```ts
 * quoteIdentifier("my `table`"); // "`my ``table```"
 * ```
 */
export function quoteIdentifier(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}
