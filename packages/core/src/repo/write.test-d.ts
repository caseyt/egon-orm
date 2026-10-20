// Type tests for the repo's writes: results narrow on `success`, insert takes a changeset of
// a new record and update one of a loaded row, `data` is nullable only with
// `onConflict: "nothing"`, insertAll rows and `returning` are typed.
import { Post, Tag, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import {
  type Changeset,
  cast,
  change,
  coalesce,
  from,
  now,
  param,
  type Repo,
  scalar,
  t,
  val,
} from "../index.js";

declare const repo: Repo;
declare const user: User;
declare const either: User | typeof User;

describe("insert", () => {
  test("returns a Result that narrows on success", async () => {
    const result = await repo.insert(cast(User, {}, ["email"]));
    if (result.success) {
      expectTypeOf(result.data).toEqualTypeOf<User>();
      expectTypeOf(result.data).not.toBeAny();
    } else {
      expectTypeOf(result.error).toEqualTypeOf<Changeset<typeof User, true>>();
    }
    expectTypeOf(await repo.insertOrThrow(change(User, { email: "a" }))).toEqualTypeOf<User>();
  });

  test("data is nullable only with onConflict: nothing", async () => {
    const skipped = await repo.insert(change(Tag, { name: "a" }), { onConflict: "nothing" });
    if (skipped.success) expectTypeOf(skipped.data).toEqualTypeOf<Tag | null>();
    const upserted = await repo.insert(change(Tag, { name: "a" }), {
      onConflict: { target: ["name"], update: "all" },
    });
    if (upserted.success) expectTypeOf(upserted.data).toEqualTypeOf<Tag>();
    expectTypeOf(
      await repo.insertOrThrow(change(Tag, {}), { onConflict: "nothing" }),
    ).toEqualTypeOf<Tag | null>();
  });

  test("a changeset that may be either kind is accepted; one of a loaded row is not", () => {
    void repo.insert(cast(either, {}, ["email"]));
    // @ts-expect-error a changeset of a loaded row cannot be inserted
    void repo.insert(cast(user, {}, ["email"]));
    // @ts-expect-error insert takes a changeset, not a row or plain values
    void repo.insert({ email: "a" });
    // @ts-expect-error not a field
    void repo.insert(change(User, {}), { returning: ["nope"] });
    // @ts-expect-error not a field
    void repo.insert(change(User, {}), { onConflict: { target: ["nope"], update: "all" } });
    // @ts-expect-error there is no "raise" spelling
    void repo.insert(change(User, {}), { onConflict: "raise" });
  });
});

describe("update and delete", () => {
  test("take a changeset of a loaded row", async () => {
    expectTypeOf(await repo.updateOrThrow(cast(user, { name: "a" }, ["name"]))).toEqualTypeOf<User>();
    const result = await repo.update(change(user, { name: "b" }), { staleError: { field: "lockVersion" } });
    if (!result.success) expectTypeOf(result.error.valid).toEqualTypeOf<boolean>();
    void repo.update(cast(either, {}, ["name"]));
    // @ts-expect-error a new record has no row to update
    void repo.update(cast(User, {}, ["name"]));
    // @ts-expect-error update takes a changeset
    void repo.update(user);
  });

  test("delete takes a row or a changeset of one", async () => {
    expectTypeOf(await repo.deleteOrThrow(user)).toEqualTypeOf<User>();
    const result = await repo.delete(change(user).noAssocConstraint("posts"));
    if (result.success) expectTypeOf(result.data).toEqualTypeOf<User>();
    // @ts-expect-error a new record has no row to delete
    void repo.delete(change(User, {}));
  });

  test("insertOrUpdate takes either kind", async () => {
    expectTypeOf(await repo.insertOrUpdateOrThrow(cast(either, {}, ["email"]))).toEqualTypeOf<User>();
    expectTypeOf(
      await repo.insertOrUpdateOrThrow(cast(either, {}, ["email"]), { onConflict: "nothing" }),
    ).toEqualTypeOf<User | null>();
  });
});

describe("insertAll", () => {
  test("rows are typed like a new record; values may be expressions", async () => {
    const none = await repo.insertAll(Post, [
      { authorId: 1, title: "a" },
      { authorId: 1, title: "b", publishedAt: now() },
      { authorId: scalar(from(User, "u").select(({ u }) => u.id)).as<number>(), title: "c" },
      { authorId: coalesce(scalar(from(User, "u").select(({ u }) => u.id)), 1), title: "d" },
      { authorId: 1, title: "d", publishedAt: param("when", t.timestamp()) },
    ]);
    expectTypeOf(none.rows).toEqualTypeOf<null>();
    // @ts-expect-error a scalar subquery may be null: say it is not, or give a fallback
    void repo.insertAll(Post, [{ authorId: scalar(from(User, "u").select(({ u }) => u.id)), title: "x" }]);
    // @ts-expect-error a nullable expression for a non-nullable field
    void repo.insertAll(Post, [{ authorId: 1, title: val(null as string | null, t.string().nullable()) }]);
    void repo.insertAll(Post, [
      // @ts-expect-error a nullable column for a non-nullable field
      { authorId: 1, title: scalar(from(User, "u").select(({ u }) => u.name)).as<string | null>() },
    ]);
    // A nullable field takes them.
    void repo.insertAll(Post, [
      { authorId: 1, title: "x", body: scalar(from(User, "u").select(({ u }) => u.name)) },
    ]);
    // @ts-expect-error title is required
    void repo.insertAll(Post, [{ authorId: 1 }]);
    // @ts-expect-error a number is not a title
    void repo.insertAll(Post, [{ authorId: 1, title: 5 }]);
    // @ts-expect-error not a field
    void repo.insertAll(Tag, [{ name: "a", nope: 1 }]);
  });

  test("returning types the rows", async () => {
    const whole = await repo.insertAll(Tag, [{ name: "a" }], { returning: true });
    expectTypeOf(whole.rows).toEqualTypeOf<Tag[]>();
    const some = await repo.insertAll(User, [{ email: "a" }], { returning: ["id", "email"] });
    expectTypeOf(some.rows).toEqualTypeOf<Pick<User, "id" | "email">[]>();
    expectTypeOf(some.rows[0]).not.toBeAny();
  });
});

describe("updateAll and deleteAll", () => {
  test("rows follow returning", async () => {
    const plain = await repo.updateAll(from(Post, "p").set({ published: true }));
    expectTypeOf(plain.count).toEqualTypeOf<number>();
    const ids = await repo.deleteAll(from(Post, "p").returning(({ p }) => ({ id: p.id })));
    expectTypeOf(ids.rows).toEqualTypeOf<{ id: number }[] | null>();
    const q = from(Post, "p").where(({ p }) => p.authorId.eq(param("author", t.bigint({ mode: "number" }))));
    void repo.deleteAll(q, { author: 1 });
    // @ts-expect-error the query needs its named parameter
    void repo.deleteAll(q);
  });
});
