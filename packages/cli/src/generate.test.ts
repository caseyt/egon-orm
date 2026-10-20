// The migration template and the --from-schema scaffold.
import { Comment, Membership, Org, Post, User, UserSettings } from "@egon-orm/test-support";
import { belongsTo, defineType, Schema, t } from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";
import { describe, expect, test } from "vitest";
import { fakeDatabase } from "../../core/src/migration/test-helpers.js";
import {
  MIGRATION_NAME,
  migrationTemplate,
  scaffoldFromSchemas,
  scaffoldHeader,
  versionAt,
} from "./generate.js";

const money = defineType<string>({
  name: "money",
  db: { kind: "custom", sql: "money" },
  cast: (v) => ({ success: true, data: String(v) }),
});
class Owner extends Schema("owners", { code: t.string().primaryKey() }, { schema: "billing" }) {}
class Everything extends Schema("everything", {
  id: t.integer().primaryKey().dbGenerated(),
  ownerCode: t.string(),
  big: t.bigint(),
  ratio: t.float().default(0.5),
  price: t.decimal({ precision: 12, scale: 3 }),
  plain: t.decimal(),
  active: t.boolean().default(true),
  token: t.uuid().autogenerate(),
  blob: t.binary().nullable(),
  day: t.date(),
  at: t.time(),
  stamp: t.timestamp({ precision: "s" }),
  local: t.localTimestamp({ precision: "us" }),
  plainStamp: t.localTimestamp(),
  data: t.json<{ a: number }>().default({ a: 1 }),
  grid: t.array(t.array(t.integer())),
  cash: t.type(money),
  level: t.enum({ low: 1, high: 2 }).default("high"),
  counted: t.bigint().default(7n),
  generated: t.integer().dbGenerated(),
  computed: t.string().default(() => "x"),
  notes: t.string().virtual(),
}) {
  static owner = belongsTo(() => Owner, { foreignKey: "ownerCode" });
}
class Log extends Schema("logs", { line: t.string() }, { primaryKey: false }) {}
class Pair extends Schema("pairs", {
  a: t.integer().primaryKey().dbGenerated(),
  b: t.integer().primaryKey(),
}) {}
/** Defaults that are not SQL constants for their column: an array, and an object on a text column. */
class Defaults extends Schema("defaults", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  tags: t.array(t.string()).default([]),
  settings: t.json<{ theme: string }>().default({ theme: "dark" }),
  list: t.json<number[]>().default([1, 2]),
}) {}

describe("versions and the template", () => {
  test("the version is the UTC time as YYYYMMDDHHMMSS", () => {
    expect(versionAt(new Date("2026-10-12T09:30:05Z"))).toBe("20261012093005");
    expect(versionAt(new Date("2027-01-02T03:04:05.999+05:00"))).toBe("20270101220405");
  });

  test("names are lower-case letters, digits and underscores", () => {
    expect(MIGRATION_NAME.test("create_users_2")).toBe(true);
    for (const bad of ["CreateUsers", "create-users", "create users", ""])
      expect(MIGRATION_NAME.test(bad)).toBe(false);
  });

  test("the empty template", () => {
    expect(migrationTemplate()).toMatchInlineSnapshot(`
      "import { defineMigration } from "egon-orm/migration";

      export default defineMigration({
        change(m) {
        },
      });
      "
    `);
  });

  test("the scaffold header says it is not a diff", () => {
    expect(scaffoldHeader("src/schema.ts", ["User", "Post"])).toMatch(/one-time scaffold, not a diff/);
  });
});

describe("--from-schema", () => {
  test("the blog's users, posts, comments, orgs and memberships", () => {
    const { body, notes } = scaffoldFromSchemas([User, Post, Comment, Org, Membership]);
    expect(body).toMatchInlineSnapshot(`
      "    m.createTable("users", (t) => {
            t.id();
            t.text("email").notNull();
            t.text("name");
            t.integer("age");
            t.text("role").notNull().default("member");
            t.text("password_hash");
            t.jsonb("settings");
            t.integer("lock_version").notNull().default(1);
            t.timestamptz("created_at").notNull(); // the application generates its value
            t.timestamptz("updated_at").notNull(); // the application generates its value
          });
          // Unique indexes are not part of the schema: add m.createIndex("users", [/* columns */], { unique: true }) for each.
          m.createTable("posts", (t) => {
            t.id();
            t.references("author_id", "users").notNull();
            t.text("title").notNull();
            t.text("body");
            t.boolean("published").default(false);
            t.integer("views").default(0);
            t.array("tags", "text");
            t.timestamptz("published_at");
            t.timestamptz("created_at").notNull(); // the application generates its value
            t.timestamptz("updated_at").notNull(); // the application generates its value
          });
          // Unique indexes are not part of the schema: add m.createIndex("posts", [/* columns */], { unique: true }) for each.
          m.createTable("comments", (t) => {
            t.id();
            t.references("post_id", "posts").notNull();
            t.references("author_id", "users");
            t.text("body").notNull();
            t.timestamptz("created_at").notNull(); // the application generates its value
          });
          // Unique indexes are not part of the schema: add m.createIndex("comments", [/* columns */], { unique: true }) for each.
          m.createTable("orgs", (t) => {
            t.uuid("id").notNull().primaryKey(); // the application generates its value
            t.text("name").notNull();
          });
          // Unique indexes are not part of the schema: add m.createIndex("orgs", [/* columns */], { unique: true }) for each.
          m.createTable("memberships", (t) => {
            t.references("org_id", "orgs", { type: "uuid" }).notNull().primaryKey();
            t.references("user_id", "users").notNull().primaryKey();
            t.text("role").notNull().default("member");
          });
          // Unique indexes are not part of the schema: add m.createIndex("memberships", [/* columns */], { unique: true }) for each.
          // users.role is an enum; to check its values in the database, use t.enumText("role", [/* its values */]).
          // memberships.role is an enum; to check its values in the database, use t.enumText("role", [/* its values */]).
      "
    `);
    expect(notes).toEqual([
      'users.role is an enum; to check its values in the database, use t.enumText("role", [/* its values */]).',
      'memberships.role is an enum; to check its values in the database, use t.enumText("role", [/* its values */]).',
    ]);
  });

  test("every column type, precision, database schema, keys without a serial and tables without a key", () => {
    expect(scaffoldFromSchemas([Everything, Log, Pair, Owner]).body).toMatchInlineSnapshot(`
      "    m.createTable("everything", (t) => {
            t.id("id", { type: "integer" });
            t.references("owner_code", "owners", { type: "text", column: "code", schema: "billing" }).notNull();
            t.bigint("big").notNull();
            t.float("ratio").notNull().default(0.5);
            t.decimal("price", { precision: 12, scale: 3 }).notNull();
            t.decimal("plain").notNull();
            t.boolean("active").notNull().default(true);
            t.uuid("token").notNull(); // the application generates its value
            t.binary("blob");
            t.date("day").notNull();
            t.time("at").notNull();
            t.timestamptz("stamp", { precision: 0 }).notNull();
            t.timestamp("local", { precision: 6 }).notNull();
            t.timestamp("plain_stamp").notNull();
            t.jsonb("data").notNull().default({"a":1});
            t.array("grid", {"kind":"array","of":"integer"}).notNull();
            t.custom("cash", "money").notNull();
            t.integer("level").notNull().default(2);
            t.bigint("counted").notNull().default(7n);
            t.integer("generated").notNull(); // the database generates its value: give the column a default
            t.text("computed").notNull(); // its default is set by the application, not written here
          });
          // Unique indexes are not part of the schema: add m.createIndex("everything", [/* columns */], { unique: true }) for each.
          m.createTable("logs", (t) => {
            t.text("line").notNull();
          }, { primaryKey: false });
          // Unique indexes are not part of the schema: add m.createIndex("logs", [/* columns */], { unique: true }) for each.
          m.createTable("pairs", (t) => {
            t.integer("a").notNull().primaryKey(); // the database generates its value: give the column a default
            t.integer("b").notNull().primaryKey();
          });
          // Unique indexes are not part of the schema: add m.createIndex("pairs", [/* columns */], { unique: true }) for each.
          m.createTable("owners", (t) => {
            t.text("code").notNull().primaryKey();
          }, { schema: "billing" });
          // Unique indexes are not part of the schema: add m.createIndex("owners", [/* columns */], { unique: true }) for each.
      "
    `);
  });

  test("defaults that are not SQL constants for their column get a note instead", () => {
    const { body } = scaffoldFromSchemas([Defaults]);
    expect(body).toContain('t.array("tags", "text").notNull(); // its default is not a SQL constant');
    expect(body).toContain('t.jsonb("settings").notNull().default({"theme":"dark"});');
    expect(body).toContain('t.jsonb("list").notNull().default([1,2]);');
  });

  test("every scaffold is a migration the builder accepts, and emits SQL", async () => {
    for (const schemas of [
      [User, Post, Comment, Org, Membership],
      [Everything, Log, Pair, Owner],
      [Defaults],
    ]) {
      const { body } = scaffoldFromSchemas(schemas as never);
      // The scaffold is the body of change(m): plain JavaScript once written into a file.
      const change = new Function("m", body) as (m: never) => void;
      const fake = fakeDatabase();
      const runs = await createMigrator({
        adapter: fake.adapter,
        migrations: [{ version: 20260101000000, name: "scaffold", migration: defineMigration({ change }) }],
      }).up({ dryRun: true });
      expect(runs[0]?.statements.length).toBe(schemas.length);
    }
  });

  test("an embedded schema has no table", () => {
    expect(() => scaffoldFromSchemas([UserSettings as never])).toThrow(/embedded schema/);
  });
});
