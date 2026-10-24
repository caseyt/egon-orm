import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test, vi } from "vitest";
import type { ValidationIssue, ValidatorContext } from "../../contracts/changeset.js";
import type { AnySchema, Row } from "../../contracts/schema.js";
import type { StandardSchemaV1, StandardSchemaV1Result } from "../../contracts/standard-schema.js";
import { QueryError } from "../../errors.js";
import { EmbeddedSchema, hasMany, hasOne, meta, Schema, t } from "../../schema/index.js";
import { type Changeset, cast, change, withAction } from "../changeset.js";
import { BASE } from "./types.js";

/** A row of `schema` as a query would return it. */
function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

/** A Standard Schema written by hand: what any library's schema looks like to the changeset. */
function standard(
  validate: (value: unknown) => StandardSchemaV1Result<unknown> | Promise<StandardSchemaV1Result<unknown>>,
): StandardSchemaV1 {
  return { "~standard": { version: 1, vendor: "handmade", validate } };
}

/** A Standard Schema that records what it was given and reports `issues`. */
function recording(issues: StandardSchemaV1Result<unknown>["issues"] = undefined) {
  const seen: unknown[] = [];
  const schema = standard((value) => {
    seen.push(value);
    return issues === undefined ? { value } : { issues };
  });
  return { schema, seen };
}

const joined = new Date("2026-02-01T08:00:00Z");
const ada = (): User =>
  loaded(User, {
    id: 11,
    email: "ada@engine.example",
    name: "Ada",
    age: 36,
    role: "admin",
    lockVersion: 2,
    createdAt: joined,
    updatedAt: joined,
  });

class Meetup extends Schema("meetups", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  startsAt: t.timestamp(),
  endsAt: t.timestamp(),
}) {}

const nineAm = new Date("2026-05-04T09:00:00Z");
const tenAm = new Date("2026-05-04T10:00:00Z");
const elevenAm = new Date("2026-05-04T11:00:00Z");
const standup = (): Meetup => loaded(Meetup, { id: 3, title: "Standup", startsAt: tenAm, endsAt: elevenAm });

describe("validate: dispatch", () => {
  test("calls a Standard Schema's validate with the values", () => {
    const { schema, seen } = recording();
    cast(User, { email: "lin@shell.example" }, ["email"]).validate(schema);
    expect(seen).toHaveLength(1);
  });

  test("calls a function with the values and a context", () => {
    const fn = vi.fn(() => []);
    cast(User, { email: "lin@shell.example" }, ["email"]).validate(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("treats a callable value with a ~standard property as a Standard Schema", () => {
    const calls: string[] = [];
    const callable = Object.assign(() => calls.push("called as a function"), {
      "~standard": {
        version: 1 as const,
        vendor: "callable",
        validate: (value: unknown) => {
          calls.push("validated");
          return { value };
        },
      },
    });
    cast(User, {}, []).validate(callable);
    expect(calls).toEqual(["validated"]);
  });

  test("reads ~standard once, so a getter works", () => {
    let reads = 0;
    const schema = {
      get "~standard"() {
        reads++;
        return { version: 1 as const, vendor: "getter", validate: (value: unknown) => ({ value }) };
      },
    };
    expect(cast(User, {}, []).validate(schema).valid).toBe(true);
    expect(reads).toBe(1);
  });

  test("refuses anything else with a TypeError that names what it got", () => {
    const cs = cast(User, {}, []);
    const cases: [unknown, RegExp][] = [
      [null, /got null/],
      [undefined, /got undefined/],
      ["email", /got a string/],
      [42, /got a number/],
      [[], /got an array/],
      [{ validate: () => [] }, /got an object without a Standard Schema "~standard" property/],
      [{ "~standard": { version: 2, vendor: "next", validate: () => ({}) } }, /version 2/],
      [{ "~standard": { version: 1, vendor: "broken" } }, /"~standard" property of an object/],
      [{ "~standard": "yes" }, /"~standard" property of a string/],
      [{ "~standard": null }, /"~standard" property of null/],
    ];
    for (const [validator, message] of cases) {
      expect(() => cs.validate(validator as never)).toThrow(TypeError);
      expect(() => cs.validate(validator as never)).toThrow(message);
    }
  });
});

describe("validate: what the validator receives", () => {
  test("a new record: every field with the changes applied and the defaults, in field order", () => {
    const { schema, seen } = recording();
    cast(User, { email: "hopper@cobol.example", age: "85" }, ["email", "age"]).validate(schema);
    const values = seen[0] as Record<string, unknown>;
    expect(values).toEqual({
      email: "hopper@cobol.example",
      name: null,
      age: 85,
      role: "member",
      passwordHash: null,
      settings: null,
      lockVersion: 1,
    });
    expect(Object.keys(values)).toEqual(
      meta(User)
        .fields.map((f) => f.name)
        .filter((n) => n in values),
    );
  });

  test("a new record: a field with no value and no default is left out, not set to undefined", () => {
    const { schema, seen } = recording();
    cast(User, {}, ["email"]).validate(schema);
    const values = seen[0] as Record<string, unknown>;
    expect(Object.hasOwn(values, "email")).toBe(false);
    expect(Object.hasOwn(values, "id")).toBe(false);
  });

  test("a loaded row: the row's values overlaid with the changes, as converted values", () => {
    const { schema, seen } = recording();
    cast(ada(), { age: "37", name: "Ada L." }, ["age", "name"]).validate(schema);
    const values = seen[0] as Record<string, unknown>;
    expect(values).toMatchObject({
      id: 11,
      email: "ada@engine.example",
      name: "Ada L.",
      age: 37,
      role: "admin",
    });
    expect(values.createdAt).toBeInstanceOf(Date);
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
  });

  test("includes virtual fields that have a value", () => {
    const { schema, seen } = recording();
    cast(User, { password: "correct horse" }, ["password"]).validate(schema);
    expect((seen[0] as Record<string, unknown>).password).toBe("correct horse");
  });

  test("a schemaless changeset: the data overlaid with the changes", () => {
    const { schema, seen } = recording();
    cast({ data: { q: "old" }, types: { q: t.string(), page: t.integer().default(1) } }, { q: "new" }, [
      "q",
    ]).validate(schema);
    expect(seen[0]).toEqual({ q: "new", page: 1 });
  });

  test("only narrows the object to those fields, still in field order", () => {
    const { schema, seen } = recording();
    cast(ada(), { name: "Countess" }, ["name"]).validate(schema, { only: ["name", "email"] });
    expect(seen[0]).toEqual({ email: "ada@engine.example", name: "Countess" });
    expect(Object.keys(seen[0] as object)).toEqual(["email", "name"]);
  });

  test("only keeps a nested change of a listed embed, and leaves out one that is not listed", () => {
    const withSettings = () => change(ada()).putEmbed("settings", { theme: "dark" } as never);
    const listed = recording();
    withSettings().validate(listed.schema, { only: ["settings"] });
    expect(listed.seen[0]).toMatchObject({ settings: { theme: "dark" } });
    const other = recording();
    withSettings().validate(other.schema, { only: ["email"] });
    expect(other.seen[0]).toEqual({ email: "ada@engine.example" });
  });

  test("a validator whose output is not an object writes nothing", () => {
    for (const value of [null, "x", 5]) {
      const cs = cast(ada(), { name: "Countess" }, ["name"]).validate(
        standard(() => ({ value })),
        { apply: true },
      );
      expect(cs.changes).toEqual({ name: "Countess" });
      expect(cs.valid).toBe(true);
    }
  });

  test("only leaves out a listed field that has no value", () => {
    const { schema, seen } = recording();
    cast(User, { name: "Lin" }, ["name"]).validate(schema, { only: ["email", "name", "role"] });
    expect(seen[0]).toEqual({ name: "Lin", role: "member" });
  });

  test("a field named like an Object.prototype member is read from the changes only when it is one", () => {
    class Widget extends Schema(
      "widgets",
      { valueOf: t.string().nullable(), hasOwnProperty: t.integer().default(7) },
      { primaryKey: false },
    ) {}
    const { schema, seen } = recording();
    cast(Widget, {}, []).validate(schema);
    cast(Widget, { valueOf: "v" }, ["valueOf"]).validate(schema);
    expect(seen).toEqual([
      { valueOf: null, hasOwnProperty: 7 },
      { valueOf: "v", hasOwnProperty: 7 },
    ]);
  });

  test("a function receives the changes, the action and isChanged in its context", () => {
    let ctx: ValidatorContext<Record<string, unknown>> | undefined;
    const cs = cast(ada(), { name: "Lovelace" }, ["name"]);
    cs.validate((_values, context) => {
      ctx = context as ValidatorContext<Record<string, unknown>>;
    });
    expect(ctx?.changes).toBe(cs.changes);
    expect(ctx?.action).toBeNull();
    expect(ctx?.isChanged("name")).toBe(true);
    expect(ctx?.isChanged("email")).toBe(false);
  });

  test("isChanged works when destructured", () => {
    const seen: boolean[] = [];
    cast(ada(), { age: "40" }, ["age"]).validate((_v, { isChanged }) => {
      seen.push(isChanged("age"), isChanged("name"));
    });
    expect(seen).toEqual([true, false]);
  });

  test("ctx.data is the row for a loaded row", () => {
    const row = ada();
    let data: unknown;
    cast(row, { name: "A." }, ["name"]).validate((_v, ctx) => {
      data = ctx.data;
    });
    expect(data).toBe(row);
  });

  test("ctx.data is never null: for a new record it holds the defaults, undefined where there is none", () => {
    let data: Readonly<Record<string, unknown>> | undefined;
    cast(User, { email: "new@user.example" }, ["email"]).validate((_v, ctx) => {
      data = ctx.data as Readonly<Record<string, unknown>>;
    });
    expect(data).toMatchObject({ role: "member", lockVersion: 1, name: null });
    expect(data !== undefined && Object.hasOwn(data, "email")).toBe(true);
    expect(data?.email).toBeUndefined();
    expect(Object.isFrozen(data)).toBe(true);
  });

  test("ctx.data of a new record is built once per call", () => {
    let first: unknown;
    let second: unknown;
    cast(User, {}, []).validate((_v, ctx) => {
      first = ctx.data;
      second = ctx.data;
    });
    expect(first).toBe(second);
  });

  test("a default given as a function is evaluated once per validation, shared by the values and ctx.data", () => {
    let calls = 0;
    class Ticket extends Schema("tickets", {
      id: t.integer().primaryKey().dbGenerated(),
      number: t.integer().default(() => ++calls),
    }) {}
    const seen: [unknown, unknown][] = [];
    cast(Ticket, {}, []).validate((values, ctx) => {
      seen.push([values.number, ctx.data.number]);
    });
    expect(seen).toEqual([[1, 1]]);
    expect(calls).toBe(1);
  });

  test("ctx.data of a schemaless changeset is its data object", () => {
    const data = { q: "old" };
    let seen: unknown;
    cast({ data, types: { q: t.string() } }, { q: "new" }, ["q"]).validate((_v, ctx) => {
      seen = ctx.data;
    });
    expect(seen).toBe(data);
  });

  test("ctx.action is the changeset's action", () => {
    const seen: unknown[] = [];
    const cs = change(ada(), { name: "Byron" });
    const record = (_v: unknown, ctx: { readonly action: unknown }) => {
      seen.push(ctx.action);
    };
    cs.validate(record);
    withAction(cs, "update").validate(record);
    expect(seen).toEqual([null, "update"]);
  });
});

describe("validate: issue mapping", () => {
  test("an issue becomes an error on the field its path starts with", () => {
    const cs = cast(User, { email: "nope" }, ["email"]).validate(
      standard(() => ({ issues: [{ message: "is not an email address", path: ["email"] }] })),
    );
    expect(cs.valid).toBe(false);
    expect(cs.errors).toEqual({
      email: [{ message: "is not an email address", validation: "schema", meta: { path: [] } }],
    });
  });

  test("the rest of the path goes to meta.path", () => {
    const cs = cast(User, {}, []).validate(
      standard(() => ({ issues: [{ message: "is not a theme", path: ["settings", "theme"] }] })),
    );
    expect(cs.errors.settings).toEqual([
      { message: "is not a theme", validation: "schema", meta: { path: ["theme"] } },
    ]);
  });

  test("{ key } path segments are unwrapped", () => {
    const cs = cast(User, {}, []).validate(
      standard(() => ({
        issues: [{ message: "is too long", path: [{ key: "settings" }, "theme", { key: 0 }] }],
      })),
    );
    expect(cs.errors.settings?.[0]?.meta).toEqual({ path: ["theme", 0] });
  });

  test("a path given as an array subclass is stored as a plain array", () => {
    class Path extends Array<PropertyKey> {
      readonly cache = {};
    }
    const path = Path.from(["settings", "theme"]) as Path;
    const cs = cast(User, {}, []).validate(
      standard(() => ({ issues: [{ message: "is not a theme", path }] })),
    );
    const stored = cs.errors.settings?.[0]?.meta.path;
    expect(stored).toStrictEqual(["theme"]);
    expect(Object.getPrototypeOf(stored)).toBe(Array.prototype);
  });

  test("an issue with an empty or missing path goes to BASE", () => {
    const cs = cast(User, {}, []).validate(
      standard(() => ({ issues: [{ message: "is not allowed" }, { message: "is a duplicate", path: [] }] })),
    );
    expect(BASE).toBe("$base");
    expect(cs.errors).toEqual({
      $base: [
        { message: "is not allowed", validation: "schema", meta: { path: [] } },
        { message: "is a duplicate", validation: "schema", meta: { path: [] } },
      ],
    });
  });

  test("an issue for a key that is not a field goes to BASE with its whole path", () => {
    const cs = cast(User, {}, []).validate(
      standard(() => ({
        issues: [
          { message: "must be accepted", path: ["termsOfService"] },
          { message: "is wrong", path: [{ key: 0 }, "x"] },
          { message: "is reserved", path: ["__proto__"] },
        ],
      })),
    );
    expect(cs.errors[BASE]?.map((error) => error.meta)).toEqual([
      { path: ["termsOfService"] },
      { path: [0, "x"] },
      { path: ["__proto__"] },
    ]);
    expect(Object.keys(cs.errors)).toEqual([BASE]);
  });

  test("an association name is not a field, so its issues go to BASE (until nested changesets)", () => {
    const cs = cast(Post, {}, []).validate(
      standard(() => ({ issues: [{ message: "is invalid", path: ["comments", 0, "body"] }] })),
    );
    expect(cs.errors[BASE]?.[0]?.meta).toEqual({ path: ["comments", 0, "body"] });
  });

  test("a function's issue may name the field with a plain key, and carry meta", () => {
    const cs = cast(User, {}, []).validate(() => [
      { path: "email", message: "is taken by {owner}", meta: { owner: "someone" } },
      { path: ["age", "years"], message: "is odd" },
    ]);
    expect(cs.errors).toEqual({
      email: [{ message: "is taken by {owner}", validation: "schema", meta: { path: [], owner: "someone" } }],
      age: [{ message: "is odd", validation: "schema", meta: { path: ["years"] } }],
    });
    expect(cs.errorMessages()).toEqual({ email: ["is taken by someone"], age: ["is odd"] });
  });

  test("a symbol or number as the whole path goes to BASE", () => {
    const tag = Symbol("tag");
    const cs = cast(User, {}, []).validate(() => [
      { path: tag, message: "is tagged" },
      { path: 3, message: "is third" },
    ]);
    expect(cs.errors[BASE]?.map((error) => error.meta.path)).toEqual([[tag], [3]]);
  });

  test("errors are appended in the validator's issue order, except on fields that already have one", () => {
    const before = cast(User, { email: "" }, ["email"]).addError("age", "was already wrong");
    const cs = before.validate(() => [
      { path: "name", message: "first" },
      { path: "age", message: "second" },
      { path: "email", message: "third" },
      { path: "name", message: "fourth" },
    ]);
    expect(cs.errors.email?.map((e) => e.message)).toEqual(["can't be blank"]);
    expect(cs.errors.age?.map((e) => e.message)).toEqual(["was already wrong"]);
    // A field without an earlier error keeps every issue this validator reports on it.
    expect(cs.errors.name?.map((e) => e.message)).toEqual(["first", "fourth"]);
    expect(before.errors.age).toHaveLength(1);
  });

  test("a failing validator never removes changes", () => {
    const cs = cast(ada(), { name: "X", age: "3" }, ["name", "age"]);
    const failed = cs.validate(() => [
      { path: "name", message: "is too short" },
      { path: "age", message: "is too young" },
    ]);
    expect(failed.changes).toBe(cs.changes);
  });

  test("no issues: the changeset is valid and its errors are shared", () => {
    const cs = cast(User, { email: "fine@ok.example" }, ["email"]);
    for (const result of [[], undefined]) {
      const next = cs.validate(() => result as never);
      expect(next.valid).toBe(true);
      expect(next.errors).toBe(cs.errors);
      expect(next.changes).toBe(cs.changes);
    }
    const viaSchema = cs.validate(standard((value) => ({ value })));
    expect(viaSchema.errors).toBe(cs.errors);
    expect(cs.validate(standard(() => ({ issues: [] }))).valid).toBe(true);
  });

  test("a malformed issue from a function throws a TypeError", () => {
    const cs = cast(User, {}, []);
    const bad: unknown[] = [
      ["just a string"],
      [{ path: "email" }],
      [null],
      [{ path: { field: "email" }, message: "x" }],
      [{ path: [true], message: "x" }],
      [{ path: [{ name: "email" }], message: "x" }],
      [{ path: "email", message: "x", meta: "extra" }],
    ];
    for (const issues of bad) {
      expect(() => cs.validate(() => issues as ValidationIssue[])).toThrow(TypeError);
    }
  });

  test("a Standard Schema answering with something that is not a result throws a TypeError", () => {
    const cs = cast(User, {}, []);
    expect(() => cs.validate(standard(() => null as never))).toThrow(/returned null, not a result/);
    expect(() => cs.validate(standard(() => ({ issues: "bad" }) as never))).toThrow(/not a list/);
  });
});

/**
 * Results a validator function may not return, with the part of the error message that
 * says what it returned. A single issue without its array is the usual slip.
 */
const NOT_A_LIST: readonly (readonly [string, unknown, string])[] = [
  [
    "a single issue",
    { path: "email", message: "is taken" },
    "but it returned a single issue, not an array. Put it in an array: return [issue].",
  ],
  ["a string", "is taken", 'but it returned the string "is taken".'],
  ["a number", 0, "but it returned the number 0."],
  ["an object without a message", { path: "email" }, "but it returned an object that is not an array."],
  ["a boolean", false, "but it returned the boolean false."],
  ["null", null, "but it returned null."],
];

describe("validate: a function's result that is not an array", () => {
  const expected = (fn: string, returned: string): string =>
    `${fn}(): a validator function must return an array of issues, such as [{ path: "email", message: "is invalid" }], or nothing, ${returned}`;

  test.each(NOT_A_LIST)("validate throws a TypeError for %s", (_name, result, returned) => {
    const cs = cast(User, { email: "fine@ok.example" }, ["email"]);
    expect(() => cs.validate(() => result as never)).toThrow(TypeError);
    expect(() => cs.validate(() => result as never)).toThrow(expected("validate", returned));
  });

  test.each(NOT_A_LIST)("validateAsync rejects with a TypeError for %s", async (_name, result, returned) => {
    const cs = cast(User, { email: "fine@ok.example" }, ["email"]);
    await expect(cs.validateAsync(() => result as never)).rejects.toThrow(TypeError);
    await expect(cs.validateAsync(() => result as never)).rejects.toThrow(
      expected("validateAsync", returned),
    );
  });

  test.each(NOT_A_LIST)(
    "validateAsync rejects with a TypeError for a promise of %s",
    async (_name, result, returned) => {
      const cs = cast(User, { email: "fine@ok.example" }, ["email"]);
      const pending = cs.validateAsync(async () => result as never);
      await expect(pending).rejects.toThrow(TypeError);
      await expect(cs.validateAsync(async () => result as never)).rejects.toThrow(
        expected("validateAsync", returned),
      );
    },
  );

  test("a long string is shortened in the message", () => {
    const cs = cast(User, {}, []);
    const long = "x".repeat(100);
    expect(() => cs.validate(() => long as never)).toThrow(`the string "${"x".repeat(60)}…".`);
  });

  test("a string of exactly 60 characters is shown whole", () => {
    const cs = cast(User, {}, []);
    const sixty = "y".repeat(60);
    expect(() => cs.validate(() => sixty as never)).toThrow(`but it returned the string "${sixty}".`);
  });

  test("shortening never splits a character made of two code units", () => {
    const cs = cast(User, {}, []);
    const text = `${"x".repeat(59)}😀 and more`;
    expect(() => cs.validate(() => text as never)).toThrow(`the string "${"x".repeat(59)}…".`);
    const fits = `${"x".repeat(58)}😀 and more`;
    expect(() => cs.validate(() => fits as never)).toThrow(`the string "${"x".repeat(58)}😀…".`);
  });

  test("an object whose message is not a string is not called a single issue", () => {
    const cs = cast(User, {}, []);
    expect(() => cs.validate(() => ({ path: "email", message: 5 }) as never)).toThrow(
      "but it returned an object that is not an array.",
    );
  });

  test("other kinds of value name their type", () => {
    const cs = cast(User, {}, []);
    expect(() => cs.validate(() => 5n as never)).toThrow("but it returned the bigint 5.");
    expect(() => cs.validate(() => (() => []) as never)).toThrow("but it returned a function.");
    expect(() => cs.validate(() => Symbol("s") as never)).toThrow("but it returned a symbol.");
  });

  test("a promise given to validate is still refused for being a promise", () => {
    const cs = cast(User, {}, []);
    expect(() => cs.validate(async () => "is taken" as never)).toThrow(QueryError);
  });

  test("arrays and undefined are accepted, sync and async", async () => {
    const cs = cast(User, { email: "fine@ok.example" }, ["email"]);
    for (const result of [[], undefined]) {
      expect(cs.validate(() => result as never).valid).toBe(true);
      expect((await cs.validateAsync(async () => result as never)).valid).toBe(true);
    }
    const issue = [{ path: "email", message: "is taken" }];
    expect(cs.validate(() => issue).errorMessages()).toEqual({ email: ["is taken"] });
    expect((await cs.validateAsync(async () => issue)).errorMessages()).toEqual({ email: ["is taken"] });
  });

  test("a Standard Schema's result is not affected", () => {
    const cs = cast(User, { email: "fine@ok.example" }, ["email"]);
    expect(cs.validate(standard((value) => ({ value }))).valid).toBe(true);
  });
});

describe("validate: scope", () => {
  const endsAfterStart = standard((value) => {
    const v = value as { startsAt: Date; endsAt: Date };
    return v.endsAt > v.startsAt
      ? { value }
      : { issues: [{ message: "must be after start", path: ["endsAt"] }] };
  });

  test('"all" (the default) keeps an issue on an unchanged field of a loaded row', () => {
    // Only startsAt changed, but the rule reports on endsAt.
    const cs = cast(standup(), { startsAt: "2026-05-04T12:00:00Z" }, ["startsAt"]).validate(endsAfterStart);
    expect(cs.errorMessages()).toEqual({ endsAt: ["must be after start"] });
  });

  test('"all" keeps issues on unchanged fields of a new record', () => {
    const cs = cast(User, {}, []).validate(
      standard(() => ({ issues: [{ message: "is required", path: ["email"] }] })),
    );
    expect(cs.errorMessages()).toEqual({ email: ["is required"] });
  });

  test('"changed" drops issues on fields without a change, on a loaded row', () => {
    const cs = cast(standup(), { startsAt: "2026-05-04T12:00:00Z" }, ["startsAt"]).validate(endsAfterStart, {
      scope: "changed",
    });
    expect(cs.valid).toBe(true);
    expect(cs.errors).toEqual({});
  });

  test('"changed" keeps issues on changed fields', () => {
    const cs = cast(standup(), { endsAt: "2026-05-04T09:30:00Z" }, ["endsAt"]).validate(endsAfterStart, {
      scope: "changed",
    });
    expect(cs.errorMessages()).toEqual({ endsAt: ["must be after start"] });
  });

  test('"changed" on a new record drops issues on fields that were not given', () => {
    const cs = cast(User, { name: "Edsger" }, ["name"]).validate(
      () => [
        { path: "email", message: "is required" },
        { path: "name", message: "is too short" },
      ],
      { scope: "changed" },
    );
    expect(cs.errorMessages()).toEqual({ name: ["is too short"] });
  });

  test('"changed" always keeps issues on the record as a whole and on keys that are not fields', () => {
    const cs = cast(standup(), {}, []).validate(
      () => [
        { path: [], message: "is double-booked" },
        { path: "room", message: "is closed" },
      ],
      { scope: "changed" },
    );
    expect(cs.errorMessages()).toEqual({ $base: ["is double-booked", "is closed"] });
  });

  test("only drops issues on fields outside the list, and keeps issues on the record", () => {
    const cs = cast(User, {}, []).validate(
      () => [
        { path: "email", message: "is required" },
        { path: "name", message: "is required" },
        { path: [], message: "is incomplete" },
      ],
      { only: ["name"] },
    );
    expect(cs.errorMessages()).toEqual({ name: ["is required"], $base: ["is incomplete"] });
  });

  test("a cross-field function rule reports when the end field changed (verbatim example)", () => {
    const cs = cast(standup(), { endsAt: "2026-05-04T09:00:00Z" }, ["endsAt"]);
    const checked = cs.validate((v, { isChanged }) =>
      isChanged("endsAt") && v.endsAt <= v.startsAt
        ? [{ path: "endsAt", message: "must be after start" }]
        : [],
    );
    expect(checked.errorMessages()).toEqual({ endsAt: ["must be after start"] });
    expect(nineAm < tenAm).toBe(true);
  });
});

describe("validate: apply", () => {
  const trimmed = standard((value) => {
    const v = value as Record<string, unknown>;
    return {
      value: {
        ...v,
        email: typeof v.email === "string" ? v.email.trim().toLowerCase() : v.email,
        notAField: "ignored",
      },
    };
  });

  test("writes the output back as changes", () => {
    const cs = cast(User, { email: "  Ada@Engine.Example " }, ["email"]).validate(trimmed, { apply: true });
    expect(cs.changes).toEqual({ email: "ada@engine.example" });
    expect(cs.valid).toBe(true);
  });

  test("leaves the changes alone without apply", () => {
    const cs = cast(User, { email: " X@Y.Z " }, ["email"]).validate(trimmed);
    expect(cs.changes).toEqual({ email: " X@Y.Z " });
  });

  test("an output value equal to the current value records nothing; one back to the row's value removes the change", () => {
    const row = ada();
    const same = cast(row, {}, []).validate(trimmed, { apply: true });
    expect(same.changes).toEqual({});
    const back = cast(row, { email: " ADA@engine.example" }, ["email"]).validate(trimmed, { apply: true });
    expect(back.changes).toEqual({});
  });

  test("compares with the field's type: an equal date is not a change", () => {
    const copyDates = standard((value) => {
      const v = value as { startsAt: Date };
      return { value: { startsAt: new Date(v.startsAt.getTime()) } };
    });
    const cs = cast(standup(), {}, []).validate(copyDates, { apply: true });
    expect(cs.changes).toEqual({});
  });

  test("an output equal by type to a field's change leaves the changes untouched", () => {
    const later = cast(standup(), { endsAt: "2026-05-04T12:00:00Z" }, ["endsAt"]);
    const copyEnd = standard((value) => {
      const v = value as { endsAt: Date };
      return { value: { endsAt: new Date(v.endsAt.getTime()) } };
    });
    const cs = later.validate(copyEnd, { apply: true });
    expect(cs.changes).toBe(later.changes);
  });

  test("casts each output value with the field's type before writing it", () => {
    const asText = standard(() => ({ value: { age: "40" } }));
    expect(cast(User, {}, []).validate(asText, { apply: true }).changes).toEqual({ age: 40 });
  });

  test("an output value the field's type rejects is a cast error and is not written", () => {
    // A transform such as z.string().transform((s) => s.length) on a text field.
    const lengthOf = standard((value) => {
      const v = value as { email: string; name: string };
      return { value: { email: v.email.length, name: v.name.trim() } };
    });
    const cs = cast(User, { email: "ada@engine.example", name: " Ada " }, ["email", "name"]).validate(
      lengthOf,
      {
        apply: true,
      },
    );
    expect(cs.valid).toBe(false);
    expect(cs.errors).toEqual({
      email: [{ message: "is invalid", validation: "cast", meta: { type: "string" } }],
    });
    expect(cs.changes).toEqual({ email: "ada@engine.example", name: "Ada" });

    // The type's own metadata is kept, as cast keeps it.
    const badTags = standard(() => ({ value: { tagList: ["news", 7] } }));
    expect(cast(Post, {}, []).validate(badTags, { apply: true }).errors.tagList).toEqual([
      { message: "is invalid", validation: "cast", meta: { type: "array(string)", index: 1, path: [1] } },
    ]);
  });

  test('cannot be combined with only or scope: "changed"', () => {
    const passthrough = standard((value) => ({ value }));
    const cs = cast(User, { email: " a@b.c " }, ["email"]);
    expect(() => cs.validate(passthrough, { apply: true, only: ["email"] })).toThrow(QueryError);
    expect(() => cs.validate(passthrough, { apply: true, only: ["email"] })).toThrow(
      /apply cannot be combined with only/,
    );
    expect(() => cs.validate(passthrough, { apply: true, scope: "changed" })).toThrow(
      /apply cannot be combined with scope: "changed"/,
    );
    expect(cs.validate(passthrough, { apply: true, scope: "all" }).valid).toBe(true);
  });

  test("sets output keys that the input did not hold, and ignores undefined", () => {
    const defaults = standard(() => ({ value: { name: "Anonymous", age: undefined } }));
    const cs = cast(User, {}, []).validate(defaults, { apply: true });
    expect(cs.changes).toEqual({ name: "Anonymous" });
  });

  test("ignores output that is not an object", () => {
    const cs = cast(User, {}, []).validate(
      standard(() => ({ value: "done" })),
      { apply: true },
    );
    expect(cs.changes).toEqual({});
  });

  test("is not applied when there are issues", () => {
    const failing = standard(() => ({ issues: [{ message: "no", path: ["email"] }] }));
    const cs = cast(User, { email: " A " }, ["email"]).validate(failing, { apply: true });
    expect(cs.changes).toEqual({ email: " A " });
  });

  test("null for a field that is not nullable becomes can't be blank, as putChange does", () => {
    const nulls = standard(() => ({ value: { email: null } }));
    const cs = cast(User, { email: "a@b.c" }, ["email"]).validate(nulls, { apply: true });
    expect(cs.errorMessages()).toEqual({ email: ["can't be blank"] });
  });

  test("with a function validator, it throws: a function has no output", () => {
    expect(() => cast(User, {}, []).validate(() => [], { apply: true })).toThrow(QueryError);
    expect(() => cast(User, {}, []).validate(() => [], { apply: true })).toThrow(
      /apply needs a Standard Schema/,
    );
  });
});

describe("validate: sync and async", () => {
  test("validate throws when a function answers with a promise", () => {
    const cs = cast(User, {}, []);
    expect(() => cs.validate(async () => [])).toThrow(
      "query.validatorPromise: The validator returned a Promise.",
    );
    expect(() => cs.validate(async () => [])).toThrow(QueryError);
  });

  test("validate throws when a Standard Schema answers with a promise, and the promise's rejection is handled", async () => {
    const cs = cast(User, {}, []);
    const rejecting = standard(() => Promise.reject(new Error("remote check failed")));
    expect(() => cs.validate(rejecting)).toThrow("query.validatorPromise: The validator returned a Promise.");
    // An unhandled rejection would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("validateAsync accepts async and sync validators alike", async () => {
    const cs = cast(User, { email: "a@b.c" }, ["email"]);
    const asyncFn = await cs.validateAsync(async (v) =>
      v.email === "a@b.c" ? [{ path: "email", message: "is disposable" }] : [],
    );
    const syncFn = await cs.validateAsync(() => [{ path: "email", message: "is disposable" }]);
    const asyncSchema = await cs.validateAsync(
      standard(async () => ({ issues: [{ message: "is disposable", path: ["email"] }] })),
    );
    for (const result of [asyncFn, syncFn, asyncSchema]) {
      expect(result.errorMessages()).toEqual({ email: ["is disposable"] });
    }
  });

  test("validateAsync applies a schema's output", async () => {
    const lower = standard(async (value) => ({
      value: { email: String((value as { email: string }).email).toLowerCase() },
    }));
    const cs = await cast(User, { email: "BIG@CASE.EXAMPLE" }, ["email"]).validateAsync(lower, {
      apply: true,
    });
    expect(cs.changes).toEqual({ email: "big@case.example" });
  });

  test("a validator that throws: the exception propagates, it is not a validation error", async () => {
    const boom = new Error("bug in the validator");
    const cs = cast(User, {}, []);
    expect(() =>
      cs.validate(() => {
        throw boom;
      }),
    ).toThrow(boom);
    expect(() =>
      cs.validate(
        standard(() => {
          throw boom;
        }),
      ),
    ).toThrow(boom);
    await expect(
      cs.validateAsync(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  test("validateAsync rejects instead of throwing on a bad validator", async () => {
    const pending = cast(User, {}, []).validateAsync("nope" as never);
    await expect(pending).rejects.toThrow(TypeError);
  });
});

describe("validate: options", () => {
  test("refuses options that are malformed", () => {
    const cs = cast(User, {}, []);
    const pass = () => [];
    expect(() => cs.validate(pass, "all" as never)).toThrow(/options must be an object/);
    expect(() => cs.validate(pass, null as never)).toThrow(/options must be an object/);
    expect(() => cs.validate(pass, { scope: "auto" as never })).toThrow(/scope must be "all" or "changed"/);
    expect(() => cs.validate(pass, { apply: "yes" as never })).toThrow(/apply must be true or false/);
    expect(() => cs.validate(pass, { only: "email" as never })).toThrow(/only must be a list/);
    expect(() => cs.validate(pass, { only: ["emial" as never] })).toThrow(/"emial" is not a field/);
    expect(() => cs.validate(pass, { only: [1 as never] })).toThrow(/takes a field name as a string/);
  });

  test("accepts explicit defaults", () => {
    const cs = cast(User, {}, []).validate(() => [{ path: "email", message: "x" }], {
      scope: "all",
      apply: false,
    });
    expect(cs.valid).toBe(false);
  });
});

describe("validate: introspection", () => {
  test('each call appends ["$schema", { validator, opts }] to validations', () => {
    const { schema } = recording();
    const fn = () => [];
    const options = { scope: "changed" as const };
    const cs = cast(User, { name: "Al" }, ["name"])
      .validateLength("name", { min: 2 })
      .validate(schema)
      .validate(fn, options);
    expect(cs.validations).toEqual([
      ["name", { validation: "length", min: 2 }],
      ["$schema", { validator: schema, opts: undefined }],
      ["$schema", { validator: fn, opts: options }],
    ]);
  });

  test("a failing validation is recorded too", () => {
    const cs = cast(User, {}, []).validate(() => [{ path: "email", message: "no" }]);
    expect(cs.validations).toHaveLength(1);
  });
});

describe("validate: one error per field", () => {
  class Person extends Schema("people", { id: t.integer().primaryKey(), name: t.string() }) {}

  /** Reports a missing `name`, as Zod's z.string() does for a key that is not there. */
  const needsName = standard((value) => {
    const v = value as { name?: unknown };
    return typeof v.name === "string"
      ? { value }
      : { issues: [{ message: "expected string, received undefined", path: ["name"] }] };
  });

  test("an issue on a field with a cast error is dropped: the field keeps the cast's message", () => {
    // cast turns "" into null and reports it; the schema then sees no name.
    const cs = cast(Person, { name: "" }, ["name"]).validate(needsName);
    expect(cs.errorMessages()).toEqual({ name: ["can't be blank"] });
    expect(cs.valid).toBe(false);

    const invalid = cast(User, { email: "a@b.c", age: "old" }, ["email", "age"]).validate(() => [
      { path: "age", message: "must be a whole number" },
      { path: ["age", "deeper"], message: "is also dropped" },
    ]);
    expect(invalid.errorMessages()).toEqual({ age: ["is invalid"] });
  });

  test("an issue on another field is kept", () => {
    const cs = cast(User, { email: "", name: "X" }, ["email", "name"]).validate(() => [
      { path: "email", message: "is dropped" },
      { path: "name", message: "is too short" },
    ]);
    expect(cs.errorMessages()).toEqual({ email: ["can't be blank"], name: ["is too short"] });
  });

  test("errors from validateRequired, a built-in validation or an earlier validator also stand", () => {
    const required = cast(User, {}, [])
      .validateRequired(["email"])
      .validate(() => [{ path: "email", message: "is dropped" }]);
    expect(required.errorMessages()).toEqual({ email: ["can't be blank"] });

    const short = cast(User, { name: "X" }, ["name"])
      .validateLength("name", { min: 2 })
      .validate(() => [{ path: "name", message: "is dropped" }]);
    expect(short.errorMessages()).toEqual({ name: ["should be at least 2 character(s)"] });

    const twice = cast(User, { name: "X" }, ["name"])
      .validate(() => [{ path: "name", message: "first" }])
      .validate(() => [{ path: "name", message: "is dropped" }]);
    expect(twice.errorMessages()).toEqual({ name: ["first"] });
  });

  test("issues on the record as a whole are always kept", () => {
    const cs = cast(User, {}, [])
      .validate(() => [{ path: [], message: "first" }])
      .validate(() => [
        { path: [], message: "second" },
        { path: ["notAField"], message: "third" },
      ]);
    expect(cs.errorMessages()).toEqual({ [BASE]: ["first", "second", "third"] });
  });

  test('scope "changed": a changed field that already has an error gets no more; other changed fields do', () => {
    const cs = cast(ada(), { name: "X", age: "40" }, ["name", "age"])
      .validateLength("name", { min: 2 })
      .validate(
        () => [
          { path: "name", message: "is dropped" },
          { path: "age", message: "is kept" },
          { path: "email", message: "is dropped by the scope" },
        ],
        { scope: "changed" },
      );
    expect(cs.errorMessages()).toEqual({ name: ["should be at least 2 character(s)"], age: ["is kept"] });
  });

  test("validateAsync drops them too", async () => {
    const cs = await cast(Person, { name: "" }, ["name"]).validateAsync(needsName);
    expect(cs.errorMessages()).toEqual({ name: ["can't be blank"] });
  });

  test("apply: an output value the type rejects adds no second error to a field that has one", () => {
    const asNumbers = standard(() => ({ value: { name: 5, email: 6 } }));
    const cs = cast(User, { name: "X" }, ["name"])
      .addError("name", "is taken")
      .validate(asNumbers, { apply: true });
    expect(cs.errorMessages()).toEqual({ name: ["is taken"], email: ["is invalid"] });
  });
});

describe("validate: nested routing, only, apply and validateField", () => {
  type AnyCs = Changeset<AnySchema, boolean>;

  function loadedWith<S extends AnySchema>(
    schema: S,
    values: Readonly<Record<string, unknown>>,
    assocs: Readonly<Record<string, unknown>> = {},
  ): Row<S> {
    const info = meta(schema);
    const names = Object.keys(assocs);
    const fields = info.persisted.map((field) =>
      Object.hasOwn(values, field.name) ? values[field.name] : null,
    );
    const rowMeta = info.rowMeta("loaded", undefined);
    return (
      names.length === 0
        ? info.create(fields, rowMeta)
        : info.createWith(names)(
            fields,
            names.map((name) => assocs[name]),
            rowMeta,
          )
    ) as Row<S>;
  }

  class Leaf extends Schema("leaves", {
    id: t.integer().primaryKey(),
    bookId: t.integer().nullable(),
    text: t.string(),
  }) {
    static changeset(leaf: Leaf | typeof Leaf, params: unknown) {
      return cast(leaf, params, ["id", "text"]);
    }
  }
  class Cover extends Schema("covers", { id: t.integer().primaryKey(), bookId: t.integer().nullable() }) {}
  class Mark extends EmbeddedSchema({ text: t.string() }) {
    static changeset(mark: Mark | typeof Mark, params: unknown) {
      return cast(mark, params, ["text"]);
    }
  }
  class Book extends Schema("books", {
    id: t.integer().primaryKey(),
    title: t.string(),
    doneAt: t.timestamp().nullable(),
    tags: t.array(t.string()).nullable(),
    marks: t.embedMany(() => Mark),
  }) {
    static leaves = hasMany(() => Leaf, { foreignKey: "bookId", onReplace: "delete" });
    static cover = hasOne(() => Cover, { foreignKey: "bookId", onReplace: "delete" });
  }

  const leaf = (id: number) => loadedWith(Leaf, { id, bookId: 7, text: `t${id}` });
  const book = (rows: readonly Leaf[] = [], extra: Readonly<Record<string, unknown>> = {}) =>
    loadedWith(
      Book,
      { id: 7, title: "B", doneAt: null, tags: null, marks: [], ...extra },
      { leaves: rows, cover: null },
    );
  const messagesOf = (cs: AnyCs, name: string) =>
    ((cs.changes as Record<string, readonly AnyCs[]>)[name] ?? []).map((item) => item.errorMessages());

  describe("routing issues into nested changes", () => {
    test("a child that leaves the relation is skipped when positions are counted", () => {
      const [a, b] = [leaf(1), leaf(2)];
      const cs = change(book([a, b] as Leaf[]))
        .putAssoc("leaves", [change(a as Leaf, { bookId: null }), change(b as Leaf, { text: "u" })] as never)
        .validate(() => [{ path: ["leaves", 0, "text"], message: "is short" }]) as AnyCs;
      expect(messagesOf(cs, "leaves")).toEqual([{}, { text: ["is short"] }]);
    });

    test("an issue reaches an item of an embedded list", () => {
      const cs = cast(book(), { marks: [{ text: "a" }, { text: "b" }] }, [])
        .castEmbed("marks")
        .validate(() => [{ path: ["marks", 1, "text"], message: "is short" }]) as AnyCs;
      expect(messagesOf(cs, "marks")).toEqual([{}, { text: ["is short"] }]);
    });

    test("a position given as text counts from 10 on; a position that is not a number goes to the parent", () => {
      const items = Array.from({ length: 11 }, (_, i) => ({ text: `m${i}` }));
      const cs = cast(book(), { marks: items }, [])
        .castEmbed("marks")
        .validate(() => [
          { path: ["marks", "10", "text"], message: "is the eleventh" },
          { path: ["marks", "x"], message: "is not a position" },
        ]) as AnyCs;
      expect(messagesOf(cs, "marks")[10]).toEqual({ text: ["is the eleventh"] });
      expect(messagesOf(cs, "marks")[1]).toEqual({});
      expect(cs.errorMessages()).toMatchObject({ marks: expect.anything() });
    });

    test("a symbol where a position would be sends the issue to the parent", () => {
      const cs = cast(book(), { marks: [{ text: "a" }] }, [])
        .castEmbed("marks")
        .validate(() => [{ path: ["marks", Symbol("x")], message: "is odd" }]) as AnyCs;
      expect(cs.errorMessages()).toEqual({ marks: ["is odd"] });
    });

    test("an issue on an item of a plain list field stays on the field", () => {
      const cs = cast(book(), { tags: ["a", "b"] }, ["tags"]).validate(() => [
        { path: ["tags", 0], message: "is reserved" },
      ]) as AnyCs;
      expect(cs.errorMessages()).toEqual({ tags: ["is reserved"] });
    });

    test("with only, an issue on a relation that is not listed is dropped", () => {
      const cs = cast(book(), { marks: [{ text: "a" }] }, [])
        .castEmbed("marks")
        .validate(() => [{ path: ["marks", 0, "text"], message: "is short" }], { only: ["title"] }) as AnyCs;
      expect(messagesOf(cs, "marks")).toEqual([{}]);
      expect(cs.valid).toBe(true);
    });

    test("the parent's own error keeps it invalid when every routed issue is dropped by the children", () => {
      const stored = book([leaf(1)]);
      const cs = cast(stored, { title: "" }, ["title"])
        .putAssoc("leaves", [{ id: 1, text: "u" }] as never)
        .validate(
          () => [
            { path: ["title"], message: "is bland" },
            // bookId has no change, so scope "changed" drops this issue inside the child.
            { path: ["leaves", 0, "bookId"], message: "is odd" },
          ],
          { scope: "changed" },
        ) as AnyCs;
      expect(messagesOf(cs, "leaves")).toEqual([{}]);
      expect(cs.valid).toBe(false);
    });

    test("the parent keeps its own error beside the routed ones, and the earlier changeset is left alone", () => {
      const before = cast(book(), { title: "", marks: [{ text: "a" }] }, ["title"]).castEmbed(
        "marks",
      ) as AnyCs;
      const listBefore = (before.changes as Record<string, readonly AnyCs[]>).marks;
      const cs = before.validate(() => [
        { path: ["title"], message: "is bland" },
        { path: ["marks", 0, "text"], message: "is short" },
      ]) as AnyCs;
      expect(cs.valid).toBe(false);
      expect((before.changes as Record<string, readonly AnyCs[]>).marks).toBe(listBefore);
      expect(listBefore?.[0]?.valid).toBe(true);
    });
  });

  describe("what a validator sees", () => {
    test("with only, a listed field without a value is not a key at all", () => {
      const seen: unknown[] = [];
      cast(User, { name: "Lin" }, ["name"]).validate(
        (values) => {
          seen.push(values);
          return [];
        },
        { only: ["email", "name"] },
      );
      expect(Object.keys(seen[0] as object)).toEqual(["name"]);
    });

    test("with only, an association change is left out; a to-one change of null is seen as null", () => {
      const seen: unknown[] = [];
      const record = (values: unknown) => {
        seen.push(values);
        return [];
      };
      const withLeaves = change(book([leaf(1)])).putAssoc("leaves", [{ id: 1, text: "u" }] as never);
      withLeaves.validate(record, { only: ["title"] });
      expect(Object.keys(seen[0] as object)).toEqual(["title"]);
      const stored = loadedWith(
        Book,
        { id: 7, title: "B", doneAt: null, tags: null, marks: [] },
        {
          leaves: [],
          cover: loadedWith(Cover, { id: 1, bookId: 7 }),
        },
      );
      change(stored).putAssoc("cover", null).validate(record);
      expect((seen[1] as Record<string, unknown>).cover).toBeNull();
    });
  });

  describe("apply", () => {
    const output = (value: unknown) => standard(() => ({ value }));

    test("null over a stored date and a date over null are changes; an output key holding undefined is ignored", () => {
      const when = new Date("2026-06-01T00:00:00.000Z");
      const cleared = change(book([], { doneAt: when })).validate(output({ doneAt: null }), {
        apply: true,
      }) as AnyCs;
      expect(cleared.changes).toEqual({ doneAt: null });
      const done = change(book()).validate(output({ doneAt: when.toISOString() }), { apply: true }) as AnyCs;
      expect(done.changes).toEqual({ doneAt: when });
      const skipped = change(book()).validate(output({ title: undefined }), { apply: true }) as AnyCs;
      expect(skipped.valid).toBe(true);
      expect(skipped.changes).toEqual({});
    });

    test("a field of a new record with no value yet takes the output, also for a type that compares dates", () => {
      const when = new Date("2026-06-01T00:00:00.000Z");
      const fresh = cast({ data: {}, types: { at: t.timestamp() } }, {}, []);
      const cs = fresh.validate(output({ at: when.toISOString() }), { apply: true }) as unknown as AnyCs;
      expect(cs.valid).toBe(true);
      expect(cs.changes).toEqual({ at: when });
    });

    test("a result with an empty list of issues is a success, and its output is applied", () => {
      const cs = change(book()).validate(
        standard(() => ({ value: { title: "C" }, issues: [] })),
        { apply: true },
      ) as AnyCs;
      expect(cs.valid).toBe(true);
      expect(cs.changes).toEqual({ title: "C" });
      const field = change(book(), { title: "C" }).validateField(
        "title",
        standard(() => ({ value: "C", issues: [] })),
      );
      expect(field.valid).toBe(true);
    });
  });

  describe("validateField and validateFieldAsync", () => {
    test("a rejected promise from validateField is refused without an unhandled rejection", async () => {
      let unhandled = false;
      const listener = () => {
        unhandled = true;
      };
      process.on("unhandledRejection", listener);
      try {
        const cs = change(book(), { title: "C" });
        expect(() => cs.validateField("title", () => Promise.reject(new Error("late")) as never)).toThrow(
          /returned a Promise/,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(unhandled).toBe(false);
      } finally {
        process.off("unhandledRejection", listener);
      }
    });

    test("validateFieldAsync skips a null value and records the validator", async () => {
      let calls = 0;
      const validator = async () => {
        calls++;
        return [{ path: [], message: "is wrong" }];
      };
      const cs = (await change(book([], { doneAt: new Date(0) }), { doneAt: null }).validateFieldAsync(
        "doneAt",
        validator,
      )) as AnyCs;
      expect(calls).toBe(0);
      expect(cs.valid).toBe(true);
      expect(cs.validations).toStrictEqual([["doneAt", { schema: validator }]]);
    });
  });
});
