import { Post, Tag, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { AnySchema, Row } from "../contracts/schema.js";
import { ROW } from "../contracts/schema.js";
import { InvalidChangesetError, QueryError } from "../errors.js";
import { meta, t } from "../schema/index.js";
import { applyAction, applyActionOrThrow, Changeset, cast, change } from "./changeset.js";

function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

const at = new Date("2026-05-04T08:00:00Z");
const margaret = (): User =>
  loaded(User, {
    id: 11,
    email: "margaret@apollo.example",
    name: "Margaret",
    age: 33,
    role: "member",
    lockVersion: 5,
    createdAt: at,
    updatedAt: at,
  });

describe("change", () => {
  test("records trusted values without converting them", () => {
    const cs = change(User, { email: "katherine@nasa.example", age: 40 });
    expect(cs.changes).toEqual({ email: "katherine@nasa.example", age: 40 });
    expect(cs.params).toBeNull();
    expect(cs.data).toBeNull();
  });

  test("leaves out values equal to the current ones", () => {
    const row = margaret();
    expect(change(row, { name: "Margaret", age: 34 }).changes).toEqual({ age: 34 });
    expect(change(User, { role: "member" }).changes).toEqual({});
  });

  test("with no values is an empty changeset of the target", () => {
    const row = margaret();
    const cs = change(row);
    expect(cs.changes).toEqual({});
    expect(cs.data).toBe(row);
    expect(cs.valid).toBe(true);
  });

  test("null on a field that is not nullable adds can't be blank", () => {
    const cs = change(User, { email: null as unknown as string });
    expect(cs.errors).toEqual({ email: [{ message: "can't be blank", validation: "required", meta: {} }] });
    expect(cs.changes).toEqual({});
  });

  test("skips keys whose value is undefined", () => {
    expect(change(User, { name: undefined } as never).changes).toEqual({});
  });

  test("applies values to an existing changeset", () => {
    const first = change(User, { email: "a@example.com" });
    expect(change(first, { name: "A" }).changes).toEqual({ email: "a@example.com", name: "A" });
  });

  test("throws for an unknown key, an embed, or values that are not an object", () => {
    expect(() => change(User, { nickname: "x" } as never)).toThrow(QueryError);
    expect(() => change(User, { settings: { theme: "dark", emailNotifications: true } } as never)).toThrow(
      /putEmbed/,
    );
    expect(() => change(User, "x" as never)).toThrow(QueryError);
  });

  test("works without a schema class", () => {
    const cs = change({ data: { q: "old" }, types: { q: t.string() } }, { q: "new" });
    expect(cs.changes).toEqual({ q: "new" });
  });
});

describe("putChange and forceChange", () => {
  test("putChange records a different value and ignores an equal one", () => {
    const row = margaret();
    const cs = change(row);
    expect(cs.putChange("name", "Maggie").changes).toEqual({ name: "Maggie" });
    expect(cs.putChange("name", "Margaret")).toBe(cs);
  });

  test("putting the current value back removes the change", () => {
    const cs = change(margaret(), { name: "Maggie" });
    expect(cs.putChange("name", "Margaret").changes).toEqual({});
  });

  test("putting the same change again returns the same changeset", () => {
    const cs = change(margaret(), { name: "Maggie" });
    expect(cs.putChange("name", "Maggie")).toBe(cs);
  });

  test("forceChange records a value equal to the current one", () => {
    expect(change(margaret()).forceChange("name", "Margaret").changes).toEqual({ name: "Margaret" });
  });

  test("null on a field that is not nullable adds can't be blank once and keeps an earlier change", () => {
    const cs = change(margaret(), { email: "m@example.com" })
      .putChange("email", null as unknown as string)
      .forceChange("email", null as unknown as string);
    expect(cs.changes).toEqual({ email: "m@example.com" });
    expect(cs.errors.email).toHaveLength(1);
    expect(cs.valid).toBe(false);
  });

  test("undefined is refused with a pointer to null and deleteChange", () => {
    expect(() =>
      change(User).putChange("name", undefined as unknown as null),
    ).toThrowErrorMatchingInlineSnapshot(
      `[QueryError: query.putChangeUndefined: putChange("name", undefined): undefined is not a value. Use null for no value, or deleteChange("name") to remove the change. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-putchangeundefined]`,
    );
  });

  test("an unknown field or an embed is refused", () => {
    expect(() => change(User).putChange("nope" as "name", "x")).toThrow(QueryError);
    expect(() =>
      change(User).putChange("settings", { theme: "dark", emailNotifications: true } as never),
    ).toThrow(/putEmbed/);
  });
});

describe("deleteChange and updateChange", () => {
  test("deleteChange removes a change and leaves a changeset without one alone", () => {
    const cs = change(User, { email: "x@example.com", name: "X" });
    expect(cs.deleteChange("name").changes).toEqual({ email: "x@example.com" });
    const bare = change(User);
    expect(bare.deleteChange("name")).toBe(bare);
    expect(() => bare.deleteChange("nope" as "name")).toThrow(QueryError);
  });

  test("updateChange transforms an existing change", () => {
    const cs = cast(User, { email: "  Ada@Example.COM " }, ["email"]);
    expect(cs.updateChange("email", (email) => email.trim().toLowerCase()).changes).toEqual({
      email: "ada@example.com",
    });
  });

  test("updateChange does nothing without a change and does not call the function", () => {
    const cs = change(User);
    expect(
      cs.updateChange("email", () => {
        throw new Error("not called");
      }),
    ).toBe(cs);
  });

  test("updateChange to the current value removes the change", () => {
    const cs = change(margaret(), { name: "MARGARET" });
    expect(cs.updateChange("name", () => "Margaret").changes).toEqual({});
  });
});

describe("merge", () => {
  test("joins changes, errors, validations, constraints and hooks of the same record", () => {
    const row = margaret();
    const profile = cast(row, { name: "Maggie", age: "x" }, ["name", "age"]).validateLength("name", {
      min: 2,
    });
    const login = cast(row, { email: "mh@example.com" }, ["email"])
      .validateRequired(["email"])
      .uniqueConstraint("email")
      .optimisticLock("lockVersion");
    const both = profile.merge(login);
    expect(both.changes).toEqual({ name: "Maggie", email: "mh@example.com" });
    expect(both.params).toEqual({ name: "Maggie", age: "x", email: "mh@example.com" });
    expect(both.errors).toEqual(profile.errors);
    expect(both.valid).toBe(false);
    expect(both.validations.map(([field, { validation }]) => [field, validation])).toEqual([
      ["name", "length"],
      ["email", "required"],
    ]);
    expect(both.constraints).toEqual(login.constraints);
    expect(both.filters).toEqual({ lockVersion: 5 });
    expect(both.prepare).toHaveLength(1);
  });

  test("is invalid when either side is", () => {
    const row = margaret();
    const valid = change(row, { name: "A" });
    const invalid = change(row).addError("age", "is wrong");
    expect(valid.merge(invalid).valid).toBe(false);
    expect(invalid.merge(valid).valid).toBe(false);
    expect(valid.merge(change(row, { age: 1 })).valid).toBe(true);
  });

  test("the other changeset's changes win", () => {
    const row = margaret();
    expect(change(row, { name: "A" }).merge(change(row, { name: "B" })).changes).toEqual({ name: "B" });
  });

  test("does not repeat an error both have", () => {
    const first = cast(User, { age: "x" }, ["age"]);
    const second = cast(first, { name: "Ada" }, ["name"]);
    expect(first.merge(second).errors.age).toHaveLength(1);
  });

  test("keeps shared members when the other adds nothing", () => {
    const first = change(User)
      .uniqueConstraint("email")
      .prepareChanges((cs) => cs);
    const merged = first.merge(change(User));
    expect(merged.constraints).toBe(first.constraints);
    expect(merged.prepare).toBe(first.prepare);
    expect(merged.params).toBeNull();
  });

  test("refuses changesets of different records, or with different actions", () => {
    expect(() => change(margaret()).merge(change(margaret()))).toThrow(QueryError);
    expect(() => change(User).merge(change(Post) as never)).toThrow(QueryError);
    expect(() => change(User).merge({} as never)).toThrow(QueryError);
    const row = margaret();
    const insert = applyAction(change(row).addError("name", "x"), "insert");
    const update = applyAction(change(row).addError("name", "y"), "update");
    if (insert.success || update.success) throw new Error("expected failures");
    expect(() => insert.error.merge(update.error)).toThrow(/different actions/);
    expect(insert.error.merge(change(row)).action).toBe("insert");
  });
});

describe("pipe", () => {
  test("applies a reusable step", () => {
    const normalizeEmail = (cs: Changeset<typeof User>) =>
      cs.updateChange("email", (email) => email.trim().toLowerCase());
    expect(cast(User, { email: " Ada@Example.com" }, ["email"]).pipe(normalizeEmail).changes).toEqual({
      email: "ada@example.com",
    });
  });
});

describe("reads", () => {
  test("getField: the change, else the data, else the fallback", () => {
    const cs = change(margaret(), { name: "Maggie" });
    expect(cs.getField("name")).toBe("Maggie");
    expect(cs.getField("age")).toBe(33);
    expect(cs.getField("password", "unset")).toBe("unset");
  });

  test("getField of a new record falls back to the field's default", () => {
    const cs = change(User);
    expect(cs.getField("role")).toBe("member");
    expect(cs.getField("lockVersion")).toBe(1);
    expect(cs.getField("name")).toBeNull();
    expect(cs.getField("email")).toBeUndefined();
    expect(cs.getField("email", "none")).toBe("none");
  });

  test("a function default is called for each read", () => {
    let calls = 0;
    const cs = change({
      data: {},
      types: {
        list: t.array(t.string()).default(() => {
          calls++;
          return [];
        }),
      },
    });
    expect(cs.getField("list")).toEqual([]);
    expect(cs.getField("list")).not.toBe(cs.getField("list"));
    expect(calls).toBe(3);
  });

  test("getChange: the change or the fallback", () => {
    const cs = change(margaret(), { name: "Maggie" });
    expect(cs.getChange("name")).toBe("Maggie");
    expect(cs.getChange("age")).toBeUndefined();
    expect(cs.getChange("age", 0)).toBe(0);
  });

  test("fetchField says where the value comes from", () => {
    const cs = change(margaret(), { name: "Maggie" });
    expect(cs.fetchField("name")).toEqual({ from: "changes", value: "Maggie" });
    expect(cs.fetchField("age")).toEqual({ from: "data", value: 33 });
    expect(change(User).fetchField("role")).toEqual({ from: "data", value: "member" });
    expect(change(User).fetchField("email")).toBeUndefined();
  });

  test("fetchChange tells a change to null from no change", () => {
    const cs = change(margaret(), { name: null });
    expect(cs.fetchChange("name")).toEqual({ value: null });
    expect(cs.fetchChange("age")).toBeUndefined();
  });

  test("isChanged, with and without from and to", () => {
    const cs = change(margaret(), { role: "admin", age: null });
    expect(cs.isChanged("role")).toBe(true);
    expect(cs.isChanged("email")).toBe(false);
    expect(cs.isChanged("role", { to: "admin" })).toBe(true);
    expect(cs.isChanged("role", { to: "member" })).toBe(false);
    expect(cs.isChanged("role", { from: "member", to: "admin" })).toBe(true);
    expect(cs.isChanged("role", { from: "admin" })).toBe(false);
    expect(cs.isChanged("age", { from: 33, to: null })).toBe(true);
    expect(change(User, { role: "admin" }).isChanged("role", { from: "member" })).toBe(true);
  });

  test("fieldMissing: no value, null or only whitespace", () => {
    const cs = cast(margaret(), { name: " \t\n" }, ["name"]);
    expect(cs.fieldMissing("name")).toBe(true);
    expect(cs.fieldMissing("email")).toBe(false);
    expect(change(User).fieldMissing("email")).toBe(true);
    expect(change(User).fieldMissing("role")).toBe(false);
  });

  test("reads throw for an unknown field", () => {
    const cs = change(User);
    for (const read of [
      () => cs.getField("nope" as "name"),
      () => cs.getChange("nope" as "name"),
      () => cs.fetchField("nope" as "name"),
      () => cs.fetchChange("nope" as "name"),
      () => cs.isChanged("nope" as "name"),
      () => cs.fieldMissing("nope" as "name"),
    ]) {
      expect(read).toThrow(QueryError);
    }
  });
});

describe("applyChanges", () => {
  test("returns a new row of the class with the changes applied", () => {
    const row = margaret();
    const updated = change(row, { name: "Maggie", password: "correct horse" }).applyChanges();
    expect(updated).toBeInstanceOf(User);
    expect(updated).not.toBe(row);
    expect(updated.name).toBe("Maggie");
    expect(updated.password).toBe("correct horse");
    expect(updated.email).toBe(row.email);
    expect(updated.displayName).toBe("Maggie");
    expect(updated[ROW as never]).toBe(row[ROW as never]);
    expect(Object.keys(updated)).toEqual(Object.keys(row));
    expect(row.name).toBe("Margaret");
  });

  test("keeps the row's virtual values and loaded associations", () => {
    const info = meta(Post);
    const tag = loaded(Tag, { id: 1, name: "release" });
    const post = info.createWith(["tags"])(
      info.persisted.map((field) => (field.name === "title" ? "Launch" : field.name === "id" ? 3 : null)),
      [[tag]],
      info.rowMeta("loaded", undefined),
    ) as Post & { tags: Tag[] };
    const updated = change(post, { title: "Launched" }).applyChanges() as Post & { tags: Tag[] };
    expect(updated.title).toBe("Launched");
    expect(updated.tags).toEqual([tag]);
    const withPassword = change(margaret()).forceChange("password", "x").applyChanges();
    expect(change(withPassword).applyChanges().password).toBe("x");
  });

  test("without a schema class returns the data merged with the changes", () => {
    const data = { q: "old", page: 1, extra: true };
    const cs = cast({ data, types: { q: t.string(), page: t.integer() } }, { q: "new" }, ["q"]);
    expect(cs.applyChanges()).toEqual({ q: "new", page: 1, extra: true });
    expect(data.q).toBe("old");
  });

  test("without a schema class, fields the data lacks take their declared default", () => {
    const types = {
      q: t.string(),
      page: t.integer().default(1),
      sort: t.string().nullable(),
      tag: t.string(),
    };
    expect(cast({ data: {}, types }, { q: "orm" }, ["q"]).applyChanges()).toEqual({
      q: "orm",
      page: 1,
      sort: null,
    });
    expect(cast({ data: { page: 4 }, types }, { page: "5" }, ["page"]).applyChanges()).toEqual({
      page: 5,
      sort: null,
    });
  });

  test("throws on a new record", () => {
    const cs = cast(User, { email: "x@example.com" }, ["email"]) as unknown as Changeset<typeof User, false>;
    expect(() => cs.applyChanges()).toThrowErrorMatchingInlineSnapshot(
      `[QueryError: query.applyChangesNewRecord: applyChanges() and applyAction() need a changeset of a loaded row (or one without a schema class); this one is of a new User. A row the database never returned cannot exist. Insert it with the repo instead. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-applychangesnewrecord]`,
    );
  });
});

describe("applyAction", () => {
  test("a valid changeset gives the applied data", () => {
    const result = applyAction(change(margaret(), { name: "Maggie" }), "update");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Maggie");
  });

  test("an invalid changeset gives itself back with the action set", () => {
    const cs = cast({ data: {}, types: { page: t.integer() } }, { page: "x" }, ["page"]);
    const result = applyAction(cs, "insert");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.action).toBe("insert");
      expect(result.error.errors).toBe(cs.errors);
      expect(cs.action).toBeNull();
    }
  });

  test("throws for an unknown action or a new record, valid or not", () => {
    expect(() => applyAction(change(margaret()), "save" as never)).toThrow(QueryError);
    const fresh = change(User) as unknown as Changeset<typeof User, false>;
    expect(() => applyAction(fresh, "insert")).toThrow(QueryError);
    expect(() => applyAction(fresh.addError("email", "x"), "insert")).toThrow(QueryError);
  });
});

describe("applyActionOrThrow", () => {
  test("a valid changeset gives the applied data itself", () => {
    const row = applyActionOrThrow(change(margaret(), { name: "Maggie" }), "update");
    expect(row).toBeInstanceOf(User);
    expect(row.name).toBe("Maggie");
    const data = applyActionOrThrow(
      cast({ data: {}, types: { q: t.string() } }, { q: "egon" }, ["q"]),
      "insert",
    );
    expect(data).toEqual({ q: "egon" });
  });

  test("an invalid changeset throws InvalidChangesetError with the changeset and its action", () => {
    const cs = cast({ data: {}, types: { page: t.integer() } }, { page: "secret-value" }, ["page"]);
    let thrown: unknown;
    try {
      applyActionOrThrow(cs, "insert");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidChangesetError);
    const error = thrown as InvalidChangesetError<typeof cs>;
    expect(error.id).toBe("invalidChangeset");
    expect(error.action).toBe("insert");
    expect(error.changeset.action).toBe("insert");
    expect(error.changeset.errors).toBe(cs.errors);
    expect(error.message).toContain("Could not perform insert because the changeset is invalid.");
    expect(error.message).toContain("page: is invalid");
    // The listing has the errors, never the values that caused them.
    expect(error.message).not.toContain("secret-value");
    expect(cs.action).toBeNull();
  });

  test("throws QueryError for an unknown action or a new record, as applyAction does", () => {
    expect(() => applyActionOrThrow(change(margaret()), "save" as never)).toThrow(QueryError);
    const fresh = change(User) as unknown as Changeset<typeof User, false>;
    expect(() => applyActionOrThrow(fresh, "insert")).toThrow(QueryError);
    expect(() => applyActionOrThrow(fresh.addError("email", "x"), "insert")).toThrow(QueryError);
  });
});

describe("the constructor", () => {
  test("is not public", () => {
    const Ctor = Changeset as unknown as new (...args: unknown[]) => unknown;
    expect(() => new Ctor(Symbol("changeset"))).toThrowErrorMatchingInlineSnapshot(
      `[QueryError: query.changesetConstructor: Changeset has no public constructor. Make one with cast(User, params, [...]) or change(User, values). See https://egon-orm.github.io/egon-orm/reference/errors/query#query-changesetconstructor]`,
    );
  });
});
