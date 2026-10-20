import { inspect } from "node:util";
import { Comment, Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { ChangesetError } from "../contracts/changeset.js";
import type { AnySchema, Row } from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import { meta, t } from "../schema/index.js";
import {
  addValidation,
  type Changeset,
  cast,
  change,
  fieldsOf,
  rebuild,
  traverseErrors,
  valueBefore,
  withAction,
  withErrors,
} from "./changeset.js";

function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

describe("addError", () => {
  test("adds an error on a field or any other key and makes the changeset invalid", () => {
    const cs = change(User)
      .addError("email", "is not allowed", { domain: "example.com" })
      .addError("$base", "try later");
    expect(cs.errors).toEqual({
      email: [{ message: "is not allowed", meta: { domain: "example.com" } }],
      $base: [{ message: "try later", meta: {} }],
    });
    expect(cs.valid).toBe(false);
  });

  test("errors on one key keep their order", () => {
    const cs = change(User).addError("email", "first").addError("email", "second");
    expect(cs.errors.email?.map((error) => error.message)).toEqual(["first", "second"]);
  });

  test("copies the meta it is given", () => {
    const given = { count: 1 };
    const cs = change(User).addError("email", "x", given);
    given.count = 2;
    expect(cs.errors.email?.[0]?.meta).toEqual({ count: 1 });
  });

  test("refuses a bad key or message", () => {
    expect(() => change(User).addError("", "x")).toThrow(QueryError);
    expect(() => change(User).addError("__proto__", "x")).toThrow(QueryError);
    expect(() => change(User).addError("email", 1 as never)).toThrow(QueryError);
  });
});

describe("errorMessages and traverseErrors", () => {
  test("errorMessages fills placeholders from meta and leaves unknown ones", () => {
    const cs = cast(User, { name: "J", age: "x" }, ["name", "age"])
      .validateLength("name", { min: 2 })
      .addError("email", "{unknown} stays");
    expect(cs.errorMessages()).toEqual({
      name: ["should be at least 2 character(s)"],
      age: ["is invalid"],
      email: ["{unknown} stays"],
    });
  });

  test("traverseErrors hands each error and its key to the callback, for plurals and translation", () => {
    const plural = (error: ChangesetError) =>
      error.meta.count === 1
        ? error.message.replace("{count}", "1").replace("character(s)", "character")
        : error.message.replace("{count}", String(error.meta.count)).replace("character(s)", "characters");
    expect(
      traverseErrors(
        cast(User, { name: "" }, ["name"], { emptyValues: [] }).validateLength("name", { min: 1 }),
        plural,
      ),
    ).toEqual({
      name: ["should be at least 1 character"],
    });
    expect(
      traverseErrors(cast(User, { name: "a" }, ["name"]).validateLength("name", { min: 3 }), plural),
    ).toEqual({
      name: ["should be at least 3 characters"],
    });
    const keys: string[] = [];
    traverseErrors(change(User).addError("email", "x").addError("name", "y"), (_, key) => keys.push(key));
    expect(keys).toEqual(["email", "name"]);
  });

  test("descends into changesets held in changes, one or a list, leaving out those without errors", () => {
    const post = loaded(Post, { id: 1, authorId: 2, title: "Hello" });
    const goodComment = cast(Comment, { body: "Nice" }, ["body"]);
    const badComment = cast(Comment, {}, ["body"]).validateRequired(["body"]);
    const author = change(User).addError("email", "can't be blank");
    const parent = rebuild(change(post), {
      changes: { comments: [goodComment, badComment], author, tags: [], extra: [1] },
      valid: false,
    });
    expect(parent.errorMessages()).toEqual({
      comments: [{}, { body: ["can't be blank"] }],
      author: { email: ["can't be blank"] },
    });
    // A key with its own errors and nested changesets with errors keeps both: the key's
    // own under $errors, a list of children under $items.
    const both = rebuild(parent, {
      errors: {
        author: [{ message: "is invalid", meta: {} }],
        comments: [{ message: "should have at least {count} item(s)", meta: { count: 3 } }],
      },
    });
    expect(both.errorMessages().author).toEqual({ email: ["can't be blank"], $errors: ["is invalid"] });
    expect(both.errorMessages().comments).toEqual({
      $errors: ["should have at least 3 item(s)"],
      $items: [{}, { body: ["can't be blank"] }],
    });
    const clean = rebuild(change(post), { changes: { comments: [goodComment], author: goodComment } });
    expect(clean.errorMessages()).toEqual({});
  });
});

describe("validations list", () => {
  test("lists each validation with its options, oldest first", () => {
    const pattern = /@/;
    const cs = cast(User, {}, ["email"])
      .validateRequired(["email", "name"])
      .validateFormat("email", pattern)
      .validateLength("name", { min: 2, max: 80 })
      .validateInclusion("role", ["admin", "member"], { message: "pick one" })
      .validateNumber("age", { greaterThan: 0 })
      .validateConfirmation("password")
      .validateAcceptance("terms")
      .validateChange("name", () => undefined);
    expect(cs.validations).toEqual([
      ["email", { validation: "required" }],
      ["name", { validation: "required" }],
      ["email", { validation: "format", pattern }],
      ["name", { validation: "length", min: 2, max: 80 }],
      ["role", { validation: "inclusion", values: ["admin", "member"], message: "pick one" }],
      ["age", { validation: "number", greaterThan: 0 }],
      ["password", { validation: "confirmation" }],
      ["terms", { validation: "acceptance" }],
      ["name", { validation: "change" }],
    ]);
    expect(cs.validations).toBe(cs.validations);
    expect(Object.isFrozen(cs.validations)).toBe(true);
  });

  test("addValidation records a descriptor as given", () => {
    const validator = () => [];
    expect(addValidation(change(User), "$schema", { validator }).validations).toEqual([
      ["$schema", { validator }],
    ]);
  });
});

describe("inspect and toJSON", () => {
  test("inspect shows the class, action, changes, errors and valid, with redacted fields hidden", () => {
    const cs = cast(User, { email: "ada@example.com", passwordHash: "$2b$10$secret" }, [
      "email",
      "passwordHash",
    ]);
    expect(inspect(cs)).toBe(
      'Changeset<User> { action: null, changes: { email: "ada@example.com", passwordHash: **redacted** }, errors: {}, valid: true }',
    );
    expect(inspect(cs)).not.toContain("secret");
  });

  test("inspect never shows params or data", () => {
    const row = loaded(User, {
      id: 1,
      email: "a@b.c",
      role: "member",
      lockVersion: 1,
      passwordHash: "$2b$hash",
    });
    const cs = cast(row, { passwordConfirmation: "plain secret", name: "x" }, ["name"]).validateLength(
      "name",
      {
        min: 2,
      },
    );
    const text = inspect(cs);
    expect(text).not.toContain("plain secret");
    expect(text).not.toContain("$2b$hash");
    expect(text).toContain("valid: false");
  });

  test("inspect of a changeset without a schema class, and of nested changesets", () => {
    const search = cast(
      { data: {}, types: { q: t.string(), token: t.string().redact() } },
      { q: "x", token: "t0p" },
      ["q", "token"],
    );
    expect(inspect(search)).toBe(
      'Changeset<schemaless> { action: null, changes: { q: "x", token: **redacted** }, errors: {}, valid: true }',
    );
    const child = cast(User, { passwordHash: "inner secret" }, ["passwordHash"]);
    const parent = rebuild(change(loaded(Post, { id: 1, authorId: 1, title: "T" })), {
      changes: { author: child, comments: [child] },
    });
    const text = inspect(parent);
    expect(text).not.toContain("inner secret");
    expect(text).toContain("**redacted**");
  });

  test("toJSON leaves out redacted fields", () => {
    const cs = cast(User, { email: "ada@example.com", passwordHash: "secret" }, ["email", "passwordHash"]);
    expect(JSON.parse(JSON.stringify(cs))).toEqual({
      action: null,
      changes: { email: "ada@example.com" },
      errors: {},
      valid: true,
    });
  });

  test("errors are plain, serialisable values without the values of redacted fields", () => {
    const cs = cast(User, { passwordHash: 42 }, ["passwordHash"]).validateLength("email", { min: 1 });
    expect(JSON.parse(JSON.stringify(cs.errors))).toEqual(cs.errors);
    expect(JSON.stringify(cs.errors)).not.toContain("42");
  });
});

describe("hooks for other modules", () => {
  test("withAction sets the action and shares the rest", () => {
    const cs = cast(User, { email: "a@b.c" }, ["email"]);
    const insert = withAction(cs, "insert");
    expect(insert.action).toBe("insert");
    expect(insert.changes).toBe(cs.changes);
  });

  test("withErrors appends errors and leaves a changeset alone when there are none", () => {
    const cs = change(User);
    expect(withErrors(cs, "email", [])).toBe(cs);
    const failed = withErrors(cs, "$base", [{ message: "is invalid", validation: "schema", meta: {} }]);
    expect(failed.valid).toBe(false);
    expect(failed.errors.$base).toHaveLength(1);
  });

  test("rebuild keeps what it is not given", () => {
    const cs = change(User, { email: "a@b.c" });
    const next = rebuild(cs, {});
    expect(next.changes).toBe(cs.changes);
    expect(next.valid).toBe(true);
  });

  test("fieldsOf and valueBefore", () => {
    const row = loaded(User, { id: 3, email: "a@b.c", role: "member", lockVersion: 1 });
    expect([...fieldsOf(change(User)).keys()]).toEqual(meta(User).fields.map((field) => field.name));
    expect(valueBefore(change(row, { email: "x@y.z" }), "email")).toBe("a@b.c");
    expect(valueBefore(change(User), "role")).toBe("member");
  });
});

describe("use cases", () => {
  // A sign-up form: cast, then the rules a registration needs.
  const register = (params: unknown) =>
    cast(User, params, ["email", "name", "password"])
      .validateRequired(["email", "password"])
      .validateFormat("email", /^[^@\s]+@[^@\s]+$/)
      .validateLength("name", { min: 2, max: 80 })
      .validateLength("password", { min: 12 })
      .validateConfirmation("password", { required: true })
      .validateAcceptance("termsOfService")
      .uniqueConstraint("email");

  test("a registration form: valid input", () => {
    const cs = register({
      email: "radia@routing.example",
      name: "Radia",
      password: "spanning-tree-1",
      passwordConfirmation: "spanning-tree-1",
      termsOfService: "true",
    });
    expect(cs.valid).toBe(true);
    expect(cs.changes).toEqual({
      email: "radia@routing.example",
      name: "Radia",
      password: "spanning-tree-1",
    });
  });

  test("a registration form: every problem reported at once", () => {
    const cs = register({ email: "radia", name: "R", password: "short", passwordConfirmation: "shorter" });
    expect(cs.errorMessages()).toEqual({
      email: ["has invalid format"],
      name: ["should be at least 2 character(s)"],
      password: ["should be at least 12 character(s)"],
      passwordConfirmation: ["does not match confirmation"],
      termsOfService: ["must be accepted"],
    });
  });

  test("a partial update of a loaded row: only changed fields; no-op update has no changes", () => {
    const row = loaded(User, {
      id: 9,
      email: "frances@ibm.example",
      name: "Frances",
      role: "member",
      lockVersion: 1,
    });
    const profile = (user: User | typeof User, params: unknown) =>
      cast(user, params, ["name", "age"]).validateNumber("age", { greaterThanOrEqualTo: 13 });
    expect(profile(row, { name: "Frances", age: "52" }).changes).toEqual({ age: 52 });
    expect(profile(row, { name: "Frances" }).changes).toEqual({});
    expect(profile(User, { age: "9" }).errorMessages()).toEqual({
      age: ["must be greater than or equal to 13"],
    });
  });

  test("two changeset functions on one schema permit different fields", () => {
    const signUp = (params: unknown) => cast(User, params, ["email", "password"]);
    const rename = (user: User, params: unknown) => cast(user, params, ["name"]);
    const row = loaded(User, { id: 9, email: "e@x.y", role: "member", lockVersion: 1 });
    expect(signUp({ email: "e@x.y", name: "ignored" }).changes).toEqual({ email: "e@x.y" });
    expect(rename(row, { email: "ignored@x.y", name: "Edsger" }).changes).toEqual({ name: "Edsger" });
  });

  test("a search form without a schema class", () => {
    const search = (params: unknown) =>
      cast({ data: {}, types: { q: t.string(), page: t.integer().default(1) } }, params, ["q", "page"])
        .validateRequired(["q"])
        .validateNumber("page", { greaterThan: 0 });
    const ok = search({ q: "changesets", page: "2" });
    expect(ok.applyChanges()).toEqual({ q: "changesets", page: 2 });
    expect(search({ page: "0" }).errorMessages()).toEqual({
      q: ["can't be blank"],
      page: ["must be greater than 0"],
    });
  });

  test("a reusable step through pipe", () => {
    const normalizeEmail = <C extends Changeset<typeof User>>(cs: C) =>
      cs.updateChange("email", (email) => email.trim().toLowerCase());
    expect(register({ email: "  RADIA@Routing.Example " }).pipe(normalizeEmail).changes.email).toBe(
      "radia@routing.example",
    );
  });
});
