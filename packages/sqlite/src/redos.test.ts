// The security review of step 21: the regular expressions of @egon-orm/sqlite, given input
// made to make a backtracking engine work hard. Each case must grow linearly with the size
// of its input (`expectLinear`: timed at two sizes, 8 times apart), which catches a
// quadratic pattern where a single time bound would not on a moderate input.
import { expectLinear } from "@egon-orm/test-support";
import { ConstraintError } from "egon-orm";
import { expect, test } from "vitest";
import { normalizeSqliteError } from "./errors.js";
import { resolveOptions } from "./options.js";
import { parseTimestamp } from "./values.js";

function sqliteError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.name = "SqliteError";
  error.code = code;
  return error;
}

test("timestamp text: SQLite stores any text, so a stored value may be anything", () => {
  for (const [label, make] of [
    ["spaces before an offset", (n: number) => `2026-01-01${" ".repeat(n)}x`],
    ["a long fraction", (n: number) => `2026-01-01 00:00:00.${"1".repeat(n)}x`],
    ["tabs before an offset", (n: number) => `2026-01-01 00:00${"\t".repeat(n)}+0`],
    ["digits", (n: number) => "1".repeat(n)],
  ] as const) {
    expectLinear(label, make, (input) => expect(parseTimestamp(input)).toBe(input));
  }
});

test("constraint messages: the patterns are anchored at the constraint's kind", () => {
  for (const [label, code, make] of [
    [
      "many columns",
      "SQLITE_CONSTRAINT_UNIQUE",
      (n: number) => `UNIQUE constraint failed: ${"a.".repeat(n / 2)}`,
    ],
    // The words of the pattern repeated, with a line end that makes every try fail: an
    // unanchored pattern tried at each of them is quadratic (296 ms at 100,000 characters).
    [
      "the pattern's words, repeated",
      "SQLITE_CONSTRAINT_UNIQUE",
      (n: number) => `UNIQUE constraint failed: ${"constraint failed: ".repeat(n / 19)}\n`,
    ],
    [
      "an index name of quotes",
      "SQLITE_CONSTRAINT_UNIQUE",
      (n: number) => `UNIQUE constraint failed: index '${"'".repeat(n)}`,
    ],
    [
      "the index words, repeated",
      "SQLITE_CONSTRAINT_UNIQUE",
      (n: number) => `UNIQUE constraint failed: ${"constraint failed: index 'x".repeat(n / 27)}`,
    ],
    [
      "a check expression",
      "SQLITE_CONSTRAINT_CHECK",
      (n: number) => `CHECK constraint failed: ${"a$".repeat(n / 2)} `,
    ],
  ] as const) {
    expectLinear(label, make, (message) =>
      expect(normalizeSqliteError(sqliteError(code, message), undefined)).toBeInstanceOf(ConstraintError),
    );
  }
  // The anchored patterns still read the messages SQLite writes.
  const unique = normalizeSqliteError(
    sqliteError("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: users.email"),
    undefined,
  ) as ConstraintError;
  expect(unique.constraint).toBe("users_email_key");
  const notNull = normalizeSqliteError(
    sqliteError("SQLITE_CONSTRAINT_NOTNULL", "NOT NULL constraint failed: users.email"),
    undefined,
  ) as ConstraintError;
  expect(notNull.column).toBe("email");
  const index = normalizeSqliteError(
    sqliteError("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: index 'users_lower_email'"),
    undefined,
  ) as ConstraintError;
  expect(index.constraint).toBe("users_lower_email");
});

test("pragma names and values", () => {
  expectLinear(
    "PRAGMA_NAME",
    (n) => `${"a".repeat(n)}-`,
    (name) =>
      expect(() => resolveOptions({ filename: ":memory:", pragmas: { [name]: 1 } })).toThrow(TypeError),
  );
  expectLinear(
    "PRAGMA_WORD",
    (n) => `-${"a.".repeat(n / 2)} `,
    (value) =>
      expect(() => resolveOptions({ filename: ":memory:", pragmas: { a: value } })).toThrow(TypeError),
  );
});
