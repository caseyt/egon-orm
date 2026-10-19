/**
 * What Postgres can do, and how it quotes an identifier.
 *
 * @module
 */
import type { Capabilities } from "egon-orm";

/**
 * The capabilities of Postgres (14 and later): everything.
 *
 * @example
 * ```ts
 * POSTGRES_CAPABILITIES.returning; // true
 * ```
 */
export const POSTGRES_CAPABILITIES: Capabilities = Object.freeze({
  returning: true,
  onConflict: true,
  conflictTarget: true,
  ilike: true,
  lateralJoin: true,
  fullJoin: true,
  distinctOn: true,
  arrays: true,
  arrayParams: true,
  jsonb: true,
  nullsOrder: true,
  updateJoin: true,
  cteMaterialized: true,
  insertDefaultValues: true,
  // Every clause lock() writes: the four modes, each alone or with SKIP LOCKED or NOWAIT.
  lockModes: Object.freeze(
    ["FOR UPDATE", "FOR NO KEY UPDATE", "FOR SHARE", "FOR KEY SHARE"].flatMap((mode) => [
      mode,
      `${mode} SKIP LOCKED`,
      `${mode} NOWAIT`,
    ]),
  ),
  isolationLevels: Object.freeze(["read committed", "repeatable read", "serializable"] as const),
  savepoints: true,
  ddlTransactions: true,
  stream: true,
  // The protocol counts the parameters of a statement in a 16-bit field.
  maxParams: 65_535,
});

/**
 * Quotes an identifier for Postgres: wraps it in double quotes and doubles every double
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
