import { Membership, Org, Tag, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { OnConflict } from "../contracts/adapter.js";
import type { FieldMeta } from "../contracts/schema.js";
import { from, Schema, t } from "../index.js";
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
    expect(compile({ target: undefined, update: [field("name")] })).toBe(
      "insert into `tags` (`name`) values (?) as `excluded` on duplicate key update `id` = last_insert_id(`id`), `name` = `excluded`.`name`",
    );
  });

  test('"nothing" sets the key to itself', () => {
    expect(compile("nothing")).toBe(
      "insert into `tags` (`name`) values (?) on duplicate key update `id` = `id`",
    );
  });
});

describe("upserts on MySQL: which columns are set, and the generated key", () => {
  const users = meta(User);
  const user = (name: string) => users.fieldsByName.get(name) as FieldMeta;
  const insert = (
    schema: typeof users,
    columns: readonly FieldMeta[],
    onConflict: OnConflict,
    source: "values" | "query" = "values",
  ) =>
    createCompiler(mysqlDialect).compileInsert(
      schema,
      columns,
      {
        source:
          source === "values"
            ? { kind: "values", rows: 1 }
            : { kind: "query", query: from(User, "u").select(({ u }) => [u.email, u.name]).ast },
        returning: [],
        onConflict,
      },
      undefined,
    ).sql;
  const columns = [user("email"), user("name")];

  test('"all" sets every inserted column from the excluded row, after the key', () => {
    expect(insert(users, columns, { target: undefined, update: "all" })).toBe(
      "insert into `users` (`email`, `name`) values (?, ?) as `excluded` on duplicate key update `id` = last_insert_id(`id`), `email` = `excluded`.`email`, `name` = `excluded`.`name`",
    );
  });

  test("{ except } sets the inserted columns it does not list", () => {
    expect(insert(users, columns, { target: undefined, update: { except: [user("name")] } })).toBe(
      "insert into `users` (`email`, `name`) values (?, ?) as `excluded` on duplicate key update `id` = last_insert_id(`id`), `email` = `excluded`.`email`",
    );
  });

  test("a key in the update list is set from the excluded row, not through last_insert_id", () => {
    expect(insert(users, columns, { target: undefined, update: [user("id"), user("email")] })).toBe(
      "insert into `users` (`email`, `name`) values (?, ?) as `excluded` on duplicate key update `id` = `excluded`.`id`, `email` = `excluded`.`email`",
    );
  });

  test("last_insert_id only for a single generated integer key", () => {
    const orgs = meta(Org);
    const memberships = meta(Membership);
    const orgName = orgs.fieldsByName.get("name") as FieldMeta;
    expect(insert(orgs, [orgName], { target: undefined, update: "all" })).toBe(
      "insert into `orgs` (`name`) values (?) as `excluded` on duplicate key update `name` = `excluded`.`name`",
    );
    const keys = memberships.primaryKey;
    expect(insert(memberships, keys, { target: undefined, update: "all" })).toBe(
      "insert into `memberships` (`org_id`, `user_id`) values (?, ?) as `excluded` on duplicate key update `org_id` = `excluded`.`org_id`, `user_id` = `excluded`.`user_id`",
    );
    expect(insert(memberships, keys, "nothing")).toBe(
      "insert into `memberships` (`org_id`, `user_id`) values (?, ?) on duplicate key update `org_id` = `org_id`",
    );
  });

  test("no last_insert_id for a key the database does not generate, or for a key of two columns", () => {
    class Counter extends Schema("counters", {
      id: t.integer().primaryKey(),
      hits: t.integer(),
    }) {}
    class Pair extends Schema("pairs", {
      id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
      part: t.integer().primaryKey(),
      hits: t.integer(),
    }) {}
    for (const schema of [meta(Counter), meta(Pair)]) {
      const hits = schema.fieldsByName.get("hits") as FieldMeta;
      expect(insert(schema, [hits], { target: undefined, update: "all" })).toBe(
        `insert into \`${schema.source}\` (\`hits\`) values (?) as \`excluded\` on duplicate key update \`hits\` = \`excluded\`.\`hits\``,
      );
    }
  });

  test("refuses a conflict target, an update from a query, an update of nothing and a malformed onConflict", () => {
    expect(() => insert(users, columns, { target: [user("email")], update: "all" })).toThrow(
      "An onConflict target is not supported by mysql.",
    );
    expect(() => insert(users, columns, { target: undefined, update: "all" }, "query")).toThrow(
      "onConflict with update on an insert from a query is not supported by mysql.",
    );
    expect(() => insert(users, columns, { target: undefined, update: { except: columns } })).toThrow(
      "onConflict's update leaves no column to update.",
    );
    expect(() => insert(users, columns, 42 as unknown as OnConflict)).toThrow(
      'onConflict is "nothing" or { target, update }.',
    );
  });
});
