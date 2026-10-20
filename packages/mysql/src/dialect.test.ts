import { describe, expect, test } from "vitest";
import { MYSQL_CAPABILITIES as REFERENCE } from "../../core/src/compiler/dialect.js";
import { MYSQL_CAPABILITIES, quoteIdentifier } from "./dialect.js";

describe("MYSQL_CAPABILITIES", () => {
  test("are the compiler's reference copy, flag for flag", () => {
    expect(MYSQL_CAPABILITIES).toEqual(REFERENCE);
  });

  test("have no RETURNING or conflict target, three isolation levels, and 65,535 parameters", () => {
    expect(MYSQL_CAPABILITIES).toMatchObject({
      returning: false,
      conflictTarget: false,
      ddlTransactions: false,
      isolationLevels: ["read committed", "repeatable read", "serializable"],
      maxParams: 65_535,
    });
  });

  test("are frozen", () => {
    expect(Object.isFrozen(MYSQL_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(MYSQL_CAPABILITIES.lockModes)).toBe(true);
  });
});

describe("quoteIdentifier", () => {
  test("wraps a name in backticks and doubles the ones inside", () => {
    expect(quoteIdentifier("users")).toBe("`users`");
    expect(quoteIdentifier("my`table")).toBe("`my``table`");
    expect(quoteIdentifier('a"b')).toBe('`a"b`');
  });
});
