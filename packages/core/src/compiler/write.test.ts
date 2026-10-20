import { Tag } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { OnConflict } from "../contracts/adapter.js";
import type { FieldMeta } from "../contracts/schema.js";
import { meta } from "../schema/index.js";
import { createCompiler } from "./compiler.js";
import { mysqlDialect, POSTGRES_CAPABILITIES } from "./dialect.js";
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

describe("upserts on MySQL (ON DUPLICATE KEY UPDATE)", () => {
  const tags = meta(Tag);
  const field = (name: string) => tags.fieldsByName.get(name) as FieldMeta;
  const compile = (onConflict: OnConflict) =>
    createCompiler(mysqlDialect).compileInsert(
      tags,
      [field("name")],
      { source: { kind: "values", rows: 1 }, returning: [], onConflict },
      undefined,
    ).sql;

  test("an update reads the excluded row, and sets the generated key with last_insert_id so a no-op reports it", () => {
    expect(compile({ update: [field("name")] } as OnConflict)).toBe(
      "insert into `tags` (`name`) values (?) as `excluded` on duplicate key update `id` = last_insert_id(`id`), `name` = `excluded`.`name`",
    );
  });

  test('"nothing" sets the key to itself', () => {
    expect(compile("nothing")).toBe(
      "insert into `tags` (`name`) values (?) on duplicate key update `id` = `id`",
    );
  });
});
