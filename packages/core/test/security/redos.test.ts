// The security review of step 21: every regular expression in egon-orm, given input made
// to make a backtracking engine work hard (long runs of what a quantifier accepts, ending
// in what the pattern refuses). Each pattern either has no ambiguity to backtrack over or
// runs only on input whose length was checked first.
//
// The bound is wide on purpose: an input of 100,000 characters takes a linear pattern well
// under a millisecond, a quadratic one tens of seconds, an exponential one forever. One
// second separates them on any machine without making the test depend on its speed.
import { describe, expect, test } from "vitest";
import type { FieldMeta } from "../../src/contracts/schema.js";
import { CUSTOM_SQL_TYPE } from "../../src/contracts/type.js";
import { cast, EmbeddedSchema, fragment, meta, Schema, t } from "../../src/index.js";
import { isLiteralText } from "../../src/migration/builder.js";
import { parseMigrationFileName } from "../../src/migration/loader.js";
import { IDENTIFIER } from "../../src/query/ast.js";
import {
  bigintType,
  dateType,
  decimalType,
  floatType,
  integerType,
  localTimestampType,
  timestampType,
  timeType,
  uuidType,
} from "../../src/types/index.js";

const N = 100_000;
const BOUND_MS = 1_000;

/** Runs `fn` and fails when it takes longer than the bound. */
function fast<T>(label: string, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  const elapsed = performance.now() - start;
  expect(elapsed, `${label} took ${elapsed.toFixed(0)} ms`).toBeLessThan(BOUND_MS);
  return result;
}

const run = (unit: string, n = N): string => unit.repeat(n);

describe("field type casts", () => {
  test("integer and bigint text: refused by length before the pattern runs", () => {
    for (const type of [integerType(), bigintType(), bigintType({ mode: "number" })]) {
      for (const input of [`${run("1")}x`, `-${run("9")}-`, run(" "), `${run("0")}.`]) {
        expect(fast("integer", () => type.cast(input).success)).toBe(false);
      }
    }
  });

  test("float text: refused by length; at the limit the pattern is still quick", () => {
    const type = floatType();
    for (const input of [`${run("1")}x`, `${run("1")}e`, `.${run("1")}e+`, `${run("1")}.${run("1")}x`]) {
      expect(fast("float", () => type.cast(input).success)).toBe(false);
    }
    // 400 characters is the longest text read: `\d+\.?\d*` is the one ambiguous part.
    expect(fast("float 400", () => type.cast(`${run("1", 399)}x`).success)).toBe(false);
    // A finite number of 400 characters (400 digits without a point would be Infinity).
    expect(fast("float 400", () => type.cast(`0.${run("1", 398)}`).success)).toBe(true);
  });

  test("decimal text: no length limit, and a grammar without backtracking", () => {
    const plain = decimalType();
    const scaled = decimalType({ precision: 10, scale: 2 });
    for (const input of [`${run("1")}x`, `${run("1")}.${run("1")}.`, `+${run("0")}-`, `.${run("9")}x`]) {
      expect(fast("decimal", () => plain.cast(input).success)).toBe(false);
      expect(fast("decimal scaled", () => scaled.cast(input).success)).toBe(false);
    }
    expect(fast("decimal", () => plain.cast(`${run("1")}.${run("9")}`).success)).toBe(true);
  });

  test("uuid text: only 36 characters are read", () => {
    const type = uuidType();
    expect(fast("uuid", () => type.cast(`${run("a")}-`).success)).toBe(false);
    expect(fast("uuid", () => type.cast(run("0123456789abcdef-", 10_000)).success)).toBe(false);
  });

  test("dates, times and timestamps: lengths are checked first", () => {
    const inputs = [
      `${run("1")}`,
      `2026-01-01T${run("1")}`,
      `2026-01-01 10:00:00.${run("1")}x`,
      run("2026-"),
    ];
    for (const type of [
      dateType(),
      dateType({ as: "date" }),
      timeType(),
      timestampType(),
      localTimestampType(),
    ]) {
      for (const input of inputs) expect(fast(type.name, () => type.cast(input).success)).toBe(false);
    }
    // A timestamp at its length limit (64), with the longest fraction it can hold.
    const longest = `2026-01-01T10:00:00.${run("1", 38)}+05:30`;
    expect(longest.length).toBe(64);
    expect(fast("timestamp", () => timestampType().cast(longest).success)).toBe(true);
    expect(fast("timestamp", () => timestampType().cast(`${longest}x`).success)).toBe(false);
  });

  test("a bigint stored in an embedded document is read with an anchored digit pattern", () => {
    class Box extends EmbeddedSchema({ n: t.bigint() }) {}
    class Holder extends Schema("holders", {
      id: t.integer().primaryKey(),
      box: t.embedOne(() => Box).nullable(),
    }) {}
    const box = meta(Holder).fieldsByName.get("box") as FieldMeta;
    // Read from the database: the stored text of a bigint is checked before BigInt() parses it.
    expect(() => fast("embed bigint", () => box.type.fromDb({ n: `${run("1")}x` }))).toThrow();
    expect(fast("embed bigint", () => box.type.fromDb({ n: run("1", 30) }))).toEqual(expect.anything());
  });
});

describe("names and SQL text", () => {
  test("identifiers: one character class after another, nothing to backtrack over", () => {
    for (const input of [`${run("a")}-`, `_${run("$")}!`, `${run("a1")} `]) {
      expect(fast("IDENTIFIER", () => IDENTIFIER.test(input))).toBe(false);
      expect(fast("fragment.ident", () => () => fragment.ident(input))).toBeTypeOf("function");
    }
  });

  test("custom SQL type names: words separated by one character, then a bounded tail", () => {
    for (const input of [
      `${run("a ")}!`,
      `${run("a.")}`,
      `${run("ab", N / 2)}(${run("1")}`,
      `a(${run("1")}, ${run("2")}`,
      `a${run("[]")}[`,
      `${run("a")} ${run("b")};`,
    ]) {
      expect(fast("CUSTOM_SQL_TYPE", () => CUSTOM_SQL_TYPE.test(input))).toBe(false);
    }
    expect(fast("CUSTOM_SQL_TYPE", () => CUSTOM_SQL_TYPE.test(`${run("a b ")}c`))).toBe(true);
  });

  test("text for a DDL string constant: the lone-surrogate check is linear", () => {
    expect(fast("isLiteralText", () => isLiteralText(`${run("𐀀")}\ud800`))).toBe(false);
    expect(fast("isLiteralText", () => isLiteralText(run("\udc00")))).toBe(false);
    expect(fast("isLiteralText", () => isLiteralText(run("a")))).toBe(true);
  });

  test("migration file names", () => {
    for (const input of [`1_${run("a_")}.t`, `${run("1")}_a.tsx`, `${run("1_")}x`]) {
      expect(fast("parseMigrationFileName", () => parseMigrationFileName(input))).toBeUndefined();
    }
  });
});

describe("messages and validations", () => {
  test("placeholders in a message are filled in one pass", () => {
    const message = `${run("{a")}${run("{")}${run("}")}{count}`;
    const cs = fast("validateLength", () =>
      cast({ data: {}, types: { name: t.string() } }, { name: "x" }, ["name"]).validateLength("name", {
        min: 3,
        message,
      }),
    );
    expect(fast("errorMessages", () => cs.errorMessages().name?.[0]?.endsWith("3"))).toBe(true);
  });

  test("validateRequired with trim on a long blank string", () => {
    const cs = fast("validateRequired", () =>
      cast({ data: {}, types: { name: t.string() } }, { name: run(" \t\n", N) }, ["name"]).validateRequired(
        ["name"],
        { trim: true },
      ),
    );
    expect(cs.valid).toBe(false);
  });
});
