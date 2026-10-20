// The rollback of `change`: the inverse of each reversible operation, in reverse order;
// reversing twice gives the operations back; and every operation that cannot be reversed
// is refused with the fix in the message.
import { describe, expect, test } from "vitest";
import { MigrationError } from "../errors.js";
import { fragment } from "../query/functions.js";
import { MigrationBuilder } from "./builder.js";
import { emitOperation } from "./ddl.js";
import { reverseOperations } from "./reverse.js";
import { postgresDdl } from "./test-helpers.js";
import type { Operation } from "./types.js";

const CONTEXT = { version: 20260101120000, migration: "sample" };

function recorded(define: (m: MigrationBuilder) => void): readonly Operation[] {
  const m = new MigrationBuilder(63);
  define(m);
  return m.operations;
}

function sql(operations: readonly Operation[]): string[] {
  const ctx = postgresDdl();
  return operations.flatMap((op) => emitOperation(op, ctx).map((statement) => statement.sql));
}

/** The SQL of rolling `define` back. */
function rollback(define: (m: MigrationBuilder) => void): string[] {
  return sql(reverseOperations(recorded(define), CONTEXT));
}

function refusal(define: (m: MigrationBuilder) => void): MigrationError {
  try {
    reverseOperations(recorded(define), CONTEXT);
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError);
    const migrationError = error as MigrationError;
    expect(migrationError.version).toBe(CONTEXT.version);
    expect(migrationError.migration).toBe(CONTEXT.migration);
    return migrationError;
  }
  throw new Error("expected the rollback to be refused");
}

describe("each reversible operation has an inverse", () => {
  test("createTable is dropped; dropTable with a definition is created again", () => {
    expect(
      rollback((m) => {
        m.createTable("users", (t) => {
          t.id();
          t.text("email").notNull();
        });
        m.dropTable("legacy", (t) => {
          t.id();
          t.text("note");
        });
      }),
    ).toEqual(['create table "legacy" ("id" bigserial primary key, "note" text)', 'drop table "users"']);
  });

  test("alterTable changes are undone in reverse order", () => {
    expect(
      rollback((m) =>
        m.alterTable("users", (t) => {
          t.integer("age");
          t.modify("score", "bigint", {
            notNull: true,
            default: 0,
            from: { type: "integer", notNull: false, default: null },
          });
          t.remove("nickname", "text", { notNull: true, default: "x" });
          t.rename("name", "full_name");
        }),
      ),
    ).toEqual([
      'alter table "users" rename column "full_name" to "name"',
      `alter table "users" add column "nickname" text not null default 'x'`,
      'alter table "users" alter column "score" type integer, alter column "score" drop not null, alter column "score" drop default',
      'alter table "users" drop column "age"',
    ]);
  });

  test("a modify that changes only the type is undone with the type alone", () => {
    expect(
      rollback((m) => m.alterTable("users", (t) => t.modify("age", "bigint", { from: "integer" }))),
    ).toEqual(['alter table "users" alter column "age" type integer']);
  });

  test("renames, indexes, constraints, execute, schemas and extensions", () => {
    expect(
      rollback((m) => {
        m.renameTable("people", "users", { schema: "app" });
        m.createIndex("users", ["email"], { unique: true });
        m.dropIndex("users", ["name"]);
        m.createConstraint("users", "users_age_check", { check: fragment`age >= 0` });
        m.dropConstraint("users", "users_old_check", { check: fragment`true` });
        m.execute(fragment`update users set role = ${"a"}`, fragment`update users set role = ${"b"}`);
        m.createSchema("audit");
        m.dropSchema("staging");
        m.createExtension("citext");
      }),
    ).toEqual([
      'drop extension "citext"',
      'create schema "staging"',
      'drop schema "audit"',
      "update users set role = $1",
      'alter table "users" add constraint "users_old_check" check (true)',
      'alter table "users" drop constraint "users_age_check"',
      'create index "users_name_index" on "users" ("name")',
      'drop index "users_email_key"',
      'alter table "app"."users" rename to "people"',
    ]);
  });

  test("the inverse of execute binds the down statement's values", () => {
    const [down] = reverseOperations(
      recorded((m) => m.execute(fragment`select ${1}`, fragment`select ${2}`)),
      CONTEXT,
    );
    expect(emitOperation(down as Operation, postgresDdl())[0]?.params).toEqual([2]);
  });

  test("reversing twice gives the original statements", () => {
    const define = (m: MigrationBuilder): void => {
      m.createTable("users", (t) => {
        t.id();
        t.enumText("role", ["a", "b"]).notNull().default("a");
        t.references("org_id", "orgs", { onDelete: "cascade" });
      });
      m.alterTable("users", (t) => {
        t.text("bio");
        t.modify("role", "text", { from: "text" });
        t.rename("bio", "about");
      });
      m.createIndex("users", ["org_id"], { where: fragment`org_id is not null` });
      m.createConstraint("users", "users_bio_check", { check: fragment`length(about) < 500` });
      m.renameTable("users", "members");
    };
    const original = recorded(define);
    expect(sql(reverseOperations(reverseOperations(original, CONTEXT), CONTEXT))).toEqual(sql(original));
  });
});

describe("operations that cannot be reversed are refused at rollback, with the fix", () => {
  test.each<[string, (m: MigrationBuilder) => void, RegExp]>([
    [
      "remove without a type",
      (m) => m.alterTable("users", (t) => t.remove("age")),
      /t\.remove\("age", "integer"\)/,
    ],
    [
      "modify without from",
      (m) => m.alterTable("users", (t) => t.modify("age", "bigint")),
      /\{ from: previousType \}/,
    ],
    [
      "modify of notNull without the previous notNull",
      (m) => m.alterTable("users", (t) => t.modify("age", "bigint", { notNull: true, from: "integer" })),
      /notNull: … \}/,
    ],
    [
      "modify of the default without the previous default",
      (m) => m.alterTable("users", (t) => t.modify("age", "bigint", { default: 1, from: "integer" })),
      /default: … \}/,
    ],
    ["execute with one statement", (m) => m.execute(fragment`select 1`), /m\.execute\(up, down\)/],
    [
      "dropTable without a definition",
      (m) => m.dropTable("users"),
      /m\.dropTable\("users", \(t\) => \{ … \}\)/,
    ],
    [
      "dropTable with cascade",
      (m) => m.dropTable("users", (t) => t.id(), { cascade: true }),
      /also drops what depends/,
    ],
    [
      "dropTable with ifExists",
      (m) => m.dropTable("users", (t) => t.id(), { ifExists: true }),
      /no table to drop/,
    ],
    [
      "createTable with ifNotExists",
      (m) => m.createTable("users", (t) => t.id(), { ifNotExists: true }),
      /did not create/,
    ],
    [
      "createIndex with ifNotExists",
      (m) => m.createIndex("users", ["a"], { ifNotExists: true }),
      /already there/,
    ],
    ["dropIndex with ifExists", (m) => m.dropIndex("users", ["a"], { ifExists: true }), /no index/],
    [
      "dropConstraint without a definition",
      (m) => m.dropConstraint("users", "users_age_check"),
      /\{ check: fragment`…` \}/,
    ],
    [
      "dropConstraint with ifExists",
      (m) => m.dropConstraint("users", "c", { check: fragment`true`, ifExists: true }),
      /no constraint/,
    ],
    ["createSchema with ifNotExists", (m) => m.createSchema("s", { ifNotExists: true }), /already there/],
    ["dropSchema with cascade", (m) => m.dropSchema("s", { cascade: true }), /everything in the schema/],
    ["dropSchema with ifExists", (m) => m.dropSchema("s", { ifExists: true }), /no schema/],
    [
      "createExtension with ifNotExists",
      (m) => m.createExtension("x", { ifNotExists: true }),
      /already installed/,
    ],
    ["dropExtension", (m) => m.dropExtension("x"), /how the extension was installed/],
  ])("%s", (_name, define, fix) => {
    const error = refusal(define);
    expect(error.message).toMatch(/^Migration 20260101120000_sample cannot be rolled back: /);
    expect(error.message).toMatch(fix);
  });

  test("an irreversible operation stops the whole rollback, even after reversible ones", () => {
    expect(() =>
      reverseOperations(
        recorded((m) => {
          m.alterTable("users", (t) => t.remove("age"));
          m.createTable("t", (t) => t.id());
        }),
        CONTEXT,
      ),
    ).toThrow(MigrationError);
  });
});
