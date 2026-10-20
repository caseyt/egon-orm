// A field that already has an error (from cast, validateRequired or an earlier validation)
// gets no more errors from a Zod schema: each field shows one message, the first failure.
import { User } from "@egon-orm/test-support";
import type { AnySchema, Row } from "egon-orm";
import { cast, meta, Schema, t } from "egon-orm";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { castWith, toZod } from "../src/index.js";

function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

class Member extends Schema("members", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string(),
  nickname: t.string().nullable(),
}) {}

const MemberInput = z.object({ email: z.email(), name: z.string().min(2) });

describe("Zod issues on a field that already has an error", () => {
  test("cast reports a blank name; Zod's missing-key issue on it is dropped", () => {
    const cs = cast(Member, { email: "ada@engine.example", name: "" }, ["email", "name"]).validate(
      MemberInput,
    );
    expect(cs.errorMessages()).toEqual({ name: ["can't be blank"] });
    expect(cs.valid).toBe(false);
    // castWith is cast followed by validate, so it gives the same.
    expect(castWith(Member, { email: "ada@engine.example", name: "" }, MemberInput).errorMessages()).toEqual({
      name: ["can't be blank"],
    });
    // Without the rule, Zod's own message would follow: the schema does report it.
    expect(MemberInput.safeParse({ email: "ada@engine.example" }).success).toBe(false);
  });

  test("a Zod issue on another field is kept", () => {
    const cs = cast(Member, { email: "not an address", name: "" }, ["email", "name"]).validate(MemberInput);
    expect(Object.keys(cs.errors).sort()).toEqual(["email", "name"]);
    expect(cs.errorMessages().name).toEqual(["can't be blank"]);
    expect(cs.errors.email?.[0]?.validation).toBe("schema");
  });

  test("a value cast rejects, and a field validateRequired found missing, keep their one message", () => {
    const Age = z.object({ age: z.number().int().min(13) });
    expect(cast(User, { age: "forty" }, ["age"]).validate(Age).errorMessages()).toEqual({
      age: ["is invalid"],
    });

    const required = cast(Member, {}, [])
      .validateRequired(["email", "name"])
      .validate(toZod(Member, { mode: "insert" }));
    expect(required.errorMessages()).toEqual({ email: ["can't be blank"], name: ["can't be blank"] });
  });

  test("a nested child field: the routed issue is dropped where the child field has an error", () => {
    const cs = cast(User, { email: "ada@engine.example", settings: { theme: "neon" } }, ["email"])
      .castEmbed("settings", { with: (settings, p) => cast(settings, p, ["theme", "emailNotifications"]) })
      .validate(
        z.object({
          settings: z.object({ theme: z.literal("dark"), emailNotifications: z.literal(false) }),
        }),
      );
    expect(cs.errorMessages()).toEqual({
      settings: { theme: ["is invalid"], emailNotifications: ["Invalid input: expected false"] },
    });
  });

  test('scope "changed": a changed field with an error is left alone, other changed fields are validated', () => {
    const row = loaded(Member, { id: 1, email: "ada@engine.example", name: "Ada", nickname: null });
    const cs = cast(row, { email: "nope", name: "" }, ["email", "name"]).validate(
      MemberInput.extend({ nickname: z.string() }),
      { scope: "changed" },
    );
    expect(Object.keys(cs.errors).sort()).toEqual(["email", "name"]);
    expect(cs.errorMessages().name).toEqual(["can't be blank"]);
    expect(cs.errors.email?.[0]?.validation).toBe("schema");
  });

  test("validateField after a built-in failure on the same field does not run", () => {
    const cs = cast(Member, { email: "a@b", name: "Ada" }, ["email", "name"])
      .validateLength("email", { min: 5 })
      .validateField("email", z.email());
    expect(cs.errorMessages()).toEqual({ email: ["should be at least 5 character(s)"] });
  });
});
