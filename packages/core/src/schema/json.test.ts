// What a row's and a changeset's toJSON return: the JSON-ready shape, so that
// JSON.parse(JSON.stringify(x)) deep-equals x.toJSON(), for every built-in type.
import { User as BlogUser } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { createAdapter } from "../adapter/adapter.js";
import type { DriverConnection, DriverCursor, DriverWrapper } from "../adapter/driver.js";
import { cast, change } from "../changeset/changeset.js";
import { POSTGRES_CAPABILITIES } from "../compiler/index.js";
import type { PoolEvent, RawResult } from "../contracts/adapter.js";
import type { AnySchema } from "../contracts/schema.js";
import { SchemaDefinitionError } from "../errors.js";
import { createRepo } from "../repo/repo.js";
import {
  arrayType,
  bigintType,
  binaryType,
  defineType,
  integerType,
  jsonType,
  stringType,
  timestampType,
} from "../types/index.js";
import { belongsTo, EmbeddedSchema, hasMany, hasOne, meta, Schema, t } from "./index.js";
import { converterOf, fieldValueJson, jsonValue } from "./json.js";

/** A loaded row of `schema` from the values of its persisted fields, in order. */
function row<S extends AnySchema>(
  schema: S,
  values: readonly unknown[],
  assocs?: Record<string, unknown>,
): object {
  const m = meta(schema);
  const rowMeta = m.rowMeta("loaded", undefined);
  if (assocs === undefined) return m.create(values, rowMeta);
  return m.createWith(Object.keys(assocs))(values, Object.values(assocs), rowMeta);
}

const toJSON = (value: object): unknown => (value as { toJSON(): unknown }).toJSON();

/** Through JSON.stringify and JSON.parse, as a client receives it. */
const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

class Money {
  constructor(readonly cents: number) {}
  toJSON(): { cents: number } {
    return { cents: this.cents };
  }
}

const MoneyType = defineType<Money, number>({
  name: "money",
  db: { kind: "integer" },
  cast: (input) =>
    typeof input === "number" ? { success: true, data: new Money(input) } : { success: false },
  fromDb: (cents) => new Money(cents),
  toDb: (money) => money.cents,
});

/** A custom type without toJSON of its own. */
const TagsType = defineType<Set<string>, string>({
  name: "tagset",
  db: { kind: "custom", sql: "text" },
  cast: () => ({ success: true, data: new Set() }),
  fromDb: (text) => new Set(text.split(",")),
  toDb: (set) => [...set].join(","),
});

class Point extends EmbeddedSchema({
  lat: t.float(),
  lng: t.float(),
  seenAt: t.timestamp().nullable(),
}) {}

class Every extends Schema("every", {
  id: t.integer().primaryKey(),
  text: t.string(),
  big: t.bigint(),
  bigAsNumber: t.bigint({ mode: "number" }),
  ratio: t.float(),
  price: t.decimal(),
  flag: t.boolean(),
  key: t.uuid(),
  bytes: t.binary(),
  day: t.date(),
  dayAsDate: t.date({ as: "date" }),
  at: t.time(),
  stamp: t.timestamp(),
  wall: t.localTimestamp(),
  doc: t.json<unknown>(),
  numbers: t.array(t.bigint()),
  stamps: t.array(t.timestamp()),
  labels: t.array(t.string()),
  role: t.enum(["admin", "member"]),
  money: t.type(MoneyType),
  tagset: t.type(TagsType),
  point: t.embedOne(() => Point).nullable(),
  points: t.embedMany(() => Point),
  password: t.string().virtual(),
  shown: t.string().virtual({ json: true }),
  secret: t.string().redact(),
}) {}

const STAMP = new Date("2026-10-21T09:30:00.123Z");
const DAY = new Date("2026-10-21T00:00:00.000Z");

function point(lat: number, lng: number, seenAt: Date | null): object {
  return row(Point, [lat, lng, seenAt]);
}

function every(overrides: Partial<Record<string, unknown>> = {}): object {
  const values: Record<string, unknown> = {
    id: 1,
    text: "hello",
    big: 9007199254740993n,
    bigAsNumber: 42,
    ratio: 0.5,
    price: "12.50",
    flag: true,
    key: "0192d4a8-7c1e-7000-8000-000000000001",
    bytes: new Uint8Array([0, 1, 2, 250, 255]),
    day: "2026-10-21",
    dayAsDate: DAY,
    at: "09:30:00",
    stamp: STAMP,
    wall: STAMP,
    doc: { when: STAMP, list: [1, undefined, () => 1], skip: undefined, n: Number.NaN },
    numbers: [1n, null, 3n],
    stamps: [STAMP],
    labels: ["a", "b"],
    role: "admin",
    money: new Money(1250),
    tagset: new Set(["x"]),
    point: point(59.9, 10.7, STAMP),
    points: [point(1, 2, null)],
    secret: "s3cret",
    ...overrides,
  };
  const persisted = meta(Every).persisted.map((field) => values[field.name]);
  return row(Every, persisted);
}

describe("the value of each field type", () => {
  const json = toJSON(every()) as Record<string, unknown>;

  test.each([
    ["t.timestamp()", "stamp", "2026-10-21T09:30:00.123Z"],
    ["t.localTimestamp()", "wall", "2026-10-21T09:30:00.123Z"],
    ['t.date({ as: "date" }): the calendar date', "dayAsDate", "2026-10-21"],
    ["t.date()", "day", "2026-10-21"],
    ["t.time()", "at", "09:30:00"],
    ["t.decimal()", "price", "12.50"],
    ["t.uuid()", "key", "0192d4a8-7c1e-7000-8000-000000000001"],
    ["t.string()", "text", "hello"],
    ["t.enum()", "role", "admin"],
    ["t.bigint(): a decimal string", "big", "9007199254740993"],
    ['t.bigint({ mode: "number" })', "bigAsNumber", 42],
    ["t.integer()", "id", 1],
    ["t.float()", "ratio", 0.5],
    ["t.binary(): base64", "bytes", "AAEC+v8="],
    ["t.boolean()", "flag", true],
  ])("%s", (_label, field, expected) => {
    expect(json[field]).toStrictEqual(expected);
  });

  test("t.json(): mapped as JSON.stringify maps it", () => {
    expect(json.doc).toStrictEqual({ when: "2026-10-21T09:30:00.123Z", list: [1, null, null], n: null });
  });

  test("arrays, element by element", () => {
    expect(json.numbers).toStrictEqual(["1", null, "3"]);
    expect(json.stamps).toStrictEqual(["2026-10-21T09:30:00.123Z"]);
    expect(json.labels).toStrictEqual(["a", "b"]);
    expect(json.labels).not.toBe((every() as { labels: unknown }).labels);
  });

  test("embeds, field by field", () => {
    expect(json.point).toStrictEqual({ lat: 59.9, lng: 10.7, seenAt: "2026-10-21T09:30:00.123Z" });
    expect(json.points).toStrictEqual([{ lat: 1, lng: 2, seenAt: null }]);
  });

  test("a custom type: its toJSON when it has one, else its own properties", () => {
    expect(json.money).toStrictEqual({ cents: 1250 });
    expect(json.tagset).toStrictEqual({});
  });

  test("NaN and the infinities are null, as JSON.stringify writes them; -0 is 0", () => {
    for (const ratio of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect((toJSON(every({ ratio })) as { ratio: unknown }).ratio).toBeNull();
    }
    expect(Object.is((toJSON(every({ ratio: -0 })) as { ratio: unknown }).ratio, 0)).toBe(true);
  });

  test("an invalid Date is null, as Date.prototype.toJSON makes it", () => {
    const invalid = new Date(Number.NaN);
    const out = toJSON(every({ stamp: invalid, dayAsDate: invalid })) as Record<string, unknown>;
    expect(out.stamp).toBeNull();
    expect(out.dayAsDate).toBeNull();
  });

  test("redacted and virtual fields are left out; a virtual { json: true } one only when set", () => {
    expect(Object.keys(json)).not.toContain("secret");
    expect(Object.keys(json)).not.toContain("password");
    expect(Object.keys(json)).not.toContain("shown");
    const withShown = every();
    (withShown as { shown: string; password: string }).shown = "visible";
    (withShown as { shown: string; password: string }).password = "hunter2hunter2";
    const out = toJSON(withShown) as Record<string, unknown>;
    expect(out.shown).toBe("visible");
    expect(Object.keys(out)).not.toContain("password");
  });

  test("keys come in declaration order", () => {
    expect(Object.keys(json)).toEqual(
      meta(Every)
        .fields.filter((field) => field.json && field.name !== "shown")
        .map((field) => field.name),
    );
  });
});

describe("a row with every type through JSON.stringify", () => {
  test("never throws, and reads back as toJSON() returns", () => {
    const value = every();
    expect(() => JSON.stringify(value)).not.toThrow();
    expect(roundTrip(value)).toStrictEqual(toJSON(value));
  });

  test("nulls in every nullable place", () => {
    const value = every({ point: null, points: [] });
    expect(roundTrip(value)).toStrictEqual(toJSON(value));
    expect((toJSON(value) as { point: unknown }).point).toBeNull();
  });
});

class Author extends Schema("authors", {
  id: t.integer().primaryKey(),
  name: t.string(),
  passwordHash: t.string().redact(),
  bornAt: t.timestamp(),
}) {
  static books = hasMany(() => Book, { foreignKey: "authorId" });
  static profile = hasOne(() => Bio, { foreignKey: "authorId" });
}

class Bio extends Schema("bios", { id: t.integer().primaryKey(), authorId: t.integer(), text: t.string() }) {}

class Book extends Schema("books", {
  id: t.integer().primaryKey(),
  authorId: t.integer().nullable(),
  sales: t.bigint(),
}) {
  static author = belongsTo(() => Author);
}

describe("preloaded associations", () => {
  const author = (assocs?: Record<string, unknown>) => row(Author, [1, "Ada", "$hash", STAMP], assocs);

  test("to-one, to-many and null, recursively, with each level mapped", () => {
    const book = row(Book, [10, 1, 5n], { author: author() });
    const orphan = row(Book, [11, null, 0n], { author: null });
    const value = author({ books: [book, orphan], profile: null });
    const json = toJSON(value);
    expect(json).toStrictEqual({
      id: 1,
      name: "Ada",
      bornAt: "2026-10-21T09:30:00.123Z",
      books: [
        {
          id: 10,
          authorId: 1,
          sales: "5",
          author: { id: 1, name: "Ada", bornAt: "2026-10-21T09:30:00.123Z" },
        },
        { id: 11, authorId: null, sales: "0", author: null },
      ],
      profile: null,
    });
    expect(roundTrip(value)).toStrictEqual(json);
    expect(JSON.stringify(value)).not.toContain("$hash");
  });

  test("associations that were not preloaded stay absent, as does one holding undefined", () => {
    expect(Object.keys(toJSON(author()) as object)).toEqual(["id", "name", "bornAt"]);
    expect(Object.keys(toJSON(author({ books: undefined })) as object)).toEqual(["id", "name", "bornAt"]);
  });

  test("an association loaded as a selected shape follows JSON.stringify", () => {
    const value = author({ books: [{ authorId: 1, title: "T", at: STAMP, skip: undefined }] });
    expect((toJSON(value) as { books: unknown }).books).toStrictEqual([
      { authorId: 1, title: "T", at: "2026-10-21T09:30:00.123Z" },
    ]);
  });

  test("an override at a nested level replaces the default there", () => {
    class Summary extends Schema("summaries", { id: t.integer().primaryKey(), authorId: t.integer() }) {
      toJSON(): unknown {
        return { summary: this.id, at: STAMP };
      }
    }
    class Owner extends Schema("owners", { id: t.integer().primaryKey() }) {
      static summaries = hasMany(() => Summary, { foreignKey: "authorId" });
    }
    const value = row(Owner, [1], { summaries: [row(Summary, [7, 1])] });
    expect(toJSON(value)).toStrictEqual({
      id: 1,
      summaries: [{ summary: 7, at: "2026-10-21T09:30:00.123Z" }],
    });
    expect(roundTrip(value)).toStrictEqual(toJSON(value));
  });

  test("an integer-like association name neither hides an association nor leaks a redacted field", () => {
    class Kid extends Schema("kids", { id: t.integer().primaryKey(), ownerId: t.integer() }) {}
    class Owner extends Schema("owners", { id: t.integer().primaryKey(), secret: t.string().redact() }) {
      static "2024" = hasMany(() => Kid, { foreignKey: "ownerId" });
    }
    const value = row(Owner, [1, "s3cret"], { "2024": [row(Kid, [5, 1])] });
    // Object.keys lists "2024" before the fields.
    expect(Object.keys(value)[0]).toBe("2024");
    expect(toJSON(value)).toStrictEqual({ id: 1, "2024": [{ id: 5, ownerId: 1 }] });
    expect(JSON.stringify(value)).not.toContain("s3cret");
  });

  test("an association named __proto__ in JSON data stays an own key", () => {
    const value = author();
    const parsed = JSON.parse('{"__proto__": {"x": 1}}') as Record<string, unknown>;
    (value as Record<string, unknown>).books = [parsed];
    const json = toJSON(value) as { books: Record<string, unknown>[] };
    expect(Object.keys(json.books[0] as object)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(json.books[0])).toBe(Object.prototype);
  });
});

describe("the json flag", () => {
  test("is true by default, false after .redact() and .virtual()", () => {
    class Flags extends Schema("flags", {
      id: t.integer().primaryKey(),
      plain: t.string(),
      hidden: t.string().redact(),
      virtual: t.string().virtual(),
      virtualJson: t.string().virtual({ json: true }),
      virtualFalse: t.string().virtual({ json: false }),
      virtualJsonRedact: t.string().virtual({ json: true }).redact(),
      redactVirtualJson: t.string().redact().virtual({ json: true }),
    }) {}
    const flags = Object.fromEntries(meta(Flags).fields.map((field) => [field.name, field.json]));
    expect(flags).toEqual({
      id: true,
      plain: true,
      hidden: false,
      virtual: false,
      virtualJson: true,
      virtualFalse: false,
      virtualJsonRedact: false,
      redactVirtualJson: false,
    });
  });

  test("virtual() refuses options it does not know", () => {
    const refusal = (options: unknown): unknown => {
      try {
        t.string().virtual(options as never);
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaDefinitionError);
        return { id: (error as SchemaDefinitionError).id, message: (error as Error).message };
      }
      throw new Error("expected virtual() to refuse the options");
    };
    expect(refusal("json")).toMatchObject({
      id: "schema.virtualOptions",
      message: expect.stringContaining("virtual() takes no options, or { json: true }."),
    });
    expect(refusal(null)).toMatchObject({ id: "schema.virtualOptions" });
    expect(refusal({ jsno: true })).toMatchObject({
      id: "schema.virtualUnknownOption",
      message: expect.stringContaining('virtual() has no option "jsno". It takes json.'),
    });
    expect(refusal({ json: true, extra: 1 })).toMatchObject({
      id: "schema.virtualUnknownOption",
      message: expect.stringContaining('no option "extra"'),
    });
    expect(refusal({ json: "yes" })).toMatchObject({
      id: "schema.virtualJsonOption",
      message: expect.stringContaining("virtual(): json must be true or false."),
    });
    expect(
      meta(Schema("v", { id: t.integer().primaryKey(), v: t.string().virtual({}) })).fieldsByName.get("v")
        ?.json,
    ).toBe(false);
  });
});

describe("helpers", () => {
  test("a field that is JSON already has no conversion", () => {
    expect(converterOf(stringType())).toBeUndefined();
    expect(converterOf(integerType())).toBeDefined();
    expect(fieldValueJson(converterOf(bigintType()), 5n)).toBe("5");
    expect(fieldValueJson(converterOf(timestampType()), null)).toBeNull();
    expect(fieldValueJson(undefined, "x")).toBe("x");
  });

  test("a converter given a value of another kind maps it as JSON", () => {
    expect(converterOf(timestampType())?.("2026-10-21")).toBe("2026-10-21");
    expect(converterOf(bigintType())?.(7)).toBe(7);
    expect(converterOf(binaryType())?.("not bytes")).toBe("not bytes");
  });

  test("a custom type stored as a built-in kind is mapped by its value", () => {
    const Label = defineType<{ toJSON(): string }, string>({
      name: "label",
      db: { kind: "text" },
      cast: () => ({ success: false }),
      fromDb: (text) => ({ toJSON: () => text.toUpperCase() }),
      toDb: () => "",
    });
    const Day = defineType<string, string>({
      name: "day",
      db: { kind: "date" },
      cast: () => ({ success: false }),
    });
    expect(converterOf(Label)?.({ toJSON: () => "A" })).toBe("A");
    expect(converterOf(Day)?.("2026-10-21")).toBe("2026-10-21");
    expect(converterOf(Day)?.(DAY)).toBe("2026-10-21");
  });

  test("an array conversion copies, maps each element and writes null for a missing one", () => {
    const labels = converterOf(arrayType(stringType()));
    const source = ["a", undefined, null, "b"];
    expect(labels?.(source)).toStrictEqual(["a", null, null, "b"]);
    expect(labels?.(source)).not.toBe(source);
    expect(labels?.("not a list")).toBe("not a list");
    const nested = converterOf(arrayType(arrayType(bigintType())));
    expect(nested?.([[1n], [2n, 3n]])).toStrictEqual([["1"], ["2", "3"]]);
    const functions = converterOf(jsonType());
    expect(functions?.([() => 1])).toStrictEqual([null]);
    expect(functions?.(Symbol("x"))).toBeUndefined();
    expect(functions?.({ bytes: new Uint8Array([1]) })).toStrictEqual({ bytes: "AQ==" });
    expect(converterOf(arrayType(jsonType()))?.([() => 1, 2])).toStrictEqual([null, 2]);
    const Custom = defineType<string[], string[]>({
      name: "custom list",
      db: { kind: "array", of: { kind: "text" } },
      cast: () => ({ success: false }),
    });
    expect(converterOf(Custom)?.([5n, "a"])).toStrictEqual(["5", "a"]);
  });

  test("jsonValue follows JSON.stringify", () => {
    const value = {
      a: 1,
      b: undefined,
      c: () => 1,
      d: Symbol("x"),
      e: [undefined, Symbol("y")],
      f: new Date(0),
      g: Object(5) as unknown,
      h: Object("s") as unknown,
      i: Object(true) as unknown,
      j: new Map([[1, 2]]),
      k: new Uint8Array([1]),
      l: Number.POSITIVE_INFINITY,
    };
    expect(jsonValue(value)).toStrictEqual(roundTrip(value));
    expect(jsonValue(undefined)).toBeUndefined();
    expect(jsonValue(() => 1)).toBeUndefined();
    expect(jsonValue(5n)).toBe(5n);
  });
});

// --- the sign-up case: a write's row and the changeset ------------------------------

class FakeDriver implements DriverWrapper {
  init(): void {}
  async acquire(): Promise<DriverConnection> {
    return {
      async query(): Promise<RawResult> {
        return { rows: [{ c0: 1 }], rowCount: 1, insertId: undefined };
      },
      async cursor(): Promise<DriverCursor> {
        throw new Error("no cursors here");
      },
      async cancel(): Promise<void> {},
      inTransaction: () => false,
    };
  }
  async release(): Promise<void> {}
  async destroy(): Promise<void> {}
  stats(): PoolEvent {
    return { size: 1, idle: 1, waiting: 0 };
  }
  saturated(): boolean {
    return false;
  }
}

function fakeRepo() {
  const driver = new FakeDriver();
  return createRepo({
    adapter: createAdapter({
      dialect: "postgres",
      capabilities: POSTGRES_CAPABILITIES,
      quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
      driver: () => driver,
      driverCodecs: {},
      normalizeError: (error) => error,
    }),
  });
}

describe("signing up", () => {
  const params = { email: "ada@example.com", password: "hunter2hunter2" };

  test("the changeset's JSON has no password", () => {
    const cs = cast(BlogUser, params, ["email", "password"]);
    expect(cs.changes).toMatchObject({ password: "hunter2hunter2" });
    const text = JSON.stringify(cs);
    expect(text).not.toContain("hunter2hunter2");
    expect(roundTrip(cs)).toStrictEqual(toJSON(cs));
    expect((toJSON(cs) as { changes: unknown }).changes).toStrictEqual({ email: "ada@example.com" });
  });

  test("the row the insert returns keeps the password, but its JSON does not", async () => {
    const user = await fakeRepo().insertOrThrow(cast(BlogUser, params, ["email", "password"]));
    expect(user.password).toBe("hunter2hunter2");
    const text = JSON.stringify(user);
    expect(text).not.toContain("hunter2hunter2");
    expect(roundTrip(user)).toStrictEqual(toJSON(user));
    expect(Object.keys(toJSON(user) as object)).not.toContain("password");
  });
});

describe("a changeset's JSON", () => {
  test("maps the changes as a row's toJSON does, and never throws", () => {
    const cs = change(Every, {
      big: 5n,
      bytes: new Uint8Array([1, 2, 3]),
      stamp: STAMP,
      secret: "s3cret",
      password: "pw",
      shown: "yes",
      dayAsDate: DAY,
    });
    expect(() => JSON.stringify(cs)).not.toThrow();
    const json = toJSON(cs) as { changes: Record<string, unknown> };
    expect(json.changes).toStrictEqual({
      big: "5",
      bytes: "AQID",
      stamp: "2026-10-21T09:30:00.123Z",
      shown: "yes",
      dayAsDate: "2026-10-21",
    });
    expect(roundTrip(cs)).toStrictEqual(json);
  });

  test("nested changesets of embeds and associations are written as JSON, without hidden fields", () => {
    const cs = change(BlogUser, { email: "a@b.c", password: "pw" })
      .putEmbed("settings", { theme: "dark" })
      .putAssoc("posts", [{ title: "Hi", publishedAt: STAMP }]);
    const json = toJSON(cs) as { changes: Record<string, unknown> };
    expect(json.changes).toMatchObject({
      email: "a@b.c",
      settings: { changes: { theme: "dark" } },
      posts: [{ changes: { title: "Hi", publishedAt: "2026-10-21T09:30:00.123Z" } }],
    });
    expect(JSON.stringify(cs)).not.toContain('"pw"');
    expect(roundTrip(cs)).toStrictEqual(json);
  });

  test("errors whose metadata holds a bigint are written with a decimal string", () => {
    const cs = change(Every, { big: 50n }).validateNumber("big", { lessThan: 10n });
    expect(cs.errors.big?.[0]?.meta).toMatchObject({ number: 10n });
    expect(() => JSON.stringify(cs)).not.toThrow();
    const json = toJSON(cs) as { errors: Record<string, { meta: Record<string, unknown> }[]> };
    expect(json.errors.big?.[0]?.meta).toMatchObject({ number: "10" });
    expect(roundTrip(cs)).toStrictEqual(json);
  });
});
