import { User } from "@egon-orm/test-support";
import fc from "fast-check";
import { expect, test } from "vitest";
import type { ChangesetError, ValidationIssue } from "../../contracts/changeset.js";
import { meta } from "../../schema/index.js";
import { cast } from "../changeset.js";
import { BASE } from "./types.js";

const fieldNames = meta(User).fields.map((field) => field.name);
const permitted = ["email", "name", "age", "role"] as const;

const params = fc.record(
  {
    email: fc.oneof(fc.constant(""), fc.emailAddress()),
    name: fc.oneof(fc.constant(""), fc.string({ maxLength: 8 })),
    age: fc.oneof(fc.integer({ min: 0, max: 120 }).map(String), fc.constant("old")),
    role: fc.constantFrom("admin", "member", "root"),
  },
  { requiredKeys: [] },
);

const issue: fc.Arbitrary<ValidationIssue> = fc.record({
  path: fc.oneof(
    fc.constantFrom(...fieldNames),
    fc.array(fc.oneof(fc.constantFrom(...fieldNames, "other"), fc.nat(3)), { maxLength: 3 }),
  ),
  message: fc.string({ maxLength: 10 }),
});

/** Where an issue is expected to land under scope "all". */
function keyOf(path: ValidationIssue["path"]): string {
  const head = Array.isArray(path) ? path[0] : path;
  return typeof head === "string" && fieldNames.includes(head) ? head : BASE;
}

test("a validator only appends errors, in issue order, to fields without one, and never touches the changes", () => {
  fc.assert(
    fc.property(params, fc.array(issue, { maxLength: 6 }), fc.boolean(), (input, issues, changedOnly) => {
      const before = cast(User, input, [...permitted]);
      const after = before.validate(() => issues, changedOnly ? { scope: "changed" } : undefined);
      expect(after.changes).toBe(before.changes);

      const expected = new Map<string, string[]>();
      for (const [key, errors] of Object.entries(before.errors))
        expected.set(
          key,
          errors.map((e) => e.message),
        );
      for (const { path, message } of issues) {
        const key = keyOf(path);
        if (changedOnly && key !== BASE && !Object.hasOwn(before.changes, key)) continue;
        // A field that already had an error (from cast) keeps only that one.
        if (key !== BASE && Object.hasOwn(before.errors, key)) continue;
        expected.set(key, [...(expected.get(key) ?? []), message]);
      }
      const actual = new Map(
        Object.entries(after.errors).map(([key, errors]) => [
          key,
          errors.map((e: ChangesetError) => e.message),
        ]),
      );
      expect(actual).toEqual(expected);
      expect(after.valid).toBe(expected.size === 0);
    }),
  );
});
