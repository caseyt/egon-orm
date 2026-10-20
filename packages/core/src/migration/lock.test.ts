// The lock keys are a contract between versions: these values must never change, or two
// versions of an application migrating one database in a rolling deploy take different
// locks and race. Do not update this test to make a change pass.
import { describe, expect, test } from "vitest";
import { lockHash, lockKeys } from "./lock.js";

describe("the migration lock keys", () => {
  test("are FNV-1a over UTF-8, as signed 32-bit integers (the published test vectors)", () => {
    expect(lockHash("")).toBe(0x811c9dc5 | 0);
    expect(lockHash("a")).toBe(0xe40c292c | 0);
    expect(lockHash("foobar")).toBe(0xbf9cf968 | 0);
  });

  test("are pinned for the default table and for a table in a database schema", () => {
    expect(lockKeys(undefined, "schema_migrations")).toEqual([-707284870, 1796039744]);
    expect(lockKeys("ops", "schema_migrations")).toEqual([-707284870, -1560260962]);
  });
});
