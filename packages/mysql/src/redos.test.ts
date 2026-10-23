// The security review of step 21: the regular expressions of @egon-orm/mysql, given input
// made to make a backtracking engine work hard. Each case must grow linearly with the size
// of its input (`expectLinear`: timed at two sizes, 8 times apart). The constraint patterns
// are not anchored at the start, but each try stops at the next quote or backtick, so the
// tries together read the message once.
import { expectLinear } from "@egon-orm/test-support";
import { ConstraintError } from "egon-orm";
import { expect, test } from "vitest";
import { normalizeMysqlError } from "./errors.js";
import { parseDatetime } from "./values.js";

function serverError(errno: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { errno, code, sqlState: "23000", fatal: false });
}

test("datetime text from the server", () => {
  expectLinear(
    "a long fraction",
    (n) => `2026-01-01 00:00:00.${"1".repeat(n)}x`,
    (input) => expect(parseDatetime(input)).toBe(input),
  );
  expectLinear(
    "a long year",
    (n) => `${"2".repeat(n)}-01-01 00:00:00`,
    (input) => expect(parseDatetime(input)).toBe(input),
  );
});

test("constraint messages, which quote values a user wrote: the patterns cannot cross a quote", () => {
  // The duplicate value is the user's: it may hold quotes and the pattern's own words.
  expectLinear(
    "DUPLICATE_KEY, the pattern's words in the value",
    (n) => `Duplicate entry '${"' for key 'x".repeat(n / 12)}' for key 'users.users_email_key'`,
    (message) => {
      const error = normalizeMysqlError(serverError(1062, "ER_DUP_ENTRY", message), undefined);
      expect((error as ConstraintError).constraint).toBe("users_email_key");
    },
  );
  expectLinear(
    "DUPLICATE_KEY, no closing quote",
    (n) => `Duplicate entry '${"for key '".repeat(n / 9)}x`,
    (message) => {
      const error = normalizeMysqlError(serverError(1062, "ER_DUP_ENTRY", message), undefined);
      expect((error as ConstraintError).constraint).toBeUndefined();
    },
  );
  for (const [errno, code, make] of [
    [1452, "ER_NO_REFERENCED_ROW_2", (n: number) => `(\`${"`".repeat(n)}`],
    [1452, "ER_NO_REFERENCED_ROW_2", (n: number) => `(\`${"(`a`.`".repeat(n / 6)}`],
    [3819, "ER_CHECK_CONSTRAINT_VIOLATED", (n: number) => `Check constraint '${"'".repeat(n)}`],
    [1048, "ER_BAD_NULL_ERROR", (n: number) => `Column '${"x".repeat(n)}`],
  ] as const) {
    expectLinear(code, make, (message) =>
      expect(normalizeMysqlError(serverError(errno, code, message), undefined)).toBeInstanceOf(
        ConstraintError,
      ),
    );
  }
});
