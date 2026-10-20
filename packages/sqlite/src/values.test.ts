import { CastError } from "egon-orm";
import { describe, expect, test } from "vitest";
import { formatTimestamp, parseTimestamp, SQLITE_DRIVER_CODECS } from "./values.js";

const codec = (kind: keyof typeof SQLITE_DRIVER_CODECS) => {
  const found = SQLITE_DRIVER_CODECS[kind];
  if (found === undefined) throw new Error(`no codec for ${kind}`);
  return { fromDb: found.fromDb ?? ((v: unknown) => v), toDb: found.toDb ?? ((v: unknown) => v) };
};

describe("SQLITE_DRIVER_CODECS", () => {
  test("integers come back as numbers, and one too large for a number is refused", () => {
    const { fromDb } = codec("integer");
    expect(fromDb(42n)).toBe(42);
    expect(fromDb(-7)).toBe(-7);
    expect(fromDb(null)).toBeNull();
    expect(() => fromDb(2n ** 53n)).toThrow(CastError);
    expect(() => fromDb(-(2n ** 53n))).toThrow(/t\.bigint\(\)/);
  });

  test("floats: a whole real is read as an integer, and a value that is not finite is refused", () => {
    const { fromDb, toDb } = codec("float");
    expect(fromDb(3n)).toBe(3);
    expect(fromDb(1.5)).toBe(1.5);
    expect(toDb(1.5)).toBe(1.5);
    expect(toDb(null)).toBeNull();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => toDb(bad)).toThrow(CastError);
    }
  });

  test("bigints keep every digit, from an integer, a whole real or digit text", () => {
    const { fromDb } = codec("bigint");
    expect(fromDb(9_223_372_036_854_775_807n)).toBe(9_223_372_036_854_775_807n);
    expect(fromDb(12)).toBe(12n);
    expect(fromDb("-123")).toBe(-123n);
    expect(fromDb(1.5)).toBe(1.5);
    expect(fromDb("x")).toBe("x");
  });

  test("booleans are 1 and 0", () => {
    const { fromDb, toDb } = codec("boolean");
    expect([fromDb(1n), fromDb(0n), fromDb(1), fromDb(0), fromDb(null), fromDb(2n)]).toEqual([
      true,
      false,
      true,
      false,
      null,
      2n,
    ]);
    expect([toDb(true), toDb(false), toDb(null)]).toEqual([1, 0, null]);
  });

  test("decimals and text stored with numeric affinity are read as text", () => {
    expect(codec("decimal").fromDb(1.25)).toBe("1.25");
    expect(codec("decimal").fromDb(10n)).toBe("10");
    expect(codec("decimal").fromDb("1.50")).toBe("1.50");
    expect(codec("text").fromDb(5n)).toBe("5");
    expect(codec("text").fromDb(2.5)).toBe("2.5");
    expect(codec("text").fromDb("a")).toBe("a");
    expect(codec("uuid").fromDb("0190d8a0-0000-7000-8000-0000000000ab")).toBe(
      "0190d8a0-0000-7000-8000-0000000000ab",
    );
  });

  test("timestamps are ISO 8601 text in UTC, with a zone for timestamptz only", () => {
    const at = new Date("2026-03-29T01:30:05.007Z");
    expect(codec("timestamptz").toDb(at)).toBe("2026-03-29T01:30:05.007Z");
    expect(codec("timestamp").toDb(at)).toBe("2026-03-29T01:30:05.007");
    expect(codec("timestamp").toDb("text")).toBe("text");
    expect(codec("timestamptz").toDb(null)).toBeNull();
    expect(codec("timestamptz").fromDb("2026-03-29T01:30:05.007Z")).toEqual(at);
    expect(codec("timestamp").fromDb(5n)).toBe(5n);
  });

  test("JSON is text both ways; a bigint is written as digits and bytes as base64", () => {
    const { fromDb, toDb } = codec("json");
    expect(toDb({ a: [1, "b"] })).toBe('{"a":[1,"b"]}');
    expect(toDb([5n, Uint8Array.of(1, 2, 3), Buffer.from([4])])).toBe('["5","AQID","BA=="]');
    expect(fromDb('{"a":1}')).toEqual({ a: 1 });
    expect(fromDb(3n)).toBe(3);
    expect(fromDb(null)).toBeNull();
    expect(() => fromDb("{")).toThrow(CastError);
    expect(codec("jsonb").fromDb("[1]")).toEqual([1]);
    expect(codec("array").toDb(["a", null])).toBe('["a",null]');
  });

  test("bytes are read as a plain Uint8Array and written as a Buffer over the same memory", () => {
    const { fromDb, toDb } = codec("binary");
    const read = fromDb(Buffer.from([1, 2]));
    expect(Object.getPrototypeOf(read)).toBe(Uint8Array.prototype);
    expect([...(read as Uint8Array)]).toEqual([1, 2]);
    const plain = Uint8Array.of(3, 4);
    expect(fromDb(plain)).toBe(plain);
    expect([...(fromDb("AQI=") as Uint8Array)]).toEqual([1, 2]);
    expect(fromDb(null)).toBeNull();
    const written = toDb(plain);
    expect(Buffer.isBuffer(written)).toBe(true);
    expect((written as Buffer).buffer).toBe(plain.buffer);
    const buffer = Buffer.from([5]);
    expect(toDb(buffer)).toBe(buffer);
  });
});

describe("parseTimestamp", () => {
  test.each([
    ["2026-01-02T03:04:05.678Z", "2026-01-02T03:04:05.678Z"],
    ["2026-01-02 03:04:05", "2026-01-02T03:04:05.000Z"],
    ["2026-01-02 03:04", "2026-01-02T03:04:00.000Z"],
    ["2026-01-02", "2026-01-02T00:00:00.000Z"],
    ["2026-01-02T03:04:05.123456", "2026-01-02T03:04:05.123Z"],
    ["2026-01-02T03:04:05.5", "2026-01-02T03:04:05.500Z"],
    ["2026-01-02T03:04:05+02:00", "2026-01-02T01:04:05.000Z"],
    ["2026-01-02T03:04:05-0130", "2026-01-02T04:34:05.000Z"],
    ["0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000Z"],
  ])("reads %s", (text, iso) => {
    expect((parseTimestamp(text) as Date).toISOString()).toBe(iso);
  });

  test("returns text it cannot read unchanged", () => {
    expect(parseTimestamp("yesterday")).toBe("yesterday");
  });
});

describe("formatTimestamp", () => {
  test("pads every field, down to the year 0000", () => {
    expect(formatTimestamp(new Date("0001-02-03T04:05:06.007Z"), true)).toBe("0001-02-03T04:05:06.007Z");
  });

  test("refuses an invalid date and a year SQLite text cannot sort", () => {
    expect(() => formatTimestamp(new Date(Number.NaN), true)).toThrow(CastError);
    expect(() => formatTimestamp(new Date("+010000-01-01T00:00:00Z"), true)).toThrow(/0000 to 9999/);
    expect(() => formatTimestamp(new Date("-000001-01-01T00:00:00Z"), false)).toThrow(/0000 to 9999/);
  });
});
