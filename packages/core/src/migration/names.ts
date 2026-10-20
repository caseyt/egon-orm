/**
 * The default names of the indexes and constraints a migration creates. They are the
 * names the changeset constraint functions look for by default, so that a migration and a
 * changeset agree without either naming anything:
 *
 * | Created by | Name | Matched by |
 * |---|---|---|
 * | `createIndex(t, cols, { unique: true })`, `.unique()` | `<table>_<columns>_key` | `uniqueConstraint(fields)` |
 * | `createIndex(t, cols)` | `<table>_<columns>_index` | (not a constraint) |
 * | `references(col, …)` | `<table>_<column>_fkey` | `foreignKeyConstraint`, `assocConstraint`, `noAssocConstraint` |
 * | `enumText(col, …)` | `<table>_<column>_check` | `checkConstraint(field, { name })` |
 *
 * A name longer than the database keeps is shortened the way Postgres shortens the names
 * it makes itself (see `shortenedName`), which is also what the repo matches a shortened
 * name against.
 *
 * @module
 */
import { shortenedName } from "../repo/constraints.js";

const encoder = new TextEncoder();

/**
 * `<table>_<columns>_<label>`, shortened to `maxBytes` when it is longer.
 *
 * @example
 * ```ts
 * defaultName("users", ["email"], "key", 63); // "users_email_key"
 * ```
 */
export function defaultName(
  table: string,
  columns: readonly string[],
  label: string,
  maxBytes: number | undefined,
): string {
  const middle = columns.join("_");
  const name = `${table}_${middle}_${label}`;
  if (maxBytes === undefined || encoder.encode(name).length <= maxBytes) return name;
  return shortenedName(table, middle, label, maxBytes);
}
