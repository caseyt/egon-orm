// Type tests for changesets: what each constructor infers, which field names and value
// types each method accepts, and that a new record has no applyChanges.
import { Post, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import type { Action, ChangesetError, ChangesetLike, Constraint } from "../contracts/changeset.js";
import type { AnySchema, Row } from "../contracts/schema.js";
import { t } from "../schema/index.js";
import {
  applyAction,
  applyActionOrThrow,
  type Changeset,
  cast,
  change,
  traverseErrors,
} from "./changeset.js";
import type {
  ChangesetModel,
  ErrorTree,
  FieldName,
  RowSchema,
  SchemalessTarget,
  TypedErrorTree,
} from "./types.js";

declare const params: unknown;
declare const user: User;
declare const either: User | typeof User;

type UserNames =
  | "id"
  | "email"
  | "name"
  | "age"
  | "role"
  | "password"
  | "passwordHash"
  | "settings"
  | "lockVersion"
  | "createdAt"
  | "updatedAt";

describe("constructors", () => {
  test("cast of a class is a changeset of a new record", () => {
    const cs = cast(User, params, ["email", "name"]);
    expectTypeOf(cs).toEqualTypeOf<Changeset<typeof User, true>>();
    expectTypeOf(cs.data).toEqualTypeOf<null>();
    expectTypeOf(cs.model).toExtend<AnySchema>();
    expectTypeOf(cs.model).toEqualTypeOf<ChangesetModel<typeof User>>();
    expectTypeOf(cs).not.toBeAny();
  });

  test("cast of a row or class (a changeset function's parameter) is typed with the class", () => {
    const cs = cast(either, params, ["email"]);
    expectTypeOf(cs).toEqualTypeOf<Changeset<typeof User, boolean>>();
    expectTypeOf(cs.data).toEqualTypeOf<User | null>();
  });

  test("cast of a row alone is typed from the row's fields", () => {
    const cs = cast(user, params, ["email", "name"]);
    expectTypeOf(cs).toEqualTypeOf<Changeset<RowSchema<User>, false>>();
    expectTypeOf(cs.data).toEqualTypeOf<User>();
    expectTypeOf<FieldName<RowSchema<User>>>().toEqualTypeOf<UserNames>();
    expectTypeOf(cs.changes.name).toEqualTypeOf<string | null | undefined>();
  });

  test("permitted names must be fields: not getters, associations or unknown names", () => {
    // @ts-expect-error a getter is not a field
    cast(User, params, ["displayName"]);
    // @ts-expect-error an association is not a field
    cast(User, params, ["posts"]);
    // @ts-expect-error not a field
    cast(user, params, ["displayName"]);
    // @ts-expect-error not a field
    cast(either, params, ["nope"]);
  });

  test("casting a changeset again keeps its type", () => {
    const first = cast(User, params, ["email"]);
    expectTypeOf(cast(first, params, ["name"])).toEqualTypeOf<Changeset<typeof User, true>>();
  });

  test("change takes typed values", () => {
    expectTypeOf(change(User, { email: "a@b.c", age: null })).toEqualTypeOf<Changeset<typeof User, true>>();
    expectTypeOf(change(user, { name: "Ada" })).toEqualTypeOf<Changeset<RowSchema<User>, false>>();
    expectTypeOf(change(either)).toEqualTypeOf<Changeset<typeof User, boolean>>();
    // @ts-expect-error email is not nullable
    change(User, { email: null });
    // @ts-expect-error age is a number
    change(user, { age: "36" });
    // @ts-expect-error not a field
    change(User, { nope: 1 });
  });

  test("a changeset without a schema class is typed from its types", () => {
    const cs = cast({ data: {}, types: { q: t.string(), page: t.integer().nullable() } }, params, [
      "q",
      "page",
    ]);
    expectTypeOf(cs.changes).toEqualTypeOf<{ readonly q?: string; readonly page?: number | null }>();
    expectTypeOf(cs.model).toEqualTypeOf<null>();
    expectTypeOf(cs.data).toEqualTypeOf<Record<never, never>>();
    expectTypeOf(cs.applyChanges()).toEqualTypeOf<{
      q: string | undefined;
      page: number | null;
    }>();
    // @ts-expect-error not one of the types
    cast({ data: {}, types: { q: t.string() } }, params, ["page"]);
    const known = change({ data: { q: "x", extra: true }, types: { q: t.string() } });
    expectTypeOf(known.applyChanges()).toEqualTypeOf<{ extra: boolean; q: string }>();
    expectTypeOf(known).toExtend<Changeset<SchemalessTarget, false>>();
  });
});

describe("the changeset members", () => {
  test("changes hold the field types; null only where the field is nullable", () => {
    const cs = cast(User, params, ["email", "name"]);
    expectTypeOf(cs.changes.email).toEqualTypeOf<string | undefined>();
    expectTypeOf(cs.changes.name).toEqualTypeOf<string | null | undefined>();
    expectTypeOf(cs.changes.role).toEqualTypeOf<"admin" | "member" | undefined>();
    expectTypeOf(cs.errors).toEqualTypeOf<Readonly<Record<string, readonly ChangesetError[]>>>();
    expectTypeOf(cs.valid).toEqualTypeOf<boolean>();
    expectTypeOf(cs.action).toEqualTypeOf<Action | null>();
    expectTypeOf(cs.constraints).toEqualTypeOf<readonly Constraint[]>();
  });

  test("a changeset satisfies ChangesetLike", () => {
    expectTypeOf(cast(User, params, ["email"])).toExtend<ChangesetLike>();
    expectTypeOf(cast(either, params, ["email"])).toExtend<ChangesetLike<User | null>>();
  });

  test("a field with a default, or nullable, is present in a schemaless result", () => {
    const cs = cast({ data: {}, types: { q: t.string(), page: t.integer().default(1) } }, params, [
      "q",
      "page",
    ]);
    expectTypeOf(cs.applyChanges()).toEqualTypeOf<{ q: string | undefined; page: number }>();
  });

  test("prepare functions are typed with the changeset's own parameters, never any", () => {
    const cs = cast(User, params, ["email"]);
    expectTypeOf(cs.prepare).toEqualTypeOf<
      readonly ((changeset: Changeset<typeof User, true>) => Changeset<typeof User, true>)[]
    >();
    expectTypeOf(cs.prepare[0]).not.toBeAny();
  });

  test("association constraints compile on a changeset made from a row alone", () => {
    change(user).noAssocConstraint("posts");
    cast(user, params, ["email"]).assocConstraint("anything, checked when called");
    // @ts-expect-error a field of a changeset with a known class is not an association
    change(User).noAssocConstraint("email");
  });

  test("a changeset of a new record fits a parameter typed for either kind", () => {
    const normalizeEmail = (cs: Changeset<typeof User>) => cs.updateChange("email", (email) => email.trim());
    expectTypeOf(cast(User, params, ["email"]).pipe(normalizeEmail)).toEqualTypeOf<Changeset<typeof User>>();
    expectTypeOf(cast(either, params, ["email"]).pipe(normalizeEmail)).toEqualTypeOf<
      Changeset<typeof User>
    >();
  });

  test("a changeset made from a row alone fits a parameter typed with the class", () => {
    const rename = (cs: Changeset<typeof User>) => cs.putChange("name", "Ada");
    rename(cast(user, params, ["email"]));
    rename(change(user));
    const update = (cs: Changeset<typeof User, false>) => cs;
    update(change(user));
    // @ts-expect-error a new record is not a changeset of a loaded row
    update(change(User));
  });

  test("Changeset with no arguments is the changeset of any schema", () => {
    expectTypeOf(cast(User, params, ["email"])).toExtend<Changeset>();
    expectTypeOf<Changeset>().toEqualTypeOf<Changeset<AnySchema, boolean>>();
  });
});

describe("methods", () => {
  const cs = cast(User, params, ["email", "name", "age", "role", "settings"]);

  test("change methods take a field and a value of its type", () => {
    expectTypeOf(cs.putChange("age", 3)).toEqualTypeOf(cs);
    cs.putChange("name", null);
    // @ts-expect-error email is not nullable
    cs.putChange("email", null);
    // @ts-expect-error age is a number
    cs.forceChange("age", "3");
    // @ts-expect-error not a field
    cs.deleteChange("nope");
    cs.updateChange("email", (email) => {
      expectTypeOf(email).toEqualTypeOf<string>();
      return email.toLowerCase();
    });
    // @ts-expect-error the function must return the field's type
    cs.updateChange("age", () => "x");
  });

  test("reads are typed by field", () => {
    expectTypeOf(cs.getField("role")).toEqualTypeOf<"admin" | "member">();
    expectTypeOf(cs.getField("name", "anonymous")).toEqualTypeOf<string | null>();
    expectTypeOf(cs.getChange("age")).toEqualTypeOf<number | null | undefined>();
    expectTypeOf(cs.fetchField("email")).toEqualTypeOf<
      { readonly from: "changes" | "data"; readonly value: string } | undefined
    >();
    expectTypeOf(cs.fetchChange("email")).toEqualTypeOf<{ readonly value: string } | undefined>();
    cs.isChanged("role", { from: "member", to: "admin" });
    // @ts-expect-error not a role
    cs.isChanged("role", { to: "root" });
  });

  test("validations accept only fields of a fitting type", () => {
    cs.validateFormat("email", /@/);
    // @ts-expect-error age is not a string
    cs.validateFormat("age", /1/);
    cs.validateLength("name", { min: 2 });
    cast(Post, params, ["tagList"]).validateLength("tagList", { max: 5 });
    // @ts-expect-error a number has no length
    cs.validateLength("age", { min: 1 });
    cs.validateNumber("age", { greaterThan: 0 });
    cs.validateNumber("id", { greaterThan: 0n });
    // @ts-expect-error email is not a number
    cs.validateNumber("email", { greaterThan: 0 });
    // @ts-expect-error not an option
    cs.validateNumber("age", { atLeast: 0 });
    cs.validateInclusion("role", ["admin"]);
    // @ts-expect-error not a role
    cs.validateInclusion("role", ["root"]);
    cs.validateExclusion("name", ["admin"]);
    cast(Post, params, ["tagList"]).validateSubset("tagList", ["news"]);
    // @ts-expect-error not an array field
    cs.validateSubset("name", ["x"]);
    // @ts-expect-error the elements are strings
    cast(Post, params, ["tagList"]).validateSubset("tagList", [1]);
    cs.validateRequired(["email", "name"]);
    cs.validateRequired("email");
    cs.validateRequired();
    // @ts-expect-error not a field
    cs.validateRequired(["nope"]);
    cs.validateConfirmation("password", { required: true });
    cs.validateAcceptance("termsOfService");
    cs.validateChange("age", (age, field) => {
      expectTypeOf(age).toEqualTypeOf<number>();
      expectTypeOf(field).toEqualTypeOf<"age">();
      return age > 100 ? "is unlikely" : undefined;
    });
    cs.validateChange("email", () => [{ message: "a" }, "b"]);
    // @ts-expect-error a number is not a result
    cs.validateChange("email", () => 1);
    cs.validateLength("name", { min: 2, message: (meta) => `at least ${String(meta.count)}` });
  });

  test("constraints take fields and associations by name", () => {
    cs.uniqueConstraint("email");
    cs.uniqueConstraint(["email", "name"], { name: "x", match: "suffix", errorKey: "email" });
    // @ts-expect-error not a field
    cs.uniqueConstraint("nope");
    cast(Post, params, ["authorId"]).assocConstraint("author");
    change(either).noAssocConstraint("posts");
    // @ts-expect-error not an association
    cs.assocConstraint("email");
    cs.checkConstraint("age", { name: "users_age_check" });
    // @ts-expect-error a check constraint needs its name
    cs.checkConstraint("age", {});
    cs.exclusionConstraint("name");
  });

  test("repo hooks", () => {
    cs.optimisticLock("lockVersion", (n) => n + 1);
    cs.prepareChanges((c) => c.putChange("name", "x"));
    expectTypeOf(cs.validateUniqueAsync("email", {})).toEqualTypeOf<Promise<typeof cs>>();
  });
});

describe("applyChanges and applyAction", () => {
  test("a changeset of a loaded row applies to the row type", () => {
    expectTypeOf(change(user).applyChanges()).toEqualTypeOf<User>();
    expectTypeOf(change(either).applyChanges()).toEqualTypeOf<User>();
    const result = applyAction(change(either, { name: "Ada" }), "update");
    if (result.success) expectTypeOf(result.data).toEqualTypeOf<User>();
    else expectTypeOf(result.error).toEqualTypeOf<Changeset<typeof User, boolean>>();
  });

  test("applyActionOrThrow returns the applied data", () => {
    expectTypeOf(applyActionOrThrow(change(either, { name: "Ada" }), "update")).toEqualTypeOf<User>();
    expectTypeOf(applyActionOrThrow(change(user), "update")).not.toBeAny();
    const filters = applyActionOrThrow(cast({ data: {}, types: { q: t.string() } }, params, ["q"]), "insert");
    expectTypeOf(filters.q).toEqualTypeOf<string | undefined>();
    // @ts-expect-error a new record cannot become a row
    applyActionOrThrow(change(User, { email: "a@b.c" }), "insert");
    // @ts-expect-error not an action
    applyActionOrThrow(change(user), "save");
  });

  test("a changeset of a new record has no row to apply to", () => {
    // @ts-expect-error a new record cannot become a row
    cast(User, params, ["email"]).applyChanges();
    // @ts-expect-error a new record cannot become a row
    applyAction(change(User, { email: "a@b.c" }), "insert");
    // @ts-expect-error not an action
    applyAction(change(user), "save");
  });
});

describe("errors", () => {
  test("traverseErrors returns a tree of what the callback makes", () => {
    const cs = cast(User, params, ["email"]);
    expectTypeOf(traverseErrors(cs, (error) => error.message.length)).toEqualTypeOf<
      TypedErrorTree<typeof User, never, number>
    >();
    expectTypeOf(cs.errorMessages()).toEqualTypeOf<TypedErrorTree<typeof User, never, string>>();
    expectTypeOf(cs.errorMessages()).toMatchTypeOf<ErrorTree<string>>();
    cs.addError("email", "is taken", { count: 1 });
    cs.addError("$base", "is invalid");
  });

  test("Row of the class is the row type a changeset applies to", () => {
    expectTypeOf<Row<typeof User>>().toEqualTypeOf<User>();
  });
});
