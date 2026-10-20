// Property tests: a schema derived with toZod reports an issue on a field exactly when the
// field's value breaks the field's declared type or nullability.
import { User } from "@egon-orm/test-support";
import { cast, change } from "egon-orm";
import fc from "fast-check";
import { expect, test } from "vitest";
import { toZod } from "../src/index.js";

const UserInsert = toZod(User, { mode: "insert" });

/** The fields that received a schema error. */
function schemaErrorKeys(
  errors: Readonly<Record<string, readonly { readonly validation?: string }[]>>,
): string[] {
  return Object.keys(errors)
    .filter((key) => (errors[key] ?? []).some((error) => error.validation === "schema"))
    .sort();
}

// Form input for each permitted field: absent, valid text, text the type rejects, or empty.
const formParams = fc.record(
  {
    email: fc.oneof(fc.emailAddress(), fc.constant(""), fc.integer(), fc.constant(null)),
    name: fc.oneof(fc.string({ maxLength: 6 }), fc.constant(""), fc.constant(null), fc.boolean()),
    age: fc.oneof(fc.integer({ min: -5, max: 150 }).map(String), fc.constant("forty"), fc.constant("")),
    role: fc.constantFrom("admin", "member", "owner", ""),
    password: fc.string({ maxLength: 6 }),
  },
  { requiredKeys: [] },
);

test("cast + validate(toZod(insert)): an issue on a field exactly when its value breaks the field's type or nullability", () => {
  fc.assert(
    fc.property(formParams, (params) => {
      const before = cast(User, params, ["email", "name", "age", "role", "password"]);
      const cs = before.validate(UserInsert);
      // cast turns what it accepts into values of the right type and records nothing it
      // rejects, so the only value left that breaks its field is a missing email (required,
      // no default); name and age are nullable, role has a default, password is virtual.
      // An email cast already reported (blank, or not a string) keeps cast's message alone.
      const expected =
        typeof cs.changes.email === "string" || Object.hasOwn(before.errors, "email") ? [] : ["email"];
      expect(schemaErrorKeys(cs.errors)).toEqual(expected);
      // One message per field.
      for (const list of Object.values(cs.errors)) expect(list).toHaveLength(1);
    }),
  );
});

// Trusted values of any kind, which change() does not convert.
const anything = fc.oneof(
  fc.string({ maxLength: 6 }),
  fc.constantFrom("admin", "member"),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(2 ** 60),
);

/** Whether `value` is a value of the field, written from the schema's declarations. */
const fits: Record<string, (value: unknown) => boolean> = {
  email: (value) => typeof value === "string",
  name: (value) => value === null || typeof value === "string",
  // A whole number in the safe range.
  age: (value) => value === null || Number.isSafeInteger(value),
  role: (value) => value === "admin" || value === "member",
  lockVersion: (value) => Number.isSafeInteger(value),
};
const nullable = new Set(["name", "age"]);
const defaulted = new Set(["role", "lockVersion"]);

test("change + validate(toZod(insert)): an issue on a field exactly when its value breaks the field's type or nullability", () => {
  fc.assert(
    fc.property(
      fc.record(
        { email: anything, name: anything, age: anything, role: anything, lockVersion: anything },
        { requiredKeys: [] },
      ),
      (values) => {
        const cs = change(User, values as never);
        const expected: string[] = [];
        for (const field of Object.keys(fits)) {
          const given = Object.hasOwn(values, field);
          const value = (values as Record<string, unknown>)[field];
          // A null on a field that is not nullable is refused by change(), which reports
          // can't be blank; that field gets no second error from the schema.
          if (given && value === null && !nullable.has(field)) continue;
          if (!given) {
            // No value: only a field without a default is then missing.
            if (!defaulted.has(field) && !nullable.has(field)) expected.push(field);
            continue;
          }
          if (!fits[field]?.(value)) expected.push(field);
        }
        expect(schemaErrorKeys(cs.validate(UserInsert).errors)).toEqual(expected.sort());
      },
    ),
  );
});
