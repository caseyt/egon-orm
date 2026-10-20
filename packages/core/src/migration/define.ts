/**
 * `defineMigration`: what a migration file exports.
 *
 * @module
 */
import type { MigrationBuilder } from "./builder.js";

/** Marks a value made by {@link defineMigration} (`Symbol.for`, so two copies of the package agree). */
const MIGRATION: unique symbol = Symbol.for("egon.migration");

/**
 * A reversible migration: `change` records operations, and the runner rolls the
 * migration back by running their inverses in reverse order.
 *
 * @example
 * ```ts
 * const definition: ReversibleMigration = {
 *   change(m) {
 *     m.renameTable("people", "users");
 *   },
 * };
 * ```
 */
export interface ReversibleMigration {
  change(m: MigrationBuilder): void | Promise<void>;
  readonly up?: never;
  readonly down?: never;
  /**
   * Runs the migration in a transaction (the default) where the database has
   * transactional DDL. `false` runs it without one, which `concurrently` index
   * operations need; a failure can then leave it half applied.
   */
  readonly transaction?: boolean;
}

/**
 * A migration written in both directions. Without `down` it cannot be rolled back.
 *
 * @example
 * ```ts
 * const definition: UpDownMigration = {
 *   up(m) {
 *     m.execute(fragment`update users set role = 'member' where role is null`);
 *   },
 *   down() {},
 * };
 * ```
 */
export interface UpDownMigration {
  readonly change?: never;
  up(m: MigrationBuilder): void | Promise<void>;
  down?(m: MigrationBuilder): void | Promise<void>;
  /** As on {@link ReversibleMigration}. */
  readonly transaction?: boolean;
}

/**
 * A migration, as {@link defineMigration} returns it.
 *
 * @example
 * ```ts
 * declare const migration: Migration;
 * const inTransaction = migration.transaction; // true unless the definition said false
 * ```
 */
export interface Migration {
  readonly [MIGRATION]: true;
  readonly change: ((m: MigrationBuilder) => void | Promise<void>) | undefined;
  readonly up: ((m: MigrationBuilder) => void | Promise<void>) | undefined;
  readonly down: ((m: MigrationBuilder) => void | Promise<void>) | undefined;
  readonly transaction: boolean;
}

const KEYS = ["change", "up", "down", "transaction"];

/**
 * Defines a migration: either `change` (reversible) or `up` with an optional `down`.
 * Export it from the migration file, as the default export or as `migration`.
 *
 * @example
 * ```ts
 * import { defineMigration } from "egon-orm/migration";
 *
 * export const migration = defineMigration({
 *   change(m) {
 *     m.createTable("users", (t) => {
 *       t.id();
 *       t.text("email").notNull();
 *       t.timestamps();
 *     });
 *     m.createIndex("users", ["email"], { unique: true });
 *   },
 * });
 * ```
 *
 * @throws TypeError when the definition is not an object with `change`, or `up` (and
 * optionally `down`), as functions.
 */
export function defineMigration(definition: ReversibleMigration | UpDownMigration): Migration {
  if (typeof definition !== "object" || definition === null) {
    throw new TypeError("defineMigration() takes an object: defineMigration({ change(m) { … } }).");
  }
  for (const key of Object.keys(definition)) {
    if (!KEYS.includes(key)) {
      throw new TypeError(
        `defineMigration(): unknown key "${key}". The keys are change, up, down and transaction.`,
      );
    }
  }
  const { change, up, down, transaction } = definition as {
    readonly change?: unknown;
    readonly up?: unknown;
    readonly down?: unknown;
    readonly transaction?: unknown;
  };
  for (const [key, value] of [
    ["change", change],
    ["up", up],
    ["down", down],
  ] as const) {
    if (value !== undefined && typeof value !== "function") {
      throw new TypeError(`defineMigration(): ${key} must be a function.`);
    }
  }
  if (change !== undefined && (up !== undefined || down !== undefined)) {
    throw new TypeError(
      "defineMigration(): give either change() (the rollback is derived from it) or up() and down(), not both.",
    );
  }
  if (change === undefined && up === undefined) {
    throw new TypeError("defineMigration(): give change(), or up() (and down() to make it reversible).");
  }
  if (transaction !== undefined && typeof transaction !== "boolean") {
    throw new TypeError("defineMigration(): transaction must be a boolean.");
  }
  type Step = (m: MigrationBuilder) => void | Promise<void>;
  return Object.freeze({
    [MIGRATION]: true as const,
    change: change as Step | undefined,
    up: up as Step | undefined,
    down: down as Step | undefined,
    transaction: transaction ?? true,
  });
}

/**
 * Whether `value` was made by {@link defineMigration}.
 *
 * @example
 * ```ts
 * isMigration(defineMigration({ up() {} })); // true
 * ```
 */
export function isMigration(value: unknown): value is Migration {
  return (
    typeof value === "object" && value !== null && (value as { [MIGRATION]?: unknown })[MIGRATION] === true
  );
}
