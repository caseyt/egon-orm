import { describe, expectTypeOf, test } from "vitest";
import type { DatabaseAdapter } from "../adapter/adapter.js";
import { fragment, param } from "../query/functions.js";
import { createRepo } from "../repo/repo.js";
import { t as field } from "../schema/index.js";
import {
  type ColumnBuilder,
  type ColumnType,
  createMigrator,
  defineMigration,
  type Migration,
  type MigrationBuilder,
  type MigrationRun,
  type MigrationStatus,
  type Migrator,
} from "./index.js";

declare const adapter: DatabaseAdapter;

describe("defineMigration", () => {
  test("takes change, or up with an optional down", () => {
    const reversible = defineMigration({
      change(m) {
        expectTypeOf(m).toEqualTypeOf<MigrationBuilder>();
        m.createTable("users", (t) => {
          expectTypeOf(t.id()).toEqualTypeOf<ColumnBuilder>();
          // Options first when the key is named id, or after a name.
          expectTypeOf(t.id({ type: "integer" })).toEqualTypeOf<ColumnBuilder>();
          expectTypeOf(t.id("key", { type: "bigint" })).toEqualTypeOf<ColumnBuilder>();
          // @ts-expect-error: a key is bigint or integer
          t.id({ type: "uuid" });
          // @ts-expect-error: options come first or second, not both
          t.id({ type: "integer" }, { type: "bigint" });
          // @ts-expect-error: no other option
          t.id({ name: "key" });
          t.text("email").notNull().unique();
        });
      },
    });
    expectTypeOf(reversible).toEqualTypeOf<Migration>();
    expectTypeOf(
      defineMigration({ async up() {}, async down() {}, transaction: false }),
    ).toEqualTypeOf<Migration>();
    expectTypeOf(defineMigration({ up() {} })).not.toBeAny();
  });

  test("refuses change together with up or down, and an empty definition", () => {
    // @ts-expect-error change and up exclude each other
    defineMigration({ change() {}, up() {} });
    // @ts-expect-error change and down exclude each other
    defineMigration({ change() {}, down() {} });
    // @ts-expect-error a definition needs change or up
    defineMigration({});
    // @ts-expect-error transaction is a boolean
    defineMigration({ up() {}, transaction: "no" });
  });
});

describe("the builders", () => {
  test("column types are DbType kinds and objects; anything else is refused", () => {
    expectTypeOf<"integer">().toExtend<ColumnType>();
    expectTypeOf<{ kind: "decimal"; precision: 10; scale: 2 }>().toExtend<ColumnType>();
    expectTypeOf<{ kind: "array"; of: "text" }>().toExtend<ColumnType>();
    expectTypeOf<{ kind: "custom"; sql: "citext" }>().toExtend<ColumnType>();
    expectTypeOf<"varchar">().not.toExtend<ColumnType>();
  });

  test("options and fragments are typed", () => {
    defineMigration({
      change(m) {
        m.createIndex("users", ["email"], { unique: true, where: fragment`deleted_at is null` });
        // @ts-expect-error unknown option
        m.createIndex("users", ["email"], { unqiue: true });
        // @ts-expect-error a predicate is a fragment, not a string
        m.createIndex("users", ["email"], { where: "deleted_at is null" });
        // @ts-expect-error execute takes a fragment, not a string
        m.execute("drop table users");
        // @ts-expect-error a fragment with a named parameter cannot be supplied
        m.execute(fragment`select ${param("id", field.integer())}`);
        // @ts-expect-error primaryKey can only be false
        m.createTable("t", (t) => t.id(), { primaryKey: true });
        m.alterTable("users", (t) => {
          t.modify("age", "bigint", { from: { type: "integer", notNull: false } });
          // @ts-expect-error an unknown column type
          t.add("age", "int4");
          // @ts-expect-error onDelete takes the listed actions
          t.references("org_id", "orgs", { onDelete: "drop" });
        });
      },
    });
  });
});

describe("the migrator", () => {
  test("takes an adapter and returns typed results", () => {
    const migrator = createMigrator({ adapter, directory: "migrations" });
    expectTypeOf(migrator).toEqualTypeOf<Migrator>();
    expectTypeOf(migrator.up()).resolves.toEqualTypeOf<MigrationRun[]>();
    expectTypeOf(migrator.down({ step: 2 })).resolves.toEqualTypeOf<MigrationRun[]>();
    expectTypeOf(migrator.status()).resolves.toEqualTypeOf<MigrationStatus[]>();
    expectTypeOf<MigrationStatus["state"]>().toEqualTypeOf<"up" | "down" | "missing" | "claimed">();
  });

  test("refuses what is not an adapter, and unknown options", () => {
    const repo = createRepo({ adapter });
    // @ts-expect-error the migrator takes the adapter, not the repo
    createMigrator({ repo, directory: "migrations" });
    // @ts-expect-error unknown option
    createMigrator({ adapter, directory: "migrations", prefix: "x" });
    // @ts-expect-error a version is a number
    createMigrator({ adapter, directory: "m" }).up({ to: "20261012093000" });
  });
});
