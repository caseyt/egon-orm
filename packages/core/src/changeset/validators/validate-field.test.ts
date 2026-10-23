import { User } from "@egon-orm/test-support";
import { describe, expect, test, vi } from "vitest";
import type { AnySchema, Row } from "../../contracts/schema.js";
import type { StandardSchemaV1, StandardSchemaV1Result } from "../../contracts/standard-schema.js";
import { QueryError } from "../../errors.js";
import { meta } from "../../schema/index.js";
import { cast, change } from "../changeset.js";

function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

function standard(
  validate: (value: unknown) => StandardSchemaV1Result<unknown> | Promise<StandardSchemaV1Result<unknown>>,
): StandardSchemaV1 {
  return { "~standard": { version: 1, vendor: "handmade", validate } };
}

/** Accepts strings that look like an address; reports "is not an email address" otherwise. */
const emailSchema = standard((value) =>
  typeof value === "string" && /^[^@\s]+@[^@\s]+$/.test(value)
    ? { value }
    : { issues: [{ message: "is not an email address" }] },
);

const row = (): User =>
  loaded(User, { id: 4, email: "radia@stp.example", name: "Radia", role: "member", lockVersion: 1 });

describe("validateField", () => {
  test("validates the changed value alone", () => {
    const seen: unknown[] = [];
    const schema = standard((value) => {
      seen.push(value);
      return { value };
    });
    cast(User, { email: "barbara@liskov.example", name: "Barbara" }, ["email", "name"]).validateField(
      "email",
      schema,
    );
    expect(seen).toEqual(["barbara@liskov.example"]);
  });

  test("puts every issue on the field, the issue's path in meta.path", () => {
    const deep = standard(() => ({
      issues: [
        { message: "is not an email address" },
        { message: "has a bad domain", path: [{ key: "domain" }] },
      ],
    }));
    const cs = cast(User, { email: "nope" }, ["email"]).validateField("email", deep);
    expect(cs.errors).toEqual({
      email: [
        { message: "is not an email address", validation: "schema", meta: { path: [] } },
        { message: "has a bad domain", validation: "schema", meta: { path: ["domain"] } },
      ],
    });
  });

  test("passes when the schema accepts the value", () => {
    const cs = cast(User, { email: "frances@allen.example" }, ["email"]);
    const next = cs.validateField("email", emailSchema);
    expect(next.valid).toBe(true);
    expect(next.errors).toBe(cs.errors);
  });

  test("is skipped when the field has no change", () => {
    const validate = vi.fn(() => ({ value: "x" }));
    const schema: StandardSchemaV1 = { "~standard": { version: 1, vendor: "spy", validate } };
    const cs = cast(row(), { name: "R. Perlman" }, ["name"]).validateField("email", schema);
    expect(validate).not.toHaveBeenCalled();
    expect(cs.valid).toBe(true);
  });

  test("is skipped when the change is to null", () => {
    const fn = vi.fn(() => [{ path: [], message: "never" }]);
    const cs = cast(row(), { name: "" }, ["name"]);
    expect(cs.changes).toEqual({ name: null });
    expect(cs.validateField("name", fn).valid).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  test("is skipped when the field already has an error: the field keeps its first message", () => {
    const fn = vi.fn(() => [{ path: [], message: "is dropped" }]);
    const cs = cast(row(), { email: "nope" }, ["email"]).validateField("email", emailSchema);
    const again = cs.validateField("email", fn);
    expect(fn).not.toHaveBeenCalled();
    expect(again.errorMessages()).toEqual({ email: ["is not an email address"] });
    expect(again.validations).toEqual([
      ["email", { schema: emailSchema }],
      ["email", { schema: fn }],
    ]);
    // Another field is still validated.
    const other = cast(row(), { email: "nope", name: "R" }, ["email", "name"])
      .validateLength("email", { min: 10 })
      .validateField("name", () => [{ path: [], message: "is too short" }]);
    expect(other.errorMessages()).toEqual({
      email: ["should be at least 10 character(s)"],
      name: ["is too short"],
    });
  });

  test("a function receives the value and the context", () => {
    const cs = change(row(), { email: "radia@example.com" });
    const checked = cs.validateField("email", (email, { isChanged, data }) =>
      email.endsWith("@example.com") && isChanged("email") && data.name === "Radia"
        ? [{ path: [], message: "is not allowed" }]
        : [],
    );
    expect(checked.errorMessages()).toEqual({ email: ["is not allowed"] });
  });

  test("records [field, { schema: validator }] whether it ran or not", () => {
    const fn = () => [];
    const cs = cast(row(), { email: "new@stp.example" }, ["email"])
      .validateField("email", emailSchema)
      .validateField("name", fn);
    expect(cs.validations).toEqual([
      ["email", { schema: emailSchema }],
      ["name", { schema: fn }],
    ]);
  });

  test("refuses a field that does not exist, and a validator of the wrong kind", () => {
    const cs = cast(User, {}, []);
    expect(() => cs.validateField("emial" as never, emailSchema)).toThrow(QueryError);
    expect(() => cs.validateField("emial" as never, emailSchema)).toThrow(/"emial" is not a field/);
    expect(() => cs.validateField(42 as never, emailSchema)).toThrow(/takes a field name as a string/);
    expect(() => cs.validateField("email", { not: "a schema" } as never)).toThrow(TypeError);
  });

  test("throws when the validator answers with a promise", () => {
    const cs = cast(User, { email: "a@b.c" }, ["email"]);
    expect(() => cs.validateField("email", async () => [])).toThrow(
      'query.fieldValidatorPromise: The field validator of "email" returned a Promise.',
    );
  });

  test("a thrown exception propagates", () => {
    const boom = new Error("validator bug");
    expect(() =>
      cast(User, { email: "a@b.c" }, ["email"]).validateField("email", () => {
        throw boom;
      }),
    ).toThrow(boom);
  });
});

describe("validateFieldAsync", () => {
  test("awaits an async validator", async () => {
    const isDisposable = async (email: string) => email.endsWith("@mailinator.example");
    const cs = await cast(User, { email: "x@mailinator.example" }, ["email"]).validateFieldAsync(
      "email",
      async (email) => ((await isDisposable(email)) ? [{ path: [], message: "is not allowed" }] : []),
    );
    expect(cs.errorMessages()).toEqual({ email: ["is not allowed"] });
  });

  test("accepts a synchronous or async Standard Schema", async () => {
    const cs = cast(User, { email: "nope" }, ["email"]);
    const viaSync = await cs.validateFieldAsync("email", emailSchema);
    const viaAsync = await cs.validateFieldAsync(
      "email",
      standard(async () => ({ issues: [{ message: "is not an email address" }] })),
    );
    expect(viaSync.errorMessages()).toEqual({ email: ["is not an email address"] });
    expect(viaAsync.errorMessages()).toEqual({ email: ["is not an email address"] });
  });

  test("is skipped when the field already has an error, so a remote check is not made", async () => {
    const remote = vi.fn(async () => [{ path: [], message: "is not allowed" }]);
    const cs = await cast(User, { email: "nope" }, ["email"])
      .validateFormat("email", /@/)
      .validateFieldAsync("email", remote);
    expect(remote).not.toHaveBeenCalled();
    expect(cs.errorMessages()).toEqual({ email: ["has invalid format"] });
  });

  test("is skipped without a change, and rejects on misuse", async () => {
    const cs = cast(User, {}, []);
    const skipped = await cs.validateFieldAsync("email", async () => [{ path: [], message: "never" }]);
    expect(skipped.valid).toBe(true);
    expect(skipped.validations).toHaveLength(1);
    await expect(cs.validateFieldAsync("nope" as never, emailSchema)).rejects.toThrow(QueryError);
    await expect(cs.validateFieldAsync("email", 7 as never)).rejects.toThrow(TypeError);
  });
});

/** Results a field validator function may not return, with what the message says about each. */
const NOT_A_LIST: readonly (readonly [string, unknown, string])[] = [
  [
    "a single issue",
    { path: [], message: "is taken" },
    "but it returned a single issue, not an array. Put it in an array: return [issue].",
  ],
  ["a string", "is taken", 'but it returned the string "is taken".'],
  ["a number", 1, "but it returned the number 1."],
  ["an object without a message", { path: [] }, "but it returned an object that is not an array."],
  ["null", null, "but it returned null."],
];

describe("validateField: a function's result that is not an array", () => {
  const expected = (fn: string, returned: string): string =>
    `${fn}(): a validator function must return an array of issues, such as [{ path: [], message: "is invalid" }], or nothing, ${returned}`;
  const changed = () => cast(User, { email: "a@b.c" }, ["email"]);

  test.each(NOT_A_LIST)("validateField throws a TypeError for %s", (_name, result, returned) => {
    expect(() => changed().validateField("email", () => result as never)).toThrow(TypeError);
    expect(() => changed().validateField("email", () => result as never)).toThrow(
      expected("validateField", returned),
    );
  });

  test.each(NOT_A_LIST)(
    "validateFieldAsync rejects with a TypeError for %s",
    async (_name, result, returned) => {
      await expect(changed().validateFieldAsync("email", () => result as never)).rejects.toThrow(TypeError);
      await expect(changed().validateFieldAsync("email", () => result as never)).rejects.toThrow(
        expected("validateFieldAsync", returned),
      );
    },
  );

  test.each(NOT_A_LIST)(
    "validateFieldAsync rejects with a TypeError for a promise of %s",
    async (_name, result, returned) => {
      await expect(changed().validateFieldAsync("email", async () => result as never)).rejects.toThrow(
        TypeError,
      );
      await expect(changed().validateFieldAsync("email", async () => result as never)).rejects.toThrow(
        expected("validateFieldAsync", returned),
      );
    },
  );

  test("is not called, so cannot throw, when the field has no change", () => {
    const cs = cast(User, {}, []).validateField("email", () => "is taken" as never);
    expect(cs.valid).toBe(true);
  });

  test("arrays and undefined are accepted, sync and async", async () => {
    for (const result of [[], undefined]) {
      expect(changed().validateField("email", () => result as never).valid).toBe(true);
      expect((await changed().validateFieldAsync("email", async () => result as never)).valid).toBe(true);
    }
    const issues = [{ path: [], message: "is taken" }];
    expect(
      changed()
        .validateField("email", () => issues)
        .errorMessages(),
    ).toEqual({ email: ["is taken"] });
    expect((await changed().validateFieldAsync("email", async () => issues)).errorMessages()).toEqual({
      email: ["is taken"],
    });
  });
});
