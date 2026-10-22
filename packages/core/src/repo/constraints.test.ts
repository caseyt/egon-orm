// Unit tests for matching constraint violations to a changeset's declarations, and for the
// message of a violation no declaration handles.
import { messageText, Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { Constraint } from "../contracts/changeset.js";
import { ConstraintError, type ConstraintViolationType } from "../errors.js";
import { change, hasMany, Schema, t } from "../index.js";
import {
  clipBytes,
  constraintError,
  findConstraint,
  handleViolation,
  nameMatches,
  shortenedName,
  unhandledViolation,
} from "./constraints.js";

function violation(
  type: ConstraintViolationType,
  constraint: string | undefined,
  extra: { table?: string; sql?: string } = {},
): ConstraintError {
  return new ConstraintError({
    type,
    constraint,
    table: extra.table,
    column: undefined,
    detail: "Key (email)=(secret@example.com) already exists.",
    ...(extra.sql === undefined ? {} : { sql: extra.sql }),
    cause: new Error("driver"),
  });
}

const declared = (
  type: Constraint["type"],
  name: string,
  match: Constraint["match"] = "exact",
): Constraint => ({
  type,
  name,
  match,
  field: "f",
  message: "m",
});

describe("matching", () => {
  test("names match exactly, by suffix or by prefix", () => {
    expect(nameMatches(declared("unique", "users_email_key"), "users_email_key")).toBe(true);
    expect(nameMatches(declared("unique", "users_email"), "users_email_key")).toBe(false);
    expect(nameMatches(declared("unique", "_email_key", "suffix"), "users_2026_email_key")).toBe(true);
    expect(nameMatches(declared("unique", "_email_key", "suffix"), "users_email_key_x")).toBe(false);
    expect(nameMatches(declared("unique", "users_", "prefix"), "users_email_key")).toBe(true);
    expect(nameMatches(declared("unique", "users_", "prefix"), "posts_users_key")).toBe(false);
  });

  test("types: foreign keys match foreignKey and noAssoc; not-null matches nothing", () => {
    const fk = violation("foreignKey", "x");
    expect(findConstraint([declared("noAssoc", "x")], fk)?.type).toBe("noAssoc");
    expect(findConstraint([declared("foreignKey", "x")], fk)?.type).toBe("foreignKey");
    expect(findConstraint([declared("unique", "x")], fk)).toBeUndefined();
    expect(findConstraint([declared("check", "x")], violation("check", "x"))?.type).toBe("check");
    expect(findConstraint([declared("exclusion", "x")], violation("exclusion", "x"))?.type).toBe("exclusion");
    expect(findConstraint([declared("unique", "x")], violation("notNull", "x"))).toBeUndefined();
    expect(findConstraint([declared("unique", "x")], violation("unique", undefined))).toBeUndefined();
    expect(findConstraint([declared("unique", "x")], violation("other" as never, "x"))).toBeUndefined();
  });

  test("the first matching declaration wins", () => {
    const first = { ...declared("unique", "users_email_key"), field: "a" };
    const second = { ...declared("unique", "_key", "suffix"), field: "b" };
    expect(findConstraint([first, second], violation("unique", "users_email_key"))).toBe(first);
  });

  test("the error carries the declared type and name", () => {
    expect(constraintError(declared("unique", "_key", "suffix"))).toEqual({
      message: "m",
      constraint: "unique",
      meta: { constraint: "unique", constraintName: "_key" },
    });
  });

  test("handleViolation puts the message on the declared key and sets the action", () => {
    const cs = change(User, { email: "a" }).uniqueConstraint("email", {
      errorKey: "login",
      message: "is used",
    });
    const failed = handleViolation(cs, violation("unique", "users_email_key"), "insert");
    expect(failed.action).toBe("insert");
    expect(failed.valid).toBe(false);
    expect(failed.errorMessages()).toEqual({ login: ["is used"] });
    expect(() => handleViolation(cs, violation("unique", "other_key"), "insert")).toThrow(ConstraintError);
  });
});

describe("names the database shortened", () => {
  test("Postgres's shortening: the longer part loses a byte at a time, then each is cut at a character", () => {
    expect(shortenedName("a".repeat(40), "b".repeat(40), "key", 63)).toBe(
      `${"a".repeat(29)}_${"b".repeat(29)}_key`,
    );
    expect(shortenedName("t".repeat(10), "c".repeat(80), "fkey", 63)).toBe(
      `${"t".repeat(10)}_${"c".repeat(47)}_fkey`,
    );
    // An odd split: on a tie the column part loses the byte (Postgres's own result).
    expect(shortenedName("a".repeat(40), "b".repeat(40), "fkey", 63)).toBe(
      `${"a".repeat(29)}_${"b".repeat(28)}_fkey`,
    );
    expect(clipBytes("ééé", 5)).toBe("éé");
    expect(clipBytes("ééé", 6)).toBe("ééé");
    expect(clipBytes("abc", 0)).toBe("");
  });

  test("a default name longer than the limit matches the shortened name reported", () => {
    class Wide extends Schema("ver_table_with_a_very_long_name_for_tests", {
      id: t.integer().primaryKey(),
      someExtremelyLongColumnNameNumberOne: t.string(),
      anotherColumnNameThatIsLong: t.string(),
    }) {}
    const cs = change(Wide, {}).uniqueConstraint([
      "someExtremelyLongColumnNameNumberOne",
      "anotherColumnNameThatIsLong",
    ]);
    const full = (cs.constraints[0] as Constraint).name;
    expect(full.length).toBeGreaterThan(63);
    const reported = shortenedName(
      "ver_table_with_a_very_long_name_for_tests",
      "some_extremely_long_column_name_number_one_another_column_name_that_is_long",
      "key",
      63,
    );
    expect(handleViolation(cs, violation("unique", reported), "insert", 63).valid).toBe(false);
    // Without the dialect's limit, the full name alone is compared.
    expect(() => handleViolation(cs, violation("unique", reported), "insert")).toThrow(ConstraintError);
    // A long name given explicitly is cut to the limit.
    const named = change(Wide, {}).uniqueConstraint("anotherColumnNameThatIsLong", { name: "x".repeat(70) });
    expect(handleViolation(named, violation("unique", "x".repeat(63)), "insert", 63).valid).toBe(false);
    // A check constraint has no default name to shorten.
    const checked = change(Wide, {}).checkConstraint("id", { name: "c".repeat(70) });
    expect(handleViolation(checked, violation("check", "c".repeat(63)), "insert", 63).valid).toBe(false);
    // A name within the limit is compared as it is.
    expect(
      findConstraint([declared("unique", "short")], violation("unique", "short"), {
        maxBytes: 63,
        tables: [],
      }),
    ).toBeDefined();
  });

  test("a noAssoc default name starts with the child's table, which the database reports", () => {
    const long = "c".repeat(60);
    const cs = change(User, {});
    const constraint: Constraint = {
      type: "noAssoc",
      name: `${long}_author_id_fkey`,
      match: "exact",
      field: "posts",
      message: "m",
    };
    const reported = shortenedName(long, "author_id", "fkey", 63);
    expect(
      findConstraint([constraint], violation("foreignKey", reported), {
        maxBytes: 63,
        tables: [cs.model === null ? null : "users", long],
      }),
    ).toBe(constraint);
    expect(
      findConstraint([constraint], violation("foreignKey", reported), {
        maxBytes: 63,
        tables: ["users", undefined],
      }),
    ).toBeUndefined();
  });
});

describe("the message of an unhandled violation", () => {
  const cs = change(User, { email: "a" });

  test("keeps the violation's facts, never its detail in the message", () => {
    const original = violation("unique", "users_email_key", { table: "users", sql: "insert …" });
    const error = unhandledViolation(cs, original, "insert");
    expect(error).not.toBe(original);
    expect(error.constraint).toBe("users_email_key");
    expect(error.table).toBe("users");
    expect(error.sql).toBe("insert …");
    expect(error.cause).toBe(original.cause);
    expect(error.detail).toBe(original.detail);
    expect(error.message).not.toContain("secret@example.com");
    expect(unhandledViolation(cs, violation("unique", "users_email_key"), "insert").sql).toBeUndefined();
  });

  test("a not-null violation, one without a name, or a changeset without a schema is rethrown as it is", () => {
    const notNull = violation("notNull", "x");
    expect(unhandledViolation(cs, notNull, "insert")).toBe(notNull);
    const nameless = violation("unique", undefined);
    expect(unhandledViolation(cs, nameless, "insert")).toBe(nameless);
  });

  test("a name that is not a default name gets the { name } form only", () => {
    expect(messageText(unhandledViolation(cs, violation("unique", "uq_users_email"), "insert"))).toBe(
      [
        'unique constraint "uq_users_email" violated on insert into "users".',
        'The changeset has not defined this constraint. Add: .uniqueConstraint("<field>", { name: "uq_users_email" })',
      ].join(" "),
    );
    // Not a column of the table, the bare table prefix, another table.
    for (const name of ["users_nope_key", "users__key", "users_key", "posts_email_key"]) {
      expect(unhandledViolation(cs, violation("unique", name), "insert").message).toContain('"<field>"');
    }
  });

  test("a composite unique name lists its fields; columns with underscores are split right", () => {
    class Project extends Schema("projects", {
      id: t.integer().primaryKey(),
      orgId: t.integer(),
      org: t.string(),
      slugName: t.string(),
    }) {}
    const project = change(Project, {});
    expect(
      messageText(
        unhandledViolation(project, violation("unique", "projects_org_id_slug_name_key"), "update"),
      ),
    ).toBe(
      [
        'unique constraint "projects_org_id_slug_name_key" violated on update of "projects".',
        'The changeset has not defined this constraint. Add: .uniqueConstraint(["orgId", "slugName"])\n(or .uniqueConstraint(["orgId", "slugName"], { name: "projects_org_id_slug_name_key" }))',
      ].join(" "),
    );
    expect(
      unhandledViolation(project, violation("unique", "projects_org_slug_name_key"), "insert").message,
    ).toContain('.uniqueConstraint(["org", "slugName"])');
  });

  test("columns are split only at an underscore, and every split is tried", () => {
    class Split extends Schema("s", {
      id: t.integer().primaryKey(),
      ab: t.string(),
      abcD: t.string(),
      a: t.string(),
      aB: t.string(),
      c: t.string(),
    }) {}
    const split = change(Split, {});
    // "ab" is a prefix of "abc_d" but not at an underscore.
    expect(unhandledViolation(split, violation("unique", "s_abc_d_key"), "insert").message).toContain(
      '.uniqueConstraint("abcD")\n',
    );
    // "a" then "b_c" fails; "a_b" then "c" spells it.
    expect(unhandledViolation(split, violation("unique", "s_a_b_c_key"), "insert").message).toContain(
      '.uniqueConstraint(["aB", "c"])\n',
    );
    // "ab" then "c" would spell "abxc" if any character could separate them: only "_" does.
    expect(unhandledViolation(split, violation("unique", "s_abxc_key"), "insert").message).toContain(
      '"<field>"',
    );
    // A trailing underscore leaves an empty column: not a default name.
    expect(unhandledViolation(split, violation("unique", "s_ab__key"), "insert").message).toContain(
      '"<field>"',
    );
  });

  test("foreign keys: the field's default name, another name, a composite one", () => {
    const post = change(Post, {});
    expect(
      unhandledViolation(post, violation("foreignKey", "posts_author_id_fkey"), "update").message,
    ).toContain('Add: .foreignKeyConstraint("authorId")\n');
    expect(unhandledViolation(post, violation("foreignKey", "fk_author"), "insert").message).toContain(
      'Add: .foreignKeyConstraint("<field>", { name: "fk_author" })',
    );
    expect(
      unhandledViolation(post, violation("foreignKey", "posts_author_id_title_fkey"), "insert").message,
    ).toContain('"<field>"');
  });

  test("a delete: the association whose rows point here, by name, by table, or none", () => {
    const user = change(User, {});
    expect(
      unhandledViolation(user, violation("foreignKey", "posts_author_id_fkey", { table: "posts" }), "delete")
        .message,
    ).toContain(
      'Add: .noAssocConstraint("posts")\n(or .noAssocConstraint("posts", { name: "posts_author_id_fkey" }))',
    );
    // Another name on the only association into that table: the { name } form.
    expect(
      unhandledViolation(user, violation("foreignKey", "fk_posts", { table: "posts" }), "delete").message,
    ).toContain('Add: .noAssocConstraint("posts", { name: "fk_posts" })');
    // A table no association points from.
    expect(
      unhandledViolation(user, violation("foreignKey", "x_fkey", { table: "audit" }), "delete").message,
    ).toContain('.noAssocConstraint("<association>", { name: "x_fkey" })');
    // Two associations into one table, and a name neither has.
    class Person extends Schema("people", { id: t.integer().primaryKey() }) {
      static written = hasMany(() => Letter, { foreignKey: "authorId" });
      static received = hasMany(() => Letter, { foreignKey: "readerId" });
    }
    class Letter extends Schema("letters", {
      id: t.integer().primaryKey(),
      authorId: t.integer(),
      readerId: t.integer(),
    }) {}
    const person = change(Person, {});
    expect(
      unhandledViolation(person, violation("foreignKey", "letters_reader_id_fkey"), "delete").message,
    ).toContain('.noAssocConstraint("received")\n');
    expect(
      unhandledViolation(person, violation("foreignKey", "fk_x", { table: "letters" }), "delete").message,
    ).toContain('"<association>"');
  });

  test("check and exclusion constraints", () => {
    expect(unhandledViolation(cs, violation("check", "users_age_check"), "insert").message).toContain(
      'Add: .checkConstraint("age", { name: "users_age_check" })',
    );
    expect(unhandledViolation(cs, violation("check", "adult"), "insert").message).toContain(
      '.checkConstraint("<field>", { name: "adult" })',
    );
    expect(unhandledViolation(cs, violation("exclusion", "users_age_excl"), "insert").message).toContain(
      'Add: .exclusionConstraint("age")\n(or .exclusionConstraint("age", { name: "users_age_excl" }))',
    );
    expect(messageText(unhandledViolation(cs, violation("exclusion", "no_overlap"), "delete"))).toBe(
      [
        'exclusion constraint "no_overlap" violated on delete from "users".',
        'The changeset has not defined this constraint. Add: .exclusionConstraint("<field>", { name: "no_overlap" })',
      ].join(" "),
    );
  });
});
