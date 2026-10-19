import { describe, expect, test } from "vitest";
import { POSTGRES_CAPABILITIES, quoteIdentifier } from "./dialect.js";

describe("POSTGRES_CAPABILITIES", () => {
  test("say yes to everything, list the lock modes and isolation levels, and allow 65,535 parameters", () => {
    expect(POSTGRES_CAPABILITIES).toEqual({
      returning: true,
      onConflict: true,
      conflictTarget: true,
      ilike: true,
      lateralJoin: true,
      fullJoin: true,
      distinctOn: true,
      arrays: true,
      arrayParams: true,
      jsonb: true,
      nullsOrder: true,
      updateJoin: true,
      cteMaterialized: true,
      insertDefaultValues: true,
      lockModes: [
        "FOR UPDATE",
        "FOR UPDATE SKIP LOCKED",
        "FOR UPDATE NOWAIT",
        "FOR NO KEY UPDATE",
        "FOR NO KEY UPDATE SKIP LOCKED",
        "FOR NO KEY UPDATE NOWAIT",
        "FOR SHARE",
        "FOR SHARE SKIP LOCKED",
        "FOR SHARE NOWAIT",
        "FOR KEY SHARE",
        "FOR KEY SHARE SKIP LOCKED",
        "FOR KEY SHARE NOWAIT",
      ],
      isolationLevels: ["read committed", "repeatable read", "serializable"],
      savepoints: true,
      ddlTransactions: true,
      stream: true,
      maxParams: 65_535,
    });
  });

  test("are frozen, lists included", () => {
    expect(Object.isFrozen(POSTGRES_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(POSTGRES_CAPABILITIES.lockModes)).toBe(true);
    expect(Object.isFrozen(POSTGRES_CAPABILITIES.isolationLevels)).toBe(true);
  });
});

describe("quoteIdentifier", () => {
  test.each([
    ["users", '"users"'],
    ["Mixed Case", '"Mixed Case"'],
    ['a"b', '"a""b"'],
    ['"; drop table users; --', '"""; drop table users; --"'],
    ["", '""'],
  ])("%s becomes %s", (name, quoted) => {
    expect(quoteIdentifier(name)).toBe(quoted);
  });
});
