import { describe, expect, test, vi } from "vitest";
import { IDENTITY } from "../contracts/type.js";
import { SchemaDefinitionError } from "../errors.js";
import { embedTypeInfo } from "../types/embed.js";
import {
  arrayType,
  bigintType,
  binaryType,
  booleanType,
  dateType,
  decimalType,
  defineType,
  elementTypeOf,
  floatType,
  integerType,
  jsonType,
  localTimestampType,
  stringType,
  timestampType,
  timeType,
  uuidType,
} from "../types/index.js";
import { EmbeddedSchema, fieldState, fieldTypeOf, t, timestamps } from "./index.js";

const state = (builder: unknown) => {
  const found = fieldState(builder);
  if (found === undefined) throw new Error("not a builder");
  return found;
};

describe("t", () => {
  test("each function wraps the built-in type of the same name", () => {
    expect(fieldTypeOf(t.string())).toBe(stringType());
    expect(fieldTypeOf(t.integer())).toBe(integerType());
    expect(fieldTypeOf(t.bigint())).toBe(bigintType());
    expect(fieldTypeOf(t.bigint({ mode: "bigint" }))).toBe(bigintType());
    expect(fieldTypeOf(t.bigint({ mode: "number" }))).toBe(bigintType({ mode: "number" }));
    expect(fieldTypeOf(t.float())).toBe(floatType());
    expect(fieldTypeOf(t.decimal())).toBe(decimalType());
    expect(fieldTypeOf(t.decimal({ precision: 10, scale: 2 }))).toBe(
      decimalType({ precision: 10, scale: 2 }),
    );
    expect(fieldTypeOf(t.boolean())).toBe(booleanType());
    expect(fieldTypeOf(t.uuid())).toBe(uuidType());
    expect(fieldTypeOf(t.binary())).toBe(binaryType());
    expect(fieldTypeOf(t.date())).toBe(dateType());
    expect(fieldTypeOf(t.date({ as: "string" }))).toBe(dateType());
    expect(fieldTypeOf(t.date({ as: "date" }))).toBe(dateType({ as: "date" }));
    expect(fieldTypeOf(t.time())).toBe(timeType());
    expect(fieldTypeOf(t.timestamp())).toBe(timestampType());
    expect(fieldTypeOf(t.timestamp({ precision: "s" }))).toBe(timestampType({ precision: "s" }));
    expect(fieldTypeOf(t.localTimestamp())).toBe(localTimestampType());
    expect(fieldTypeOf(t.localTimestamp({ precision: "us" }))).toBe(localTimestampType({ precision: "us" }));
    expect(fieldTypeOf(t.json())).toBe(jsonType());
  });

  test("an array wraps the type of its element", () => {
    expect(fieldTypeOf(t.array(t.integer()))).toBe(arrayType(integerType()));
    const nested = fieldTypeOf(t.array(t.array(t.string())));
    expect(nested.name).toBe("array(array(string))");
    expect(elementTypeOf(nested)).toBe(arrayType(stringType()));
  });

  test("an enum takes a list or a mapping", () => {
    const list = fieldTypeOf(t.enum(["admin", "member"]));
    expect(list.cast("admin")).toEqual({ success: true, data: "admin" });
    expect(list.cast("owner").success).toBe(false);
    expect(list.db).toEqual({ kind: "text" });
    const mapping = fieldTypeOf(t.enum({ low: 1, high: 2 }));
    expect(mapping.toDb("high")).toBe(2);
    expect(mapping.db).toEqual({ kind: "integer" });
  });

  test("a custom type is used as it is", () => {
    const slug = defineType<string>({
      name: "slug",
      db: { kind: "text" },
      cast: (input) => (typeof input === "string" ? { success: true, data: input } : { success: false }),
    });
    expect(fieldTypeOf(t.type(slug))).toBe(slug);
    expect(fieldTypeOf(t.type(slug)).fromDb).toBe(IDENTITY);
  });

  test("a new builder has no modifier applied", () => {
    expect(state(t.string())).toEqual({
      type: stringType(),
      nullable: false,
      primaryKey: false,
      virtual: false,
      redact: false,
      writable: "always",
      dbGenerated: false,
      default: undefined,
      autogenerate: undefined,
      column: undefined,
      embed: undefined,
    });
  });

  test("t cannot be added to or changed", () => {
    expect(Object.isFrozen(t)).toBe(true);
  });

  test("what is not a type is refused, with the fix", () => {
    expect(() => t.array("string" as never)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.arrayElement: t.array() takes a field type with no modifiers, such as t.array(t.string()). Put the modifiers on the array: t.array(t.string()).nullable(). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-arrayelement]`,
    );
    expect(() => t.array(t.string().nullable() as never)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.arrayElement: t.array() takes a field type with no modifiers, such as t.array(t.string()). Put the modifiers on the array: t.array(t.string()).nullable(). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-arrayelement]`,
    );
    expect(() => t.array(t.embedOne(() => EmbeddedSchema({ a: t.string() })) as never)).toThrow(
      SchemaDefinitionError,
    );
    expect(() => t.type("money" as never)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.typeNotDefined: t.type() takes a type made with defineType(): t.type(MoneyType). For a built-in type use its own function, such as t.string(). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-typenotdefined]`,
    );
    expect(() => t.type(null as never)).toThrow(SchemaDefinitionError);
    expect(() => t.type({ name: "x" } as never)).toThrow(SchemaDefinitionError);
    expect(() => fieldTypeOf("integer")).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.notFieldTypeValue: Expected a field type such as t.integer() or t.string(). Use a field type from t, such as t.integer() or t.string(), or a type made with defineType() and wrapped as t.type(MyType). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-notfieldtypevalue]`,
    );
    expect(() => fieldTypeOf(null)).toThrow(SchemaDefinitionError);
    expect(() => fieldTypeOf({})).toThrow(SchemaDefinitionError);
    expect(fieldState(42)).toBeUndefined();
  });
});

describe("modifiers", () => {
  test("each returns a new builder and leaves the receiver as it was", () => {
    const base = t.string();
    const modified = [
      base.nullable(),
      base.default("x"),
      base.primaryKey(),
      base.autogenerate(() => "x"),
      base.virtual(),
      base.column("col"),
      base.redact(),
      base.dbGenerated(),
      base.writable("insert"),
    ];
    for (const builder of modified) {
      expect(builder).not.toBe(base);
      expect(state(builder)).not.toEqual(state(base));
    }
    expect(state(base).nullable).toBe(false);
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.keys(base)).toEqual([]);
  });

  test("each sets what it says", () => {
    expect(state(t.string().nullable()).nullable).toBe(true);
    expect(state(t.string().virtual()).virtual).toBe(true);
    expect(state(t.string().redact()).redact).toBe(true);
    expect(state(t.string().dbGenerated()).dbGenerated).toBe(true);
    expect(state(t.string().column("pw_hash")).column).toBe("pw_hash");
    expect(state(t.string().writable("never")).writable).toBe("never");
    expect(state(t.string().writable("insert")).writable).toBe("insert");
    expect(state(t.string().writable("insert").writable("always")).writable).toBe("always");
  });

  test("modifiers accumulate in any order", () => {
    const a = state(t.string().nullable().redact().column("c").writable("insert"));
    const b = state(t.string().writable("insert").column("c").redact().nullable());
    expect(a).toEqual(b);
  });

  test("a default is kept as a value or as a function", () => {
    expect(state(t.integer().default(0)).default).toEqual({ kind: "value", value: 0 });
    expect(state(t.string().nullable().default(null)).default).toEqual({ kind: "value", value: null });
    const fn = (): string[] => [];
    expect(state(t.json<string[]>().default(fn)).default).toEqual({ kind: "fn", fn });
    expect(Object.isFrozen(state(t.integer().default(0)).default)).toBe(true);
    expect(() => t.integer().default(undefined as never)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.defaultValue: default() needs a value, or a function that returns one. To allow a missing value, use nullable(). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-defaultvalue]`,
    );
  });

  test("primaryKey marks a key and says nothing about generation", () => {
    expect(state(t.integer().primaryKey())).toMatchObject({ primaryKey: true, dbGenerated: false });
    expect(state(t.integer().primaryKey().dbGenerated())).toMatchObject({
      primaryKey: true,
      dbGenerated: true,
    });
  });

  test("autogenerate takes a function, used on insert", () => {
    const fn = (): string => "generated";
    expect(state(t.string().autogenerate(fn)).autogenerate).toEqual({ on: "insert", fn });
    expect(() => t.string().autogenerate("x" as never)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.autogenerateFunction: autogenerate() takes a function that returns the value. Pass a function that makes the value, such as autogenerate(() => crypto.randomUUID()). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-autogeneratefunction]`,
    );
  });

  test("autogenerate without a function makes a UUID v7 for a uuid field", () => {
    const generate = state(t.uuid().autogenerate()).autogenerate?.fn as
      | ((arg?: unknown) => unknown)
      | undefined;
    // An argument passed by whoever calls it is not taken for the time.
    expect(String(generate?.(0)).slice(0, 13)).not.toBe("00000000-0000");
    const first = generate?.();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(generate?.()).not.toBe(first);
  });

  test("autogenerate without a function gives the current time for a timestamp, at the type's precision", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-13T12:34:56.789Z"));
      expect(state(t.timestamp().autogenerate()).autogenerate?.fn()).toEqual(
        new Date("2026-10-13T12:34:56.789Z"),
      );
      expect(state(t.localTimestamp().autogenerate()).autogenerate?.fn()).toEqual(
        new Date("2026-10-13T12:34:56.789Z"),
      );
      expect(state(t.timestamp({ precision: "s" }).autogenerate()).autogenerate?.fn()).toEqual(
        new Date("2026-10-13T12:34:56.000Z"),
      );
      vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
      expect(state(t.timestamp().autogenerate()).autogenerate?.fn()).toEqual(
        new Date("2027-01-01T00:00:00.000Z"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("autogenerate without a function is refused for a type with no obvious value", () => {
    expect(() => t.integer().autogenerate()).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.autogenerateType: autogenerate() without a function has no value to make for the type integer. autogenerate() without a function works for t.uuid() (a UUID v7) and for timestamps (the current time). For other types, pass the function: autogenerate(() => value). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-autogeneratetype]`,
    );
    expect(() => t.string().autogenerate()).toThrow(SchemaDefinitionError);
    // A column of kind timestamp whose type does not take a Date has no "now" either.
    const epoch = defineType<number, Date>({
      name: "epoch",
      db: { kind: "timestamptz" },
      cast: (input) => (typeof input === "number" ? { success: true, data: input } : { success: false }),
      fromDb: (stored) => stored.getTime(),
      toDb: (ms) => new Date(ms),
    });
    expect(() => t.type(epoch).autogenerate()).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.autogenerateType: autogenerate() without a function has no value to make for the type epoch. autogenerate() without a function works for t.uuid() (a UUID v7) and for timestamps (the current time). For other types, pass the function: autogenerate(() => value). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-autogeneratetype]`,
    );
  });

  test("a wrong argument is refused when the modifier is called", () => {
    expect(() => t.string().column("")).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.columnName: column() needs the column name as a non-empty string. Pass the column name, as in column("pw_hash"). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-columnname]`,
    );
    expect(() => t.string().column(1 as never)).toThrow(SchemaDefinitionError);
    expect(() => t.string().writable("sometimes" as never)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.writableOption: writable() takes "always", "insert" or "never". Pass "always" (the default), "insert" for a field set only when the row is inserted, or "never" for a field only the database writes. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-writableoption]`,
    );
  });
});

describe("embeds", () => {
  class Address extends EmbeddedSchema({ street: t.string() }) {}

  test("an embed is a JSON field that remembers its schema", () => {
    const one = state(t.embedOne(() => Address));
    expect(one.type.db).toEqual({ kind: "jsonb" });
    expect(embedTypeInfo(one.type)).toMatchObject({ cardinality: "one", onReplace: "error" });
    expect(embedTypeInfo(one.type)?.schema()).toBe(Address);
    expect(one.embed?.cardinality).toBe("one");
    expect(one.embed?.schema()).toBe(Address);
    expect(one.embed?.onReplace).toBe("error");
    expect(one.default).toBeUndefined();
    expect(state(t.embedOne(() => Address, { onReplace: "update" })).embed?.onReplace).toBe("update");
    expect(state(t.embedOne(() => Address).nullable()).embed?.schema()).toBe(Address);
  });

  test("a list of embeds starts as a new empty list for every record", () => {
    const many = state(t.embedMany(() => Address, { onReplace: "delete" }));
    expect(many.embed).toMatchObject({ cardinality: "many", onReplace: "delete" });
    const initial = many.default;
    if (initial?.kind !== "fn") throw new Error("expected a function default");
    expect(initial.fn()).toEqual([]);
    expect(initial.fn()).not.toBe(initial.fn());
  });

  test("the schema is given as a function, and onReplace is one of the embed modes", () => {
    expect(() => t.embedOne(Address as never)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.embedSchemaThunk: t.embedOne() takes a function that returns the embedded schema class. Pass a function that returns the class, as in t.embedOne(() => Address) or t.embedMany(() => Address), so that the class may be declared after the field. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-embedschemathunk]`,
    );
    expect(() => t.embedMany("Address" as never)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.embedSchemaThunk: t.embedMany() takes a function that returns the embedded schema class. Pass a function that returns the class, as in t.embedOne(() => Address) or t.embedMany(() => Address), so that the class may be declared after the field. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-embedschemathunk]`,
    );
    expect(() =>
      t.embedOne(() => Address, { onReplace: "setNull" as never }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.onReplaceOption: t.embedOne(): onReplace must be one of "error", "invalid", "update", "delete". Pick one of the listed modes; "error" (the default) refuses to replace an existing embed. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-onreplaceoption]`,
    );
    expect(() => t.embedMany(() => Address, { onReplace: "update" })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.onReplaceOption: t.embedMany(): onReplace must be one of "error", "invalid", "delete". Pick one of the listed modes; "error" (the default) refuses to replace an existing embed. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-onreplaceoption]`,
    );
  });
});

describe("timestamps", () => {
  test("gives createdAt, set on insert, and updatedAt, set on insert and update", () => {
    const fields = timestamps();
    expect(Object.keys(fields)).toEqual(["createdAt", "updatedAt"]);
    expect(state(fields.createdAt)).toMatchObject({ type: timestampType(), nullable: false });
    expect(state(fields.createdAt).autogenerate?.on).toBe("insert");
    expect(state(fields.updatedAt).autogenerate?.on).toBe("insertAndUpdate");
    expect(state(fields.createdAt).autogenerate?.fn()).toBeInstanceOf(Date);
  });

  test("a field can be renamed or left out", () => {
    expect(Object.keys(timestamps({ createdAt: "insertedAt" }))).toEqual(["insertedAt", "updatedAt"]);
    expect(Object.keys(timestamps({ updatedAt: "modifiedAt" }))).toEqual(["createdAt", "modifiedAt"]);
    expect(Object.keys(timestamps({ updatedAt: false }))).toEqual(["createdAt"]);
    expect(Object.keys(timestamps({ createdAt: false }))).toEqual(["updatedAt"]);
    expect(Object.keys(timestamps({ createdAt: false, updatedAt: false }))).toEqual([]);
  });

  test("the result spreads into a fields object, even with a name that is refused later", () => {
    const fields = { id: t.integer(), ...timestamps({ createdAt: "__proto__" }) };
    expect(Object.keys(fields)).toEqual(["id", "__proto__", "updatedAt"]);
  });

  test("another timestamp type sets the type and the precision of the generated time", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-13T12:34:56.789Z"));
      const fields = timestamps({ type: t.localTimestamp({ precision: "s" }) });
      expect(state(fields.createdAt).type).toBe(localTimestampType({ precision: "s" }));
      expect(state(fields.updatedAt).autogenerate?.fn()).toEqual(new Date("2026-10-13T12:34:56.000Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  test("wrong options are refused, with the fix", () => {
    expect(() => timestamps({ createdAt: "" })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.timestampsField: timestamps(): createdAt must be a field name, or false to leave the field out. Pass the field name as a string, as in timestamps({ createdAt: "insertedAt" }), or false to leave that field out. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-timestampsfield]`,
    );
    expect(() => timestamps({ updatedAt: true as never })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.timestampsField: timestamps(): updatedAt must be a field name, or false to leave the field out. Pass the field name as a string, as in timestamps({ createdAt: "insertedAt" }), or false to leave that field out. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-timestampsfield]`,
    );
    expect(() => timestamps({ createdAt: "at", updatedAt: "at" })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.timestampsSameName: timestamps(): createdAt and updatedAt are both named "at". Give them different names, or pass false for one. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-timestampssamename]`,
    );
    expect(() => timestamps({ type: t.string() as never })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.timestampsType: timestamps(): type must be a timestamp type with no modifiers, such as t.timestamp() or t.localTimestamp(). Pass a timestamp type such as t.timestamp() or t.localTimestamp(), without modifiers: timestamps() adds its own. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-timestampstype]`,
    );
    expect(() => timestamps({ type: t.timestamp().nullable() as never })).toThrow(SchemaDefinitionError);
    expect(() => timestamps({ type: "timestamp" as never })).toThrow(SchemaDefinitionError);
  });
});
