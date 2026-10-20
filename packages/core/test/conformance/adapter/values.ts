// The values the conformance suite sends through an adapter and reads back, per type:
// limits, nulls, unicode, every byte, dates at daylight-saving changes and in years 1
// and 9999, arrays. The suite compares with each type's own `equal`.
import type { AnyFieldType } from "egon-orm";
import {
  arrayType,
  bigintType,
  binaryType,
  booleanType,
  dateType,
  decimalType,
  floatType,
  integerType,
  jsonType,
  localTimestampType,
  stringType,
  timestampType,
  timeType,
  uuidType,
} from "../../../src/types/index.js";

export interface RoundTripCase {
  readonly label: string;
  readonly type: AnyFieldType;
  /** Application values; `null` is sent as SQL `NULL`. */
  readonly values: readonly unknown[];
  /** The capability the case needs; it is skipped where that capability is false. */
  readonly requires?: "nonFiniteFloats";
}

const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);

/** Instants around the 2026 daylight-saving changes in Europe (29 March, 01:00 UTC) and the US (1 November, 06:00 UTC in New York). */
const instants = [
  new Date("2026-03-29T00:59:59.999Z"),
  new Date("2026-03-29T01:00:00.000Z"),
  new Date("2026-10-25T00:59:59.999Z"),
  new Date("2026-11-01T05:59:59.999Z"),
  new Date("2026-11-01T06:00:00.000Z"),
  new Date("1970-01-01T00:00:00.000Z"),
  new Date("0001-01-01T00:00:00.000Z"),
  new Date("9999-12-31T23:59:59.999Z"),
];

const AnyType = (type: unknown): AnyFieldType => type as AnyFieldType;

export const ROUND_TRIP_CASES: readonly RoundTripCase[] = [
  { label: "integer", type: AnyType(integerType()), values: [0, 1, -1, 2_147_483_647, -2_147_483_648, null] },
  {
    label: "bigint",
    type: AnyType(bigintType()),
    values: [0n, 1n, 9_007_199_254_740_993n, 9_223_372_036_854_775_807n, -9_223_372_036_854_775_808n, null],
  },
  {
    label: "bigint as number",
    type: AnyType(bigintType({ mode: "number" })),
    values: [0, 42, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, null],
  },
  {
    label: "float",
    type: AnyType(floatType()),
    values: [0, 1.5, -2.25, 0.1, 1e308, 5e-324, null],
  },
  {
    label: "float (NaN and infinities)",
    type: AnyType(floatType()),
    values: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null],
    requires: "nonFiniteFloats",
  },
  {
    label: "decimal",
    type: AnyType(decimalType()),
    values: [
      "0",
      "1.50",
      "-123456789012345678901234567890.123456789",
      "0.000000000000000000000000000001",
      null,
    ],
  },
  { label: "boolean", type: AnyType(booleanType()), values: [true, false, null] },
  {
    label: "string",
    type: AnyType(stringType()),
    values: [
      "",
      "plain",
      "zażółć gęślą jaźń, 日本語, Ελληνικά, 🎉🧪 (and a ZWJ: 👩‍💻)",
      "quotes ' \" \\ and\nnew\tlines",
      "NULL",
      null,
    ],
  },
  { label: "uuid", type: AnyType(uuidType()), values: ["0190d8a0-1234-7abc-8def-0123456789ab", null] },
  {
    label: "binary",
    type: AnyType(binaryType()),
    values: [new Uint8Array(0), allBytes, Uint8Array.of(0), null],
  },
  {
    label: "date",
    type: AnyType(dateType()),
    values: ["0001-01-01", "9999-12-31", "2026-03-29", "2026-11-01", "2024-02-29", "1970-01-01", null],
  },
  {
    label: "date as Date",
    type: AnyType(dateType({ as: "date" })),
    values: [
      new Date("0001-01-01T00:00:00Z"),
      new Date("9999-12-31T00:00:00Z"),
      new Date("2026-03-29T00:00:00Z"),
      null,
    ],
  },
  { label: "time", type: AnyType(timeType()), values: ["00:00:00", "12:30:00", "23:59:59.999999", null] },
  { label: "timestamp (with time zone)", type: AnyType(timestampType()), values: [...instants, null] },
  {
    label: "local timestamp (without time zone)",
    type: AnyType(localTimestampType()),
    values: [...instants, null],
  },
  {
    label: "json",
    type: AnyType(jsonType()),
    values: [
      { a: 1, b: [true, null, "x"] },
      [1, 2, 3],
      [],
      "just a string",
      42,
      false,
      { nested: { deep: { text: 'é " \\ 🎉' } } },
      null,
    ],
  },
  {
    label: "integer array",
    type: AnyType(arrayType(integerType())),
    values: [[1, 2, 3], [], [1, null, 3], null],
  },
  {
    label: "bigint array",
    type: AnyType(arrayType(bigintType())),
    values: [[9_223_372_036_854_775_807n, -1n, 0n], null],
  },
  {
    label: "bigint-as-number array",
    type: AnyType(arrayType(bigintType({ mode: "number" }))),
    values: [[Number.MAX_SAFE_INTEGER, -1], null],
  },
  {
    label: "string array",
    type: AnyType(arrayType(stringType())),
    values: [["a", "b,c", '"q"', "back\\slash", "NULL", "", " spaced ", "{braces}", "🎉"], [], null],
  },
  { label: "decimal array", type: AnyType(arrayType(decimalType())), values: [["1.5", "-2", "0.001"], null] },
  {
    label: "uuid array",
    type: AnyType(arrayType(uuidType())),
    values: [["0190d8a0-1234-7abc-8def-0123456789ab"], null],
  },
  {
    label: "binary array",
    type: AnyType(arrayType(binaryType())),
    values: [[Uint8Array.of(0, 255), allBytes], null],
  },
  { label: "date array", type: AnyType(arrayType(dateType())), values: [["0001-01-01", "9999-12-31"], null] },
  { label: "timestamp array", type: AnyType(arrayType(timestampType())), values: [instants, null] },
  {
    label: "local timestamp array",
    type: AnyType(arrayType(localTimestampType())),
    values: [instants, null],
  },
  { label: "json array", type: AnyType(arrayType(jsonType())), values: [[{ a: 1 }, [2, "x"], "s"], null] },
];
