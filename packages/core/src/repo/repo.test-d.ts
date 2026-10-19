// Type tests for the repo's reads: the result type of every method, the argument forms
// (named parameters required exactly when the query has some), id typing for scalar and
// composite keys, and the calls that must not compile.
import { Membership, Post, Profile, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import type { DatabaseAdapter } from "../adapter/adapter.js";
import type { PlanCacheStats } from "../compiler/index.js";
import type { PoolEvent } from "../contracts/adapter.js";
import type { Loaded } from "../contracts/schema.js";
import { from } from "../query/builder.js";
import { count, fragment, param } from "../query/functions.js";
import { Schema, t } from "../schema/index.js";
import type { RepoOperation, RepoQueryEvent } from "./options.js";
import type { RawRows } from "./read.js";
import { createRepo, type Repo, type SqlAndParams } from "./repo.js";

declare const adapter: DatabaseAdapter;
declare const repo: Repo;
declare const user: User;

const adults = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));
const emails = from(User, "u").select(({ u }) => ({ id: u.id, email: u.email }));

describe("createRepo", () => {
  test("takes an adapter and returns a Repo", () => {
    expectTypeOf(createRepo({ adapter })).toEqualTypeOf<Repo>();
    createRepo({ adapter, schema: "tenant_1", log: true, codegen: false, warnOnRootUseInTransaction: true });
    createRepo({ adapter, log: { params: true } });
    createRepo({ adapter, log: (event) => expectTypeOf(event).toEqualTypeOf<RepoQueryEvent>() });
    createRepo({ adapter, schema: process.env.SCHEMA });
  });

  test("refuses a missing adapter and wrong options", () => {
    // @ts-expect-error the adapter is required
    createRepo({});
    // @ts-expect-error log takes { params: true }, not false
    createRepo({ adapter, log: { params: false } });
    // @ts-expect-error there is no prefix option: it is schema
    createRepo({ adapter, prefix: "x" });
  });
});

describe("result types", () => {
  test("all, one, oneOrThrow and first", async () => {
    expectTypeOf(await repo.all(User)).toEqualTypeOf<User[]>();
    expectTypeOf(await repo.all(emails)).toEqualTypeOf<{ id: number; email: string }[]>();
    expectTypeOf(await repo.one(User)).toEqualTypeOf<User | null>();
    expectTypeOf(await repo.oneOrThrow(emails)).toEqualTypeOf<{ id: number; email: string }>();
    expectTypeOf(await repo.first(from(Post, "p"))).toEqualTypeOf<Post | null>();
    expectTypeOf(await repo.all(from(Post, "p").select(({ p }) => p.title))).toEqualTypeOf<string[]>();
    expectTypeOf(await repo.all(User)).not.toBeAny();
  });

  test("a query that preloads returns loaded rows", async () => {
    const loaded = await repo.all(from(User, "u").preload("posts"));
    expectTypeOf(loaded).toEqualTypeOf<Loaded<typeof User, "posts">[]>();
    expectTypeOf(loaded[0]?.posts).toEqualTypeOf<Post[] | undefined>();
  });

  test("a right join makes the root's rows nullable", async () => {
    const rows = await repo.all(from(Profile, "pr").rightJoin(User, "u", ({ pr, u }) => pr.userId.eq(u.id)));
    expectTypeOf(rows).toEqualTypeOf<(Profile | null)[]>();
  });

  test("exists, count, aggregate", async () => {
    expectTypeOf(await repo.exists(User)).toEqualTypeOf<boolean>();
    expectTypeOf(await repo.count(from(Post, "p"))).toEqualTypeOf<number>();
    expectTypeOf(await repo.aggregate(Post, "count")).toEqualTypeOf<number>();
    expectTypeOf(await repo.aggregate(Post, "count", "views")).toEqualTypeOf<number>();
    expectTypeOf(await repo.aggregate(Post, "sum", "views")).toEqualTypeOf<number | null>();
    expectTypeOf(await repo.aggregate(Post, "avg", "views")).toEqualTypeOf<number | null>();
    expectTypeOf(await repo.aggregate(Post, "max", "createdAt")).toEqualTypeOf<Date | null>();
    expectTypeOf(await repo.aggregate(Post, "min", "publishedAt")).toEqualTypeOf<Date | null>();
    expectTypeOf(await repo.aggregate(from(Post, "p"), "max", "title")).toEqualTypeOf<string | null>();
  });

  test("stream, reload, toSql, explain, raw", async () => {
    expectTypeOf(repo.stream(User)).toEqualTypeOf<AsyncIterable<User>>();
    expectTypeOf(repo.stream(emails, { batchSize: 100 })).toEqualTypeOf<
      AsyncIterable<{ id: number; email: string }>
    >();
    expectTypeOf(await repo.reload(user)).toEqualTypeOf<User | null>();
    expectTypeOf(await repo.reload([user])).toEqualTypeOf<(User | null)[]>();
    expectTypeOf(await repo.reloadOrThrow(user)).toEqualTypeOf<User>();
    expectTypeOf(await repo.reloadOrThrow([user])).toEqualTypeOf<User[]>();
    expectTypeOf(repo.toSql(User)).toEqualTypeOf<SqlAndParams>();
    expectTypeOf(await repo.explain(User)).toEqualTypeOf<string>();
    expectTypeOf(await repo.explain(User, { analyze: true })).toEqualTypeOf<string>();
    expectTypeOf(await repo.explain(User, { format: "json" })).toEqualTypeOf<unknown>();
    expectTypeOf(await repo.raw(fragment`select 1`)).toEqualTypeOf<RawRows>();
  });

  test("health and events", () => {
    expectTypeOf(repo.ping()).toEqualTypeOf<Promise<void>>();
    expectTypeOf(repo.poolStats()).toEqualTypeOf<PoolEvent>();
    expectTypeOf(repo.planCacheStats()).toEqualTypeOf<PlanCacheStats>();
    repo.on("query", (event) => {
      expectTypeOf(event.operation).toEqualTypeOf<RepoOperation>();
      expectTypeOf(event.decodeMs).toEqualTypeOf<number>();
      expectTypeOf(event.context).toEqualTypeOf<Readonly<Record<string, unknown>> | undefined>();
    });
    repo.on("poolExhausted", (event) => expectTypeOf(event).toEqualTypeOf<PoolEvent>());
    // @ts-expect-error there is no such event
    repo.on("connected", () => undefined);
  });
});

describe("named parameters and options", () => {
  test("params are required exactly when the query has some", async () => {
    await repo.all(adults, { minAge: 18 });
    await repo.all(adults, { minAge: 18 }, { timeoutMs: 500 });
    await repo.all(User, {
      timeoutMs: 500,
      signal: new AbortController().signal,
      context: { requestId: "r" },
    });
    await repo.one(adults, { minAge: 1 });
    await repo.count(adults, { minAge: 1 });
    await repo.exists(adults, { minAge: 1 });
    await repo.aggregate(adults, "max", "age", { minAge: 1 });
    await repo.aggregate(adults, "count", { minAge: 1 });
    await repo.getBy(adults, { role: "admin" }, { minAge: 1 });
    repo.stream(adults, { minAge: 1 }, { batchSize: 10 });
    repo.toSql(adults, { minAge: 1 });
    await repo.explain(adults, { minAge: 1 }, { format: "json" });
    await repo.raw(fragment`select ${param("n", t.integer())}`, { n: 1 });
  });

  test("a query with params cannot run without them, nor with the wrong ones", async () => {
    // @ts-expect-error minAge is required
    await repo.all(adults);
    // @ts-expect-error minAge is a number
    await repo.all(adults, { minAge: "18" });
    // @ts-expect-error options come third: { timeoutMs } is not the params
    await repo.all(adults, { timeoutMs: 5 });
    // @ts-expect-error a fragment's named parameter is required too
    await repo.raw(fragment`select ${param("n", t.integer())}`);
  });

  test("a query without params takes only options", async () => {
    // @ts-expect-error User takes no named parameters
    await repo.all(User, { minAge: 18 });
    // @ts-expect-error unknown option
    await repo.all(User, { timeout: 5 });
    // @ts-expect-error the stream's batchSize is not an option of all
    await repo.all(User, { batchSize: 5 });
    // @ts-expect-error toSql takes only the schema option
    repo.toSql(User, { timeoutMs: 5 });
  });

  test("a query whose params clash cannot run", async () => {
    const clashing = from(User, "u")
      .where(({ u }) => u.age.gte(param("n", t.integer())))
      .where(({ u }) => u.email.eq(param("n", t.string())));
    // @ts-expect-error no value is a never parameter
    await repo.all(clashing, { n: 1 });
  });
});

describe("get and getBy", () => {
  test("the id has the key's type: a scalar, or an object for a composite key", async () => {
    expectTypeOf(await repo.get(User, 1)).toEqualTypeOf<User | null>();
    expectTypeOf(await repo.getOrThrow(User, 1, { timeoutMs: 1 })).toEqualTypeOf<User>();
    expectTypeOf(await repo.get(Membership, { orgId: "o", userId: 1 })).toEqualTypeOf<Membership | null>();
    // @ts-expect-error the key of User is a number
    await repo.get(User, "1");
    // @ts-expect-error a composite key is an object of its fields
    await repo.get(Membership, "o");
    // @ts-expect-error every field of the key is needed
    await repo.get(Membership, { orgId: "o" });
    // @ts-expect-error null is not an id
    await repo.get(User, null);
    // @ts-expect-error get takes a schema class, not a query
    await repo.get(from(User, "u"), 1);
  });

  test("a schema without a primary key has no id to get by", async () => {
    class Note extends Schema("notes", { body: t.string() }, { primaryKey: false }) {}
    // @ts-expect-error there is no primary key
    await repo.get(Note, "x");
  });

  test("getBy takes the object form of where on the root binding", async () => {
    expectTypeOf(await repo.getBy(User, { email: "a@b.c" })).toEqualTypeOf<User | null>();
    expectTypeOf(await repo.getByOrThrow(emails, { role: "admin" })).toEqualTypeOf<{
      id: number;
      email: string;
    }>();
    await repo.getBy(User, { age: null });
    // @ts-expect-error User has no field nope
    await repo.getBy(User, { nope: 1 });
    // @ts-expect-error email is a string
    await repo.getBy(User, { email: 1 });
  });
});

describe("aggregate", () => {
  test("refuses what it cannot compute", async () => {
    // @ts-expect-error sum needs a field
    await repo.aggregate(Post, "sum");
    // @ts-expect-error Post has no field nope
    await repo.aggregate(Post, "max", "nope");
    // @ts-expect-error password is virtual: it has no column
    await repo.aggregate(User, "count", "password");
    // @ts-expect-error published is a boolean: it has no sum
    await repo.aggregate(Post, "sum", "published");
    // @ts-expect-error there is no median
    await repo.aggregate(Post, "median", "views");
  });

  test("count in a select is still a select", async () => {
    const rows = await repo.all(from(Post, "p").select(() => ({ n: count() })));
    expectTypeOf(rows).toEqualTypeOf<{ n: number }[]>();
  });
});

describe("raw", () => {
  test("takes a fragment, never a string", async () => {
    await repo.raw(fragment`select now() as now`, { timeoutMs: 100 });
    // @ts-expect-error a string would be SQL text: only a fragment
    await repo.raw("select 1");
  });
});
