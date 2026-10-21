import { describe, expectTypeOf, test } from "vitest";
import type { ChangesetLike } from "./contracts/changeset.js";
import {
  ConstraintError,
  type ConstraintViolationType,
  DatabaseError,
  type DatabaseErrorCode,
  type EgonError,
  type ErrorCode,
  InvalidChangesetError,
  isEgonError,
  MultipleResultsError,
  NoResultsError,
  NotLoadedError,
  QueryError,
  StaleEntryError,
} from "./errors.js";

describe("error codes", () => {
  test("each class has its literal code", () => {
    expectTypeOf(new NoResultsError().code).toEqualTypeOf<"noResults">();
    expectTypeOf(new QueryError("query.unsupportedFeature", "x").code).toEqualTypeOf<"query">();
    expectTypeOf(new DatabaseError("database.rejected", "x").code).toEqualTypeOf<DatabaseErrorCode>();
    expectTypeOf<EgonError["code"]>().toEqualTypeOf<ErrorCode>();
    expectTypeOf<DatabaseErrorCode>().toExtend<ErrorCode>();
  });

  test("the code discriminates a union of errors", () => {
    const error = {} as NoResultsError | MultipleResultsError | StaleEntryError;
    if (error.code === "multipleResults") expectTypeOf(error).toEqualTypeOf<MultipleResultsError>();
    if (error.code === "staleEntry") expectTypeOf(error.schema).toEqualTypeOf<string>();
  });

  test("isEgonError narrows unknown and takes only real codes", () => {
    const caught: unknown = undefined;
    if (isEgonError(caught)) {
      expectTypeOf(caught).toEqualTypeOf<EgonError>();
      expectTypeOf(caught.code).toEqualTypeOf<ErrorCode>();
    }
    isEgonError(caught, "deadlock");
    // @ts-expect-error not an error code
    isEgonError(caught, "nope");
  });
});

describe("constructors", () => {
  test("InvalidChangesetError keeps the changeset's own type", () => {
    interface UserChangeset extends ChangesetLike<{ email: string }> {
      readonly extra: number;
    }
    const changeset = {} as UserChangeset;
    const error = new InvalidChangesetError({ action: "insert", changeset });
    expectTypeOf(error.changeset).toEqualTypeOf<UserChangeset>();
    expectTypeOf(error.changeset.data.email).toEqualTypeOf<string>();
    expectTypeOf(error.changeset).not.toBeAny();
    // @ts-expect-error not a changeset
    new InvalidChangesetError({ action: "insert", changeset: { valid: false } });
  });

  test("required details are required", () => {
    // @ts-expect-error count is required
    new MultipleResultsError({});
    // @ts-expect-error schema is required
    new StaleEntryError({ action: "update" });
    // @ts-expect-error association is required
    new NotLoadedError({ schema: "User" });
    // @ts-expect-error a message is required
    new QueryError();
    // @ts-expect-error table, column and detail must be passed, even as undefined
    new ConstraintError({ type: "unique", constraint: "x" });
  });

  test("ConstraintError and DatabaseError take only their own kinds", () => {
    expectTypeOf<ConstraintError["type"]>().toEqualTypeOf<ConstraintViolationType>();
    const unreported = { constraint: undefined, table: undefined, column: undefined, detail: undefined };
    new ConstraintError({ type: "notNull", ...unreported });
    // @ts-expect-error noAssoc is a changeset declaration, not a database violation
    new ConstraintError({ type: "noAssoc", ...unreported });
    // @ts-expect-error not an adapter code
    new DatabaseError("database.rejected", "x", { code: "query" });
    expectTypeOf(new DatabaseError("database.rejected", "x").retryable).toEqualTypeOf<boolean>();
    expectTypeOf(new DatabaseError("database.rejected", "x").sql).toEqualTypeOf<string | undefined>();
  });

  test("the detail fields of every error are typed, never any", () => {
    const constraint = {} as ConstraintError;
    expectTypeOf(constraint.constraint).toEqualTypeOf<string | undefined>();
    expectTypeOf(constraint.table).toEqualTypeOf<string | undefined>();
    expectTypeOf(constraint.column).toEqualTypeOf<string | undefined>();
    expectTypeOf(constraint.detail).toEqualTypeOf<string | undefined>();
    for (const field of [constraint.constraint, constraint.table, constraint.column, constraint.detail]) {
      expectTypeOf(field).not.toBeAny();
    }
    expectTypeOf({} as NoResultsError)
      .toHaveProperty("query")
      .toEqualTypeOf<string | undefined>();
    expectTypeOf({} as MultipleResultsError)
      .toHaveProperty("count")
      .toEqualTypeOf<number>();
    expectTypeOf({} as MultipleResultsError)
      .toHaveProperty("query")
      .not.toBeAny();
    expectTypeOf({} as StaleEntryError)
      .toHaveProperty("action")
      .toEqualTypeOf<string>();
    expectTypeOf({} as NotLoadedError)
      .toHaveProperty("association")
      .toEqualTypeOf<string>();
    expectTypeOf({} as NotLoadedError)
      .toHaveProperty("schema")
      .not.toBeAny();
    expectTypeOf({} as InvalidChangesetError)
      .toHaveProperty("action")
      .not.toBeAny();
    expectTypeOf({} as DatabaseError)
      .toHaveProperty("retryable")
      .not.toBeAny();
    expectTypeOf({} as DatabaseError)
      .toHaveProperty("sql")
      .not.toBeAny();
    expectTypeOf({} as EgonError)
      .toHaveProperty("cause")
      .toBeUnknown();
  });
});
