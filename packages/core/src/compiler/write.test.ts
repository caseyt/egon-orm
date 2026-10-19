import { describe, expect, test } from "vitest";
import { POSTGRES_CAPABILITIES } from "./dialect.js";
import { insertChunks } from "./write.js";

describe("insertChunks", () => {
  test("splits a row count into powers of two, largest first", () => {
    expect(insertChunks(13, 2, POSTGRES_CAPABILITIES.maxParams)).toEqual([8, 4, 1]);
    expect(insertChunks(1, 5, POSTGRES_CAPABILITIES.maxParams)).toEqual([1]);
    expect(insertChunks(0, 5, POSTGRES_CAPABILITIES.maxParams)).toEqual([]);
    expect(insertChunks(1000, 3, POSTGRES_CAPABILITIES.maxParams)).toEqual([512, 256, 128, 64, 32, 8]);
  });

  test("no chunk has more values than the dialect accepts", () => {
    expect(insertChunks(10, 3, 10)).toEqual([2, 2, 2, 2, 2]);
    expect(insertChunks(5, 0, 4)).toEqual([4, 1]);
    for (const rows of [1, 7, 100, 4097]) {
      const chunks = insertChunks(rows, 7, 100);
      expect(chunks.reduce((a, b) => a + b, 0)).toBe(rows);
      expect(Math.max(...chunks) * 7).toBeLessThanOrEqual(100);
    }
  });

  test("one column set has a bounded number of distinct chunk sizes", () => {
    const sizes = new Set<number>();
    for (let rows = 1; rows <= 5000; rows++)
      for (const size of insertChunks(rows, 1, 65_535)) sizes.add(size);
    expect(sizes.size).toBeLessThanOrEqual(17);
  });

  test("refuses a row too wide for one statement and a count that is not a whole number", () => {
    expect(() => insertChunks(1, 11, 10)).toThrow(
      "One row of 11 values is more than the 10 parameters a statement may have.",
    );
    expect(() => insertChunks(2.5, 1, 10)).toThrow(
      "An insert's row count is a whole number of zero or more.",
    );
    expect(() => insertChunks(-1, 1, 10)).toThrow("An insert's row count is a whole number of zero or more.");
  });
});
