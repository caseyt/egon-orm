// SQL snapshots of every migration operation on Postgres, and the features a dialect can
// lack. Every statement here is also run against Postgres by the migration conformance suite.
import { describe, expect, test } from "vitest";
import { MigrationError, shortMessageOf } from "../errors.js";
import { fragment } from "../query/functions.js";
import { MigrationBuilder } from "./builder.js";
import { type DdlContext, emitOperation, typeSql } from "./ddl.js";
import { type DdlFeatures, POSTGRES_MIGRATION_DIALECT } from "./dialect.js";
import { postgresDdl, sqlOf } from "./test-helpers.js";

/** Postgres with some DDL features turned off. */
function without(features: Partial<DdlFeatures>): DdlContext {
  const ctx = postgresDdl();
  return {
    ...ctx,
    dialect: {
      ...POSTGRES_MIGRATION_DIALECT,
      features: { ...POSTGRES_MIGRATION_DIALECT.features, ...features },
    },
  };
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("createTable", () => {
  test("writes every column helper with its type, nullability, default and constraints", () => {
    expect(
      sqlOf((m) =>
        m.createTable("accounts", (t) => {
          t.id();
          t.string("email").notNull().unique();
          t.text("bio");
          t.integer("age");
          t.bigint("balance").notNull().default(0n);
          t.float("ratio").default(1.5);
          t.decimal("price", { precision: 10, scale: 2 });
          t.decimal("amount");
          t.boolean("active").notNull().default(true);
          t.uuid("token");
          t.binary("avatar");
          t.date("born_on");
          t.time("wakes_at", { precision: 0 });
          t.timestamp("seen_at");
          t.timestamptz("confirmed_at", { precision: 3 });
          t.json("raw");
          t.jsonb("settings").default({ theme: "dark" });
          t.array("tags", "text");
          t.custom("nickname", "citext");
          t.enumText("role", ["admin", "member"]).notNull().default("member");
          t.references("org_id", "orgs", { type: "uuid", onDelete: "cascade" });
          t.timestamps();
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "create table "accounts" ("id" bigserial primary key, "email" text not null constraint "accounts_email_key" unique, "bio" text, "age" integer, "balance" bigint not null default 0, "ratio" double precision default 1.5, "price" numeric(10, 2), "amount" numeric, "active" boolean not null default true, "token" uuid, "avatar" bytea, "born_on" date, "wakes_at" time(0), "seen_at" timestamp, "confirmed_at" timestamptz(3), "raw" json, "settings" jsonb default '{"theme":"dark"}', "tags" text[], "nickname" citext, "role" text not null default 'member' constraint "accounts_role_check" check ("role" in ('admin', 'member')), "org_id" uuid constraint "accounts_org_id_fkey" references "orgs" ("id") on delete cascade, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now())",
      ]
    `);
  });

  test("a composite key is a table constraint, and a serial key can be integer", () => {
    expect(
      sqlOf((m) => {
        m.createTable("pairs", (t) => {
          t.integer("left_id").notNull().primaryKey();
          t.integer("right_id").notNull().primaryKey();
        });
        m.createTable("counters", (t) => t.id("counter_id", { type: "integer" }));
      }),
    ).toMatchInlineSnapshot(`
      [
        "create table "pairs" ("left_id" integer not null, "right_id" integer not null, primary key ("left_id", "right_id"))",
        "create table "counters" ("counter_id" serial primary key)",
      ]
    `);
  });

  test("t.id() takes its options first when the key is named id", () => {
    expect(
      sqlOf((m) => {
        m.createTable("tallies", (t) => t.id({ type: "integer" }));
        m.createTable("ledgers", (t) => t.id({ type: "bigint" }));
        m.createTable("notes", (t) => t.id({}));
        m.createTable("marks", (t) => t.id(undefined, { type: "integer" }));
      }),
    ).toMatchInlineSnapshot(`
      [
        "create table "tallies" ("id" serial primary key)",
        "create table "ledgers" ("id" bigserial primary key)",
        "create table "notes" ("id" bigserial primary key)",
        "create table "marks" ("id" serial primary key)",
      ]
    `);
  });

  test("a table can live in a database schema, skip an existing one, and have no key when it says so", () => {
    expect(
      sqlOf((m) => {
        m.createTable("events", (t) => t.text("payload"), {
          schema: "audit",
          primaryKey: false,
          ifNotExists: true,
        });
        m.createTable("logins", (t) => {
          t.id();
          t.references("user_id", "users", {
            schema: "auth",
            column: "user_id",
            onUpdate: "restrict",
            name: "logins_owner",
          });
        });
      }),
    ).toMatchInlineSnapshot(`
      [
        "create table if not exists "audit"."events" ("payload" text)",
        "create table "logins" ("id" bigserial primary key, "user_id" bigint constraint "logins_owner" references "auth"."users" ("user_id") on update restrict)",
      ]
    `);
  });

  test("defaults: strings are quoted, backslashes make an E-string, expressions are written as given", () => {
    expect(
      sqlOf((m) =>
        m.createTable("defaults", (t) => {
          t.id();
          t.text("quote").default("it's");
          t.text("backslash").default("a\\b'c");
          t.text("empty").default("");
          t.integer("negative").default(-7);
          t.boolean("off").default(false);
          t.text("nothing").default(null);
          t.uuid("key").default(fragment`gen_random_uuid()`);
          t.timestamptz("at").default(fragment`now()`);
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "create table "defaults" ("id" bigserial primary key, "quote" text default 'it''s', "backslash" text default E'a\\\\b''c', "empty" text default '', "negative" integer default -7, "off" boolean default false, "nothing" text default null, "key" uuid default (gen_random_uuid()), "at" timestamptz default (now()))",
      ]
    `);
  });

  test("names are quoted and quote characters in them doubled", () => {
    expect(sqlOf((m) => m.createTable('we"ird', (t) => t.id('i"d')))).toMatchInlineSnapshot(`
      [
        "create table "we""ird" ("i""d" bigserial primary key)",
      ]
    `);
  });
});

describe("dropTable, renameTable", () => {
  test("drop, drop if exists, drop cascade, rename", () => {
    expect(
      sqlOf((m) => {
        m.dropTable("users");
        m.dropTable("users", { ifExists: true, schema: "auth" });
        m.dropTable("users", { cascade: true });
        m.renameTable("people", "users");
        m.renameTable("people", "users", { schema: "auth" });
      }),
    ).toMatchInlineSnapshot(`
      [
        "drop table "users"",
        "drop table if exists "auth"."users"",
        "drop table "users" cascade",
        "alter table "people" rename to "users"",
        "alter table "auth"."people" rename to "users"",
      ]
    `);
  });
});

describe("alterTable", () => {
  test("add, modify, remove and rename write one statement each", () => {
    expect(
      sqlOf((m) =>
        m.alterTable("users", (t) => {
          t.text("nickname");
          t.references("org_id", "orgs", { onDelete: "setNull" });
          t.add("score", { kind: "decimal", precision: 5 });
          t.modify("age", "bigint");
          t.modify("name", "text", { notNull: true, default: "anonymous" });
          t.modify("bio", "text", { notNull: false, default: null });
          t.remove("legacy");
          t.rename("name", "full_name");
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        "alter table "users" add column "nickname" text",
        "alter table "users" add column "org_id" bigint constraint "users_org_id_fkey" references "orgs" ("id") on delete set null",
        "alter table "users" add column "score" numeric(5)",
        "alter table "users" alter column "age" type bigint",
        "alter table "users" alter column "name" type text, alter column "name" set not null, alter column "name" set default 'anonymous'",
        "alter table "users" alter column "bio" type text, alter column "bio" drop not null, alter column "bio" drop default",
        "alter table "users" drop column "legacy"",
        "alter table "users" rename column "name" to "full_name"",
      ]
    `);
  });

  test("a key column added to an existing table is written inline", () => {
    expect(sqlOf((m) => m.alterTable("tags", (t) => t.id()))).toMatchInlineSnapshot(`
      [
        "alter table "tags" add column "id" bigserial primary key",
      ]
    `);
  });
});

describe("indexes", () => {
  test("default names, unique, method, include, partial, concurrent, expressions", () => {
    expect(
      sqlOf((m) => {
        m.createIndex("users", ["email"], { unique: true });
        m.createIndex("posts", ["author_id", "created_at"]);
        m.createIndex("posts", ["tags"], { using: "GIN" });
        m.createIndex("posts", ["author_id"], { include: ["title"], name: "posts_by_author" });
        m.createIndex("posts", ["published_at"], { where: fragment`published`, concurrently: true });
        m.createIndex("users", [fragment`lower(${fragment.ident("email")})`], {
          name: "users_lower_email",
          unique: true,
        });
        m.createIndex("users", ["email"], { ifNotExists: true, schema: "auth" });
        m.dropIndex("users", ["email"], { unique: true });
        m.dropIndex("posts", ["published_at"], { concurrently: true, ifExists: true, schema: "blog" });
      }),
    ).toMatchInlineSnapshot(`
      [
        "create unique index "users_email_key" on "users" ("email")",
        "create index "posts_author_id_created_at_index" on "posts" ("author_id", "created_at")",
        "create index "posts_tags_index" on "posts" using gin ("tags")",
        "create index "posts_by_author" on "posts" ("author_id") include ("title")",
        "create index concurrently "posts_published_at_index" on "posts" ("published_at") where published",
        "create unique index "users_lower_email" on "users" ((lower("email")))",
        "create index if not exists "users_email_index" on "auth"."users" ("email")",
        "drop index "users_email_key"",
        "drop index concurrently if exists "blog"."posts_published_at_index"",
      ]
    `);
  });

  test("an unknown index method is refused", () => {
    const error = thrown(() => sqlOf((m) => m.createIndex("posts", ["tags"], { using: "rtree" })));
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toMatchInlineSnapshot(
      `"migration.indexMethod: The index method "rtree" is not one postgres has. Use one of btree, hash, gist, gin, spgist, brin. See https://egon-orm.github.io/egon-orm/reference/errors/migration#migration-indexmethod"`,
    );
  });
});

describe("constraints", () => {
  test("check and exclusion constraints, and dropping one", () => {
    expect(
      sqlOf((m) => {
        m.createConstraint("books", "books_pages_check", { check: fragment`pages > 0` });
        m.createConstraint("bookings", "bookings_during_excl", { exclude: fragment`during with &&` });
        m.createConstraint("rooms", "rooms_span_excl", {
          exclude: fragment`span with &&`,
          using: "spgist",
          schema: "hotel",
        });
        m.dropConstraint("books", "books_pages_check");
        m.dropConstraint("books", "books_pages_check", { ifExists: true });
      }),
    ).toMatchInlineSnapshot(`
      [
        "alter table "books" add constraint "books_pages_check" check (pages > 0)",
        "alter table "bookings" add constraint "bookings_during_excl" exclude using gist (during with &&)",
        "alter table "hotel"."rooms" add constraint "rooms_span_excl" exclude using spgist (span with &&)",
        "alter table "books" drop constraint "books_pages_check"",
        "alter table "books" drop constraint if exists "books_pages_check"",
      ]
    `);
  });
});

describe("schemas, extensions and execute", () => {
  test("create and drop a database schema and an extension", () => {
    expect(
      sqlOf((m) => {
        m.createSchema("audit");
        m.createSchema("audit", { ifNotExists: true });
        m.dropSchema("audit");
        m.dropSchema("audit", { ifExists: true, cascade: true });
        m.createExtension("btree_gist");
        m.createExtension("citext", { ifNotExists: true, schema: "public" });
        m.dropExtension("citext", { ifExists: true });
      }),
    ).toMatchInlineSnapshot(`
      [
        "create schema "audit"",
        "create schema if not exists "audit"",
        "drop schema "audit"",
        "drop schema if exists "audit" cascade",
        "create extension "btree_gist"",
        "create extension if not exists "citext" schema "public"",
        "drop extension if exists "citext"",
      ]
    `);
  });

  test("execute binds its values", () => {
    const m = new MigrationBuilder(63);
    m.execute(fragment`update users set role = ${"member"} where role is null and age > ${18}`);
    const [statement] = emitOperation(m.operations[0] as never, postgresDdl());
    expect(statement?.sql).toMatchInlineSnapshot(
      `"update users set role = $1 where role is null and age > $2"`,
    );
    expect(statement?.params).toEqual(["member", 18]);
    expect(statement?.slots).toHaveLength(2);
  });
});

describe("features a dialect lacks are refused with MigrationError", () => {
  const cases: [string, Partial<DdlFeatures>, (m: MigrationBuilder) => void][] = [
    [
      "CREATE INDEX CONCURRENTLY",
      { concurrentIndexes: false },
      (m) => m.createIndex("t", ["a"], { concurrently: true }),
    ],
    [
      "DROP INDEX CONCURRENTLY",
      { concurrentIndexes: false },
      (m) => m.dropIndex("t", ["a"], { concurrently: true }),
    ],
    [
      "A partial index (WHERE)",
      { partialIndexes: false },
      (m) => m.createIndex("t", ["a"], { where: fragment`a > 0` }),
    ],
    [
      "An index with INCLUDE columns",
      { includeColumns: false },
      (m) => m.createIndex("t", ["a"], { include: ["b"] }),
    ],
    [
      "An exclusion constraint",
      { exclusionConstraints: false },
      (m) => m.createConstraint("t", "t_a_excl", { exclude: fragment`a with &&` }),
    ],
    ["CREATE EXTENSION", { extensions: false }, (m) => m.createExtension("citext")],
    ["DROP EXTENSION", { extensions: false }, (m) => m.dropExtension("citext")],
    ["A database schema", { schemas: false }, (m) => m.createSchema("audit")],
    ["A database schema", { schemas: false }, (m) => m.dropTable("t", { schema: "audit" })],
    ["DROP … CASCADE", { dropCascade: false }, (m) => m.dropTable("t", { cascade: true })],
  ];
  test.each(cases)("%s", (feature, features, record) => {
    const error = thrown(() => sqlOf(record, without(features)));
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).id).toBe("migration.unsupportedFeature");
    expect(shortMessageOf(error as MigrationError)).toBe(`${feature} is not supported by postgres.`);
  });

  test("the same operations are written when the features are there", () => {
    for (const [, , record] of cases) expect(sqlOf(record)).toHaveLength(1);
  });
});

describe("refused at emission", () => {
  test("a DDL fragment that binds a value", () => {
    // The builder refuses it when recorded; the emitter refuses it again, whatever builds the operation.
    const ctx = postgresDdl();
    const node = fragment`pages > ${0}`.node;
    const error = thrown(() =>
      emitOperation(
        {
          op: "createConstraint",
          table: { name: "books", schema: undefined },
          name: "books_pages_check",
          definition: { kind: "check", expression: node as never, using: undefined },
        },
        ctx,
      ),
    );
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toMatch(/cannot bind values/);
  });

  test("a custom type that is not a plain type name", () => {
    const error = thrown(() =>
      typeSql(
        {
          kind: "custom",
          sql: "text; drop table users",
          precision: undefined,
          scale: undefined,
          of: undefined,
        },
        false,
        postgresDdl(),
      ),
    );
    expect(error).toBeInstanceOf(MigrationError);
  });

  test("constants that cannot be literals", () => {
    const column = (value: unknown) => ({
      op: "createTable" as const,
      table: { name: "t", schema: undefined },
      ifNotExists: false,
      columns: [
        {
          name: "c",
          type: {
            kind: "text" as const,
            precision: undefined,
            scale: undefined,
            of: undefined,
            sql: undefined,
          },
          serial: false,
          notNull: false,
          default: { kind: "value" as const, value },
          primaryKey: true,
          unique: undefined,
          references: undefined,
          check: undefined,
        },
      ],
    });
    for (const value of ["a\u0000b", "x\ud83d", Number.NaN, Number.POSITIVE_INFINITY, {}, undefined]) {
      expect(thrown(() => emitOperation(column(value), postgresDdl()))).toBeInstanceOf(MigrationError);
    }
  });
});
