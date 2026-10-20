/**
 * `egon migrate create`: the migration name rule, the version, and the file template.
 *
 * @module
 */

/**
 * A migration name as the file name carries it: lower-case letters, digits and underscores.
 *
 * @example
 * ```ts
 * MIGRATION_NAME.test("create_users"); // true
 * MIGRATION_NAME.test("CreateUsers"); // false
 * ```
 */
export const MIGRATION_NAME = /^[a-z0-9_]+$/;

/**
 * The version of a migration created at `now`: its UTC time as `YYYYMMDDHHMMSS`.
 *
 * @example
 * ```ts
 * versionAt(new Date("2026-10-12T09:30:00Z")); // "20261012093000"
 * ```
 */
export function versionAt(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    pad(now.getUTCFullYear(), 4) +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds())
  );
}

/**
 * The source of a new, empty migration file.
 *
 * @example
 * ```ts
 * const source = migrationTemplate();
 * ```
 */
export function migrationTemplate(): string {
  return `import { defineMigration } from "egon-orm/migration";

export default defineMigration({
  change(m) {
  },
});
`;
}
