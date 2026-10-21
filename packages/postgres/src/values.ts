/**
 * How Postgres values become the canonical driver values the types expect, and back.
 *
 * Two layers, both scoped to this adapter (the global `pg.types` registry is never
 * touched, so other code in the process that uses `pg` sees its usual values):
 *
 * - **Result parsers** ({@link PG_TYPES}), passed to `pg` with every statement and cursor
 *   of this adapter. They keep `date`, `int8` and `numeric` as the text Postgres sends,
 *   read a `timestamp` without time zone as UTC wall time, and read `timestamptz` without
 *   depending on the process's time zone.
 * - **Driver codecs** ({@link PG_DRIVER_CODECS}), composed with each type's own
 *   conversions by the shared adapter: `int8` text to `bigint`, a `Buffer` to a plain
 *   `Uint8Array` view, JSON serialised by us (`pg` would write an array as a Postgres
 *   array literal and a string as text), and timestamps written as explicit UTC text.
 *
 * @module
 */
import type { DriverCodecs } from "egon-orm";
import { CastError } from "egon-orm";
import pg from "pg";

// --- array literals -----------------------------------------------------------------

/**
 * Parses a Postgres array literal (`{1,NULL,"a b",{2,3}}`, with an optional dimension
 * prefix such as `[0:1]=`) into nested arrays, applying `element` to every non-null item.
 * Returns the text unchanged when it is not an array literal.
 */
export function parseArrayLiteral(text: string, element: (item: string) => unknown): unknown {
  let start = 0;
  if (text.charCodeAt(0) === 91 /* [ */) {
    const equals = text.indexOf("=");
    if (equals === -1) return text;
    start = equals + 1;
  }
  if (text.charCodeAt(start) !== 123 /* { */) return text;
  const stack: unknown[][] = [];
  let current: unknown[] = [];
  let i = start + 1;
  const root = current;
  stack.push(current);
  const length = text.length;
  while (i < length) {
    const code = text.charCodeAt(i);
    if (code === 123 /* { */) {
      const child: unknown[] = [];
      current.push(child);
      stack.push(child);
      current = child;
      i++;
    } else if (code === 125 /* } */) {
      stack.pop();
      current = stack[stack.length - 1] ?? root;
      i++;
    } else if (code === 44 /* , */) {
      i++;
    } else if (code === 34 /* " */) {
      let value = "";
      i++;
      while (i < length) {
        const c = text.charCodeAt(i);
        if (c === 92 /* \ */) {
          value += text[i + 1] ?? "";
          i += 2;
        } else if (c === 34) {
          i++;
          break;
        } else {
          value += text[i];
          i++;
        }
      }
      current.push(element(value));
    } else {
      let end = i;
      while (end < length) {
        const c = text.charCodeAt(end);
        if (c === 44 || c === 125) break;
        end++;
      }
      const raw = text.slice(i, end);
      current.push(raw.length === 4 && raw.toUpperCase() === "NULL" ? null : element(raw));
      i = end;
    }
  }
  return root;
}

// --- timestamps ---------------------------------------------------------------------

const TIMESTAMP_TEXT =
  /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?( BC)?$/;

/**
 * Reads the text of a `timestamp` (`withZone` false: the wall time is taken as UTC) or a
 * `timestamptz` (`withZone` true: the offset Postgres wrote is applied). `infinity` and
 * `-infinity` become `Infinity` and `-Infinity`, as `pg` reports them; text in any other
 * form is returned unchanged.
 */
export function parseTimestamp(text: string, withZone: boolean): Date | number | string {
  const match = TIMESTAMP_TEXT.exec(text);
  if (match === null) {
    if (text === "infinity") return Number.POSITIVE_INFINITY;
    if (text === "-infinity") return Number.NEGATIVE_INFINITY;
    return text;
  }
  let year = Number(match[1]);
  if (match[12] !== undefined) year = 1 - year;
  const millisecond = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"));
  const date = new Date(0);
  date.setUTCFullYear(year, Number(match[2]) - 1, Number(match[3]));
  date.setUTCHours(Number(match[4]), Number(match[5]), Number(match[6]), millisecond);
  if (withZone && match[8] !== undefined) {
    const offsetSeconds = Number(match[9]) * 3600 + Number(match[10] ?? "0") * 60 + Number(match[11] ?? "0");
    const sign = match[8] === "-" ? -1 : 1;
    date.setTime(date.getTime() - sign * offsetSeconds * 1000);
  }
  return date;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Writes a `Date` as Postgres timestamp text from its UTC fields: with `+00` for a
 * `timestamptz`, without for a `timestamp` (whose UTC fields are the wall time). Years
 * before 1 are written with `BC`. Independent of the process's time zone.
 *
 * @throws CastError for an invalid `Date`.
 */
export function formatTimestamp(value: Date, withZone: boolean): string {
  const time = value.getTime();
  if (Number.isNaN(time)) {
    throw new CastError(
      "cast.timestampInvalidDate",
      "An invalid Date cannot be written to a timestamp column.",
    );
  }
  const year = value.getUTCFullYear();
  const bc = year < 1;
  const text = `${pad(bc ? 1 - year : year, 4)}-${pad(value.getUTCMonth() + 1, 2)}-${pad(value.getUTCDate(), 2)}T${pad(
    value.getUTCHours(),
    2,
  )}:${pad(value.getUTCMinutes(), 2)}:${pad(value.getUTCSeconds(), 2)}.${pad(value.getUTCMilliseconds(), 3)}`;
  return `${text}${withZone ? "+00" : ""}${bc ? " BC" : ""}`;
}

// --- result parsers -----------------------------------------------------------------

/** Postgres type OIDs this adapter reads itself. */
export const OID = {
  int8: 20,
  int8Array: 1016,
  numeric: 1700,
  numericArray: 1231,
  date: 1082,
  dateArray: 1182,
  timestamp: 1114,
  timestampArray: 1115,
  timestamptz: 1184,
  timestamptzArray: 1185,
} as const;

const keepText = (text: string): string => text;
const textArray = (text: string): unknown => parseArrayLiteral(text, keepText);
const localTimestamp = (text: string): unknown => parseTimestamp(text, false);
const zonedTimestamp = (text: string): unknown => parseTimestamp(text, true);
const localTimestampArray = (text: string): unknown => parseArrayLiteral(text, localTimestamp);
const zonedTimestampArray = (text: string): unknown => parseArrayLiteral(text, zonedTimestamp);

type TextParser = (text: string) => unknown;

const TEXT_PARSERS: ReadonlyMap<number, TextParser> = new Map<number, TextParser>([
  [OID.int8, keepText],
  [OID.int8Array, textArray],
  [OID.numeric, keepText],
  [OID.numericArray, textArray],
  [OID.date, keepText],
  [OID.dateArray, textArray],
  [OID.timestamp, localTimestamp],
  [OID.timestampArray, localTimestampArray],
  [OID.timestamptz, zonedTimestamp],
  [OID.timestamptzArray, zonedTimestampArray],
]);

/**
 * The result parsers of this adapter, handed to `pg` with each statement (`types` of a
 * query config). Every other type is parsed as `pg` parses it by default.
 */
export const PG_TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (format === undefined || format === "text") {
      const parser = TEXT_PARSERS.get(oid);
      if (parser !== undefined) return parser;
    }
    return pg.types.getTypeParser(oid, format as "text");
  }) as pg.CustomTypesConfig["getTypeParser"],
};

// --- driver codecs ------------------------------------------------------------------

function readBigint(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return BigInt(value);
  } catch {
    throw new CastError(
      "cast.bigintFraction",
      "A bigint column received a value from the database that is not a whole number.",
    );
  }
}

function readBytes(value: unknown): unknown {
  // A Buffer is a Uint8Array subclass; the types want the plain class, over the same memory.
  if (value instanceof Uint8Array && Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

const writeJson = (value: unknown): unknown => JSON.stringify(value);

const writeTimestamp = (value: unknown): unknown =>
  value instanceof Date ? formatTimestamp(value, false) : value;
const writeTimestamptz = (value: unknown): unknown =>
  value instanceof Date ? formatTimestamp(value, true) : value;

/**
 * Where `pg`'s values (with {@link PG_TYPES}) differ from the canonical driver values.
 */
export const PG_DRIVER_CODECS: DriverCodecs = Object.freeze({
  bigint: Object.freeze({ fromDb: readBigint }),
  binary: Object.freeze({ fromDb: readBytes }),
  json: Object.freeze({ toDb: writeJson }),
  jsonb: Object.freeze({ toDb: writeJson }),
  timestamp: Object.freeze({ toDb: writeTimestamp }),
  timestamptz: Object.freeze({ toDb: writeTimestamptz }),
});
