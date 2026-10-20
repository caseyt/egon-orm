import { ConstraintError, DatabaseError, QueryError } from "egon-orm";
import { describe, expect, test } from "vitest";
import { normalizeSqliteError } from "./errors.js";

/** An error shaped as better-sqlite3's `SqliteError`. */
function sqliteError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.name = "SqliteError";
  error.code = code;
  return error;
}

describe("normalizeSqliteError", () => {
  test("a unique violation names the default constraint made of its columns", () => {
    const cause = sqliteError("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: users.email");
    const error = normalizeSqliteError(cause, "insert into users (email) values (?)");
    expect(error).toBeInstanceOf(ConstraintError);
    expect(error).toMatchObject({
      type: "unique",
      constraint: "users_email_key",
      table: "users",
      column: "email",
      sql: "insert into users (email) values (?)",
      cause,
    });
  });

  test("a unique violation over several columns names them all, and no single column", () => {
    const error = normalizeSqliteError(
      sqliteError(
        "SQLITE_CONSTRAINT_UNIQUE",
        "UNIQUE constraint failed: posts_tags.post_id, posts_tags.tag_id",
      ),
      undefined,
    );
    expect(error).toMatchObject({
      constraint: "posts_tags_post_id_tag_id_key",
      table: "posts_tags",
      column: undefined,
    });
    expect((error as { sql?: unknown }).sql).toBeUndefined();
  });

  test("a primary key violation names <table>_pkey", () => {
    expect(
      normalizeSqliteError(
        sqliteError("SQLITE_CONSTRAINT_PRIMARYKEY", "UNIQUE constraint failed: users.id"),
        "x",
      ),
    ).toMatchObject({ type: "unique", constraint: "users_pkey", table: "users", column: "id" });
  });

  test("a unique index on an expression is reported by its name; a message it cannot read names nothing", () => {
    expect(
      normalizeSqliteError(
        sqliteError("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: index 'users_lower_email'"),
        "x",
      ),
    ).toMatchObject({ type: "unique", constraint: "users_lower_email", table: undefined, column: undefined });
    expect(
      normalizeSqliteError(sqliteError("SQLITE_CONSTRAINT_UNIQUE", "something else"), "x"),
    ).toMatchObject({
      constraint: undefined,
      table: undefined,
    });
  });

  test("a not-null violation names the table and the column, and no constraint", () => {
    expect(
      normalizeSqliteError(
        sqliteError("SQLITE_CONSTRAINT_NOTNULL", "NOT NULL constraint failed: users.email"),
        "x",
      ),
    ).toMatchObject({ type: "notNull", constraint: undefined, table: "users", column: "email" });
  });

  test("a check violation names its constraint when it has a name", () => {
    expect(
      normalizeSqliteError(
        sqliteError("SQLITE_CONSTRAINT_CHECK", "CHECK constraint failed: books_pages_check"),
        "x",
      ),
    ).toMatchObject({ type: "check", constraint: "books_pages_check" });
    expect(
      normalizeSqliteError(sqliteError("SQLITE_CONSTRAINT_CHECK", "CHECK constraint failed: pages > 0"), "x"),
    ).toMatchObject({ type: "check", constraint: undefined });
    expect(normalizeSqliteError(sqliteError("SQLITE_CONSTRAINT_CHECK", "no detail"), "x")).toMatchObject({
      constraint: undefined,
    });
  });

  test("a foreign-key violation names nothing", () => {
    expect(
      normalizeSqliteError(sqliteError("SQLITE_CONSTRAINT_FOREIGNKEY", "FOREIGN KEY constraint failed"), "x"),
    ).toMatchObject({ type: "foreignKey", constraint: undefined, table: undefined, column: undefined });
  });

  test.each(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED", "SQLITE_LOCKED_SHAREDCACHE"])(
    "%s is retryable",
    (code) => {
      const error = normalizeSqliteError(sqliteError(code, "database is locked"), "x");
      expect(error).toBeInstanceOf(DatabaseError);
      expect(error).toMatchObject({ code: "database", retryable: true, sql: "x" });
    },
  );

  test.each(["SQLITE_CANTOPEN", "SQLITE_CANTOPEN_ISDIR", "SQLITE_NOTADB"])(
    "%s is a connection error",
    (code) => {
      const error = normalizeSqliteError(sqliteError(code, "unable to open database file"), undefined);
      expect(error).toMatchObject({ code: "connection" });
      expect((error as Error).message).toContain(code);
    },
  );

  test("a closed database is a connection error", () => {
    const cause = new TypeError("The database connection is not open");
    expect(normalizeSqliteError(cause, "select 1")).toMatchObject({
      code: "connection",
      cause,
      sql: "select 1",
    });
  });

  test("a syntax error repeats SQLite's message, which names no value", () => {
    const error = normalizeSqliteError(sqliteError("SQLITE_ERROR", 'near "selec": syntax error'), "selec 1");
    expect(error).toMatchObject({ code: "database" });
    expect((error as Error).message).toBe(
      'The database rejected the statement (SQLITE_ERROR): near "selec": syntax error.',
    );
  });

  test("other codes leave the message, which may quote a value, on the cause", () => {
    const error = normalizeSqliteError(sqliteError("SQLITE_TOOBIG", "string or blob too big: secret"), "x");
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).message).toContain("SQLITE_TOOBIG");
  });

  test("anything else is returned unchanged", () => {
    const egon = new QueryError("mine");
    const plain = new Error("app");
    const type = new TypeError("not about the database");
    const named = sqliteError("NOT_SQLITE", "x");
    expect(normalizeSqliteError(egon, "x")).toBe(egon);
    expect(normalizeSqliteError(plain, "x")).toBe(plain);
    expect(normalizeSqliteError(type, "x")).toBe(type);
    expect(normalizeSqliteError(named, "x")).toBe(named);
    expect(normalizeSqliteError("text", "x")).toBe("text");
  });
});
