import { CastError } from "egon-orm";
import { describe, expect, test } from "vitest";
import { formatDatetime, MYSQL_DRIVER_CODECS, parseDatetime } from "./values.js";

const codec = (kind: keyof typeof MYSQL_DRIVER_CODECS) => {
  const found = MYSQL_DRIVER_CODECS[kind];
  if (found === undefined) throw new Error(`no codec for ${kind}`);
  return { fromDb: found.fromDb ?? ((v: unknown) => v), toDb: found.toDb ?? ((v: unknown) => v) };
};

describe("MYSQL_DRIVER_CODECS", () => {
  test("integers: digit text and bigints become numbers, and one beyond a number is refused", () => {
    const { fromDb } = codec("integer");
    expect(fromDb(42)).toBe(42);
    expect(fromDb("-17")).toBe(-17);
    expect(fromDb(5n)).toBe(5);
    expect(fromDb(null)).toBeNull();
    expect(fromDb("1.5")).toBe("1.5");
    expect(() => fromDb("9007199254740993")).toThrow(CastError);
  });

  test("floats: text is read as a number, and a value that is not finite is refused", () => {
    const { fromDb, toDb } = codec("float");
    expect(fromDb("1.5")).toBe(1.5);
    expect(fromDb(2.5)).toBe(2.5);
    expect(fromDb("")).toBe("");
    expect(fromDb("x")).toBe("x");
    expect(toDb(1.5)).toBe(1.5);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => toDb(bad)).toThrow(CastError);
    }
  });

  test("bigints from a number or digit text", () => {
    const { fromDb } = codec("bigint");
    expect(fromDb(12)).toBe(12n);
    expect(fromDb("9223372036854775807")).toBe(9_223_372_036_854_775_807n);
    expect(fromDb(1.5)).toBe(1.5);
    expect(fromDb(null)).toBeNull();
  });

  test("decimals are text", () => {
    expect(codec("decimal").fromDb("1.50")).toBe("1.50");
    expect(codec("decimal").fromDb(2)).toBe("2");
    expect(codec("decimal").fromDb(3n)).toBe("3");
  });

  test("booleans are 1 and 0", () => {
    const { fromDb, toDb } = codec("boolean");
    expect([
      fromDb(1),
      fromDb("1"),
      fromDb(1n),
      fromDb(0),
      fromDb("0"),
      fromDb(0n),
      fromDb(null),
      fromDb(2),
    ]).toEqual([true, true, true, false, false, false, null, 2]);
    expect([toDb(true), toDb(false), toDb(null)]).toEqual([1, 0, null]);
  });

  test("a time drops the zeros time(6) pads it with", () => {
    const { fromDb } = codec("time");
    expect(fromDb("12:30:00.000000")).toBe("12:30:00");
    expect(fromDb("23:59:59.500000")).toBe("23:59:59.5");
    expect(fromDb("23:59:59.999999")).toBe("23:59:59.999999");
    expect(fromDb("12:30:00")).toBe("12:30:00");
    expect(fromDb(null)).toBeNull();
  });

  test("timestamps are written and read as UTC wall time", () => {
    const at = new Date("2026-03-29T01:30:05.007Z");
    expect(codec("timestamptz").toDb(at)).toBe("2026-03-29 01:30:05.007");
    expect(codec("timestamp").toDb(at)).toBe("2026-03-29 01:30:05.007");
    expect(codec("timestamp").toDb("text")).toBe("text");
    expect(codec("timestamptz").fromDb("2026-03-29 01:30:05.007000")).toEqual(at);
    expect(codec("timestamp").fromDb(null)).toBeNull();
  });

  test("JSON, and arrays, are written as JSON text: a bigint as digits, bytes as base64", () => {
    expect(codec("json").toDb({ a: 1 })).toBe('{"a":1}');
    expect(codec("jsonb").toDb([1])).toBe("[1]");
    expect(codec("array").toDb([5n, Uint8Array.of(1, 2, 3), Buffer.from([4]), null])).toBe(
      '["5","AQID","BA==",null]',
    );
  });

  test("bytes are read as a plain Uint8Array and written as a Buffer over the same memory", () => {
    const { fromDb, toDb } = codec("binary");
    const read = fromDb(Buffer.from([1, 2]));
    expect(Object.getPrototypeOf(read)).toBe(Uint8Array.prototype);
    const plain = Uint8Array.of(3);
    expect(fromDb(plain)).toBe(plain);
    expect([...(fromDb("AQI=") as Uint8Array)]).toEqual([1, 2]);
    expect(fromDb(null)).toBeNull();
    expect(Buffer.isBuffer(toDb(plain))).toBe(true);
    const buffer = Buffer.from([5]);
    expect(toDb(buffer)).toBe(buffer);
  });
});

describe("parseDatetime", () => {
  test.each([
    ["2026-01-02 03:04:05", "2026-01-02T03:04:05.000Z"],
    ["2026-01-02T03:04:05.123456", "2026-01-02T03:04:05.123Z"],
    ["2026-01-02 03:04:05.5", "2026-01-02T03:04:05.500Z"],
    ["0001-01-01 00:00:00", "0001-01-01T00:00:00.000Z"],
  ])("reads %s as UTC", (text, iso) => {
    expect((parseDatetime(text) as Date).toISOString()).toBe(iso);
  });

  test("returns text it cannot read unchanged", () => {
    expect(parseDatetime("2026-01-02")).toBe("2026-01-02");
  });
});

describe("formatDatetime", () => {
  test("pads every field", () => {
    expect(formatDatetime(new Date("0001-02-03T04:05:06.007Z"))).toBe("0001-02-03 04:05:06.007");
  });

  test("refuses an invalid date and a year outside 0000–9999", () => {
    expect(() => formatDatetime(new Date(Number.NaN))).toThrow(CastError);
    expect(() => formatDatetime(new Date("+010000-01-01T00:00:00Z"))).toThrow(/0000 to 9999/);
    expect(() => formatDatetime(new Date("-000001-01-01T00:00:00Z"))).toThrow(/0000 to 9999/);
  });
});
