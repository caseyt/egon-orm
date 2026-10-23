// A check that work grows linearly with its input, for the ReDoS tests of the security
// review (step 21). One time bound cannot tell a quadratic pattern on a moderate input from
// a slow machine; the growth between two sizes can.
import { expect } from "vitest";

/** The fastest of `runs` timings of `fn`, in milliseconds. */
function fastest(fn: () => unknown, runs: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/**
 * Fails when `run` grows faster than linearly in the size of its input: it is timed on
 * `make(n)` and on `make(8 * n)` (the fastest of three runs each, after one to warm up), and
 * the larger must take less than 16 times the smaller, plus 50 ms for noise. Linear work
 * grows 8 times, quadratic 64 times. Only `run` is timed, not `make`.
 *
 * @example
 * ```ts
 * expectLinear("COLUMNS_FAILED", (n) => `constraint failed: ${"x".repeat(n)}\n`, (text) => PATTERN.exec(text));
 * ```
 */
export function expectLinear<T>(
  label: string,
  make: (n: number) => T,
  run: (input: T) => unknown,
  n = 50_000,
): void {
  const small = make(n);
  const large = make(8 * n);
  run(small);
  const smallMs = fastest(() => run(small), 3);
  const largeMs = fastest(() => run(large), 3);
  expect(
    largeMs,
    `${label}: ${smallMs.toFixed(2)} ms at ${n}, ${largeMs.toFixed(2)} ms at ${8 * n}`,
  ).toBeLessThan(16 * smallMs + 50);
}
