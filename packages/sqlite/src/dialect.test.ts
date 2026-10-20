import { describe, expect, test } from "vitest";
import { SQLITE_CAPABILITIES as REFERENCE } from "../../core/src/compiler/dialect.js";
import { quoteIdentifier, SQLITE_CAPABILITIES } from "./dialect.js";

describe("SQLITE_CAPABILITIES", () => {
  test("are the compiler's reference copy, flag for flag", () => {
    expect(SQLITE_CAPABILITIES).toEqual(REFERENCE);
  });

  test("have no row locks or isolation levels, one connection, and 32,766 parameters", () => {
    expect(SQLITE_CAPABILITIES).toMatchObject({
      lockModes: [],
      isolationLevels: [],
      multipleConnections: false,
      cancel: false,
      maxParams: 32_766,
    });
  });

  test("are frozen", () => {
    expect(Object.isFrozen(SQLITE_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(SQLITE_CAPABILITIES.lockModes)).toBe(true);
  });
});

describe("quoteIdentifier", () => {
  test("wraps a name in double quotes and doubles the ones inside", () => {
    expect(quoteIdentifier("users")).toBe('"users"');
    expect(quoteIdentifier('my "table"')).toBe('"my ""table"""');
    expect(quoteIdentifier("a`b")).toBe('"a`b"');
  });
});
