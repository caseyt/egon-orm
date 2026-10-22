// The examples of the validators step, verbatim, as tests.
import { User } from "@egon-orm/test-support";
import { cast } from "egon-orm";
import { describe, expect, test } from "vitest";
import * as yup from "yup";
import { z } from "zod";
import { toZod } from "../src/index.js";
import { keynote } from "./compat/scenarios.js";

const DISPOSABLE = new Set(["mailinator.example", "throwaway.example"]);
async function isDisposable(email: string): Promise<boolean> {
  await Promise.resolve();
  return DISPOSABLE.has(email.slice(email.indexOf("@") + 1));
}

describe("the step's examples", () => {
  test("Zod", () => {
    const params = { email: "grace@cobol.example", age: "12" };
    // verbatim
    const UserInput = z.object({
      email: z.string().email(),
      age: z.number().int().min(13).nullish(),
    });
    const cs = cast(User, params, ["email", "age"]).validate(UserInput);
    expect(Object.keys(cs.errors)).toEqual(["age"]);
    expect(cs.errors.age?.[0]?.validation).toBe("schema");
  });

  test("cross-field rule with Zod", () => {
    const cs = cast(keynote(), { endsAt: "2026-06-01T09:00:00Z" }, ["endsAt"]);
    // verbatim
    const checked = cs.validate(
      z
        .object({ startsAt: z.date(), endsAt: z.date() })
        .refine((v) => v.endsAt > v.startsAt, { path: ["endsAt"], message: "must be after start" }),
    );
    expect(checked.errorMessages()).toEqual({ endsAt: ["must be after start"] });
  });

  test("plain function", () => {
    const cs = cast(keynote(), { endsAt: "2026-06-01T09:00:00Z" }, ["endsAt"]);
    // verbatim
    const checked = cs.validate((v, { isChanged }) =>
      isChanged("endsAt") && v.endsAt <= v.startsAt
        ? [{ path: "endsAt", message: "must be after start" }]
        : [],
    );
    expect(checked.errorMessages()).toEqual({ endsAt: ["must be after start"] });
  });

  test("Yup: its Standard Schema is asynchronous, so the example runs with validateAsync", async () => {
    const cs = cast(User, { email: "not an address" }, ["email"]);
    expect(() => cs.validate(yup.object({ email: yup.string().email().required() }))).toThrow(
      "query.validatorPromise: The validator returned a Promise.",
    );
    const checked = await cs.validateAsync(yup.object({ email: yup.string().email().required() }));
    expect(Object.keys(checked.errors)).toEqual(["email"]);
  });

  test("async (a remote check)", async () => {
    const cs = cast(User, { email: "temp@mailinator.example" }, ["email"]);
    // verbatim
    const checked = await cs.validateAsync(async (v) =>
      (await isDisposable(v.email)) ? [{ path: "email", message: "is not allowed" }] : [],
    );
    expect(checked.errorMessages()).toEqual({ email: ["is not allowed"] });
  });

  test("toZod", () => {
    // verbatim
    const UserZ = toZod(User); // z.object matching Row<User> (virtual included, redacted included)
    const CreateUser = toZod(User, { mode: "insert", pick: ["email", "name", "age"] }).extend({
      email: z.string().email(),
    });
    type CreateUser = z.infer<typeof CreateUser>; // { email: string; name?: string | null; age?: number | null }

    const created: CreateUser = { email: "edsger@goto.example", name: null };
    expect(CreateUser.parse(created)).toEqual(created);
    expect(CreateUser.safeParse({ email: "nope" }).success).toBe(false);
    expect(Object.keys(UserZ.shape)).toContain("password");
    expect(Object.keys(UserZ.shape)).toContain("passwordHash");
  });
});
