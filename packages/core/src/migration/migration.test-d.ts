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
  type MigrationDefinition,
  type MigrationRun,
  type MigrationStatus,
  type Migrator,
} from "./index.js";

declare const adapter: DatabaseAdapter;

describe("defineMigration", () => {
  test("takes up and down", () => {
    const migration = defineMigration({
      up(m) {
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
      down(m) {
        expectTypeOf(m).toEqualTypeOf<MigrationBuilder>();
        m.dropTable("users");
      },
    });
    expectTypeOf(migration).toEqualTypeOf<Migration>();
    expectTypeOf(migration).not.toBeAny();
    expectTypeOf(
      defineMigration({ async up() {}, async down() {}, transaction: false }),
    ).toEqualTypeOf<Migration>();
    expectTypeOf<Parameters<typeof defineMigration>[0]>().toEqualTypeOf<MigrationDefinition>();
  });

  test("an empty down without its parameter says there is nothing to undo", () => {
    // Without the parameter, so that no linter reports an unused `m`.
    const migration = defineMigration({
      up(m) {
        m.execute(fragment`update users set role = 'member' where role is null`);
      },
      down() {
        // noop
      },
    });
    expectTypeOf(migration).toEqualTypeOf<Migration>();
    expectTypeOf(defineMigration({ up() {}, down() {} })).toEqualTypeOf<Migration>();
  });

  test("refuses a definition without up or down, change, and a non-boolean transaction", () => {
    // @ts-expect-error down is required
    defineMigration({ up() {} });
    // @ts-expect-error up is required
    defineMigration({ down() {} });
    // @ts-expect-error up and down are required
    defineMigration({});
    // @ts-expect-error change is not a key
    defineMigration({ change() {} });
    // @ts-expect-error change is not a key, even beside up and down
    defineMigration({ change() {}, up() {}, down() {} });
    // @ts-expect-error transaction is a boolean
    defineMigration({ up() {}, down() {}, transaction: "no" });
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
      down() {},
      up(m) {
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
        // @ts-expect-error execute takes one statement: what undoes it goes in down()
        m.execute(fragment`insert into t values (1)`, fragment`delete from t`);
        // @ts-expect-error dropTable takes no definition
        m.dropTable("users", (t) => t.id());
        // @ts-expect-error a constraint is dropped by its name alone
        m.dropConstraint("books", "books_pages_check", { check: fragment`pages > 0` });
        // @ts-expect-error dropIndex takes no predicate
        m.dropIndex("users", ["email"], { where: fragment`deleted_at is null` });
        m.dropIndex("users", ["email"], { unique: true, concurrently: true, ifExists: true });
        m.alterTable("users", (t) => {
          t.modify("age", "bigint", { notNull: true, default: 0 });
          // @ts-expect-error modify takes no from
          t.modify("age", "bigint", { from: "integer" });
          t.remove("legacy");
          // @ts-expect-error remove takes the column name alone
          t.remove("legacy", "boolean");
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
