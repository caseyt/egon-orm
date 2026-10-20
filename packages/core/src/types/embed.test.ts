// Unit tests for the embed type: how embedded rows are written to JSON and read back.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { IDENTITY } from "../contracts/type.js";
import { CastError } from "../errors.js";
import { EmbeddedSchema, meta, Schema, stateOf, t } from "../index.js";
import { defineType } from "./define.js";
import { dumpEmbedded, embedType, embedTypeInfo, fromBase64, loadEmbedded, toBase64 } from "./embed.js";

const upper = defineType<string, string>({
  name: "upper",
  db: { kind: "text" },
  cast: (input) => (typeof input === "string" ? { success: true, data: input } : { success: false }),
  fromDb: (stored) => stored.toUpperCase(),
  toDb: (value) => value.toLowerCase(),
});

class Pin extends EmbeddedSchema({ lat: t.float(), lng: t.float() }) {}

class Sample extends EmbeddedSchema({
  label: t.string(),
  count: t.integer(),
  big: t.bigint(),
  ratio: t.float().nullable(),
  ok: t.boolean(),
  when: t.timestamp(),
  day: t.date(),
  dayAsDate: t.date({ as: "date" }).nullable(),
  amount: t.decimal(),
  blob: t.binary().nullable(),
  tags: t.array(t.string()),
  stamps: t.array(t.timestamp()).nullable(),
  data: t.json<{ a: number }>().nullable(),
  shout: t.type(upper).nullable(),
  pin: t.embedOne(() => Pin).nullable(),
  pins: t.embedMany(() => Pin),
  note: t.string().default("none"),
  renamed: t.string().nullable().column("re_named"),
  scratch: t.string().virtual(),
}) {
  get summary(): string {
    return `${this.label}:${this.count}`;
  }
}

const sampleMeta = meta(Sample);
const loadedRow = sampleMeta.rowMeta("loaded", undefined);

function sample(values: Partial<Record<string, unknown>>): Sample {
  return sampleMeta.create(
    sampleMeta.persisted.map((field) => values[field.name] ?? null),
    loadedRow,
  ) as Sample;
}

describe("dumpEmbedded and loadEmbedded", () => {
  const row = sample({
    label: "a",
    count: 3,
    big: 12345678901234567890n,
    ratio: Number.NaN,
    ok: true,
    when: new Date("2026-10-20T08:00:00.123Z"),
    day: "2026-10-20",
    dayAsDate: new Date("2026-10-21T00:00:00.000Z"),
    amount: "1.50",
    blob: new Uint8Array([0, 1, 254, 255]),
    tags: ["x", "y"],
    stamps: [new Date("2026-01-01T00:00:00.000Z"), null],
    data: { a: 1 },
    shout: "LOUD",
    pin:
      sampleMeta === undefined
        ? null
        : (meta(Pin).create([1.5, -2], meta(Pin).rowMeta("loaded", undefined)) as Pin),
    pins: [],
    note: "n",
    renamed: "r",
  });

  test("each field is written with its own type, as JSON", () => {
    expect(dumpEmbedded(sampleMeta, row)).toEqual({
      label: "a",
      count: 3,
      big: "12345678901234567890",
      ratio: "NaN",
      ok: true,
      when: "2026-10-20T08:00:00.123Z",
      day: "2026-10-20",
      dayAsDate: "2026-10-21",
      amount: "1.50",
      blob: "AAH+/w==",
      tags: ["x", "y"],
      stamps: ["2026-01-01T00:00:00.000Z", null],
      data: { a: 1 },
      shout: "loud",
      pin: { lat: 1.5, lng: -2 },
      pins: [],
      note: "n",
      re_named: "r",
    });
  });

  test("a stored object reads back as a row of the class, with getters", () => {
    const back = loadEmbedded(
      sampleMeta,
      JSON.parse(JSON.stringify(dumpEmbedded(sampleMeta, row))),
      loadedRow,
    ) as Sample;
    expect(back).toBeInstanceOf(Sample);
    expect(stateOf(back)).toBe("loaded");
    expect(back.summary).toBe("a:3");
    expect(back.big).toBe(12345678901234567890n);
    expect(back.ratio).toBeNaN();
    expect(back.when).toEqual(new Date("2026-10-20T08:00:00.123Z"));
    expect(back.dayAsDate).toEqual(new Date("2026-10-21T00:00:00.000Z"));
    expect(back.blob).toEqual(new Uint8Array([0, 1, 254, 255]));
    expect(back.stamps).toEqual([new Date("2026-01-01T00:00:00.000Z"), null]);
    expect(back.shout).toBe("LOUD");
    expect(back.pin).toBeInstanceOf(Pin);
    expect(back.renamed).toBe("r");
    expect(back.scratch).toBeUndefined();
  });

  test("unknown keys are ignored, missing keys take defaults or null, missing required ones throw", () => {
    const minimal = {
      label: "m",
      count: 1,
      big: 1,
      ok: false,
      when: "2026-01-01T00:00:00Z",
      day: "2026-01-01",
      amount: "0",
      tags: [],
      extra: "ignored",
    };
    const back = loadEmbedded(sampleMeta, minimal, loadedRow) as Sample;
    expect(back.note).toBe("none");
    expect(back.pins).toEqual([]);
    expect(back.ratio).toBeNull();
    expect(back.big).toBe(1n);
    expect(Object.keys(back)).not.toContain("extra");
    const { label: _label, ...noLabel } = minimal;
    expect(() => loadEmbedded(sampleMeta, noLabel, loadedRow)).toThrow(/has no "label"/);
  });

  test("stored values the field's type cannot read are a CastError", () => {
    const good = JSON.parse(JSON.stringify(dumpEmbedded(sampleMeta, row))) as Record<string, unknown>;
    for (const [key, value] of [
      ["when", "not a date"],
      ["when", true],
      ["big", "1.5"],
      ["big", 1.5],
      ["blob", "@@@"],
      ["blob", 3],
      ["tags", "x"],
    ] as const) {
      expect(() => loadEmbedded(sampleMeta, { ...good, [key]: value }, loadedRow)).toThrow(CastError);
    }
    expect(() => loadEmbedded(sampleMeta, [], loadedRow)).toThrow(/not a JSON object/);
    expect(() => loadEmbedded(sampleMeta, null, loadedRow)).toThrow(CastError);
    expect(() => dumpEmbedded(sampleMeta, sample({ ...row, when: new Date(Number.NaN) }))).toThrow(
      /invalid Date/,
    );
  });

  test("a plain object's missing fields take their defaults or are left out", () => {
    expect(dumpEmbedded(meta(Pin), { lat: 1 })).toEqual({ lat: 1 });
    expect(dumpEmbedded(sampleMeta, { label: "p" })).toMatchObject({ label: "p", note: "none", pins: [] });
  });
});

describe("base64", () => {
  test("round-trips every length and refuses what is not base64", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 40 }), (bytes) => {
        expect(fromBase64(toBase64(bytes))).toEqual(bytes);
        expect(fromBase64(toBase64(bytes).replace(/=+$/, ""))).toEqual(bytes);
      }),
    );
    expect(fromBase64("A")).toBeUndefined();
    expect(fromBase64("ab*d")).toBeUndefined();
  });
});

describe("embedType", () => {
  class Box extends Schema("boxes", {
    id: t.integer().primaryKey(),
    pin: t.embedOne(() => Pin),
    pins: t.embedMany(() => Pin),
  }) {}
  const one = meta(Box).fieldsByName.get("pin")?.type ?? fail();
  const many = meta(Box).fieldsByName.get("pins")?.type ?? fail();
  function fail(): never {
    throw new Error("no field");
  }

  test("is a jsonb type that remembers its schema", () => {
    expect(one.db).toEqual({ kind: "jsonb" });
    expect([one.name, many.name]).toEqual(["embedOne", "embedMany"]);
    expect(embedTypeInfo(many)?.cardinality).toBe("many");
    expect(embedTypeInfo(many)?.schema()).toBe(Pin);
    expect(embedType("one", () => Pin).fromDb).not.toBe(IDENTITY);
  });

  test("fromDb builds rows from parsed or textual JSON; toDb writes JSON objects", () => {
    const pin = one.fromDb({ lat: 1, lng: 2 }) as Pin;
    expect(pin).toBeInstanceOf(Pin);
    expect(one.fromDb('{"lat":3,"lng":4}')).toMatchObject({ lat: 3, lng: 4 });
    const pins = many.fromDb([{ lat: 1, lng: 2 }]) as Pin[];
    expect(pins[0]).toBeInstanceOf(Pin);
    expect(() => many.fromDb({})).toThrow(/not a JSON array/);
    expect(one.toDb(pin)).toEqual({ lat: 1, lng: 2 });
    expect(many.toDb(pins)).toEqual([{ lat: 1, lng: 2 }]);
  });

  test("cast accepts rows and plain objects of the fields, nothing else", () => {
    const pin = one.fromDb({ lat: 1, lng: 2 });
    expect(one.cast(pin)).toEqual({ success: true, data: pin });
    const cast = one.cast({ lat: "1.5", lng: 2 });
    expect(cast.success && cast.data).toBeInstanceOf(Pin);
    expect(cast.success && cast.data).toMatchObject({ lat: 1.5, lng: 2 });
    expect(one.cast({ lat: 1 }).success).toBe(false);
    expect(one.cast({ lat: 1, lng: 2, other: 3 }).success).toBe(false);
    expect(one.cast({ lat: "north", lng: 2 }).success).toBe(false);
    expect(one.cast([]).success).toBe(false);
    expect(one.cast(new Date()).success).toBe(false);
    expect(many.cast([{ lat: 1, lng: 2 }, pin]).success).toBe(true);
    expect(many.cast([{ lat: 1 }]).success).toBe(false);
    expect(many.cast({}).success).toBe(false);
    const trap = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("trap");
        },
      },
    );
    expect(one.cast(trap).success).toBe(false);
  });

  test("equal compares the stored forms", () => {
    expect(one.equal(one.fromDb({ lat: 1, lng: 2 }), { lat: 1, lng: 2 })).toBe(true);
    expect(one.equal(one.fromDb({ lat: 1, lng: 2 }), { lat: 1, lng: 3 })).toBe(false);
  });

  test("a round trip through JSON gives back equal rows, nested embeds and dates included", () => {
    const pinArb = fc.record({
      lat: fc.double({ noNaN: true, noDefaultInfinity: true }),
      lng: fc.double({ noNaN: true, noDefaultInfinity: true }),
    });
    const sampleArb = fc.record({
      label: fc.string(),
      count: fc.integer(),
      big: fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
      ratio: fc.option(fc.double({ noNaN: true, noDefaultInfinity: true }), { nil: null }),
      ok: fc.boolean(),
      when: fc.date({
        noInvalidDate: true,
        min: new Date("0001-01-01T00:00:00Z"),
        max: new Date("9999-12-31T00:00:00Z"),
      }),
      day: fc.constantFrom("2026-10-20", "1999-01-31"),
      dayAsDate: fc.constant(null),
      amount: fc.constantFrom("0", "1.50", "-3.25"),
      blob: fc.option(fc.uint8Array({ maxLength: 8 }), { nil: null }),
      tags: fc.array(fc.string(), { maxLength: 3 }),
      stamps: fc.constant(null),
      data: fc.option(fc.record({ a: fc.integer() }), { nil: null }),
      shout: fc.constant(null),
      pin: fc.option(pinArb, { nil: null }),
      pins: fc.array(pinArb, { maxLength: 3 }),
      note: fc.string(),
      renamed: fc.option(fc.string(), { nil: null }),
    });
    const type = embedType("one", () => Sample);
    fc.assert(
      fc.property(sampleArb, (values) => {
        const casted = type.cast(values);
        if (!casted.success) throw new Error("cast failed");
        const stored = JSON.parse(JSON.stringify(type.toDb(casted.data)));
        const back = type.fromDb(stored) as Sample;
        expect(back).toBeInstanceOf(Sample);
        expect(type.equal(back, casted.data)).toBe(true);
        expect(back.when.getTime()).toBe(values.when.getTime());
        expect(back.big).toBe(values.big);
        if (values.pin !== null) expect(back.pin).toBeInstanceOf(Pin);
        for (const each of back.pins) expect(each).toBeInstanceOf(Pin);
      }),
      { numRuns: 200 },
    );
  });
});
