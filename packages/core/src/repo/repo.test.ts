// Unit tests for the repo's reads, over the real compiler and a fake driver that returns
// canned rows: no database. What the rows look like is checked against real Postgres by
// the read conformance suite; these tests check the pipeline, the derived queries, the
// argument forms, the options, the errors and the telemetry.
import { Membership, Post, Profile, User, UserSettings } from "@egon-orm/test-support";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createAdapter, type DatabaseAdapter } from "../adapter/adapter.js";
import type { DriverConnection, DriverCursor, DriverHooks, DriverWrapper } from "../adapter/driver.js";
import { POSTGRES_CAPABILITIES } from "../compiler/index.js";
import type {
  Capabilities,
  ExecuteOptions,
  PoolEvent,
  RawResult,
  StreamOptions,
} from "../contracts/adapter.js";
import type { QueryAst } from "../contracts/query.js";
import { ROW } from "../contracts/schema.js";
import { CastError, DatabaseError, MultipleResultsError, NoResultsError, QueryError } from "../errors.js";
import { count, exists, fragment, from, meta, param, Schema, sum, t, val } from "../index.js";
import type { RepoQueryEvent } from "./options.js";
import { createRepo, type Repo } from "./repo.js";

// --- a driver without a database ---------------------------------------------------

type Responder = (sql: string, params: readonly unknown[]) => readonly Record<string, unknown>[] | Error;

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

class FakeCursor implements DriverCursor {
  closed = false;
  #position = 0;
  constructor(private readonly rows: readonly Record<string, unknown>[]) {}
  async read(count: number): Promise<readonly Record<string, unknown>[]> {
    const batch = this.rows.slice(this.#position, this.#position + count);
    this.#position += batch.length;
    return batch;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeDriver implements DriverWrapper {
  readonly statements: Statement[] = [];
  readonly cursors: FakeCursor[] = [];
  hooks: DriverHooks | undefined;
  respond: Responder = () => [];

  init(): void {}
  async acquire(): Promise<DriverConnection> {
    this.hooks?.connected();
    const driver = this;
    return {
      async query(sql, params): Promise<RawResult> {
        driver.statements.push({ sql, params });
        const rows = driver.respond(sql, params);
        if (rows instanceof Error) throw rows;
        return { rows, rowCount: rows.length, insertId: undefined };
      },
      async cursor(sql, params): Promise<DriverCursor> {
        driver.statements.push({ sql, params });
        const rows = driver.respond(sql, params);
        if (rows instanceof Error) throw rows;
        const cursor = new FakeCursor(rows);
        driver.cursors.push(cursor);
        return cursor;
      },
      async cancel(): Promise<void> {},
      inTransaction: () => false,
    };
  }
  async release(): Promise<void> {}
  async destroy(): Promise<void> {}
  stats(): PoolEvent {
    return { size: 1, idle: 1, waiting: 0 };
  }
  saturated(): boolean {
    return false;
  }
}

function setup(
  respond?: Responder,
  capabilities: Capabilities = POSTGRES_CAPABILITIES,
): { adapter: DatabaseAdapter; driver: FakeDriver } {
  const driver = new FakeDriver();
  if (respond !== undefined) driver.respond = respond;
  const adapter = createAdapter({
    dialect: "postgres",
    capabilities,
    quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
    driver: (hooks) => {
      driver.hooks = hooks;
      return driver;
    },
    driverCodecs: { bigint: { fromDb: (value) => BigInt(value as string) } },
    normalizeError: (error) => error,
  });
  return { adapter, driver };
}

/** A repo over a fake driver answering `respond`, with the statements it was sent. */
function fake(respond?: Responder, options: Omit<Parameters<typeof createRepo>[0], "adapter"> = {}) {
  const { adapter, driver } = setup(respond);
  const repo = createRepo({ adapter, ...options });
  return { repo, adapter, driver, statements: driver.statements };
}

/** The repo as JavaScript sees it: any arguments, for the calls its types refuse. */
type Untyped = Readonly<
  Record<
    "all" | "getBy" | "exists" | "count" | "aggregate" | "raw",
    (...args: readonly unknown[]) => Promise<unknown>
  >
>;
const untyped = (repo: Repo): Untyped => repo as unknown as Untyped;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const ADA = {
  c0: "1",
  c1: "ada@example.com",
  c2: "Ada",
  c3: 36,
  c4: "admin",
  c5: null,
  c6: null,
  c7: 1,
  c8: new Date("2026-01-01T00:00:00.000Z"),
  c9: new Date("2026-01-01T00:00:00.000Z"),
};
const GRACE = { ...ADA, c0: "2", c1: "grace@example.com", c2: null };

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("createRepo", () => {
  test("checks its options", () => {
    const { adapter } = setup();
    expect(() => createRepo(undefined as never)).toThrow(TypeError);
    expect(() => createRepo([] as never)).toThrow(TypeError);
    expect(() => createRepo({ adapter, prefix: "x" } as never)).toThrow(/unknown option "prefix"/);
    expect(() => createRepo({ adapter: {} as never })).toThrow(/database adapter/);
    expect(() => createRepo({ adapter: null as never })).toThrow(/database adapter/);
    expect(() => createRepo({ adapter, schema: "" })).toThrow(/schema/);
    expect(() => createRepo({ adapter, schema: 5 as never })).toThrow(/number 5/);
    expect(() => createRepo({ adapter, codegen: "yes" as never })).toThrow(/codegen/);
    expect(() => createRepo({ adapter, warnOnRootUseInTransaction: 1 as never })).toThrow(
      /warnOnRootUseInTransaction/,
    );
    expect(() => createRepo({ adapter, log: { params: false } as never })).toThrow(/log/);
    expect(() => createRepo({ adapter, log: { params: true, extra: 1 } as never })).toThrow(/log/);
    expect(() => createRepo({ adapter, log: "verbose" as never })).toThrow(/log/);
    expect(() => createRepo({ adapter, log: null as never })).toThrow(/log must be/);
    // undefined counts as left out
    expect(() =>
      createRepo({
        adapter,
        schema: undefined,
        log: undefined,
        codegen: undefined,
        warnOnRootUseInTransaction: undefined,
      }),
    ).not.toThrow();
    expect(() =>
      createRepo({ adapter, log: false, codegen: false, warnOnRootUseInTransaction: true }),
    ).not.toThrow();
  });

  test("connects nothing until the first query", () => {
    const { adapter } = setup();
    createRepo({ adapter });
    expect(adapter.poolStats()).toEqual({ size: 0, idle: 0, waiting: 0 });
  });
});

describe("all", () => {
  test("decodes the rows of a schema class into instances, in a fresh array", async () => {
    const rows = [ADA, GRACE];
    const { repo, statements } = fake(() => rows);
    const users = await repo.all(User);
    expect(users).toHaveLength(2);
    expect(users[0]).toBeInstanceOf(User);
    expect(users[0]?.id).toBe(1);
    expect(users[1]?.displayName).toBe("grace@example.com");
    expect((users[0] as unknown as { [ROW]: unknown })[ROW]).toEqual({
      state: "loaded",
      source: "users",
      schema: undefined,
    });
    expect(users).not.toBe(rows);
    expect(statements[0]?.sql).toBe(
      'select "users"."id" as "c0", "users"."email" as "c1", "users"."name" as "c2", "users"."age" as "c3", "users"."role" as "c4", "users"."password_hash" as "c5", "users"."settings" as "c6", "users"."lock_version" as "c7", "users"."created_at" as "c8", "users"."updated_at" as "c9" from "users" as "users"',
    );
  });

  test("a tuple select", async () => {
    const { repo } = fake(() => [{ c0: "1", c1: "a@b.c" }]);
    expect(await repo.all(from(User, "u").select(({ u }) => [u.id, u.email]))).toEqual([[1, "a@b.c"]]);
  });

  test("returns what the query selects, its constants included", async () => {
    const { repo } = fake(() => [{ c0: "1", c1: "a@b.c" }]);
    const rows = await repo.all(
      from(User, "u").select(({ u }) => ({ id: u.id, email: u.email, kind: "user" })),
    );
    expect(rows).toEqual([{ id: 1, email: "a@b.c", kind: "user" }]);
  });

  test("binds values, and named parameters given second", async () => {
    const { repo, statements } = fake(() => []);
    const adults = from(User, "u").where(({ u }) =>
      u.age.gte(param("minAge", t.integer())).and(u.role.eq("admin")),
    );
    await repo.all(adults, { minAge: 18 });
    await repo.all(adults, { minAge: 21 }, { timeoutMs: 1_000 });
    expect(statements.map((each) => each.params)).toEqual([
      [18, "admin"],
      [21, "admin"],
    ]);
    await expect(repo.all(adults, {} as never)).rejects.toThrow(/"minAge"/);
    await expect(repo.all(adults, { minAge: 1, extra: 2 } as never)).rejects.toThrow(/"extra"/);
  });

  test("refuses arguments that do not fit the query", async () => {
    const { repo } = fake();
    const adults = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));
    await expect(repo.all(adults, 18 as never)).rejects.toThrow(/named parameter "minAge"/);
    await expect(repo.all(adults, null as never)).rejects.toThrow(TypeError);
    await expect(repo.all(adults, [18] as never)).rejects.toThrow(TypeError);
    await expect(untyped(repo).all(adults, { minAge: 1 }, {}, {} as never)).rejects.toThrow(/3 arguments/);
    await expect(untyped(repo).all(User, {}, {} as never)).rejects.toThrow(/no named parameters/);
    await expect(repo.all(User, { minAge: 18 } as never)).rejects.toThrow(/unknown option "minAge"/);
    await expect(repo.all(User, "fast" as never)).rejects.toThrow(/options must be an object/);
    await expect(repo.all(User, { context: "x" } as never)).rejects.toThrow(/context option/);
    await expect(repo.all(User, { context: [] } as never)).rejects.toThrow(/context option/);
    await expect(repo.all(User, { schema: "" })).rejects.toThrow(/schema/);
    await expect(untyped(repo).all({} as never)).rejects.toThrow(/schema class or a query/);
    await expect(untyped(repo).all("users" as never)).rejects.toThrow(TypeError);
    await expect(untyped(repo).all({ ast: { kind: "other" } } as never)).rejects.toThrow(TypeError);
  });

  test("refuses an embedded schema", async () => {
    const { repo } = fake();
    await expect(untyped(repo).all(UserSettings as never)).rejects.toThrow(/embedded schema/);
  });

  test("passes the slots, the signal and the time budget to the adapter", async () => {
    const { repo, adapter } = fake();
    const execute = vi.spyOn(adapter, "execute");
    await repo.all(User);
    await repo.all(User);
    const [first, second] = execute.mock.calls.map((call) => call[2] as ExecuteOptions);
    // No options and nobody listening: one options object per plan, reused.
    expect(first).toBe(second);
    expect(first?.slots).toEqual([]);
    expect(first?.context).toBeUndefined();
    const controller = new AbortController();
    await repo.all(User, { timeoutMs: 5_000, signal: controller.signal });
    const third = execute.mock.calls[2]?.[2] as ExecuteOptions;
    expect(third).toMatchObject({ timeoutMs: 5_000, signal: controller.signal });
  });

  test("a driver error passes through", async () => {
    const failure = new Error("boom");
    const { repo } = fake(() => failure);
    expect(await rejection(repo.all(User))).toBe(failure);
  });

  test("a value that cannot be decoded is an error", async () => {
    // Beyond Number.MAX_SAFE_INTEGER: bigint({ mode: "number" }) refuses it.
    const { repo } = fake(() => [{ ...ADA, c0: "9007199254740993" }]);
    expect(await rejection(repo.all(User))).toBeInstanceOf(CastError);
  });

  test("codegen off gives the same rows", async () => {
    const generated = fake(() => [{ ...ADA, c10: "1" }]);
    const interpreted = fake(() => [{ ...ADA, c10: "1" }], { codegen: false });
    const q = from(User, "u").select(({ u }) => ({ user: u, id: u.id }));
    expect(await interpreted.repo.all(q)).toStrictEqual(await generated.repo.all(q));
  });

  test("a query with preloads cannot run yet", async () => {
    const { repo } = fake(() => [ADA]);
    await expect(repo.all(from(User, "u").preload("posts"))).rejects.toThrow(/preloads associations/);
    await expect(repo.first(from(User, "u").preload("posts"))).rejects.toThrow(/preloads associations/);
  });

  test("a table whose name starts with $ is read under another alias", async () => {
    class Odd extends Schema("$odd", { id: t.integer().primaryKey() }) {}
    const { repo, statements } = fake(() => [{ c0: 1 }]);
    expect(await repo.all(Odd)).toHaveLength(1);
    expect(statements[0]?.sql).toBe('select "t"."id" as "c0" from "$odd" as "t"');
  });

  test("a query whose root is not a table reports no source", async () => {
    const { repo } = fake(() => [{ c0: 1 }]);
    const events: RepoQueryEvent[] = [];
    repo.on("query", (event) => events.push(event));
    const inner = from(User, "u").select(({ u }) => ({ id: u.id })).ast;
    const outer: QueryAst = {
      ...inner,
      from: { kind: "subquerySource", query: inner, alias: "x" },
      select: {
        kind: "select",
        shape: {
          kind: "expr",
          expr: { kind: "column", binding: "x", field: "id", column: "id" },
          type: undefined,
        },
        constants: [],
      },
    };
    expect(await untyped(repo).all({ ast: outer } as never)).toEqual([1]);
    expect(events[0]?.source).toBeUndefined();
  });
});

describe("database schemas", () => {
  test("the repo default is the weakest, then the call's, then the query's own", async () => {
    const { repo, statements } = fake(() => [], { schema: "tenant_1" });
    await repo.all(User);
    await repo.all(User, { schema: "tenant_2" });
    await repo.all(from(User, "u").schema("tenant_3"), { schema: "tenant_2" });
    const tables = statements.map((each) => /from ("[^"]+"\.)?"users"/.exec(each.sql)?.[1]);
    expect(tables).toEqual(['"tenant_1".', '"tenant_2".', '"tenant_3".']);
  });

  test("a schema class's declared schema wins over all of them", async () => {
    class Audit extends Schema("audits", { id: t.integer().primaryKey() }, { schema: "audit" }) {}
    const { repo, statements } = fake(() => [{ c0: 1 }], { schema: "tenant_1" });
    const [row] = await repo.all(Audit, { schema: "tenant_2" });
    expect(statements[0]?.sql).toContain('from "audit"."audits"');
    expect((row as unknown as { [ROW]: unknown })[ROW]).toEqual({
      state: "loaded",
      source: "audits",
      schema: "audit",
    });
  });

  test("rows are stamped with the schema they were read from", async () => {
    const { repo } = fake(() => [ADA], { schema: "tenant_1" });
    const [user] = await repo.all(User);
    expect((user as unknown as { [ROW]: { schema: unknown } })[ROW].schema).toBe("tenant_1");
  });
});

describe("one, oneOrThrow, first", () => {
  test("one: null, the row, or MultipleResultsError with the query's rendering", async () => {
    let rows: Record<string, unknown>[] = [];
    const { repo } = fake(() => rows);
    const q = from(User, "u").where({ role: "member" });
    expect(await repo.one(q)).toBeNull();
    rows = [ADA];
    expect((await repo.one(q))?.id).toBe(1);
    rows = [ADA, GRACE];
    const error = await rejection(repo.one(q));
    expect(error).toBeInstanceOf(MultipleResultsError);
    expect((error as MultipleResultsError).count).toBe(2);
    expect((error as MultipleResultsError).query).toBe("from users as u where u.role = ?");
  });

  test("oneOrThrow", async () => {
    let rows: Record<string, unknown>[] = [];
    const { repo } = fake(() => rows);
    const error = await rejection(repo.oneOrThrow(User));
    expect(error).toBeInstanceOf(NoResultsError);
    expect((error as NoResultsError).query).toBe("from users as users");
    rows = [ADA];
    expect((await repo.oneOrThrow(User)).email).toBe("ada@example.com");
    rows = [ADA, GRACE];
    expect(await rejection(repo.oneOrThrow(User))).toBeInstanceOf(MultipleResultsError);
  });

  test("first adds a limit of 1 and never throws for extra rows", async () => {
    let rows: Record<string, unknown>[] = [ADA, GRACE];
    const { repo, statements } = fake(() => rows);
    const q = from(User, "u").orderBy(({ u }) => u.id);
    expect((await repo.first(q))?.id).toBe(1);
    expect(statements[0]?.sql).toMatch(/order by "u"\."id" asc limit \$1$/);
    expect(statements[0]?.params).toEqual([1]);
    rows = [];
    expect(await repo.first(q)).toBeNull();
    // The derived query is made once per query.
    expect(statements[1]?.sql).toBe(statements[0]?.sql);
  });

  test("first keeps a smaller limit of the query's own, and its offset", async () => {
    const { repo, statements } = fake(() => []);
    const q = from(User, "u")
      .orderBy(({ u }) => u.id)
      .limit(10)
      .offset(5);
    await repo.first(q);
    expect(statements[0]?.sql).toMatch(
      /order by "u"\."id" asc limit case when cast\(\$1 as bigint\) < 1 then cast\(\$2 as bigint\) else 1 end offset \$3$/,
    );
    expect(statements[0]?.params).toEqual([10, 10, 5]);
    const paged = from(User, "u").limit(param("size", t.integer()));
    await repo.first(paged, { size: 0 });
    expect(statements[1]?.params).toEqual([0, 0]);
  });
});

describe("get and getBy", () => {
  test("get filters on the primary key", async () => {
    const { repo, statements } = fake(() => [ADA]);
    expect((await repo.get(User, 1))?.email).toBe("ada@example.com");
    expect(statements[0]?.sql).toMatch(/where "users"\."id" = \$1$/);
    expect(statements[0]?.params).toEqual([1]);
    expect((await repo.getOrThrow(User, 1)).id).toBe(1);
  });

  test("get by a composite key", async () => {
    const orgId = "0190d8a0-0000-7000-8000-00000000000a";
    const { repo, statements } = fake(() => [{ c0: orgId, c1: "2", c2: "member" }]);
    const membership = await repo.get(Membership, { userId: 2, orgId });
    expect(membership).toBeInstanceOf(Membership);
    expect(statements[0]?.params).toEqual([orgId, 2]);
  });

  test("get refuses an array as the value of a key field that is not an array", async () => {
    const { repo, statements } = fake(() => [ADA]);
    await expect(repo.get(User, [1, 2] as never)).rejects.toThrow(
      /"id" holds one value, but it was given an array/,
    );
    await expect(repo.get(Membership, { orgId: ["a", "b"], userId: 1 } as never)).rejects.toThrow(/"orgId"/);
    expect(statements).toEqual([]);
    class Tagged extends Schema("tagged", { path: t.array(t.string()).primaryKey(), note: t.string() }) {}
    const { repo: arrays, statements: sent } = fake(() => []);
    await arrays.get(Tagged, ["a", "b"]);
    expect(sent[0]?.params).toEqual([["a", "b"]]);
  });

  test("get refuses ids that cannot be right", async () => {
    const { repo, statements } = fake(() => []);
    await expect(repo.get(User, undefined as never)).rejects.toThrow(/the id is undefined/);
    await expect(repo.get(User, null as never)).rejects.toThrow(/the id is null/);
    await expect(repo.get(User, { id: 1 } as never)).rejects.toThrow(/single field "id"/);
    await expect(repo.get(Membership, "x" as never)).rejects.toThrow(/composite primary key/);
    await expect(repo.get(Membership, { orgId: "o" } as never)).rejects.toThrow(/"userId"/);
    await expect(repo.get(Membership, { orgId: "o", userId: null } as never)).rejects.toThrow(/"userId"/);
    await expect(repo.get(Membership, { orgId: "o", userId: 1, role: "x" } as never)).rejects.toThrow(
      /"role" is not a field/,
    );
    class Keyless extends Schema("keyless", { body: t.string() }, { primaryKey: false }) {}
    await expect(repo.get(Keyless, 1 as never)).rejects.toThrow(/no primary key/);
    await expect(repo.get("users" as never, 1 as never)).rejects.toThrow(TypeError);
    await expect(repo.getOrThrow(User, 1, { bogus: 1 } as never)).rejects.toThrow(/unknown option/);
    expect(statements).toEqual([]);
  });

  test("getOrThrow throws NoResultsError for a missing row", async () => {
    const { repo } = fake(() => []);
    expect(await rejection(repo.getOrThrow(User, 9))).toBeInstanceOf(NoResultsError);
  });

  test("getBy adds the clauses to the query and is strict", async () => {
    let rows: Record<string, unknown>[] = [ADA];
    const { repo, statements } = fake(() => rows);
    expect((await repo.getBy(User, { email: "ada@example.com" }))?.id).toBe(1);
    expect(statements[0]?.sql).toMatch(/where "users"\."email" = \$1$/);
    const adults = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));
    expect((await repo.getBy(adults, { role: "admin" }, { minAge: 18 }))?.id).toBe(1);
    expect(statements[1]?.params).toEqual([18, "admin"]);
    rows = [ADA, GRACE];
    expect(await rejection(repo.getBy(User, { role: "member" }))).toBeInstanceOf(MultipleResultsError);
    rows = [];
    expect(await repo.getBy(User, { role: "member" })).toBeNull();
    expect(await rejection(repo.getByOrThrow(User, { role: "member" }))).toBeInstanceOf(NoResultsError);
    rows = [ADA];
    expect((await repo.getByOrThrow(User, { role: "admin" })).id).toBe(1);
  });

  test("getBy refuses clauses that are not an object, and a query without where()", async () => {
    const { repo } = fake();
    await expect(repo.getBy(User, "x" as never)).rejects.toThrow(/object of field values/);
    await expect(repo.getBy(User, null as never)).rejects.toThrow(/object of field values/);
    const bare = { ast: from(User, "u").ast } as never;
    await expect(untyped(repo).getBy(bare, {} as never)).rejects.toThrow(/no where\(\) method/);
  });
});

describe("exists", () => {
  test("runs SELECT 1 … LIMIT 1 without select, order, distinct and preloads", async () => {
    let rows: Record<string, unknown>[] = [{ c0: 1 }];
    const { repo, statements } = fake(() => rows);
    const q = from(User, "u")
      .distinct()
      .where({ role: "admin" })
      .orderBy(({ u }) => u.email)
      .select(({ u }) => u.email);
    expect(await repo.exists(q)).toBe(true);
    expect(statements[0]?.sql).toBe('select 1 as "c0" from "users" as "u" where "u"."role" = $1 limit $2');
    expect(statements[0]?.params).toEqual(["admin", 1]);
    rows = [];
    expect(await repo.exists(User)).toBe(false);
  });

  test("distinct with an offset, and a select that aggregates by itself, are wrapped", async () => {
    const { repo, statements } = fake(() => []);
    const wrapped = /^select 1 as "c0" from \(select .*\) as "s" limit \$\d+$/;
    await repo.exists(from(User, "u").distinct().offset(3));
    await repo.exists(
      from(User, "u")
        .distinct(({ u }) => [u.role])
        .offset(1),
    );
    await repo.exists(from(User, "u").select(() => ({ n: count() })));
    await repo.exists(from(User, "u").select(() => fragment`count(*)`));
    await repo.exists(from(User, "u").select(({ u }) => [u.id, count()]));
    await repo.exists(from(User, "u").select(() => ({ n: sum(count()).over() })));
    for (const statement of statements) expect(statement.sql).toMatch(wrapped);
    statements.length = 0;
    // Not wrapped: distinct without an offset, an offset alone, a window function, grouping.
    await repo.exists(from(User, "u").distinct());
    await repo.exists(from(User, "u").offset(3));
    await repo.exists(from(User, "u").select(({ u }) => ({ n: count().over({ partitionBy: [u.role] }) })));
    await repo.exists(
      from(User, "u")
        .groupBy(({ u }) => u.role)
        .select(({ u }) => ({ role: u.role, n: count() })),
    );
    await repo.exists(from(User, "u").select(({ u }) => [u.id, u]));
    await repo.exists(
      from(User, "u").select(({ u }) => ({
        some: u.id.in([1, 2]),
        many: exists(from(Post, "p").select(() => count())),
        authored: u.id.in(from(Post, "p").select(({ p }) => p.authorId)),
      })),
    );
    for (const statement of statements)
      expect(statement.sql).toMatch(/^select 1 as "c0" from "users" as "u"/);
  });

  test("a query with a limit or a set operation is wrapped, not given another limit", async () => {
    const { repo, statements } = fake(() => []);
    await repo.exists(from(User, "u").limit(0));
    expect(statements[0]?.sql).toMatch(
      /^select 1 as "c0" from \(select .* from "users" as "u" limit \$1\) as "s" limit \$2$/,
    );
    expect(statements[0]?.params).toEqual([0, 1]);
    const base = from(User, "u").ast;
    const union: QueryAst = {
      ...base,
      combinations: [{ kind: "combination", op: "intersect", all: false, query: from(User, "v").ast }],
    };
    await untyped(repo).exists({ ast: union } as never);
    expect(statements[1]?.sql).toMatch(/^select 1 as "c0" from \(.*intersect.*\) as "s" limit \$1$/);
  });

  test("named parameters only in dropped clauses are accepted and not bound", async () => {
    const { repo, statements } = fake(() => []);
    const q = from(User, "u")
      .where(({ u }) => u.age.gte(param("minAge", t.integer())))
      .select(({ u }) => ({ id: u.id, bonus: val(1, t.integer()).add(param("bonus", t.integer())) }));
    await repo.exists(q, { minAge: 18, bonus: 5 });
    expect(statements[0]?.params).toEqual([18, 1]);
    await expect(repo.exists(q, { minAge: 18, bonus: 5, other: 1 } as never)).rejects.toThrow(
      /no named parameter "other"; it takes "minAge", "bonus"/,
    );
    await expect(repo.exists(q, { minAge: 18, bonus: 5, other: 1, more: 2 } as never)).rejects.toThrow(
      /no named parameters "other", "more"/,
    );
    await expect(repo.exists(q, { minAge: 18 } as never)).rejects.toThrow(/"bonus"/);
    await expect(repo.exists(q, { minAge: 18, bonus: undefined } as never)).rejects.toThrow(/"bonus"/);
    await expect(repo.exists(User, { minAge: 1 } as never)).rejects.toThrow(TypeError);
  });

  test("an inherited named key is not a named parameter", async () => {
    const { repo } = fake(() => []);
    const q = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));
    const named = Object.create({ inherited: 1 }) as Record<string, unknown>;
    named.minAge = 3;
    await expect(repo.count(q, named as never)).resolves.toBeNull();
  });
});

describe("count and aggregate", () => {
  test("count drops the select, the order and the preloads", async () => {
    const { repo, statements } = fake(() => [{ c0: "3" }]);
    expect(
      await repo.count(
        from(User, "u")
          .orderBy(({ u }) => u.email)
          .select(({ u }) => u.email),
      ),
    ).toBe(3);
    expect(statements[0]?.sql).toBe('select count(*) as "c0" from "users" as "u"');
  });

  test("aggregate over a field of the root binding", async () => {
    const { repo, statements } = fake((sql) => [
      { c0: sql.includes("avg") ? 2.5 : sql.includes("max") ? new Date(0) : "7" },
    ]);
    expect(await repo.aggregate(Post, "count")).toBe(7);
    expect(await repo.aggregate(Post, "count", "views")).toBe(7);
    expect(await repo.aggregate(Post, "sum", "views")).toBe(7);
    expect(await repo.aggregate(Post, "avg", "views")).toBe(2.5);
    expect(await repo.aggregate(Post, "min", "title")).toBe("7");
    expect(await repo.aggregate(Post, "max", "createdAt")).toEqual(new Date(0));
    expect(statements.map((each) => each.sql.split(" from ")[0])).toEqual([
      'select count(*) as "c0"',
      'select count("posts"."views") as "c0"',
      'select sum("posts"."views") as "c0"',
      'select cast(avg("posts"."views") as double precision) as "c0"',
      'select min("posts"."title") as "c0"',
      'select max("posts"."created_at") as "c0"',
    ]);
  });

  test("a query with limit, offset, distinct, groupBy, having or a set operation is aggregated as a subquery", async () => {
    const { repo, statements } = fake(() => [{ c0: "1" }]);
    const q = from(Post, "p");
    await repo.count(q.limit(2));
    await repo.count(q.offset(2));
    await repo.count(q.distinct());
    await repo.count(q.groupBy(({ p }) => p.authorId).select(({ p }) => p.authorId));
    await repo.count(
      q
        .groupBy(({ p }) => p.authorId)
        .having(() => count().gt(1))
        .select(({ p }) => p.authorId),
    );
    const union: QueryAst = {
      ...q.ast,
      combinations: [{ kind: "combination", op: "union", all: true, query: from(Post, "p").ast }],
    };
    await untyped(repo).count({ ast: union } as never);
    for (const statement of statements)
      expect(statement.sql).toMatch(/^select count\(\*\) as "c0" from \(select .*\) as "s"$/);
    await repo.aggregate(q.limit(2), "sum", "views");
    expect(statements[6]?.sql).toMatch(
      /^select sum\("s"\."views"\) as "c0" from \(select .* from "posts" as "p" limit \$1\) as "s"$/,
    );
  });

  test("a wrapped aggregate over a field needs the field in the select", async () => {
    const { repo, statements } = fake(() => [{ c0: "1" }]);
    const limited = from(Post, "p").limit(5);
    await repo.aggregate(
      limited.select(({ p }) => ({ views: p.views, title: p.title })),
      "sum",
      "views",
    );
    expect(statements[0]?.sql).toMatch(/^select sum\("s"\."views"\)/);
    await repo.aggregate(
      limited.select(({ p }) => p),
      "sum",
      "views",
    );
    await expect(
      repo.aggregate(
        limited.select(({ p }) => p.title),
        "sum",
        "views",
      ),
    ).rejects.toThrow(/must select the column "views"/);
    await expect(
      repo.aggregate(
        limited.select(({ p }) => ({ title: p.title })),
        "sum",
        "views",
      ),
    ).rejects.toThrow(/must select the column "views"/);
    // A key named after the field counts only when its value is that column.
    await expect(
      repo.aggregate(
        limited.select(({ p }) => ({ views: p.id })),
        "sum",
        "views",
      ),
    ).rejects.toThrow(/must select the column "views"/);
    await expect(
      repo.aggregate(
        limited.select(() => ({ views: count() })),
        "max",
        "views",
      ),
    ).rejects.toThrow(/must select the column "views"/);
    const joined = from(Post, "p")
      .join(Post, "q", ({ p, q }) => q.id.eq(p.id))
      .limit(5);
    await expect(
      repo.aggregate(
        joined.select(({ q }) => ({ views: q.views })),
        "sum",
        "views",
      ),
    ).rejects.toThrow(/must select the column "views"/);
    await expect(
      untyped(repo).aggregate(
        limited.select(({ p }) => ({ views: { nested: p.views } })) as never,
        "sum",
        "views",
      ),
    ).rejects.toThrow(/must select the column "views"/);
  });

  test("aggregate refuses what it cannot compute", async () => {
    const { repo } = fake(() => [{ c0: "1" }]);
    await expect(repo.aggregate(Post, "median" as never, "views" as never)).rejects.toThrow(/"median"/);
    await expect(repo.aggregate(Post, "sum" as never)).rejects.toThrow(/needs the field/);
    await expect(repo.aggregate(Post, "sum", "nope" as never)).rejects.toThrow(/no column "nope"/);
    await expect(repo.aggregate(User, "count", "password" as never)).rejects.toThrow(/virtual field/);
    await expect(repo.aggregate(Post, "sum", "title" as never)).rejects.toThrow(QueryError);
    const inner = from(Post, "p").ast;
    const overSubquery: QueryAst = { ...inner, from: { kind: "subquerySource", query: inner, alias: "x" } };
    await expect(untyped(repo).aggregate({ ast: overSubquery } as never, "sum", "views")).rejects.toThrow(
      /a subquery/,
    );
    const overValues: QueryAst = { ...inner, from: { kind: "values", columns: ["a"], rows: [], alias: "x" } };
    await expect(untyped(repo).aggregate({ ast: overValues } as never, "sum", "views")).rejects.toThrow(
      /a values source/,
    );
  });

  test("a locked query, and one whose select aggregates by itself, are aggregated as a subquery", async () => {
    const { repo, statements } = fake(() => [{ c0: "1" }]);
    await repo.count(from(Post, "p").lock("update"));
    await repo.count(from(Post, "p").select(() => ({ n: count() })));
    expect(statements[0]?.sql).toMatch(/^select count\(\*\) as "c0" from \(select .* for update\) as "s"$/);
    expect(statements[1]?.sql).toMatch(
      /^select count\(\*\) as "c0" from \(select count\(\*\) as "n" from "posts" as "p"\) as "s"$/,
    );
  });

  test("aggregate returns null when the database returns no row", async () => {
    const { repo } = fake(() => []);
    expect(await repo.aggregate(Post, "max", "views")).toBeNull();
  });

  test("named parameters and options after the field", async () => {
    const { repo, statements } = fake(() => [{ c0: "4" }]);
    const q = from(Post, "p").where(({ p }) => p.views.gte(param("min", t.integer())));
    expect(await repo.aggregate(q, "sum", "views", { min: 2 }, { timeoutMs: 500 })).toBe(4);
    expect(await repo.aggregate(q, "count", { min: 3 })).toBe(4);
    expect(statements.map((each) => each.params)).toEqual([[2], [3]]);
  });
});

describe("stream", () => {
  test("decodes lazily and closes the cursor when the loop ends early", async () => {
    const rows = [ADA, GRACE, { ...ADA, c0: "3" }];
    const { repo, adapter, driver } = fake(() => rows);
    const stream = vi.spyOn(adapter, "stream");
    const ids: number[] = [];
    for await (const user of repo.stream(User)) {
      ids.push(user.id);
      if (ids.length === 2) break;
    }
    expect(ids).toEqual([1, 2]);
    expect(driver.cursors[0]?.closed).toBe(true);
    expect((stream.mock.calls[0]![2] as StreamOptions).batchSize).toBe(500);
    const all: string[] = [];
    driver.respond = () => [{ c0: "a@b.c" }, { c0: "d@e.f" }, { c0: "g@h.i" }];
    for await (const email of repo.stream(
      from(User, "u").select(({ u }) => u.email),
      { batchSize: 2 },
    ))
      all.push(email);
    expect(all).toEqual(["a@b.c", "d@e.f", "g@h.i"]);
    expect((stream.mock.calls[1]![2] as StreamOptions).batchSize).toBe(2);
  });

  test("refuses preloads before running anything", async () => {
    const { repo, statements } = fake(() => [ADA]);
    const iterate = async (): Promise<void> => {
      for await (const _ of repo.stream(from(User, "u").preload("posts"))) {
        // not reached
      }
    };
    await expect(iterate()).rejects.toThrow(/cannot preload/);
    expect(statements).toEqual([]);
  });

  test("takes named parameters and checks its options", async () => {
    const { repo, statements } = fake(() => []);
    const q = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));
    for await (const _ of repo.stream(q, { minAge: 4 }, { batchSize: 10 })) {
      // none
    }
    expect(statements[0]?.params).toEqual([4]);
    expect(() => repo.stream(User, { analyze: true } as never)).toThrow(/unknown option "analyze"/);
  });

  test("reports one event with the total decoding time", async () => {
    const { repo } = fake(() => [ADA, GRACE]);
    const events: RepoQueryEvent[] = [];
    repo.on("query", (event) => events.push(event));
    for await (const _ of repo.stream(User, { context: { job: "export" } })) {
      // consume
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: "stream",
      source: "users",
      rowCount: 2,
      context: { job: "export" },
      error: undefined,
    });
    expect(events[0]?.decodeMs).toBeGreaterThanOrEqual(0);
  });

  test("a row that cannot be decoded ends the stream with its error, reported", async () => {
    const { repo, driver } = fake(() => [ADA, { ...ADA, c0: "9007199254740993" }]);
    const events: RepoQueryEvent[] = [];
    repo.on("query", (event) => events.push(event));
    const seen: number[] = [];
    const iterate = async (): Promise<void> => {
      for await (const user of repo.stream(User)) seen.push(user.id);
    };
    const error = await rejection(iterate());
    expect(error).toBeInstanceOf(CastError);
    expect(seen).toEqual([1]);
    expect(driver.cursors[0]?.closed).toBe(true);
    expect(events[0]?.error).toBe(error);
  });

  test("a failing cursor is reported with its error", async () => {
    const failure = new Error("cursor failed");
    const { repo } = fake(() => failure);
    const events: RepoQueryEvent[] = [];
    repo.on("query", (event) => events.push(event));
    const iterate = async (): Promise<void> => {
      for await (const _ of repo.stream(User)) {
        // none
      }
    };
    expect(await rejection(iterate())).toBe(failure);
    expect(events[0]?.error).toBe(failure);
    expect(events[0]?.decodeMs).toBe(0);
  });
});

describe("reload", () => {
  /** A responder that answers a reload statement with the given rows, each tagged with its 1-based position. */
  const answer =
    (alias: string, rows: readonly (readonly [Record<string, unknown>, number])[]) =>
    (): Record<string, unknown>[] =>
      rows.map(([row, position]) => ({ ...row, [alias]: String(position) }));

  test("the database matches the keys; rows are placed by the position they carry", async () => {
    let respond: Responder = () => [GRACE, ADA];
    const { repo, statements } = fake((sql, params) => respond(sql, params));
    const users = await repo.all(User);
    statements.length = 0;
    // Given [ADA, GRACE]: only ADA (position 1) is still there.
    respond = answer("c10", [[ADA, 1]]);
    const fresh = await repo.reload([users[1] as User, users[0] as User]);
    expect(fresh.map((user) => user?.id ?? null)).toEqual([1, null]);
    expect(fresh[0]).not.toBe(users[1]);
    expect(statements[0]?.sql).toBe(
      'select "users"."id" as "c0", "users"."email" as "c1", "users"."name" as "c2", "users"."age" as "c3", "users"."role" as "c4", "users"."password_hash" as "c5", "users"."settings" as "c6", "users"."lock_version" as "c7", "users"."created_at" as "c8", "users"."updated_at" as "c9", "k"."position" as "c10" from "users" as "users" inner join unnest(cast($1 as bigint[])) with ordinality as "k" ("k0", "position") on "users"."id" = "k"."k0"',
    );
    expect(statements[0]?.params).toEqual([[1, 2]]);
    // The position is not a property of the row.
    expect(Object.keys(fresh[0] as object)).not.toContain("position");
    respond = answer("c10", [[ADA, 1]]);
    expect((await repo.reload(users[1] as User))?.id).toBe(1);
    respond = () => [];
    expect(await repo.reload(users[1] as User)).toBeNull();
    expect(await repo.reload([])).toEqual([]);
    // One statement for any number of rows.
    expect(new Set(statements.map((each) => each.sql)).size).toBe(1);
  });

  test("the same row given twice comes back twice", async () => {
    let respond: Responder = () => [ADA];
    const { repo } = fake(() => respond("", []));
    const [ada] = await repo.all(User);
    respond = answer("c10", [
      [ADA, 1],
      [ADA, 2],
    ]);
    const fresh = await repo.reload([ada as User, ada as User]);
    expect(fresh.map((user) => user?.id)).toEqual([1, 1]);
    expect(fresh[0]).not.toBe(fresh[1]);
  });

  test("reloadOrThrow throws when a row is gone", async () => {
    let respond: Responder = () => [ADA];
    const { repo } = fake(() => respond("", []));
    const [ada] = await repo.all(User);
    respond = answer("c10", [[ADA, 1]]);
    expect((await repo.reloadOrThrow(ada as User)).id).toBe(1);
    expect((await repo.reloadOrThrow([ada as User]))[0]?.id).toBe(1);
    respond = () => [];
    const error = await rejection(repo.reloadOrThrow(ada as User));
    expect(error).toBeInstanceOf(NoResultsError);
    expect((error as NoResultsError).query).toMatch(/^from users as users inner join /);
    expect(await rejection(repo.reloadOrThrow([ada as User]))).toBeInstanceOf(NoResultsError);
  });

  test("a row is reloaded from the database schema it was read from", async () => {
    const { repo, statements } = fake(() => [{ ...ADA, c10: "1" }], { schema: "tenant_9" });
    const [ada] = await repo.all(User);
    statements.length = 0;
    // The row's own schema is the source's: neither the call's nor another default moves it.
    await repo.reload(ada as User, { schema: "tenant_x" });
    expect(statements[0]?.sql).toContain('from "tenant_9"."users" as "users"');
    const other = fake(() => [{ ...ADA, c10: "1" }], { schema: "tenant_y" });
    await other.repo.reload(ada as User);
    expect(other.statements[0]?.sql).toContain('from "tenant_9"."users" as "users"');
  });

  test("a composite key: one array per key field, in one statement", async () => {
    const orgId = "0190d8a0-0000-7000-8000-00000000000a";
    const member = { c0: orgId, c1: "2", c2: "member" };
    const owner = { c0: orgId, c1: "1", c2: "owner" };
    let respond: Responder = () => [member, owner];
    const { repo, statements } = fake(() => respond("", []));
    const memberships = await repo.all(Membership);
    statements.length = 0;
    respond = answer("c3", [
      [owner, 2],
      [member, 1],
    ]);
    const fresh = await repo.reload(memberships);
    expect(fresh.map((each) => each?.userId)).toEqual([2, 1]);
    expect(statements[0]?.sql).toMatch(
      /inner join unnest\(cast\(\$1 as uuid\[\]\), cast\(\$2 as bigint\[\]\)\) with ordinality as "k" \("k0", "k1", "position"\) on "memberships"\."org_id" = "k"\."k0" and "memberships"\."user_id" = "k"\."k1"$/,
    );
    expect(statements[0]?.params).toEqual([
      [orgId, orgId],
      [2, 1],
    ]);
  });

  test("without array parameters, a values list of at most 1,000 rows, under the parameter limit", async () => {
    const orgId = "0190d8a0-0000-7000-8000-00000000000a";
    const { adapter, driver } = setup(() => [], { ...POSTGRES_CAPABILITIES, arrays: false });
    const repo = createRepo({ adapter });
    driver.respond = () =>
      Array.from({ length: 2_500 }, (_, i) => ({ c0: orgId, c1: String(i + 1), c2: "member" }));
    const memberships = await repo.all(Membership);
    driver.statements.length = 0;
    driver.respond = () => [];
    await repo.reload(memberships);
    // Three parameters a row: two key fields and the position.
    expect(driver.statements.map((each) => each.params.length)).toEqual([3_000, 3_000, 1_500]);
    expect(driver.statements[2]?.sql).toMatch(
      /inner join \(values \(cast\(\$1 as uuid\), cast\(\$2 as bigint\), cast\(\$3 as bigint\)\), .*\) as "k" \("k0", "k1", "position"\) on "memberships"\."org_id" = "k"\."k0" and "memberships"\."user_id" = "k"\."k1"$/,
    );
    const small = setup(() => [], { ...POSTGRES_CAPABILITIES, arrays: false, maxParams: 7 });
    const limited = createRepo({ adapter: small.adapter });
    small.driver.respond = () =>
      Array.from({ length: 5 }, (_, i) => ({ c0: orgId, c1: String(i + 1), c2: "member" }));
    const five = await limited.all(Membership);
    small.driver.statements.length = 0;
    small.driver.respond = () => [];
    await limited.reload(five);
    // 7 parameters at most: 2 rows (6 parameters) a statement.
    expect(small.driver.statements.map((each) => each.params.length)).toEqual([6, 6, 3]);
  });

  test("rows placed from several values statements land at their own positions", async () => {
    const { adapter, driver } = setup(() => [], {
      ...POSTGRES_CAPABILITIES,
      arrayParams: false,
      maxParams: 4,
    });
    const repo = createRepo({ adapter });
    driver.respond = () => [ADA, GRACE, { ...ADA, c0: "3" }];
    const users = await repo.all(User);
    // Two rows a statement; the second statement's first row is the third given.
    driver.respond = (_sql, params) => (params.length === 2 ? [{ ...ADA, c0: "3", c10: "1" }] : []);
    const fresh = await repo.reload(users);
    expect(fresh.map((user) => user?.id ?? null)).toEqual([null, null, 3]);
  });

  test("keys holding arrays or JSON go as a values list", async () => {
    class Path extends Schema("paths", { path: t.array(t.string()).primaryKey(), n: t.integer() }) {}
    const { repo, driver } = fake(() => [{ c0: ["a", "b"], c1: 1 }]);
    const paths = await repo.all(Path);
    driver.statements.length = 0;
    driver.respond = () => [{ c0: ["a", "b"], c1: 1, c2: "1" }];
    expect((await repo.reload(paths))[0]?.n).toBe(1);
    expect(driver.statements[0]?.sql).toMatch(
      /inner join \(values \(cast\(\$1 as text\[\]\), cast\(\$2 as bigint\)\)\) as "k"/,
    );
    expect(driver.statements[0]?.params).toEqual([["a", "b"], 1]);
  });

  test("rows of several schemas are read with one query each", async () => {
    const { repo, statements } = fake((sql) =>
      sql.includes('"profiles"')
        ? [{ c0: "5", c1: "1", c2: null, c3: null, c4: "1" }]
        : [{ ...ADA, c10: "1" }],
    );
    const [ada] = await repo.all(User);
    const [profile] = await repo.all(Profile);
    statements.length = 0;
    const [freshAda, freshProfile] = await repo.reload([ada as object, profile as object]);
    expect(freshAda).toBeInstanceOf(User);
    expect(freshProfile).toBeInstanceOf(Profile);
    expect(statements).toHaveLength(2);
  });

  test("refuses what is not a row, a row without a key value, and a keyless schema", async () => {
    const { repo } = fake(() => [ADA]);
    await expect(repo.reload({ id: 1 } as never)).rejects.toThrow(/a plain object/);
    await expect(repo.reload(null as never)).rejects.toThrow(/null/);
    await expect(repo.reload([5] as never)).rejects.toThrow(/number/);
    await expect(repo.reload([{ id: 1 }, { id: 2 }] as never)).rejects.toThrow(/element 0/);
    const [ada] = await repo.all(User);
    const broken = Object.create(Object.getPrototypeOf(ada) as object) as Record<string | symbol, unknown>;
    for (const key of Object.keys(ada as object))
      broken[key] = (ada as unknown as Record<string, unknown>)[key];
    broken.id = null;
    broken[ROW] = (ada as unknown as Record<symbol, unknown>)[ROW];
    await expect(repo.reload(broken as never)).rejects.toThrow(/no value for its key field "id"/);
    class Keyless extends Schema("keyless", { body: t.string() }, { primaryKey: false }) {}
    const keyless = meta(Keyless).create(["x"], meta(Keyless).rowMeta("loaded", undefined));
    await expect(repo.reload(keyless as never)).rejects.toThrow(/no primary key/);
    await expect(repo.reload(ada as User, "x" as never)).rejects.toThrow(TypeError);
    const orphan = { [ROW]: { state: "loaded", source: "x", schema: undefined } };
    await expect(repo.reload(orphan as never)).rejects.toThrow(TypeError);
  });
});

describe("toSql, explain and raw", () => {
  test("toSql returns the SQL and the parameters as sent", () => {
    const { repo } = fake(undefined, { schema: "tenant_1" });
    expect(
      repo.toSql(
        from(User, "u")
          .where(({ u }) => u.age.gte(18))
          .select(({ u }) => u.id),
      ),
    ).toEqual({
      sql: 'select "u"."id" as "c0" from "tenant_1"."users" as "u" where "u"."age" >= $1',
      params: [18],
    });
    const q = from(User, "u")
      .where(({ u }) => u.age.gte(param("minAge", t.integer())))
      .select(({ u }) => u.id);
    expect(repo.toSql(q, { minAge: 3 }, { schema: "other" })).toEqual({
      sql: 'select "u"."id" as "c0" from "other"."users" as "u" where "u"."age" >= $1',
      params: [3],
    });
    expect(() => repo.toSql(User, { timeoutMs: 1 } as never)).toThrow(/unknown option "timeoutMs"/);
  });

  test("explain returns the lines as text, or the structured plan", async () => {
    let rows: Record<string, unknown>[] = [
      { "QUERY PLAN": "Seq Scan on users" },
      { "QUERY PLAN": "  Filter: x" },
    ];
    const { repo, statements } = fake(() => rows);
    expect(await repo.explain(User)).toBe("Seq Scan on users\n  Filter: x");
    expect(statements[0]?.sql).toMatch(/^explain select/);
    rows = [{ "QUERY PLAN": [{ Plan: { "Node Type": "Seq Scan" } }] }];
    expect(await repo.explain(User, { format: "json", analyze: true })).toEqual([
      { Plan: { "Node Type": "Seq Scan" } },
    ]);
    expect(statements[1]?.sql).toMatch(/^explain \(analyze, format json\) select/);
    rows = [{ plan: '[{"Plan":{}}]' }];
    expect(await repo.explain(User, { format: "json" })).toEqual([{ Plan: {} }]);
    rows = [];
    expect(await repo.explain(User, { format: "json" })).toBeUndefined();
    rows = [{ plan: { odd: true } }];
    expect(await repo.explain(User, { format: "text", analyze: false })).toBe('{"odd":true}');
    const q = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));
    await repo.explain(q, { minAge: 1 });
    expect(statements.at(-1)?.params).toEqual([1]);
    await expect(repo.explain(User, { batchSize: 1 } as never)).rejects.toThrow(/unknown option/);
  });

  test("raw runs a fragment and returns the driver's rows", async () => {
    const { repo, statements } = fake(() => [{ n: 2 }]);
    const result = await repo.raw(fragment`select count(*) as n from users where age >= ${18}`);
    expect(result).toEqual({ rows: [{ n: 2 }], rowCount: 1 });
    expect(statements[0]).toEqual({ sql: "select count(*) as n from users where age >= $1", params: [18] });
    await repo.raw(
      fragment`select ${param("x", t.integer())} as x, ${param("x", t.integer())} as y`,
      { x: 4 },
      { timeoutMs: 100 },
    );
    expect(statements[1]?.params).toEqual([4, 4]);
  });

  test("raw refuses anything but a fragment", async () => {
    const { repo, statements } = fake();
    await expect(untyped(repo).raw("select 1" as never)).rejects.toThrow(/a string/);
    await expect(untyped(repo).raw(val(1, t.integer()) as never)).rejects.toThrow(/something else/);
    await expect(untyped(repo).raw(null as never)).rejects.toThrow(QueryError);
    expect(statements).toEqual([]);
  });
});

describe("events", () => {
  test("a query event carries the repo's facts", async () => {
    const { repo } = fake(() => [ADA]);
    const events: RepoQueryEvent[] = [];
    const off = repo.on("query", (event) => events.push(event));
    await repo.one(User, { context: { requestId: "r1" } });
    await repo.raw(fragment`select 1`);
    off();
    off();
    await repo.all(User);
    expect(events).toHaveLength(2);
    expect(Object.keys(events[0] as object)).toEqual([
      "sql",
      "paramCount",
      "durationMs",
      "queueMs",
      "rowCount",
      "error",
      "params",
      "context",
      "operation",
      "source",
      "decodeMs",
    ]);
    expect(events[0]).toMatchObject({
      operation: "one",
      source: "users",
      context: { requestId: "r1" },
      rowCount: 1,
      params: undefined,
    });
    expect(events[1]).toMatchObject({ operation: "raw", source: undefined, context: undefined });
  });

  test("operations report their method name", async () => {
    const { repo } = fake((sql) =>
      sql.startsWith("explain")
        ? [{ p: "x" }]
        : sql.includes("count")
          ? [{ c0: "1" }]
          : [{ ...ADA, c10: "1" }],
    );
    const operations: string[] = [];
    repo.on("query", (event) => operations.push(event.operation));
    const [ada] = await repo.all(User);
    await repo.first(User);
    await repo.get(User, 1);
    await repo.getBy(User, { id: 1 });
    await repo.exists(User);
    await repo.count(User);
    await repo.reload(ada as User);
    await repo.explain(User);
    expect(operations).toEqual(["all", "first", "get", "getBy", "exists", "aggregate", "reload", "explain"]);
  });

  test("a statement-level read that fails is reported, and so is a result it cannot read", async () => {
    const failure = new Error("nope");
    let respond: Responder = () => failure;
    const { repo } = fake((sql, params) => respond(sql, params));
    expect(await rejection(repo.raw(fragment`select 1`))).toBe(failure);
    const events: RepoQueryEvent[] = [];
    repo.on("query", (event) => events.push(event));
    expect(await rejection(repo.exists(User))).toBe(failure);
    respond = () => [{ plan: "not json" }];
    const unreadable = await rejection(repo.explain(User, { format: "json" }));
    expect(unreadable).toBeInstanceOf(SyntaxError);
    expect(events.map((event) => [event.operation, event.error])).toEqual([
      ["exists", failure],
      ["explain", unreadable],
    ]);
  });

  test("a failed statement is reported with its error", async () => {
    const failure = new Error("nope");
    const { repo } = fake(() => failure);
    const events: RepoQueryEvent[] = [];
    repo.on("query", (event) => events.push(event));
    await rejection(repo.all(User));
    expect(events[0]?.error).toBe(failure);
    expect(events[0]?.decodeMs).toBe(0);
  });

  test("a decoding failure is reported as the event's error", async () => {
    const { repo } = fake(() => [{ ...ADA, c0: "9007199254740993" }]);
    const events: RepoQueryEvent[] = [];
    repo.on("query", (event) => events.push(event));
    const error = await rejection(repo.all(User));
    expect(events[0]?.error).toBe(error);
  });

  test("parameters are reported only with log: { params: true }, redacted ones hidden", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { repo } = fake(() => [], { log: { params: true } });
    const events: RepoQueryEvent[] = [];
    repo.on("query", (event) => events.push(event));
    await repo.all(from(User, "u").where({ passwordHash: "secret", age: 3 }));
    expect(events[0]?.params).toEqual(["**redacted**", 3]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toMatch(/-- params: \["\*\*redacted\*\*", 3\]\n$/);
    expect(String(write.mock.calls[0]?.[0])).not.toContain("secret");
  });

  test("log: true writes one line per statement without parameters; a function receives the events", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logged = fake(() => [ADA], { log: true });
    await logged.repo.all(from(User, "u").where({ age: 3 }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toMatch(
      /^egon all users \d+\.\d\d ms \(queue \d+\.\d\d ms, decode \d+\.\d\d ms\) 1 row: select .*\n$/,
    );
    expect(String(write.mock.calls[0]?.[0])).not.toContain("params");
    const seen: RepoQueryEvent[] = [];
    const custom = fake(() => [], { log: (event) => seen.push(event) });
    await custom.repo.all(User);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.params).toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("a listener that throws does not fail the statement; its error is rethrown later", async () => {
    const queued = vi.spyOn(globalThis, "queueMicrotask").mockImplementation(() => undefined);
    const { repo } = fake(() => [ADA]);
    const after: RepoQueryEvent[] = [];
    repo.on("query", () => {
      throw new Error("listener bug");
    });
    repo.on("query", (event) => after.push(event));
    await expect(repo.all(User)).resolves.toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(queued).toHaveBeenCalled();
    const task = queued.mock.calls.at(-1)?.[0] as () => void;
    expect(task).toThrow("listener bug");
  });

  test("the same function subscribed twice is called twice; a listener must be a function", async () => {
    const { repo } = fake(() => []);
    const listener = vi.fn();
    repo.on("query", listener);
    repo.on("query", listener);
    await repo.all(User);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(() => repo.on("query", "x" as never)).toThrow(TypeError);
    expect(() => repo.on("connected" as never, listener)).toThrow(/unknown event/);
  });

  test("the repo listens to the adapter only while it has listeners", async () => {
    const { repo, adapter } = fake(() => []);
    const on = vi.spyOn(adapter, "on");
    const off = repo.on("query", () => undefined);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[2]).toBeUndefined();
    const second = repo.on("query", () => undefined);
    expect(on).toHaveBeenCalledTimes(1);
    off();
    second();
    const execute = vi.spyOn(adapter, "execute");
    await repo.all(User);
    expect((execute.mock.calls[0]![2] as ExecuteOptions).context).toBeUndefined();
  });

  test("a listener that leaves while its statement runs gets nothing, and nothing breaks", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { repo, driver } = fake();
    driver.respond = () => [];
    const listener = vi.fn();
    const off = repo.on("query", listener);
    const original = driver.acquire.bind(driver);
    driver.acquire = async () => {
      await gate;
      return original();
    };
    const pending = repo.all(User);
    off();
    release();
    await pending;
    expect(listener).not.toHaveBeenCalled();
  });

  test("statements of another repo on the same adapter are not reported", async () => {
    const { adapter } = setup(() => []);
    const mine = createRepo({ adapter });
    const theirs = createRepo({ adapter });
    const events: RepoQueryEvent[] = [];
    mine.on("query", (event) => events.push(event));
    await theirs.all(User);
    await adapter.execute("select 1", []);
    expect(events).toEqual([]);
    await mine.all(User);
    expect(events).toHaveLength(1);
  });

  test("pool events come from the adapter", async () => {
    const { repo } = fake(() => []);
    const connects: PoolEvent[] = [];
    const off = repo.on("connect", (event) => connects.push(event));
    repo.on("disconnect", () => undefined);
    repo.on("poolExhausted", () => undefined);
    await repo.all(User);
    expect(connects).toEqual([{ size: 1, idle: 1, waiting: 0 }]);
    off();
    await repo.all(User);
    expect(connects).toHaveLength(1);
  });
});

describe("the adapter's health and statistics", () => {
  test("ping, poolStats, planCacheStats and close pass through", async () => {
    const { repo, adapter, statements } = fake(() => []);
    await repo.ping();
    expect(statements[0]?.sql).toBe("select 1");
    expect(repo.poolStats()).toEqual({ size: 1, idle: 1, waiting: 0 });
    await repo.all(from(User, "u").where({ id: 1 }));
    await repo.all(from(User, "u").where({ id: 2 }));
    expect(repo.planCacheStats()).toEqual({ hits: 1, misses: 1, collisions: 0, size: 1 });
    expect(repo.planCacheStats()).toEqual(adapter.planCacheStats());
    const on = vi.spyOn(adapter, "on");
    repo.on("query", () => undefined);
    const unsubscribe = on.mock.results[0]?.value as () => void;
    expect(typeof unsubscribe).toBe("function");
    await repo.close();
    expect(await rejection(repo.all(User))).toBeInstanceOf(DatabaseError);
    await repo.close();
  });
});
