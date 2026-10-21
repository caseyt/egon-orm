import { ConstraintError, DatabaseError, QueryError } from "egon-orm";
import { describe, expect, test } from "vitest";
import { normalizePgError } from "./errors.js";

/** An error shaped as pg reports a server error. */
function serverError(code: string, message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, severity: "ERROR", ...fields });
}

const SQL = 'insert into "users" ("email") values ($1)';

describe("constraint violations", () => {
  test.each([
    [
      "23505",
      "unique",
      { constraint: "users_email_key", table: "users", detail: "Key (email)=(a@b.c) already exists." },
    ],
    [
      "23503",
      "foreignKey",
      { constraint: "posts_author_id_fkey", table: "posts", detail: "Key (author_id)=(9) is not present." },
    ],
    ["23514", "check", { constraint: "posts_views_check", table: "posts" }],
    ["23P01", "exclusion", { constraint: "rooms_during_excl", table: "rooms" }],
    ["23502", "notNull", { table: "users", column: "email" }],
  ] as const)(
    "SQLSTATE %s is a %s ConstraintError with the driver's fields, the SQL and the cause",
    (code, type, fields) => {
      const cause = serverError(code, "violates", fields);
      const error = normalizePgError(cause, SQL);
      expect(error).toBeInstanceOf(ConstraintError);
      expect(error).toMatchObject({
        type,
        constraint: "constraint" in fields ? fields.constraint : undefined,
        table: fields.table,
        column: "column" in fields ? fields.column : undefined,
        detail: "detail" in fields ? fields.detail : undefined,
        sql: SQL,
        cause,
      });
    },
  );

  test("the detail line, which may quote values, stays out of the message", () => {
    const error = normalizePgError(
      serverError("23505", "duplicate", {
        constraint: "c",
        table: "t",
        detail: "Key (email)=(secret@x.y) already exists.",
      }),
      SQL,
    ) as ConstraintError;
    expect(error.message).not.toContain("secret");
  });

  test("empty fields are read as absent, and an unknown SQL is left off", () => {
    const error = normalizePgError(
      serverError("23505", "duplicate", { constraint: "", table: 7 }),
      undefined,
    );
    expect(error).toMatchObject({ constraint: undefined, table: undefined, sql: undefined });
  });
});

describe("database errors", () => {
  test.each([
    ["40001", "serializationFailure", true],
    ["40P01", "deadlock", true],
    ["57014", "timeout", false],
    ["57P01", "connection", false],
    ["57P02", "connection", false],
    ["57P03", "connection", false],
    ["53300", "connection", false],
    ["08006", "connection", false],
    ["08P01", "connection", false],
    ["28P01", "connection", false],
    ["42601", "database", false],
    ["22P02", "database", false],
    ["XX000", "database", false],
  ] as const)("SQLSTATE %s is a DatabaseError with the code %s", (code, egonCode, retryable) => {
    const cause = serverError(code, "message");
    const error = normalizePgError(cause, SQL);
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ code: egonCode, retryable, sql: SQL, cause });
  });

  test("repeats the database's message for classes that never quote values", () => {
    const error = normalizePgError(
      serverError("42601", 'syntax error at or near "selec"'),
      "selec 1",
    ) as DatabaseError;
    expect(error.message).toBe(
      'The database rejected the statement (SQLSTATE 42601): syntax error at or near "selec".',
    );
  });

  test("leaves the database's message out for classes that may quote a value", () => {
    const error = normalizePgError(
      serverError("22P02", 'invalid input syntax for type integer: "my secret"'),
      SQL,
    ) as DatabaseError;
    expect(error.message).not.toContain("my secret");
    expect(error.message).toContain("SQLSTATE 22P02");
    expect(error.message).toContain("error.cause");
  });

  test("a five-character code without a severity is not taken for a SQLSTATE", () => {
    const odd = Object.assign(new Error("odd"), { code: "ABCDE" });
    expect(normalizePgError(odd, SQL)).toBe(odd);
  });
});

describe("connection failures", () => {
  test.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"])(
    "a network error %s is a connection error naming the code",
    (code) => {
      const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:5432`), { code });
      const error = normalizePgError(cause, SQL);
      expect(error).toBeInstanceOf(DatabaseError);
      expect(error).toMatchObject({ code: "connection", sql: SQL, cause });
      expect((error as Error).message).toContain(code);
    },
  );

  test.each([
    "Connection terminated unexpectedly",
    "Connection terminated",
    "Connection terminated due to connection timeout",
    "timeout exceeded when trying to connect",
    "Client has encountered a connection error and is not queryable",
    "Client was closed and is not queryable",
    "Cannot use a pool after calling end on the pool",
    "The server does not support SSL connections",
  ])("pg's own error %j is a connection error", (message) => {
    const cause = new Error(message);
    const error = normalizePgError(cause, undefined);
    expect(error).toMatchObject({ code: "connection", sql: undefined, cause });
  });
});

describe("anything else", () => {
  test("is returned unchanged", () => {
    const egon = new QueryError("query.unsupportedFeature", "already ours");
    expect(normalizePgError(egon, SQL)).toBe(egon);
    const plain = new TypeError("a bug in the application");
    expect(normalizePgError(plain, SQL)).toBe(plain);
    expect(normalizePgError("a string", SQL)).toBe("a string");
    expect(normalizePgError(undefined, SQL)).toBeUndefined();
  });
});
