import assert from "node:assert/strict";
import { test } from "node:test";
import { badgeOf } from "./coverage-badge.mjs";

const summaryOf = (pct) => ({ total: { lines: { pct } } });

test("the badge shows the line percentage, rounded down to one decimal", () => {
  assert.deepEqual(badgeOf(summaryOf(99.36)), {
    schemaVersion: 1,
    label: "coverage",
    message: "99.3%",
    color: "brightgreen",
  });
  assert.equal(badgeOf(summaryOf(100)).message, "100%");
  assert.equal(badgeOf(summaryOf(94.99)).message, "94.9%");
});

test("the colour falls with the percentage", () => {
  assert.equal(badgeOf(summaryOf(95)).color, "brightgreen");
  assert.equal(badgeOf(summaryOf(94.99)).color, "green");
  assert.equal(badgeOf(summaryOf(90)).color, "green");
  assert.equal(badgeOf(summaryOf(89.9)).color, "yellow");
  assert.equal(badgeOf(summaryOf(79.9)).color, "red");
});

test("a summary without a usable line percentage is refused", () => {
  for (const summary of [{}, { total: {} }, summaryOf("99"), summaryOf(Number.NaN), summaryOf(101), summaryOf(-1)]) {
    assert.throws(() => badgeOf(summary), /no line percentage/);
  }
});
