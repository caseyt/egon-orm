// The security review of step 21: the regular expressions of @egon-orm/mysql, given input
// made to make a backtracking engine work hard. The bound is wide on purpose (see
// packages/core/test/security/redos.test.ts).
import { ConstraintError } from "egon-orm";
import { expect, test } from "vitest";
import { normalizeMysqlError } from "./errors.js";
import { parseDatetime } from "./values.js";

const N = 100_000;

function fast<T>(label: string, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  expect(performance.now() - start, label).toBeLessThan(1_000);
  return result;
}

function serverError(errno: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { errno, code, sqlState: "23000", fatal: false });
}

test("datetime text from the server", () => {
  for (const input of [`2026-01-01 00:00:00.${"1".repeat(N)}x`, `${"2".repeat(N)}-01-01 00:00:00`]) {
    expect(fast("parseDatetime", () => parseDatetime(input))).toBe(input);
  }
});

test("constraint messages, which quote values a user wrote: the patterns cannot cross a quote", () => {
  // The duplicate value is the user's: it may hold quotes and the pattern's own words.
  const value = "' for key 'x".repeat(N / 12);
  const duplicate = fast("DUPLICATE_KEY", () =>
    normalizeMysqlError(
      serverError(1062, "ER_DUP_ENTRY", `Duplicate entry '${value}' for key 'users.users_email_key'`),
      undefined,
    ),
  );
  expect(duplicate).toBeInstanceOf(ConstraintError);
  expect((duplicate as ConstraintError).constraint).toBe("users_email_key");
  const repeated = fast("DUPLICATE_KEY", () =>
    normalizeMysqlError(
      serverError(1062, "ER_DUP_ENTRY", `Duplicate entry '${"for key '".repeat(N / 9)}x`),
      undefined,
    ),
  );
  expect((repeated as ConstraintError).constraint).toBeUndefined();
  for (const [errno, code, message] of [
    [1452, "ER_NO_REFERENCED_ROW_2", `(\`${"`".repeat(N)}`],
    [3819, "ER_CHECK_CONSTRAINT_VIOLATED", `Check constraint '${"'".repeat(N)}`],
    [1048, "ER_BAD_NULL_ERROR", `Column '${"x".repeat(N)}`],
  ] as const) {
    expect(
      fast(code, () => normalizeMysqlError(serverError(errno, code, message), undefined)),
    ).toBeInstanceOf(ConstraintError);
  }
});
