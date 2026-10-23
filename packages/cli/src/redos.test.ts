// The security review of step 21: the regular expressions of @egon-orm/cli, given input
// made to make a backtracking engine work hard (see packages/core/test/security/redos.test.ts).
import { expect, test } from "vitest";
import { MIGRATION_NAME } from "./create.js";

test("a migration name is one character class, anchored", () => {
  const start = performance.now();
  expect(MIGRATION_NAME.test(`${"a_1".repeat(100_000)}-`)).toBe(false);
  expect(performance.now() - start).toBeLessThan(1_000);
});
