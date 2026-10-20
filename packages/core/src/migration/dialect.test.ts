// The Postgres migration table, and above all its string literal writer: DDL takes no
// bound parameters, so a constant default is written as a literal, and no string may end
// the literal early. The conformance suite checks the same strings against Postgres.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { MigrationError } from "../errors.js";
import { migrationDialectOf, POSTGRES_MIGRATION_DIALECT } from "./dialect.js";

const literal = POSTGRES_MIGRATION_DIALECT.stringLiteral;

/**
 * Reads a Postgres string literal the way the server does, under either setting of
 * standard_conforming_strings, and returns its value and what follows it. `undefined`
 * when it is not a literal.
 */
function readLiteral(sql: string, standardConforming: boolean): { value: string; rest: string } | undefined {
  let i = 0;
  let escapes = false;
  if (sql[0] === "E") {
    escapes = true;
    i = 1;
  } else if (!standardConforming) {
    escapes = true;
  }
  if (sql[i] !== "'") return undefined;
  i++;
  let value = "";
  while (i < sql.length) {
    const c = sql[i] as string;
    if (c === "'") {
      if (sql[i + 1] === "'") {
        value += "'";
        i += 2;
        continue;
      }
      return { value, rest: sql.slice(i + 1) };
    }
    if (escapes && c === "\\") {
      const next = sql[i + 1];
      if (next === undefined) return undefined;
      // Only the escapes that matter here: an escaped backslash or quote stands for itself.
      // Any other escape changes the value, which the round trip below would catch.
      value += next === "\\" || next === "'" ? next : `\\${next}`;
      i += 2;
      continue;
    }
    value += c;
    i++;
  }
  return undefined;
}

describe("the Postgres string literal", () => {
  test("doubles quotes, and makes an E-string with doubled backslashes when there is a backslash", () => {
    expect(literal("member")).toBe("'member'");
    expect(literal("it's")).toBe("'it''s'");
    expect(literal("")).toBe("''");
    expect(literal("a\\b")).toBe("E'a\\\\b'");
    expect(literal("\\'; drop table users; --")).toBe("E'\\\\''; drop table users; --'");
  });

  test("any string reads back as itself and nothing follows it, under either string setting", () => {
    const strings = fc.oneof(
      fc.string({ unit: "binary" }),
      fc.string({ unit: fc.constantFrom("'", "\\", "a", " ", ";", "-", "E", "$", "\n") }),
    );
    fc.assert(
      fc.property(
        strings.filter((s) => !s.includes("\u0000")),
        (value) => {
          const sql = literal(value);
          for (const standardConforming of [true, false]) {
            const read = readLiteral(sql, standardConforming);
            expect(read).toEqual({ value, rest: "" });
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("migrationDialectOf", () => {
  test("has a table for Postgres and refuses the others", () => {
    expect(migrationDialectOf("postgres")).toBe(POSTGRES_MIGRATION_DIALECT);
    expect(() => migrationDialectOf("sqlite")).toThrow(MigrationError);
    expect(() => migrationDialectOf("constructor" as never)).toThrow(MigrationError);
  });

  test("the table is frozen", () => {
    expect(Object.isFrozen(POSTGRES_MIGRATION_DIALECT)).toBe(true);
    expect(Object.isFrozen(POSTGRES_MIGRATION_DIALECT.features)).toBe(true);
  });
});
