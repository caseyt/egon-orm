// #region sandbox
// test/accounts.itest.ts
import { createSandbox } from "egon-orm/testing";
import { afterEach, beforeEach, expect, test } from "vitest";
import { register } from "../src/accounts.js";
import { repo } from "../src/db.js";
import { User } from "../src/schemas.js";

const sandbox = await createSandbox(repo);
beforeEach(() => sandbox.begin()); //  every test runs in a transaction…
afterEach(() => sandbox.rollback()); // …that is rolled back afterwards

test("registers a user and hashes the password", async () => {
  const result = await register({ email: "ada@example.com", name: "Ada", password: "correct horse battery" });

  expect(result.errors).toBeUndefined();
  const user = await repo.getByOrThrow(User, { email: "ada@example.com" });
  expect(user.passwordHash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
});

test("reports a taken email on the field", async () => {
  const params = { email: "ada@example.com", name: "Ada", password: "correct horse battery" };
  await register(params);

  expect(await register(params)).toEqual({ errors: { email: ["has already been taken"] } });
});
// #endregion sandbox

test("reports every invalid field at once, one message per field", async () => {
  const result = await register({ email: "not an email", name: "", password: "short" });

  expect(result.errors).toEqual({
    email: ["Invalid email address"],
    name: ["can't be blank"], // cast's message: "" becomes null; Zod's own is not added
    password: ["Too small: expected string to have >=12 characters"],
  });
  const spaces = await register({ email: "bo@example.com", name: "  ", password: "correct horse battery" });
  expect(spaces.errors).toEqual({ name: ["Too small: expected string to have >=1 characters"] });
  expect(await repo.count(User)).toBe(0);
});

test("keeps the password and its hash out of JSON", async () => {
  const { user } = await register({ email: "bo@example.com", name: "Bo", password: "correct horse battery" });

  expect(user).toBeDefined();
  expect(JSON.stringify(user)).not.toContain("passwordHash");
  expect(JSON.stringify(user)).not.toContain("correct horse battery");
});
