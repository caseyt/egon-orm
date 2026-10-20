// Type tests for Batch: results accumulate step by step and reach the function-form steps
// and the final `data` typed, with no annotation anywhere; the failure is a union over the
// steps that can fail, discriminated by `step`; a repeated step name does not compile.
import { Profile, Tag, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import type { Changeset } from "../changeset/changeset.js";
import { change } from "../changeset/index.js";
import { failure, type Result, success } from "../contracts/result.js";
import { from } from "../query/builder.js";
import { param } from "../query/functions.js";
import type { Repo } from "../repo/repo.js";
import { t } from "../schema/index.js";
import { type Batch, type BatchFailure, createBatch } from "./batch.js";

declare const repo: Repo;
declare const userChangeset: Changeset<typeof User, true>;
declare const loadedUser: User;

describe("results accumulate", () => {
  test("five different steps, each typed under its name, and each later step sees the earlier ones", async () => {
    const batch = createBatch()
      .insert("user", userChangeset)
      .insert("profile", ({ user }) => {
        expectTypeOf(user).toEqualTypeOf<User>();
        return change(Profile, { userId: user.id });
      })
      .updateAll("published", ({ user }) => from(Tag, "t").where({ name: user.email }).set({ name: "x" }))
      .run("welcome", async (tx, { user, profile }) => {
        expectTypeOf(tx).toEqualTypeOf<Repo>();
        expectTypeOf(profile).toEqualTypeOf<Profile>();
        return success(`welcome ${user.email}`);
      })
      .put("source", 42)
      .one("again", ({ profile }) => from(Profile, "p").where({ id: profile.id }));

    const result = await repo.transaction(batch);
    if (result.success) {
      expectTypeOf(result.data).toEqualTypeOf<{
        user: User;
        profile: Profile;
        published: { readonly count: number; readonly rows: Tag[] | null };
        welcome: string;
        source: number;
        again: Profile | null;
      }>();
      expectTypeOf(result.data.user).not.toBeAny();
    }
    expectTypeOf(await repo.transactionOrThrow(batch))
      .toHaveProperty("welcome")
      .toEqualTypeOf<string>();
  });

  test("all, exists, deleteAll, insertAll and inspect", async () => {
    const batch = createBatch()
      .all("users", from(User, "u"))
      .exists("any", User)
      .deleteAll("removed", from(Tag, "t"))
      .insertAll("plain", Tag, [{ name: "a" }])
      .insertAll("picked", Tag, [{ name: "b" }], { returning: ["id"] })
      .insertAll("whole", Tag, [{ name: "c" }], { returning: true })
      .inspect(({ users, any }) => {
        expectTypeOf(users).toEqualTypeOf<User[]>();
        expectTypeOf(any).toEqualTypeOf<boolean>();
      });
    const data = await repo.transactionOrThrow(batch);
    expectTypeOf(data.removed).toEqualTypeOf<{ readonly count: number; readonly rows: Tag[] | null }>();
    expectTypeOf(data.plain).toEqualTypeOf<{ readonly count: number; readonly rows: null }>();
    expectTypeOf(data.picked.rows).toEqualTypeOf<Pick<Tag, "id">[]>();
    expectTypeOf(data.whole.rows).toEqualTypeOf<Tag[]>();
  });

  test("insert with onConflict: nothing may give null; update and delete give the row", async () => {
    const data = await repo.transactionOrThrow(
      createBatch()
        .insert("maybe", userChangeset, { onConflict: "nothing" })
        .update("renamed", change(loadedUser, { name: "Ada" }))
        .delete("gone", loadedUser),
    );
    expectTypeOf(data.maybe).toEqualTypeOf<User | null>();
    expectTypeOf(data.renamed).toEqualTypeOf<User>();
    expectTypeOf(data.gone).toEqualTypeOf<User>();
  });

  test("merge, append and prepend combine the results", async () => {
    const first = createBatch().insert("user", userChangeset);
    const merged = first.merge(({ user }) => createBatch().put("id", user.id));
    expectTypeOf((await repo.transactionOrThrow(merged)).id).toEqualTypeOf<number>();
    const appended = first.append(createBatch().put("flag", true));
    expectTypeOf(await repo.transactionOrThrow(appended)).toEqualTypeOf<{ user: User; flag: boolean }>();
    const prepended = first.prepend(createBatch().put("flag", true));
    expectTypeOf(await repo.transactionOrThrow(prepended)).toEqualTypeOf<{ flag: boolean; user: User }>();
  });

  test("a query step with named parameters takes them, typed, before its options", () => {
    const adults = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));
    createBatch().all("adults", adults, { minAge: 18 });
    createBatch().all("adults", adults, { minAge: 18 }, { timeoutMs: 100 });
    // @ts-expect-error the named parameter is required
    createBatch().all("adults", adults);
    // @ts-expect-error and typed
    createBatch().all("adults", adults, { minAge: "18" });
    createBatch().all("users", from(User, "u"), { timeoutMs: 100 });
  });
});

describe("failures", () => {
  test("are a union over the steps that can fail, narrowed by step", async () => {
    const batch = createBatch()
      .insert("user", userChangeset)
      .put("source", "form")
      .insert("profile", ({ user }) => change(Profile, { userId: user.id }))
      .run("quota", async () => (Math.random() > 0.5 ? success(1) : failure({ full: true as const })));
    const result = await repo.transaction(batch);
    if (!result.success) {
      expectTypeOf(result.error.step).toEqualTypeOf<"user" | "profile" | "quota">();
      switch (result.error.step) {
        case "user":
          expectTypeOf(result.error.error).toEqualTypeOf<Changeset<typeof User, true>>();
          expectTypeOf(result.error.completed).toEqualTypeOf<Record<never, never>>();
          break;
        case "profile":
          expectTypeOf(result.error.error).toEqualTypeOf<Changeset<typeof Profile, true>>();
          expectTypeOf(result.error.completed).toEqualTypeOf<{ user: User; source: string }>();
          break;
        case "quota":
          expectTypeOf(result.error.error).toEqualTypeOf<{ full: true }>();
          expectTypeOf(result.error.completed).toEqualTypeOf<{
            user: User;
            source: string;
            profile: Profile;
          }>();
          break;
      }
    }
  });

  test("of an appended batch include the results before it in completed", async () => {
    const appended = createBatch()
      .put("a", 1)
      .append(createBatch().run("b", () => failure("no")));
    const result = await repo.transaction(appended);
    if (!result.success) {
      expectTypeOf(result.error).toEqualTypeOf<BatchFailure<"b", string, { a: number }>>();
    }
  });

  test("a batch with no step that can fail never fails", async () => {
    const result = await repo.transaction(createBatch().put("a", 1));
    expectTypeOf(result).toEqualTypeOf<Result<{ a: number }, never>>();
    // A run step that only ever returns success(…) cannot fail either.
    const ran = await repo.transaction(
      createBatch()
        .put("a", 1)
        .run("r", async () => success(1)),
    );
    if (!ran.success) expectTypeOf(ran.error).toBeNever();
    expectTypeOf(ran).toEqualTypeOf<Result<{ a: number; r: number }, never>>();
  });
});

describe("what does not compile", () => {
  test("a step name already used", () => {
    const batch = createBatch().insert("user", userChangeset);
    // @ts-expect-error "user" is already a step
    batch.put("user", 1);
    // @ts-expect-error also for a write step
    batch.insert("user", userChangeset);
    batch.put("other", 1);
  });

  test("a function step that reads a result no earlier step gives", () => {
    // @ts-expect-error there is no step "profile" before this one
    createBatch().insert("user", ({ profile }) => change(User, { email: String(profile) }));
  });

  test("a run step that does not return a Result", () => {
    // @ts-expect-error run must return success(data) or failure(error)
    createBatch().run("plain", async () => 42);
  });

  test("a batch value is not a callback, and Batch has no public constructor", () => {
    const batch: Batch = createBatch();
    expectTypeOf(batch).not.toBeAny();
    // @ts-expect-error the constructor is private: use createBatch()
    new (createBatch().constructor as typeof Batch)([], new Set());
  });
});
