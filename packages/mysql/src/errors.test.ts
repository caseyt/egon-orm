import { ConstraintError, DatabaseError, QueryError } from "egon-orm";
import { describe, expect, test } from "vitest";
import { normalizeMysqlError } from "./errors.js";

/** An error shaped as a server error of mysql2. */
function serverError(errno: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { errno, code, sqlState: "23000", fatal: false });
}

describe("normalizeMysqlError", () => {
  test("a duplicate entry names the key, and the table MySQL 8 puts before it", () => {
    const cause = serverError(
      1062,
      "ER_DUP_ENTRY",
      "Duplicate entry 'a@b.c' for key 'users.users_email_key'",
    );
    const error = normalizeMysqlError(cause, "insert into users (email) values (?)");
    expect(error).toBeInstanceOf(ConstraintError);
    expect(error).toMatchObject({
      type: "unique",
      constraint: "users_email_key",
      table: "users",
      sql: "insert into users (email) values (?)",
      cause,
    });
  });

  test("the primary key, which MySQL calls PRIMARY, is <table>_pkey", () => {
    expect(
      normalizeMysqlError(
        serverError(1062, "ER_DUP_ENTRY", "Duplicate entry '1' for key 'users.PRIMARY'"),
        "x",
      ),
    ).toMatchObject({ constraint: "users_pkey", table: "users" });
  });

  test("a key without a table, or a message it cannot read", () => {
    expect(
      normalizeMysqlError(serverError(1062, "ER_DUP_ENTRY", "Duplicate entry '1' for key 'email_key'"), "x"),
    ).toMatchObject({ constraint: "email_key", table: undefined });
    expect(
      normalizeMysqlError(serverError(1062, "ER_DUP_ENTRY", "Duplicate entry '1' for key 'PRIMARY'"), "x"),
    ).toMatchObject({ constraint: "PRIMARY", table: undefined });
    expect(
      normalizeMysqlError(serverError(1586, "ER_DUP_ENTRY_WITH_KEY_NAME", "odd"), undefined),
    ).toMatchObject({
      type: "unique",
      constraint: undefined,
    });
  });

  test("a foreign-key violation names the constraint and the table", () => {
    expect(
      normalizeMysqlError(
        serverError(
          1452,
          "ER_NO_REFERENCED_ROW_2",
          "Cannot add or update a child row: a foreign key constraint fails (`db`.`books`, CONSTRAINT `books_author_id_fkey` FOREIGN KEY (`author_id`) REFERENCES `authors` (`id`))",
        ),
        "x",
      ),
    ).toMatchObject({ type: "foreignKey", constraint: "books_author_id_fkey", table: "books" });
    expect(normalizeMysqlError(serverError(1451, "ER_ROW_IS_REFERENCED_2", "no detail"), "x")).toMatchObject({
      type: "foreignKey",
      constraint: undefined,
      table: undefined,
    });
  });

  test("a check violation names its constraint", () => {
    expect(
      normalizeMysqlError(
        serverError(
          3819,
          "ER_CHECK_CONSTRAINT_VIOLATED",
          "Check constraint 'books_pages_check' is violated.",
        ),
        "x",
      ),
    ).toMatchObject({ type: "check", constraint: "books_pages_check" });
  });

  test("a missing value names its column", () => {
    expect(
      normalizeMysqlError(serverError(1048, "ER_BAD_NULL_ERROR", "Column 'email' cannot be null"), "x"),
    ).toMatchObject({ type: "notNull", column: "email" });
    expect(
      normalizeMysqlError(
        serverError(1364, "ER_NO_DEFAULT_FOR_FIELD", "Field 'title' doesn't have a default value"),
        "x",
      ),
    ).toMatchObject({ type: "notNull", column: "title" });
    expect(normalizeMysqlError(serverError(1048, "ER_BAD_NULL_ERROR", "odd"), "x")).toMatchObject({
      column: undefined,
    });
  });

  test("a deadlock, a lock wait timeout and a statement timeout get codes of their own", () => {
    expect(normalizeMysqlError(serverError(1213, "ER_LOCK_DEADLOCK", "Deadlock found"), "x")).toMatchObject({
      code: "deadlock",
    });
    const wait = normalizeMysqlError(
      serverError(1205, "ER_LOCK_WAIT_TIMEOUT", "Lock wait timeout exceeded"),
      "x",
    );
    expect(wait).toMatchObject({ code: "database", retryable: true });
    expect(
      normalizeMysqlError(
        serverError(3024, "ER_QUERY_TIMEOUT", "maximum statement execution time exceeded"),
        "x",
      ),
    ).toMatchObject({ code: "timeout" });
    expect(
      normalizeMysqlError(serverError(1045, "ER_ACCESS_DENIED_ERROR", "Access denied"), "x"),
    ).toMatchObject({
      code: "connection",
    });
  });

  test("a message that names only SQL objects is repeated; others stay on the cause", () => {
    const parse = normalizeMysqlError(
      serverError(1064, "ER_PARSE_ERROR", "You have an error in your SQL syntax"),
      "x",
    );
    expect(parse).toBeInstanceOf(DatabaseError);
    expect((parse as Error).message).toBe(
      "database.rejected: The database rejected the statement (MySQL error 1064, ER_PARSE_ERROR): You have an error in your SQL syntax. The cause is the driver's error, with the database's full report; error.sql is the statement. Look the SQL state up in the database's documentation. See https://egon-orm.github.io/egon-orm/reference/errors/database#database-rejected",
    );
    const range = normalizeMysqlError(
      serverError(1264, "ER_WARN_DATA_OUT_OF_RANGE", "Out of range value 99999 for column 'n'"),
      undefined,
    );
    expect((range as Error).message).not.toContain("99999");
    expect(range).toMatchObject({ code: "database" });
    const unnamed = Object.assign(new Error("odd"), { errno: 1999, sqlState: "HY000" });
    expect((normalizeMysqlError(unnamed, "x") as Error).message).toContain("unknown");
  });

  test.each(["ECONNREFUSED", "PROTOCOL_CONNECTION_LOST", "POOL_TIMEOUT"])(
    "%s is a connection error",
    (code) => {
      const cause = Object.assign(new Error("gone"), { code });
      const error = normalizeMysqlError(cause, "select 1");
      expect(error).toMatchObject({ code: "connection", cause, sql: "select 1" });
      expect((error as Error).message).toContain(code);
    },
  );

  test("mysql2's own messages about a closed connection or pool are connection errors", () => {
    for (const message of [
      "Can't add new command when connection is in closed state",
      "Connection lost: The server closed the connection.",
      "Pool is closed.",
    ]) {
      expect(normalizeMysqlError(new Error(message), undefined)).toMatchObject({ code: "connection" });
    }
  });

  test("a fatal error that is not a server error is a connection error", () => {
    const cause = Object.assign(new Error("handshake failed"), { fatal: true });
    expect(normalizeMysqlError(cause, "x")).toMatchObject({ code: "connection", cause });
  });

  test("anything else is returned unchanged", () => {
    const egon = new QueryError("query.unsupportedFeature", "mine");
    const plain = new Error("app");
    const half = Object.assign(new Error("no state"), { errno: 1062 });
    expect(normalizeMysqlError(egon, "x")).toBe(egon);
    expect(normalizeMysqlError(plain, "x")).toBe(plain);
    expect(normalizeMysqlError(half, "x")).toBe(half);
    expect(normalizeMysqlError("text", "x")).toBe("text");
  });
});
