// The type an arithmetic result is read as when its operands have different numeric types
// (owner decision, 2026-10-20): the wider one, in the order integer < bigint < decimal <
// float. The builder types the result with it, and the compiler casts a typed value beside
// a column only between types of this order, so the database computes in that type too.
import type { AnyFieldType, DbType } from "../contracts/type.js";

/** The place of each numeric column type in the widening order; other kinds have none. */
const NUMERIC_RANK: Readonly<Record<string, number>> = /* @__PURE__ */ Object.freeze({
  integer: 0,
  bigint: 1,
  decimal: 2,
  float: 3,
});

/**
 * The place of a column type in the widening order (integer < bigint < decimal < float),
 * or `undefined` for a type outside it: a custom type, text, a date, an array.
 *
 * @example
 * ```ts
 * numericRank({ kind: "float" }); // 3
 * numericRank({ kind: "custom", sql: "money" }); // undefined
 * ```
 */
export function numericRank(db: DbType | undefined): number | undefined {
  if (typeof db !== "object" || db === null || typeof db.kind !== "string") return undefined;
  return Object.hasOwn(NUMERIC_RANK, db.kind) ? NUMERIC_RANK[db.kind] : undefined;
}

/**
 * The type an arithmetic result of operands typed `left` and `right` is read as: the wider
 * of the two when both are in the widening order, `left` otherwise (a custom type, an
 * untyped operand, or equal places keep the left operand's type, the field type itself,
 * so a `bigint({ mode: "number" })` operand keeps its mode).
 *
 * @example
 * ```ts
 * widerType(t.integer(), t.float()); // the float type
 * widerType(t.float(), t.integer()); // the float type
 * widerType(t.integer(), money); // t.integer(): a custom type has no place
 * ```
 */
export function widerType(
  left: AnyFieldType | undefined,
  right: AnyFieldType | undefined,
): AnyFieldType | undefined {
  if (left === undefined || right === undefined || left === right) return left;
  const l = numericRank(left.db);
  const r = numericRank(right.db);
  return l !== undefined && r !== undefined && r > l ? right : left;
}
