// createDatabase / dropDatabase, and the MigrationError class.
import { describe, expect, test } from "vitest";
import { createAdapter } from "../adapter/adapter.js";
import { POSTGRES_CAPABILITIES } from "../compiler/dialect.js";
import { EgonError, isEgonError, MigrationError } from "../errors.js";
import { createDatabase, dropDatabase } from "./database.js";
import * as entry from "./index.js";
import { fakeDatabase } from "./test-helpers.js";

describe("createDatabase and dropDatabase", () => {
  test("write the statement with the name quoted", async () => {
    const fake = fakeDatabase();
    await createDatabase(fake.adapter, 'blog"dev');
    await dropDatabase(fake.adapter, "blog_dev");
    await dropDatabase(fake.adapter, "blog_dev", { ifExists: true });
    expect(fake.statements.map((s) => s.sql)).toEqual([
      'create database "blog""dev"',
      'drop database "blog_dev"',
      'drop database if exists "blog_dev"',
    ]);
  });

  test("refuse a name that is not one, and a bad option", async () => {
    const fake = fakeDatabase();
    await expect(createDatabase(fake.adapter, "")).rejects.toThrow(TypeError);
    await expect(dropDatabase(fake.adapter, "a\u0000b")).rejects.toThrow(TypeError);
    await expect(dropDatabase(fake.adapter, "a", { ifExists: "yes" } as never)).rejects.toThrow(TypeError);
    expect(fake.statements).toEqual([]);
  });

  test("refuse a dialect this build has no table for", async () => {
    const adapter = createAdapter({
      dialect: "sqlite",
      capabilities: POSTGRES_CAPABILITIES,
      quoteIdentifier: (name) => `"${name}"`,
      driver: () => {
        throw new Error("not used");
      },
      driverCodecs: {},
      normalizeError: (error) => error,
    });
    await expect(createDatabase(adapter, "x")).rejects.toThrow(MigrationError);
  });
});

describe("MigrationError", () => {
  test("has its own name and code, and carries the migration and the statement", () => {
    const cause = new Error("driver");
    const error = new MigrationError("failed", {
      version: 20260101000000,
      migration: "a",
      sql: "select 1",
      cause,
    });
    expect(error).toBeInstanceOf(EgonError);
    expect(error.name).toBe("MigrationError");
    expect(error.code).toBe("migration");
    expect(isEgonError(error, "migration")).toBe(true);
    expect([error.version, error.migration, error.sql, error.cause]).toEqual([
      20260101000000,
      "a",
      "select 1",
      cause,
    ]);
    const bare = new MigrationError("x");
    expect([bare.version, bare.migration, bare.sql, bare.cause]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("is exported by egon-orm/migration, and the entry exports exactly these values", () => {
    expect(entry.MigrationError).toBe(MigrationError);
    expect(Object.keys(entry).sort()).toEqual([
      "MigrationError",
      "createDatabase",
      "createMigrator",
      "defineMigration",
      "dropDatabase",
      "parseMigrationFileName",
    ]);
  });
});
