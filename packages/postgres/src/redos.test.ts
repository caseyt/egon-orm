// The security review of step 21: the regular expressions of @egon-orm/postgres, given
// input made to make a backtracking engine work hard. Every pattern here is anchored at the
// start, so it is tried once; the one-second bound (see
// packages/core/test/security/redos.test.ts) catches an exponential one.
import { expect, test } from "vitest";
import { normalizePgError } from "./errors.js";
import { parseTimestamp } from "./values.js";

const N = 100_000;

function fast<T>(label: string, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  expect(performance.now() - start, label).toBeLessThan(1_000);
  return result;
}

test("timestamp text from the server: one digit run per part, then fixed separators", () => {
  for (const input of [
    `${"1".repeat(N)}-01-01 00:00:00`,
    `2026-01-01 00:00:00.${"1".repeat(N)}x`,
    `2026-01-01 00:00:00+${"1".repeat(N)}`,
    `2026-01-01 00:00:00${" BC".repeat(N)}`,
  ]) {
    fast("parseTimestamp", () => parseTimestamp(input, true));
    fast("parseTimestamp", () => parseTimestamp(`${input}x`, false));
  }
});

test("error codes and connection messages are anchored", () => {
  const code = Object.assign(new Error("x"), { code: "1".repeat(N), severity: "ERROR" });
  expect(fast("SQLSTATE", () => normalizePgError(code, undefined))).toBe(code);
  const message = new Error(`${"Connection terminated".repeat(N / 20)}x`);
  expect(fast("connection message", () => normalizePgError(message, undefined))).not.toBe(message);
  const other = new Error(`x${"Connection terminated".repeat(N / 20)}`);
  expect(fast("connection message", () => normalizePgError(other, undefined))).toBe(other);
});
