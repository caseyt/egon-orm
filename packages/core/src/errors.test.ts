import { beforeEach, describe, expect, test } from "vitest";
import type { ChangesetLike } from "./contracts/changeset.js";
import {
  CastError,
  ConstraintError,
  type ConstraintViolationType,
  DatabaseError,
  docsLink,
  EgonError,
  type ErrorCode,
  fullMessageOf,
  InvalidChangesetError,
  isEgonError,
  MigrationError,
  MultipleResultsError,
  NoResultsError,
  NotLoadedError,
  QueryError,
  RollbackError,
  rewrap,
  SchemaDefinitionError,
  StaleEntryError,
  shortMessageOf,
  useFullErrorMessages,
} from "./errors.js";
import { messages } from "./messages/catalog.js";

// The default: short messages (the test setup turns full ones on for the other tests), for
// the errors made below as well as in the tests.
useFullErrorMessages(null);
beforeEach(() => {
  useFullErrorMessages(null);
});

const driverError = Object.assign(new Error("duplicate key value violates unique constraint"), {
  code: "23505",
});

const changeset: ChangesetLike = {
  valid: false,
  action: "insert",
  data: {},
  changes: { email: "taken@example.com", password: "hunter2" },
  errors: {
    email: [{ message: "has already been taken", constraint: "unique", meta: {} }],
    password: [
      {
        message: "should be at least {count} character(s)",
        validation: "length",
        meta: { count: 12, kind: "min" },
      },
      { message: "needs {missing} filled in", meta: {} },
    ],
  },
};

const DOCS = "https://egon-orm.github.io/egon-orm/reference/errors";

/** One instance of every error class, with the code, name and identifier it must have. */
const EVERY_ERROR: [error: EgonError, name: string, code: ErrorCode, id: string][] = [
  [new NoResultsError(), "NoResultsError", "noResults", "noResults"],
  [new MultipleResultsError({ count: 2 }), "MultipleResultsError", "multipleResults", "multipleResults"],
  [
    new InvalidChangesetError({ action: "insert", changeset }),
    "InvalidChangesetError",
    "invalidChangeset",
    "invalidChangeset",
  ],
  [new StaleEntryError({ action: "update", schema: "User" }), "StaleEntryError", "staleEntry", "staleEntry"],
  [
    new ConstraintError({
      type: "unique",
      constraint: "c",
      table: "t",
      column: undefined,
      detail: undefined,
    }),
    "ConstraintError",
    "constraint",
    "constraint.violated",
  ],
  [
    new QueryError("query.unsupportedFeature", "bad query"),
    "QueryError",
    "query",
    "query.unsupportedFeature",
  ],
  [new CastError("cast.paramsNotObject", "bad cast"), "CastError", "cast", "cast.paramsNotObject"],
  [new NotLoadedError({ schema: "User", association: "posts" }), "NotLoadedError", "notLoaded", "notLoaded"],
  [new RollbackError({ reason: "over the limit" }), "RollbackError", "rollback", "rollback.called"],
  [new DatabaseError("database.rejected", "driver failed"), "DatabaseError", "database", "database.rejected"],
  [
    new SchemaDefinitionError("schema.notSchemaClass", "bad schema"),
    "SchemaDefinitionError",
    "schemaDefinition",
    "schema.notSchemaClass",
  ],
  [
    new MigrationError("migration.failed", "bad migration"),
    "MigrationError",
    "migration",
    "migration.failed",
  ],
];

describe("every error class", () => {
  test.each(EVERY_ERROR)("%o has its own stable name, code and identifier", (error, name, code, id) => {
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    expect(error.id).toBe(id);
    expect(error.constructor.name).toBe(name);
  });

  test("codes are unique across the classes", () => {
    const codes = EVERY_ERROR.map(([, , code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test.each(EVERY_ERROR)("%o is an Error and an EgonError with a stack and a message", (error) => {
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(EgonError);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.stack).toContain(error.name);
    expect(String(error)).toBe(`${error.name}: ${error.message}`);
  });

  test.each(EVERY_ERROR)(
    "%o's message is its identifier, a short sentence and the docs link",
    (error, _name, _code, id) => {
      expect(error.message.startsWith(`${id}: ${shortMessageOf(error)}`)).toBe(true);
      expect(error.message.endsWith(`See ${docsLink(error.id)}`)).toBe(true);
    },
  );

  test.each(EVERY_ERROR)(
    "JSON.stringify(%o) gives only its name, code and identifier",
    (error, name, code, id) => {
      expect(JSON.parse(JSON.stringify(error))).toStrictEqual({ name, code, id });
      expect(Object.keys(error.toJSON())).toEqual(["name", "code", "id"]);
    },
  );

  test("JSON leaves out the message, the cause and the SQL", () => {
    const error = new DatabaseError(
      "database.rejected",
      "The database rejected the statement (SQLSTATE 23505).",
      {
        sql: 'insert into "users" ("email") values ($1)',
        cause: driverError,
      },
    );
    const json = JSON.stringify({ error });
    expect(json).toBe('{"error":{"name":"DatabaseError","code":"database","id":"database.rejected"}}');
    expect(json).not.toContain("insert");
    expect(json).not.toContain("duplicate key");
  });

  test("every identifier of these errors is in the catalog", () => {
    for (const [error] of EVERY_ERROR) expect(Object.hasOwn(messages, error.id)).toBe(true);
  });

  test("has no cause unless one is given", () => {
    for (const [error] of EVERY_ERROR) {
      expect(error.cause).toBeUndefined();
      expect(Object.hasOwn(error, "cause")).toBe(false);
    }
  });

  test("keeps the cause it is given, by identity", () => {
    const withCause: EgonError[] = [
      new NoResultsError({ cause: driverError }),
      new MultipleResultsError({ count: 2, cause: driverError }),
      new InvalidChangesetError({ action: "insert", changeset, cause: driverError }),
      new StaleEntryError({ action: "delete", schema: "User", cause: driverError }),
      new ConstraintError({
        type: "unique",
        constraint: undefined,
        table: undefined,
        column: undefined,
        detail: undefined,
        cause: driverError,
      }),
      new QueryError("query.unsupportedFeature", "bad query", { cause: driverError }),
      new CastError("cast.paramsNotObject", "bad cast", { cause: driverError }),
      new NotLoadedError({ schema: "User", association: "posts", cause: driverError }),
      new RollbackError({ reason: 1, cause: driverError }),
      new DatabaseError("database.rejected", "driver failed", { cause: driverError }),
      new SchemaDefinitionError("schema.notSchemaClass", "bad schema", { cause: driverError }),
      new MigrationError("migration.failed", "bad migration", { cause: driverError }),
    ];
    expect(withCause).toHaveLength(EVERY_ERROR.length);
    for (const error of withCause) expect(error.cause).toBe(driverError);
  });

  test("a cause chain survives several levels", () => {
    const adapter = new DatabaseError("database.connectionFailed", "Lost the connection.", {
      code: "connection",
      cause: driverError,
    });
    const query = new QueryError("query.unsupportedFeature", "Could not run the query.", { cause: adapter });
    expect(query.cause).toBe(adapter);
    expect((query.cause as DatabaseError).cause).toBe(driverError);
  });

  test("a falsy cause other than undefined is kept", () => {
    expect(new QueryError("query.unsupportedFeature", "bad query", { cause: null }).cause).toBeNull();
    expect(
      Object.hasOwn(new QueryError("query.unsupportedFeature", "bad query", { cause: 0 }), "cause"),
    ).toBe(true);
  });
});

describe("docsLink", () => {
  test("points at the namespace's page and the identifier's anchor", () => {
    expect(docsLink("query.aliasTaken")).toBe(`${DOCS}/query#query-aliastaken`);
    expect(docsLink("schema.noPrimaryKey")).toBe(`${DOCS}/schema#schema-noprimarykey`);
  });

  test("puts the identifiers without a namespace on the general page", () => {
    expect(docsLink("noResults")).toBe(`${DOCS}/general#noresults`);
  });
});

describe("full messages", () => {
  test("are off by default: the message has no advice", () => {
    expect(new NotLoadedError({ schema: "User", association: "posts" }).message).toBe(
      `notLoaded: Association "posts" of User is not loaded. See ${DOCS}/general#notloaded`,
    );
  });

  test("useFullErrorMessages(messages) adds the catalog's advice, with its parameters filled in", () => {
    useFullErrorMessages(messages);
    expect(new NotLoadedError({ schema: "User", association: "posts" }).message).toBe(
      `notLoaded: Association "posts" of User is not loaded. Preload it first: add .preload("posts") to the query, or call repo.preload(rows, "posts"). See ${DOCS}/general#notloaded`,
    );
  });

  test("apply only to errors constructed after the call, and null turns them off again", () => {
    const before = new NoResultsError();
    useFullErrorMessages(messages);
    const during = new NoResultsError();
    useFullErrorMessages(null);
    const after = new NoResultsError();
    expect(before.message).not.toContain("OrThrow");
    expect(during.message).toContain('Use the variant without "OrThrow"');
    expect(after.message).toBe(before.message);
  });

  test("take a catalog of one's own; an identifier it leaves out keeps its short message", () => {
    useFullErrorMessages({ noResults: "Prüfen Sie die ID." });
    expect(new NoResultsError().message).toBe(
      `noResults: Expected at least one result but got none. Prüfen Sie die ID. See ${DOCS}/general#noresults`,
    );
    expect(new MultipleResultsError({ count: 2 }).message).toBe(
      `multipleResults: Expected at most one result but got 2. See ${DOCS}/general#multipleresults`,
    );
  });

  test("leave a placeholder with no parameter as it is, and never read the prototype chain", () => {
    useFullErrorMessages({ noResults: "Look at {{query}} and {{toString}}." });
    expect(new NoResultsError().message).toContain("Look at {{query}} and {{toString}}.");
  });

  test("put the advice and the link after a blank line when the short sentence has several lines", () => {
    useFullErrorMessages(messages);
    const message = new InvalidChangesetError({ action: "insert", changeset }).message;
    expect(message).toMatch(/needs \{missing\} filled in\n\nFix the input, .+\n\nSee https:/);
  });

  test("useFullErrorMessages refuses anything but an object or null", () => {
    expect(() => useFullErrorMessages("on" as never)).toThrow(TypeError);
    expect(() => useFullErrorMessages([] as never)).toThrow(TypeError);
  });

  test("fullMessageOf gives the full text from any catalog, whatever the global setting", () => {
    const error = new NotLoadedError({ schema: "User", association: "posts" });
    expect(fullMessageOf(error, messages)).toContain('add .preload("posts")');
    expect(fullMessageOf(error, {})).toBeUndefined();
    const foreign = Object.assign(new Error("x"), { id: "notLoaded", [Symbol.for("egon.error")]: true });
    expect(fullMessageOf(foreign as unknown as EgonError, messages)).toBeUndefined();
  });
});

describe("rewrap and shortMessageOf", () => {
  test("rewrap keeps the class, the identifier and the parameters, and changes the short sentence", () => {
    const inner = new QueryError("query.windowMemberArray", "the window: partitionBy is not an array.", {
      params: { member: "partitionBy" },
    });
    const outer = rewrap(inner, (short) => `where(): ${short}`);
    expect(outer).toBeInstanceOf(QueryError);
    expect(outer.id).toBe("query.windowMemberArray");
    expect(outer.cause).toBe(inner);
    expect(shortMessageOf(outer)).toBe("where(): the window: partitionBy is not an array.");
    expect(fullMessageOf(outer, messages)).toContain("partitionBy: [p.authorId]");
  });

  test("shortMessageOf of an error made elsewhere is its message", () => {
    const foreign = Object.assign(new Error("from another copy"), { [Symbol.for("egon.error")]: true });
    expect(shortMessageOf(foreign as unknown as EgonError)).toBe("from another copy");
  });
});

describe("isEgonError", () => {
  test("recognises every Egon error and nothing else", () => {
    for (const [error] of EVERY_ERROR) expect(isEgonError(error)).toBe(true);
    for (const other of [
      new Error("x"),
      driverError,
      null,
      undefined,
      "QueryError",
      42,
      {},
      { code: "query" },
    ]) {
      expect(isEgonError(other)).toBe(false);
    }
  });

  test("matches on the code when one is given", () => {
    const error = new QueryError("query.unsupportedFeature", "bad query");
    expect(isEgonError(error, "query")).toBe(true);
    expect(isEgonError(error, "cast")).toBe(false);
    expect(isEgonError(new DatabaseError("database.rejected", "x", { code: "deadlock" }), "deadlock")).toBe(
      true,
    );
    expect(isEgonError(new DatabaseError("database.rejected", "x", { code: "deadlock" }), "database")).toBe(
      false,
    );
  });

  test("recognises an error from another copy of the package, where instanceof fails", () => {
    // What a second installed copy of this module would create: a different
    // class, the same process-wide brand.
    const foreign = Object.assign(new Error("from another copy"), {
      code: "query",
      [Symbol.for("egon.error")]: true,
    });
    expect(foreign).not.toBeInstanceOf(EgonError);
    expect(isEgonError(foreign)).toBe(true);
    expect(isEgonError(foreign, "query")).toBe(true);
  });
});

describe("NoResultsError", () => {
  test("says what was expected", () => {
    expect(shortMessageOf(new NoResultsError())).toBe("Expected at least one result but got none.");
  });

  test("includes the query when it is known", () => {
    const error = new NoResultsError({ query: 'from(User, "u").where(u.id = $1)' });
    expect(error.query).toBe('from(User, "u").where(u.id = $1)');
    expect(shortMessageOf(error)).toBe(
      'Expected at least one result but got none in query: from(User, "u").where(u.id = $1).',
    );
    expect(new NoResultsError().query).toBeUndefined();
  });
});

describe("MultipleResultsError", () => {
  test("reports the count", () => {
    const error = new MultipleResultsError({ count: 3, query: 'from(User, "u")' });
    expect(error.count).toBe(3);
    expect(error.query).toBe('from(User, "u")');
    expect(shortMessageOf(error)).toBe('Expected at most one result but got 3 in query: from(User, "u").');
    expect(shortMessageOf(new MultipleResultsError({ count: 2 }))).toBe(
      "Expected at most one result but got 2.",
    );
  });
});

describe("InvalidChangesetError", () => {
  test("carries the changeset and the action", () => {
    const error = new InvalidChangesetError({ action: "insert", changeset });
    expect(error.changeset).toBe(changeset);
    expect(error.action).toBe("insert");
  });

  test("lists every error by field, with placeholders filled from meta", () => {
    expect(new InvalidChangesetError({ action: "insert", changeset }).message).toMatchInlineSnapshot(`
      "invalidChangeset: Could not perform insert because the changeset is invalid.

      Errors:
        email: has already been taken
        password: should be at least 12 character(s)
        password: needs {missing} filled in

      See https://egon-orm.github.io/egon-orm/reference/errors/general#invalidchangeset"
    `);
  });

  test("never puts a field value in the message", () => {
    useFullErrorMessages(messages);
    const message = new InvalidChangesetError({ action: "insert", changeset }).message;
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("taken@example.com");
  });

  test("does not read placeholders from the prototype chain", () => {
    const tricky: ChangesetLike = {
      ...changeset,
      errors: { name: [{ message: "is {toString} and {constructor}", meta: {} }] },
    };
    expect(new InvalidChangesetError({ action: "update", changeset: tricky }).message).toContain(
      "name: is {toString} and {constructor}",
    );
  });

  test("says so when an invalid changeset lists no errors", () => {
    const empty: ChangesetLike = { ...changeset, errors: {} };
    expect(
      shortMessageOf(new InvalidChangesetError({ action: "update", changeset: empty })),
    ).toMatchInlineSnapshot(`
      "Could not perform update because the changeset is invalid.

      Errors:
        (the changeset is marked invalid but lists no errors)"
    `);
  });
});

describe("StaleEntryError", () => {
  test("explains an update that matched nothing", () => {
    const error = new StaleEntryError({ action: "update", schema: "User" });
    expect([error.action, error.schema]).toEqual(["update", "User"]);
    expect(shortMessageOf(error)).toBe(
      "Attempted to update a stale User row: no row matched its primary key and lock version.",
    );
  });

  test("does not mention the lock version for a delete", () => {
    expect(shortMessageOf(new StaleEntryError({ action: "delete", schema: "Post" }))).toBe(
      "Attempted to delete a stale Post row: no row matched its primary key.",
    );
  });
});

describe("ConstraintError", () => {
  test("carries type, constraint, table, column and detail", () => {
    const error = new ConstraintError({
      type: "foreignKey",
      constraint: "posts_author_id_fkey",
      table: "posts",
      column: "author_id",
      detail: 'Key (author_id)=(99) is not present in table "users".',
      cause: driverError,
    });
    expect(error).toMatchObject({
      type: "foreignKey",
      constraint: "posts_author_id_fkey",
      table: "posts",
      column: "author_id",
      detail: 'Key (author_id)=(99) is not present in table "users".',
    });
  });

  test("carries the failing statement when the adapter knows it, and none otherwise", () => {
    const base = {
      type: "unique",
      constraint: "users_email_key",
      table: "users",
      column: undefined,
      detail: undefined,
    } as const;
    const sql = 'insert into "users" ("email") values ($1)';
    expect(new ConstraintError({ ...base, sql }).sql).toBe(sql);
    expect(new ConstraintError({ ...base, sql }).message).not.toContain("insert");
    expect(new ConstraintError(base).sql).toBeUndefined();
  });

  test("keeps the database's detail line, which may quote row values, out of the message", () => {
    useFullErrorMessages(messages);
    const error = new ConstraintError({
      type: "unique",
      constraint: "users_email_key",
      table: "users",
      column: undefined,
      detail: "Key (email)=(secret@example.com) already exists.",
    });
    expect(error.message).not.toContain("secret@example.com");
  });

  const cases: [ConstraintViolationType, string, string][] = [
    ["unique", "unique", "uniqueConstraint"],
    ["foreignKey", "foreign-key", "foreignKeyConstraint (or noAssocConstraint on the referenced side)"],
    ["check", "check", "checkConstraint"],
    ["exclusion", "exclusion", "exclusionConstraint"],
    ["notNull", "not-null", "validateRequired"],
  ];
  test.each(cases)(
    "names a %s violation, and the changeset call that handles it in the full text",
    (type, what, call) => {
      const make = () =>
        new ConstraintError({ type, constraint: "c1", table: "t", column: "col", detail: undefined });
      const short = `The database rejected the write: ${what} constraint "c1" on table "t", column "col" was violated.`;
      expect(shortMessageOf(make())).toBe(short);
      expect(make().message).not.toContain(call);
      useFullErrorMessages(messages);
      expect(make().message).toContain(
        `${short} To report this as a changeset error instead of an exception, call ${call} on the changeset before the write.`,
      );
    },
  );

  test("leaves out what the database did not report", () => {
    const bare = { constraint: undefined, table: undefined, column: undefined, detail: undefined };
    expect(shortMessageOf(new ConstraintError({ type: "unique", ...bare }))).toBe(
      "The database rejected the write: unique constraint was violated.",
    );
    expect(new ConstraintError({ type: "check", ...bare, table: "users" }).message).toContain(
      'check constraint on table "users" was violated',
    );
    expect(new ConstraintError({ type: "check", ...bare, column: "age" }).message).toContain(
      "check constraint was violated",
    );
  });

  test("accepts an identifier and a message that replace the default", () => {
    const error = new ConstraintError({
      type: "unique",
      constraint: "users_email_key",
      table: "users",
      column: undefined,
      detail: undefined,
      id: "constraint.undeclared",
      message: 'unique constraint "users_email_key" violated on insert into "users".',
      params: { add: '.uniqueConstraint("email")' },
    });
    expect(error.id).toBe("constraint.undeclared");
    expect(shortMessageOf(error)).toBe(
      'unique constraint "users_email_key" violated on insert into "users".',
    );
    expect(fullMessageOf(error, messages)).toContain('Add: .uniqueConstraint("email")');
    expect(error.constraint).toBe("users_email_key");
    const plain = new ConstraintError({
      type: "unique",
      constraint: undefined,
      table: undefined,
      column: undefined,
      detail: undefined,
      message: "x",
    });
    expect(plain.id).toBe("constraint.violated");
  });
});

describe("NotLoadedError", () => {
  test("names the association", () => {
    const error = new NotLoadedError({ schema: "User", association: "posts" });
    expect([error.schema, error.association]).toEqual(["User", "posts"]);
    expect(shortMessageOf(error)).toBe('Association "posts" of User is not loaded.');
  });
});

describe("RollbackError", () => {
  test("carries the reason, and takes another identifier and message", () => {
    const error = new RollbackError({
      reason: { step: "charge" },
      id: "rollback.batchFailed",
      message: 'The batch failed at its step "charge".',
    });
    expect(error.reason).toEqual({ step: "charge" });
    expect(error.id).toBe("rollback.batchFailed");
    expect(shortMessageOf(error)).toBe('The batch failed at its step "charge".');
  });
});

describe("DatabaseError", () => {
  test("defaults to the generic code, not retryable, no sql", () => {
    const error = new DatabaseError("database.rejected", "The driver reported an error.");
    expect([error.code, error.retryable, error.sql]).toEqual(["database", false, undefined]);
    expect(error.message).toBe(
      `database.rejected: The driver reported an error. See ${DOCS}/database#database-rejected`,
    );
  });

  test.each([
    ["serializationFailure", true],
    ["deadlock", true],
    ["connection", false],
    ["aborted", false],
    ["timeout", false],
    ["database", false],
  ] as const)("code %s is retryable by default: %s", (code, retryable) => {
    const error = new DatabaseError("database.rejected", "x", { code });
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
  });

  test("an explicit retryable wins over the default", () => {
    expect(
      new DatabaseError("database.rejected", "x", { code: "connection", retryable: true }).retryable,
    ).toBe(true);
    expect(
      new DatabaseError("database.rejected", "x", { code: "deadlock", retryable: false }).retryable,
    ).toBe(false);
  });

  test("keeps the sql and the driver error", () => {
    const error = new DatabaseError("database.connectionFailed", "Lost the connection.", {
      code: "connection",
      sql: 'select "u"."id" from "users" as "u" where "u"."id" = $1',
      cause: driverError,
    });
    expect(error.sql).toBe('select "u"."id" from "users" as "u" where "u"."id" = $1');
    expect(error.cause).toBe(driverError);
    expect((error.cause as { code: string }).code).toBe("23505");
  });
});

describe("MigrationError", () => {
  test("names the migration and the statement", () => {
    const error = new MigrationError("migration.failed", "Migration 1_a failed.", {
      version: 1,
      migration: "a",
      sql: "drop table x",
    });
    expect([error.version, error.migration, error.sql]).toEqual([1, "a", "drop table x"]);
  });
});

describe("message-only errors", () => {
  test.each([
    [QueryError, "query.unsupportedFeature", "FULL JOIN is not supported by sqlite."],
    [CastError, "cast.paramsNotObject", 'Cannot cast params of type "string" to a changeset.'],
    [
      SchemaDefinitionError,
      "schema.assocFieldMissing",
      'Post.author: belongsTo expects the field "authorId".',
    ],
  ] as const)("%o keeps the short sentence it is given, unchanged", (ErrorClass, id, message) => {
    const error = new ErrorClass(id as never, message);
    expect(shortMessageOf(error)).toBe(message);
    expect(error.message).toBe(`${id}: ${message} See ${docsLink(id)}`);
  });
});
