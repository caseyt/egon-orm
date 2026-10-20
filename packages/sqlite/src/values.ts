/**
 * How SQLite values become the canonical driver values the types expect, and back.
 *
 * SQLite stores five kinds of value (null, integer, real, text, blob). The adapter reads
 * every integer as a `bigint` (`better-sqlite3`'s safe integers), so that a 64-bit integer
 * never loses a digit, and these codecs turn values into what each column kind expects:
 *
 * | Kind | Stored as | Read back as |
 * |---|---|---|
 * | `integer`, `float` | integer, real | `number` |
 * | `bigint` | integer | `bigint` |
 * | `boolean` | `0` / `1` | `boolean` |
 * | `decimal` | text | `string` |
 * | `date`, `time`, `text` | text | `string` |
 * | `uuid` | text, written in lowercase | `string` |
 * | `timestamp`, `timestamptz` | ISO 8601 text in UTC (`2026-01-02T03:04:05.678Z`) | `Date` |
 * | `json`, `jsonb` | JSON text | the parsed value |
 * | `binary` | blob | `Uint8Array` |
 * | arrays | JSON text of the elements | an array |
 *
 * @module
 */
import type { DriverCodecs } from "egon-orm";
import { CastError } from "egon-orm";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** A number column: integers arrive as `bigint`, reals as `number`. */
function readNumber(value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  if (value > MAX_SAFE || value < MIN_SAFE) {
    throw new CastError(
      "A number column received an integer from the database beyond Number.MAX_SAFE_INTEGER. Read it with t.bigint().",
    );
  }
  return Number(value);
}

/** SQLite stores NaN as NULL: a value that is not finite is refused rather than lost. */
function writeFloat(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new CastError(
      "SQLite cannot store NaN, Infinity or -Infinity in a float column without losing it.",
    );
  }
  return value;
}

/** A bigint column: an integer arrives as `bigint` already; a whole real or digit text is converted. */
function readBigint(value: unknown): unknown {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return value;
}

function readBoolean(value: unknown): unknown {
  if (value === 0n || value === 0) return false;
  if (value === 1n || value === 1) return true;
  return value;
}

const writeBoolean = (value: unknown): unknown => (value === true ? 1 : value === false ? 0 : value);

/** A decimal is kept as text; one stored in a column of numeric affinity arrives as a number. */
function readDecimal(value: unknown): unknown {
  return typeof value === "number" || typeof value === "bigint" ? String(value) : value;
}

/** Text columns: a value stored in a column of numeric affinity arrives as a number. */
function readText(value: unknown): unknown {
  return typeof value === "bigint" || typeof value === "number" ? String(value) : value;
}

const TIMESTAMP_TEXT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/i;

/**
 * Reads timestamp text: ISO 8601 with `T` or a space, with or without seconds, a fraction
 * and a zone (`Z` or `±hh:mm`). Text without a zone is UTC, as SQLite's own date
 * functions write it. Anything else is returned unchanged (the type then refuses it).
 */
export function parseTimestamp(text: string): Date | string {
  const match = TIMESTAMP_TEXT.exec(text);
  if (match === null) return text;
  const millisecond = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"));
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setUTCHours(Number(match[4] ?? "0"), Number(match[5] ?? "0"), Number(match[6] ?? "0"), millisecond);
  if (match[9] !== undefined) {
    const offset = (Number(match[10]) * 60 + Number(match[11])) * 60_000;
    date.setTime(date.getTime() - (match[9] === "-" ? -offset : offset));
  }
  return date;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Writes a `Date` as ISO 8601 text from its UTC fields, with milliseconds: with `Z` for a
 * `timestamptz`, without for a `timestamp` (whose UTC fields are the wall time). Text of
 * one form sorts as the instants do, which is what comparisons and `orderBy` rely on.
 *
 * @throws CastError for an invalid `Date`, or a year outside 0000–9999.
 */
export function formatTimestamp(value: Date, withZone: boolean): string {
  const time = value.getTime();
  if (Number.isNaN(time)) throw new CastError("An invalid Date cannot be written to a timestamp column.");
  const year = value.getUTCFullYear();
  if (year < 0 || year > 9999) {
    throw new CastError("SQLite stores timestamps as text with a four-digit year: 0000 to 9999.");
  }
  const text = `${pad(year, 4)}-${pad(value.getUTCMonth() + 1, 2)}-${pad(value.getUTCDate(), 2)}T${pad(
    value.getUTCHours(),
    2,
  )}:${pad(value.getUTCMinutes(), 2)}:${pad(value.getUTCSeconds(), 2)}.${pad(value.getUTCMilliseconds(), 3)}`;
  return withZone ? `${text}Z` : text;
}

function readTimestamp(value: unknown): unknown {
  return typeof value === "string" ? parseTimestamp(value) : value;
}

const writeTimestamp = (value: unknown): unknown =>
  value instanceof Date ? formatTimestamp(value, false) : value;
const writeTimestamptz = (value: unknown): unknown =>
  value instanceof Date ? formatTimestamp(value, true) : value;

/**
 * Inside JSON text (an array column), a `bigint` element is written as its digits and a
 * bytes element as base64; the element's own conversion reads them back.
 */
function jsonReplacer(this: unknown, key: string, item: unknown): unknown {
  if (typeof item === "bigint") return item.toString();
  // JSON.stringify calls toJSON (a Buffer's) before the replacer: look at the original.
  const original = (this as Record<string, unknown>)[key];
  if (original instanceof Uint8Array)
    return Buffer.from(original.buffer, original.byteOffset, original.byteLength).toString("base64");
  return item;
}

function writeJson(value: unknown): unknown {
  return JSON.stringify(value, jsonReplacer);
}

function readJson(value: unknown): unknown {
  if (typeof value !== "string") return typeof value === "bigint" ? readNumber(value) : value;
  try {
    return JSON.parse(value);
  } catch {
    throw new CastError("A JSON column received text from the database that is not valid JSON.");
  }
}

function readBytes(value: unknown): unknown {
  // A Buffer is a Uint8Array subclass; the types want the plain class, over the same memory.
  if (value instanceof Uint8Array && Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  // An element of a bytes array, read from the array's JSON text.
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "base64");
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return value;
}

/** better-sqlite3 binds a `Buffer`; a plain `Uint8Array` is wrapped over the same memory. */
function writeBytes(value: unknown): unknown {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

/**
 * A uuid is written in lowercase, as Postgres stores one: two spellings of one uuid are
 * one key, and a key read back compares equal to the one given in either case.
 */
const writeUuid = (value: unknown): unknown => (typeof value === "string" ? value.toLowerCase() : value);

/** Where SQLite's values (read with safe integers) differ from the canonical driver values. */
export const SQLITE_DRIVER_CODECS: DriverCodecs = Object.freeze({
  integer: Object.freeze({ fromDb: readNumber }),
  float: Object.freeze({ fromDb: readNumber, toDb: writeFloat }),
  bigint: Object.freeze({ fromDb: readBigint }),
  decimal: Object.freeze({ fromDb: readDecimal }),
  boolean: Object.freeze({ fromDb: readBoolean, toDb: writeBoolean }),
  text: Object.freeze({ fromDb: readText }),
  uuid: Object.freeze({ fromDb: readText, toDb: writeUuid }),
  binary: Object.freeze({ fromDb: readBytes, toDb: writeBytes }),
  timestamp: Object.freeze({ fromDb: readTimestamp, toDb: writeTimestamp }),
  timestamptz: Object.freeze({ fromDb: readTimestamp, toDb: writeTimestamptz }),
  json: Object.freeze({ fromDb: readJson, toDb: writeJson }),
  jsonb: Object.freeze({ fromDb: readJson, toDb: writeJson }),
  array: Object.freeze({ fromDb: readJson, toDb: writeJson }),
});
