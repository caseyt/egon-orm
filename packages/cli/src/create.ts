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
 * The longest migration name, in characters. With the version and `.ts` the file name stays
 * far below the 255 bytes file systems allow.
 *
 * @example
 * ```ts
 * "create_users".length <= MAX_NAME_LENGTH; // true
 * ```
 */
export const MAX_NAME_LENGTH = 100;

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
 * The source of a new, empty migration file: an `up` and a `down` to fill in.
 *
 * @example
 * ```ts
 * const source = migrationTemplate();
 * ```
 */
export function migrationTemplate(): string {
  return `import { defineMigration } from "egon-orm/migration";

export default defineMigration({
  up(m) {
    // the change
  },
  down(m) {
    // undo it, or leave a // noop comment
  },
});
`;
}
