// The security review of step 21: the regular expressions of @egon-orm/sqlite, given input
// made to make a backtracking engine work hard. The bound is wide on purpose (see
// packages/core/test/security/redos.test.ts).
import { ConstraintError } from "egon-orm";
import { expect, test } from "vitest";
import { normalizeSqliteError } from "./errors.js";
import { resolveOptions } from "./options.js";
import { parseTimestamp } from "./values.js";

const N = 100_000;

function fast<T>(label: string, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  expect(performance.now() - start, label).toBeLessThan(1_000);
  return result;
}

function sqliteError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.name = "SqliteError";
  error.code = code;
  return error;
}

test("timestamp text: SQLite stores any text, so a stored value may be anything", () => {
  for (const input of [
    `2026-01-01${" ".repeat(N)}x`,
    `2026-01-01 00:00:00.${"1".repeat(N)}x`,
    `2026-01-01 00:00${"\t".repeat(N)}+0`,
    `${"1".repeat(N)}`,
  ]) {
    expect(fast("parseTimestamp", () => parseTimestamp(input))).toBe(input);
  }
});

test("constraint messages", () => {
  for (const message of [
    `UNIQUE constraint failed: ${"a.".repeat(N)}`,
    `UNIQUE constraint failed: ${"constraint failed: ".repeat(N / 20)}\n`,
    `UNIQUE constraint failed: index '${"'".repeat(N)}`,
    `CHECK constraint failed: ${"a$".repeat(N)} `,
  ]) {
    const code = message.startsWith("CHECK") ? "SQLITE_CONSTRAINT_CHECK" : "SQLITE_CONSTRAINT_UNIQUE";
    expect(fast(code, () => normalizeSqliteError(sqliteError(code, message), undefined))).toBeInstanceOf(
      ConstraintError,
    );
  }
});

test("pragma names and values", () => {
  expect(() =>
    fast("PRAGMA_NAME", () =>
      resolveOptions({ filename: ":memory:", pragmas: { [`${"a".repeat(N)}-`]: 1 } }),
    ),
  ).toThrow(TypeError);
  expect(() =>
    fast("PRAGMA_WORD", () =>
      resolveOptions({ filename: ":memory:", pragmas: { a: `-${"a.".repeat(N)} ` } }),
    ),
  ).toThrow(TypeError);
});
