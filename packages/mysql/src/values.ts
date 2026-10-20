/**
 * How MySQL values become the canonical driver values the types expect, and back.
 *
 * The adapter's connections read dates and times as text (`dateStrings`), big integers as
 * a `number` when they fit one and as digit text when they do not (`supportBigNumbers`),
 * decimals as text, and JSON parsed. Its session time zone is UTC. These codecs do the rest:
 *
 * | Kind | Column | Read back as |
 * |---|---|---|
 * | `boolean` | `tinyint(1)` | `boolean` (from `0` / `1`) |
 * | `bigint` | `bigint` | `bigint` (from a number or digit text) |
 * | `decimal` | `decimal(p, s)` | `string` |
 * | `uuid` | `char(36)` | `string` |
 * | `timestamp`, `timestamptz` | `datetime(6)`, written and read as UTC | `Date` |
 * | `json`, `jsonb` | `json` | the parsed value |
 * | `binary` | `blob`, `binary` | `Uint8Array` |
 * | arrays | `json` (an array of the elements) | an array |
 *
 * @module
 */
import type { DriverCodecs } from "egon-orm";
import { CastError } from "egon-orm";

/** An integer column: a number, or digit text when the driver had to keep it as text. */
function readInteger(value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new CastError(
        "A number column received an integer from the database beyond Number.MAX_SAFE_INTEGER. Read it with t.bigint().",
      );
    }
    return number;
  }
  if (typeof value === "bigint") return Number(value);
  return value;
}

function readFloat(value: unknown): unknown {
  return typeof value === "string" && value !== "" && !Number.isNaN(Number(value)) ? Number(value) : value;
}

/** MySQL has no NaN or infinities: one is refused rather than sent. */
function writeFloat(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new CastError("MySQL cannot store NaN, Infinity or -Infinity in a float column.");
  }
  return value;
}

function readBigint(value: unknown): unknown {
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return value;
}

function readDecimal(value: unknown): unknown {
  return typeof value === "number" || typeof value === "bigint" ? String(value) : value;
}

function readBoolean(value: unknown): unknown {
  if (value === 0 || value === "0" || value === 0n) return false;
  if (value === 1 || value === "1" || value === 1n) return true;
  return value;
}

const writeBoolean = (value: unknown): unknown => (value === true ? 1 : value === false ? 0 : value);

/**
 * A `time(6)` column always reads with six fraction digits (`12:30:00.000000`); trailing
 * zeros are dropped, as other databases write a time (`12:30:00`, `23:59:59.5`).
 */
function readTime(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const dot = value.indexOf(".");
  if (dot === -1) return value;
  const trimmed = value.replace(/0+$/, "");
  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}

const DATETIME_TEXT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

/** Reads `datetime` text as UTC; anything else is returned unchanged (the type then refuses it). */
export function parseDatetime(text: string): Date | string {
  const match = DATETIME_TEXT.exec(text);
  if (match === null) return text;
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setUTCHours(
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number((match[7] ?? "").slice(0, 3).padEnd(3, "0")),
  );
  return date;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Writes a `Date` as `datetime` text from its UTC fields, with milliseconds. The session
 * is UTC, so a `timestamptz` means the same instant everywhere, and a `timestamp`'s UTC
 * fields are its wall time.
 *
 * @throws CastError for an invalid `Date`, or a year outside 0000–9999.
 */
export function formatDatetime(value: Date): string {
  const time = value.getTime();
  if (Number.isNaN(time)) throw new CastError("An invalid Date cannot be written to a timestamp column.");
  const year = value.getUTCFullYear();
  if (year < 0 || year > 9999)
    throw new CastError("MySQL stores datetimes with a four-digit year: 0000 to 9999.");
  return `${pad(year, 4)}-${pad(value.getUTCMonth() + 1, 2)}-${pad(value.getUTCDate(), 2)} ${pad(
    value.getUTCHours(),
    2,
  )}:${pad(value.getUTCMinutes(), 2)}:${pad(value.getUTCSeconds(), 2)}.${pad(value.getUTCMilliseconds(), 3)}`;
}

function readDatetime(value: unknown): unknown {
  return typeof value === "string" ? parseDatetime(value) : value;
}

const writeDatetime = (value: unknown): unknown => (value instanceof Date ? formatDatetime(value) : value);

/**
 * Inside JSON (an array column), a `bigint` element is written as its digits and a bytes
 * element as base64; the element's own conversion reads them back.
 */
function jsonReplacer(this: unknown, key: string, item: unknown): unknown {
  if (typeof item === "bigint") return item.toString();
  // JSON.stringify calls toJSON (a Buffer's) before the replacer: look at the original.
  const original = (this as Record<string, unknown>)[key];
  if (original instanceof Uint8Array) {
    return Buffer.from(original.buffer, original.byteOffset, original.byteLength).toString("base64");
  }
  return item;
}

/** mysql2 does not serialise a value for a JSON column: the adapter writes JSON text. */
function writeJson(value: unknown): unknown {
  return JSON.stringify(value, jsonReplacer);
}

function readBytes(value: unknown): unknown {
  // A Buffer is a Uint8Array subclass; the types want the plain class, over the same memory.
  if (value instanceof Uint8Array && Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  // An element of a bytes array, read from the array's JSON.
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "base64");
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return value;
}

/** mysql2 binds a `Buffer`; a plain `Uint8Array` is wrapped over the same memory. */
function writeBytes(value: unknown): unknown {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

/** Where `mysql2`'s values (with the adapter's connection settings) differ from the canonical driver values. */
export const MYSQL_DRIVER_CODECS: DriverCodecs = Object.freeze({
  integer: Object.freeze({ fromDb: readInteger }),
  float: Object.freeze({ fromDb: readFloat, toDb: writeFloat }),
  bigint: Object.freeze({ fromDb: readBigint }),
  decimal: Object.freeze({ fromDb: readDecimal }),
  boolean: Object.freeze({ fromDb: readBoolean, toDb: writeBoolean }),
  binary: Object.freeze({ fromDb: readBytes, toDb: writeBytes }),
  time: Object.freeze({ fromDb: readTime }),
  timestamp: Object.freeze({ fromDb: readDatetime, toDb: writeDatetime }),
  timestamptz: Object.freeze({ fromDb: readDatetime, toDb: writeDatetime }),
  json: Object.freeze({ toDb: writeJson }),
  jsonb: Object.freeze({ toDb: writeJson }),
  array: Object.freeze({ toDb: writeJson }),
});
