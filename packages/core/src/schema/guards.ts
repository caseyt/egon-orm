/**
 * Runtime checks for "is this a schema class?" and "is this a row?".
 *
 * @module
 */
import type { AnySchema, RowMeta, RowState } from "../contracts/schema.js";
import { META, ROW } from "../contracts/schema.js";
import { SchemaDefinitionError } from "../errors.js";

/**
 * Whether `value` is a schema class: a class that extends `Schema(...)` or
 * `EmbeddedSchema(...)`, or the class those functions return.
 *
 * @example
 * ```ts
 * isSchema(User); // true
 * isSchema(user); // false: a row, not a class
 * isSchema(() => User); // false
 * ```
 */
export function isSchema(value: unknown): value is AnySchema {
  if (typeof value !== "function") return false;
  const meta = (value as { readonly [META]?: unknown })[META];
  return typeof meta === "object" && meta !== null;
}

/**
 * Whether `value` is a row: an object that a query or a write returned.
 *
 * @example
 * ```ts
 * const user = await repo.getOrThrow(User, 1);
 * isRow(user); // true
 * isRow({ id: 1 }); // false
 * ```
 */
export function isRow(value: unknown): value is { readonly [ROW]: RowMeta } {
  return (
    typeof value === "object" && value !== null && (value as { readonly [ROW]?: unknown })[ROW] !== undefined
  );
}

/**
 * Where a row stands relative to the database: `"loaded"` once it was read or written,
 * `"deleted"` after `repo.delete`.
 *
 * @example
 * ```ts
 * const user = await repo.getOrThrow(User, 1);
 * stateOf(user); // "loaded"
 * await repo.deleteOrThrow(user);
 * ```
 *
 * @throws SchemaDefinitionError when `row` is not a row.
 */
export function stateOf(row: object): RowState {
  if (!isRow(row)) {
    throw new SchemaDefinitionError(
      "schema.stateNotRow",
      "stateOf() expects a row: an object returned by a query or a write.",
    );
  }
  return row[ROW].state;
}

/**
 * Whether `name` is a member of `prototype` or of a prototype it inherits from, short of
 * `Object.prototype`: a getter, a method or a value that a row's own property of that
 * name would collide with.
 */
export function definedOnPrototype(prototype: unknown, name: string): boolean {
  for (
    let current = prototype;
    typeof current === "object" && current !== null && current !== Object.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    if (Object.hasOwn(current, name)) return true;
  }
  return false;
}

/** A short description of a value for an error message. It never includes the value itself. */
export function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (value === "") return "an empty string";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "function") return value.name === "" ? "a function" : `the function ${value.name}`;
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}
