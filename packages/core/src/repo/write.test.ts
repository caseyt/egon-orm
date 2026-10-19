// Unit tests for the repo's writes, over the real compiler and a fake driver that answers
// with canned results: no database. What the database does with the statements is checked
// against real Postgres by the write conformance suite; these tests check the values
// written, the statements, the options, the errors and the telemetry.
import { Comment, Membership, Org, Post, Tag, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { createAdapter, type DatabaseAdapter } from "../adapter/adapter.js";
import type { DriverConnection, DriverCursor, DriverWrapper } from "../adapter/driver.js";
import { POSTGRES_CAPABILITIES } from "../compiler/index.js";
import type { Capabilities, PoolEvent, RawResult } from "../contracts/adapter.js";
import {
  ConstraintError,
  DatabaseError,
  InvalidChangesetError,
  QueryError,
  StaleEntryError,
} from "../errors.js";
import {
  cast,
  change,
  defineType,
  fragment,
  from,
  meta,
  param,
  Schema,
  scalar,
  stateOf,
  t,
  val,
} from "../index.js";
import type { RepoQueryEvent } from "./options.js";
import { createRepo, type Repo } from "./repo.js";

// --- a driver without a database ---------------------------------------------------

interface Answer {
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number;
  readonly insertId?: bigint | number;
}

type Responder = (sql: string, params: readonly unknown[]) => Answer | Error;

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

class FakeDriver implements DriverWrapper {
  readonly statements: Statement[] = [];
  respond: Responder = () => ({});
  acquired = 0;
  released = 0;
  destroyed = 0;
  /** When set, `acquire` waits for this before handing out a connection. */
  gate: Promise<void> | undefined;

  init(): void {}
  async acquire(): Promise<DriverConnection> {
    if (this.gate !== undefined) await this.gate;
    this.acquired++;
    const driver = this;
    return {
      async query(sql, params): Promise<RawResult> {
        driver.statements.push({ sql, params });
        const answer = driver.respond(sql, params);
        if (answer instanceof Error) throw answer;
        const rows = answer.rows ?? [];
        return { rows, rowCount: answer.rowCount ?? rows.length, insertId: answer.insertId };
      },
      async cursor(): Promise<DriverCursor> {
        throw new Error("no cursors here");
      },
      async cancel(): Promise<void> {},
      inTransaction: () => false,
    };
  }
  async release(_connection: DriverConnection, destroy: boolean): Promise<void> {
    if (destroy) this.destroyed++;
    else this.released++;
  }
  async destroy(): Promise<void> {}
  stats(): PoolEvent {
    return { size: 1, idle: 1, waiting: 0 };
  }
  saturated(): boolean {
    return false;
  }
}

function setup(respond?: Responder, capabilities: Capabilities = POSTGRES_CAPABILITIES) {
  const driver = new FakeDriver();
  if (respond !== undefined) driver.respond = respond;
  const adapter: DatabaseAdapter = createAdapter({
    dialect: "postgres",
    capabilities,
    quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
    driver: () => driver,
    driverCodecs: {},
    normalizeError: (error) => error,
  });
  const repo = createRepo({ adapter });
  const events: RepoQueryEvent[] = [];
  repo.on("query", (event) => events.push(event));
  return { repo, adapter, driver, statements: driver.statements, events };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** A user row as the repo reads it, through a fake `get`. */
async function loadedUser(repo: Repo, driver: FakeDriver, extra: Record<string, unknown> = {}) {
  const previous = driver.respond;
  driver.respond = () => ({
    rows: [
      {
        c0: 7,
        c1: "ada@example.com",
        c2: "Ada",
        c3: 36,
        c4: "admin",
        c5: null,
        c6: null,
        c7: 3,
        c8: new Date("2026-01-01T00:00:00.000Z"),
        c9: new Date("2026-01-02T00:00:00.000Z"),
        ...extra,
      },
    ],
  });
  const user = await repo.getOrThrow(User, 7);
  driver.respond = previous;
  driver.statements.splice(0);
  return user;
}

const unique = (constraint: string, table = "users") =>
  new ConstraintError({ type: "unique", constraint, table, column: undefined, detail: undefined });

/** The repo as JavaScript sees it, for the calls its types refuse. */
type Loose = Readonly<
  Record<
    "insert" | "update" | "delete" | "insertOrUpdate" | "insertAll" | "updateAll",
    (...args: readonly unknown[]) => Promise<unknown>
  >
>;
const loose = (repo: Repo): Loose => repo as unknown as Loose;

// --- insert ---------------------------------------------------------------------------

describe("insert", () => {
  test("writes changes, then defaults, then generated values; leaves out what has none", async () => {
    const { repo, statements } = setup(() => ({ rows: [{ c0: 1 }] }));
    const user = await repo.insertOrThrow(
      change(User, { email: "ada@example.com", age: null, password: "secret" }),
    );
    expect(statements).toHaveLength(1);
    const statement = statements[0] as Statement;
    // age: null is no change for a new record (null is its initial value), so it is left out.
    expect(statement.sql).toBe(
      'insert into "users" ("email", "role", "lock_version", "created_at", "updated_at") values ($1, $2, $3, $4, $5) returning "id" as "c0"',
    );
    expect(statement.params.slice(0, 3)).toEqual(["ada@example.com", "member", 1]);
    // createdAt and updatedAt share one instant.
    expect(statement.params[3]).toEqual(statement.params[4]);
    expect(user).toBeInstanceOf(User);
    expect(stateOf(user)).toBe("loaded");
    expect(user.id).toBe(1);
    expect(user.name).toBeNull();
    expect(user.password).toBe("secret");
    expect(user.settings).toBeNull();
  });

  test("an invalid changeset sends nothing, and its action is set", async () => {
    const { repo, statements, events } = setup();
    let prepared = 0;
    const result = await repo.insert(
      cast(User, { email: "" }, ["email"])
        .validateRequired(["email"])
        .prepareChanges((cs) => {
          prepared++;
          return cs;
        }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.action).toBe("insert");
    // The prepare functions run only for a valid changeset.
    expect(prepared).toBe(0);
    expect(statements).toEqual([]);
    expect(events).toEqual([]);
    const error = await rejection(
      repo.insertOrThrow(cast(User, { email: "" }, ["email"]).validateRequired(["email"])),
    );
    expect(error).toBeInstanceOf(InvalidChangesetError);
    expect((error as InvalidChangesetError).action).toBe("insert");
  });

  test("a required field without a value, or set to null, is can't be blank; nothing is sent", async () => {
    const { repo, statements } = setup();
    const missing = await repo.insert(change(Post, { title: "x" } as never));
    if (missing.success) throw new Error("expected a failure");
    expect(missing.error.errorMessages()).toEqual({ authorId: ["can't be blank"] });
    expect(missing.error.errors.authorId?.[0]?.validation).toBe("required");
    const nulled = await repo.insert(change(Post, { title: "x", authorId: null } as never));
    if (nulled.success) throw new Error("expected a failure");
    expect(nulled.error.errorMessages()).toEqual({ authorId: ["can't be blank"] });
    // A composite key that is not generated is required too.
    const membership = await repo.insert(
      change(Membership, { orgId: "0190d8a0-0000-7000-8000-00000000000a" } as never),
    );
    if (membership.success) throw new Error("expected a failure");
    expect(membership.error.errorMessages()).toEqual({ userId: ["can't be blank"] });
    expect(statements).toEqual([]);
  });

  test("an explicit null for a nullable field overrides its default", async () => {
    const { repo, statements } = setup(() => ({ rows: [{ c0: 5 }] }));
    const post = await repo.insertOrThrow(change(Post, { authorId: 1, title: "a", views: null }));
    expect(statements[0]?.sql).toBe(
      'insert into "posts" ("author_id", "title", "published", "views", "created_at", "updated_at") values ($1, $2, $3, $4, $5, $6) returning "id" as "c0"',
    );
    expect(statements[0]?.params[3]).toBeNull();
    expect(post.views).toBeNull();
  });

  test("an explicit key for a database-generated field is written", async () => {
    const { repo, statements } = setup(() => ({ rows: [{ c0: 42 }] }));
    await repo.insertOrThrow(change(Tag, { id: 42, name: "a" }));
    expect(statements[0]?.sql).toBe(
      'insert into "tags" ("id", "name") values ($1, $2) returning "id" as "c0"',
    );
  });

  test("an autogenerated uuid key is generated per insert and returned", async () => {
    const { repo, statements } = setup((_sql, params) => ({ rows: [{ c0: params[0] }] }));
    const a = await repo.insertOrThrow(change(Org, { name: "A" }));
    const b = await repo.insertOrThrow(change(Org, { name: "B" }));
    expect(a.id).not.toBe(b.id);
    expect(statements[0]?.sql).toBe(
      'insert into "orgs" ("id", "name") values ($1, $2) returning "id" as "c0"',
    );
  });

  test("a function default is called per insert", async () => {
    let calls = 0;
    class Ticket extends Schema("tickets", {
      id: t.integer().primaryKey().dbGenerated(),
      code: t.string().default(() => `T${++calls}`),
    }) {}
    const { repo, statements } = setup(() => ({ rows: [{ c0: 1 }] }));
    await repo.insertOrThrow(change(Ticket, {}));
    await repo.insertOrThrow(change(Ticket, {}));
    expect(statements.map((s) => s.params[0])).toEqual(["T1", "T2"]);
  });

  test("writable modes: never is not written but read back; insert is written", async () => {
    class Audit extends Schema("audits", {
      id: t.integer().primaryKey().dbGenerated(),
      label: t.string(),
      owner: t.string().writable("insert"),
      checksum: t.string().writable("never"),
    }) {}
    const { repo, statements } = setup(() => ({ rows: [{ c0: 1, c1: "from db" }] }));
    const audit = await repo.insertOrThrow(change(Audit, { label: "l", owner: "me", checksum: "mine" }));
    expect(statements[0]?.sql).toBe(
      'insert into "audits" ("label", "owner") values ($1, $2) returning "id" as "c0", "checksum" as "c1"',
    );
    expect(audit.checksum).toBe("from db");
    expect(audit.owner).toBe("me");
  });

  test("the plan is reused for the same column set, and differs for another", async () => {
    const { repo, adapter } = setup(() => ({ rows: [{ c0: 1 }] }));
    await repo.insertOrThrow(change(Tag, { name: "a" }));
    const misses = adapter.planCacheStats().misses;
    await repo.insertOrThrow(change(Tag, { name: "b" }));
    expect(adapter.planCacheStats().misses).toBe(misses);
    await repo.insertOrThrow(change(Tag, {}));
    expect(adapter.planCacheStats().misses).toBe(misses + 1);
  });

  test("returning reads more fields back; true reads all of them", async () => {
    const { repo, statements } = setup(() => ({ rows: [{ c0: 1, c1: "db title", c2: null }] }));
    await repo.insertOrThrow(change(Comment, { postId: 1, body: "b" }), { returning: ["body"] });
    expect(statements[0]?.sql).toContain('returning "id" as "c0", "body" as "c1"');
    await repo.insertOrThrow(change(Tag, { name: "x" }), { returning: true });
    expect(statements[1]?.sql).toContain('returning "id" as "c0", "name" as "c1"');
  });

  test("onConflict: nothing gives null on a conflict; updates read the whole row back", async () => {
    let count = 0;
    const { repo, statements } = setup(() => ({ rows: [], rowCount: count }));
    const result = await repo.insert(change(Tag, { name: "a" }), { onConflict: "nothing" });
    expect(result).toEqual({ success: true, data: null });
    expect(statements[0]?.sql).toBe(
      'insert into "tags" ("name") values ($1) on conflict do nothing returning "id" as "c0"',
    );
    count = 1;
    await expect(
      repo.insertOrThrow(change(Tag, { name: "a" }), { onConflict: "nothing" }),
    ).resolves.toMatchObject({
      name: "a",
    });
    await repo.insert(change(Tag, { name: "a" }), {
      onConflict: { target: fragment`(lower(${"x"}))`, update: { except: ["id"] } },
    });
    const last = statements.at(-1) as Statement;
    expect(last.sql).toBe(
      'insert into "tags" ("name") values ($1) on conflict (lower($2)) do update set "name" = "excluded"."name" returning "id" as "c0", "name" as "c1"',
    );
    expect(last.params).toEqual(["a", "x"]);
  });

  test("an insert that reports no row without onConflict is an error", async () => {
    const { repo } = setup(() => ({ rows: [], rowCount: 0 }));
    expect(await rejection(repo.insert(change(Tag, { name: "a" })))).toBeInstanceOf(QueryError);
  });

  test("prepareChanges: run in order with repo and action, then cleared; may fail the changeset", async () => {
    const { repo, statements } = setup(() => ({ rows: [{ c0: 1 }] }));
    const order: string[] = [];
    const tag = await repo.insertOrThrow(
      change(Tag, { name: "a" })
        .prepareChanges((cs) => {
          order.push(`first ${cs.action} ${cs.repo === repo}`);
          return cs.putChange("name", "b");
        })
        .prepareChanges((cs) => {
          order.push(`second ${String(cs.getChange("name"))}`);
          return cs;
        }),
    );
    expect(order).toEqual(["first insert true", "second b"]);
    expect(tag.name).toBe("b");
    const failed = await repo.insert(change(Tag, {}).prepareChanges((cs) => cs.addError("name", "no")));
    if (failed.success) throw new Error("expected a failure");
    expect(failed.error.repo).toBeNull();
    expect(failed.error.action).toBe("insert");
    expect(statements).toHaveLength(1);
    const bad = change(Tag, {}).prepareChanges((() => "nope") as never);
    expect(await rejection(repo.insert(bad))).toBeInstanceOf(TypeError);
  });

  test("misuse is refused before anything is sent", async () => {
    const { repo, statements, driver } = setup();
    const r = loose(repo);
    expect(await rejection(r.insert({ email: "x" }))).toBeInstanceOf(TypeError);
    expect(
      await rejection(r.insert(cast({ data: {}, types: { q: t.string() } }, { q: "a" }, ["q"]))),
    ).toBeInstanceOf(QueryError);
    const user = await loadedUser(repo, driver);
    expect(await rejection(r.insert(change(user, { name: "x" })))).toBeInstanceOf(QueryError);
    expect(await rejection(r.insert(change(Tag, { name: "a" }), { bogus: 1 }))).toBeInstanceOf(TypeError);
    expect(await rejection(r.insert(change(Tag, { name: "a" }), { returning: "name" }))).toBeInstanceOf(
      QueryError,
    );
    expect(await rejection(r.insert(change(Tag, { name: "a" }), { returning: ["nope"] }))).toBeInstanceOf(
      QueryError,
    );
    expect(
      await rejection(r.insert(change(User, { email: "a" }), { returning: ["password"] })),
    ).toBeInstanceOf(QueryError);
    expect(await rejection(r.insert(change(Tag, { name: "a" }), { returning: [] }))).toBeInstanceOf(
      QueryError,
    );
    expect(statements).toEqual([]);
  });

  test("onConflict is checked", async () => {
    const { repo, statements } = setup();
    const r = loose(repo);
    const cs = change(Tag, { name: "a" });
    for (const onConflict of [
      "raise",
      null,
      { update: "all", extra: 1 },
      { target: "name", update: "all" },
      { target: { constraint: "" }, update: "all" },
      { target: { constraint: "x", other: 1 }, update: "all" },
      { target: ["name"], update: "some" },
      { target: ["name"], update: { except: "id" } },
      { target: ["nope"], update: "all" },
      { target: ["name"], update: [] },
      { target: [], update: "all" },
    ]) {
      expect(await rejection(r.insert(cs, { onConflict })), JSON.stringify(onConflict)).toBeInstanceOf(
        QueryError,
      );
    }
    // Postgres needs a target to update.
    expect(await rejection(r.insert(cs, { onConflict: { update: "all" } }))).toBeInstanceOf(QueryError);
    expect(statements).toEqual([]);
  });

  test("nested changes are refused", async () => {
    const { repo } = setup();
    const withAssoc = change(User, { email: "a" });
    const nested = Object.create(
      Object.getPrototypeOf(withAssoc),
      Object.getOwnPropertyDescriptors(withAssoc),
    );
    Object.defineProperty(nested, "changes", { value: { email: "a", posts: [] } });
    const error = await rejection(repo.insert(nested));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toContain("nested changes are not supported yet");
    const child = change(Tag, { name: "a" });
    const holder = Object.create(
      Object.getPrototypeOf(withAssoc),
      Object.getOwnPropertyDescriptors(withAssoc),
    );
    Object.defineProperty(holder, "changes", { value: { email: child } });
    expect(await rejection(repo.insert(holder))).toBeInstanceOf(QueryError);
    Object.defineProperty(holder, "changes", { value: { email: [child] } });
    expect(await rejection(repo.insert(holder))).toBeInstanceOf(QueryError);
  });

  test("a declared constraint becomes a failure; an undeclared one is thrown with a hint", async () => {
    const { repo } = setup(() => unique("users_email_key"));
    const result = await repo.insert(change(User, { email: "a" }).uniqueConstraint("email"));
    if (result.success) throw new Error("expected a failure");
    expect(result.error.errors.email).toEqual([
      {
        message: "has already been taken",
        constraint: "unique",
        meta: { constraint: "unique", constraintName: "users_email_key" },
      },
    ]);
    const error = await rejection(repo.insert(change(User, { email: "a" })));
    expect((error as Error).message).toContain('Add: .uniqueConstraint("email")');
  });

  test("other database errors are passed through", async () => {
    const failure = new DatabaseError("down", { code: "connection" });
    const { repo, events } = setup(() => failure);
    expect(await rejection(repo.insert(change(Tag, { name: "a" })))).toBe(failure);
    expect(events[0]?.error).toBe(failure);
  });

  test("telemetry reports the operation, the table and the caller's context", async () => {
    const { repo, events } = setup(() => ({ rows: [{ c0: 1 }] }));
    await repo.insertOrThrow(change(Tag, { name: "a" }), { context: { requestId: "r1" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: "insert", source: "tags", context: { requestId: "r1" } });
  });

  test("a returned value that cannot be decoded is reported and thrown", async () => {
    const brittle = defineType<string, string>({
      name: "brittle",
      db: { kind: "text" },
      cast: (input) => (typeof input === "string" ? { success: true, data: input } : { success: false }),
      fromDb: () => {
        throw new Error("cannot read");
      },
      toDb: (value) => value,
      equal: (a, b) => a === b,
    });
    class Fragile extends Schema("fragile", {
      id: t.type(brittle).primaryKey().dbGenerated(),
      n: t.integer(),
    }) {}
    const { repo, events } = setup(() => ({ rows: [{ c0: "x" }] }));
    const error = await rejection(repo.insert(change(Fragile, { n: 1 })));
    expect((error as Error).message).toBe("cannot read");
    expect(events).toHaveLength(1);
    expect(events[0]?.error).toBe(error);
  });

  test("the schema of the write: the call's, else the schema's, else the repo's", async () => {
    class Audited extends Schema(
      "audited",
      { id: t.integer().primaryKey(), n: t.integer() },
      { schema: "audit" },
    ) {}
    const driver = new FakeDriver();
    driver.respond = () => ({ rows: [{ c0: 1 }] });
    const adapter = createAdapter({
      dialect: "postgres",
      capabilities: POSTGRES_CAPABILITIES,
      quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
      driver: () => driver,
      driverCodecs: {},
      normalizeError: (error) => error,
    });
    const repo = createRepo({ adapter, schema: "tenant" });
    const inTenant = await repo.insertOrThrow(change(Tag, { name: "a" }));
    expect(driver.statements[0]?.sql).toContain('into "tenant"."tags"');
    await repo.insertOrThrow(change(Tag, { name: "a" }), { schema: "other" });
    expect(driver.statements[1]?.sql).toContain('into "other"."tags"');
    await repo.insertOrThrow(change(Audited, { id: 1, n: 1 }));
    expect(driver.statements[2]?.sql).toContain('into "audit"."audited"');
    // An update goes where the row is.
    await repo.updateOrThrow(change(inTenant, { name: "b" }));
    expect(driver.statements[3]?.sql).toContain('update "tenant"."tags"');
  });
});

// --- dialects without RETURNING -------------------------------------------------------

describe("insert without RETURNING", () => {
  const noReturning: Capabilities = { ...POSTGRES_CAPABILITIES, returning: false };

  test("a single generated key comes from insertId", async () => {
    const { repo, statements } = setup(() => ({ rowCount: 1, insertId: 9n }), noReturning);
    const tag = await repo.insertOrThrow(change(Tag, { name: "a" }));
    expect(statements[0]?.sql).toBe('insert into "tags" ("name") values ($1)');
    expect(tag.id).toBe(9);
  });

  test("other database-filled fields are read back by key on the same connection", async () => {
    const { repo, statements, driver } = setup((sql) => {
      if (sql.startsWith("insert")) return { rowCount: 1, insertId: 4 };
      return { rows: [{ c0: 4, c1: "a" }] };
    }, noReturning);
    const tag = await repo.insertOrThrow(change(Tag, { name: "a" }), { returning: true });
    expect(statements.map((s) => s.sql.split(" ")[0])).toEqual(["insert", "select"]);
    expect(statements[1]?.params).toEqual([4]);
    expect(tag.name).toBe("a");
    expect(driver.acquired).toBe(1);
    expect(driver.released).toBe(1);
  });

  test("a key the caller gave is used to read back; a skipped conflict reads nothing", async () => {
    let inserted = 1;
    const { repo, statements } = setup((sql) => {
      if (sql.startsWith("insert")) return { rowCount: inserted };
      return { rows: [{ c0: "0190d8a0-0000-7000-8000-00000000000a", c1: "Acme" }] };
    }, noReturning);
    const org = await repo.insertOrThrow(
      change(Org, { id: "0190d8a0-0000-7000-8000-00000000000a", name: "Acme" }),
      {
        returning: true,
      },
    );
    expect(org.name).toBe("Acme");
    expect(statements[1]?.params).toEqual(["0190d8a0-0000-7000-8000-00000000000a"]);
    inserted = 0;
    statements.splice(0);
    expect(
      await repo.insertOrThrow(change(Tag, { name: "a" }), { returning: true, onConflict: "nothing" }),
    ).toBeNull();
    expect(statements).toHaveLength(1);
  });
});

// --- update -------------------------------------------------------------------------

describe("update", () => {
  test("no change: no query, the row itself", async () => {
    const env = setup();
    const user = await loadedUser(env.repo, env.driver);
    env.events.splice(0);
    expect(await env.repo.updateOrThrow(change(user))).toBe(user);
    expect(await env.repo.updateOrThrow(cast(user, { name: "Ada" }, ["name"]))).toBe(user);
    expect(env.statements).toEqual([]);
    expect(env.events).toEqual([]);
  });

  test("only virtual changes: no query, the row with them", async () => {
    const env = setup();
    const user = await loadedUser(env.repo, env.driver);
    const updated = await env.repo.updateOrThrow(change(user, { password: "new" }));
    expect(updated).not.toBe(user);
    expect(updated.password).toBe("new");
    expect(env.statements).toEqual([]);
  });

  test("sets the changed columns and updatedAt, finds the row by key", async () => {
    const env = setup(() => ({ rows: [], rowCount: 1 }));
    const user = await loadedUser(env.repo, env.driver);
    const updated = await env.repo.updateOrThrow(change(user, { name: "Ada L." }));
    const statement = env.statements[0] as Statement;
    expect(statement.sql).toBe('update "users" set "name" = $1, "updated_at" = $2 where "id" = $3');
    expect(statement.params[0]).toBe("Ada L.");
    expect(statement.params[2]).toBe(7);
    expect(updated.name).toBe("Ada L.");
    expect(updated.email).toBe("ada@example.com");
    expect(updated.updatedAt).toBe(statement.params[1]);
    expect(updated.createdAt).toEqual(user.createdAt);
    expect(stateOf(updated)).toBe("loaded");
  });

  test("an explicit updatedAt is kept; force writes updatedAt alone", async () => {
    const env = setup(() => ({ rowCount: 1 }));
    const user = await loadedUser(env.repo, env.driver);
    const at = new Date("2027-01-01T00:00:00.000Z");
    await env.repo.updateOrThrow(change(user, { updatedAt: at }));
    expect(env.statements[0]?.sql).toBe('update "users" set "updated_at" = $1 where "id" = $2');
    expect(env.statements[0]?.params[0]).toBe(at);
    await env.repo.updateOrThrow(change(user), { force: true });
    expect(env.statements[1]?.sql).toBe('update "users" set "updated_at" = $1 where "id" = $2');
  });

  test("force with nothing to set sends nothing", async () => {
    const env = setup(() => ({ rowCount: 1 }));
    await env.repo.insertOrThrow(change(Tag, { name: "a" })).catch(() => undefined);
    env.statements.splice(0);
    env.driver.respond = () => ({ rows: [{ c0: 3, c1: "t" }] });
    const tag = await env.repo.getOrThrow(Tag, 3);
    env.statements.splice(0);
    expect(await env.repo.updateOrThrow(change(tag), { force: true })).toMatchObject({ id: 3 });
    expect(env.statements).toEqual([]);
  });

  test("fields that may not be updated are left out", async () => {
    class Doc extends Schema("docs", {
      id: t.integer().primaryKey(),
      owner: t.string().writable("insert"),
      body: t.string(),
    }) {}
    const env = setup(() => ({ rows: [{ c0: 1, c1: "me", c2: "b" }] }));
    const doc = await env.repo.getOrThrow(Doc, 1);
    env.statements.splice(0);
    env.driver.respond = () => ({ rowCount: 1 });
    const updated = await env.repo.updateOrThrow(change(doc, { owner: "you", body: "c" }));
    expect(env.statements[0]?.sql).toBe('update "docs" set "body" = $1 where "id" = $2');
    expect(updated.owner).toBe("me");
    env.statements.splice(0);
    expect((await env.repo.updateOrThrow(change(doc, { owner: "you" }))).owner).toBe("me");
    expect(env.statements).toEqual([]);
  });

  test("null for a non-nullable field is can't be blank", async () => {
    const env = setup();
    const user = await loadedUser(env.repo, env.driver);
    const result = await env.repo.update(change(user, { email: null } as never));
    if (result.success) throw new Error("expected a failure");
    expect(result.error.errorMessages()).toEqual({ email: ["can't be blank"] });
    expect(env.statements).toEqual([]);
  });

  test("an optimistic lock adds the filter and the new value", async () => {
    const env = setup(() => ({ rowCount: 1 }));
    const user = await loadedUser(env.repo, env.driver);
    const updated = await env.repo.updateOrThrow(change(user, { name: "x" }).optimisticLock("lockVersion"));
    expect(env.statements[0]?.sql).toBe(
      'update "users" set "name" = $1, "lock_version" = $2, "updated_at" = $3 where "id" = $4 and "lock_version" = $5',
    );
    expect(env.statements[0]?.params[1]).toBe(4);
    expect(env.statements[0]?.params[4]).toBe(3);
    expect(updated.lockVersion).toBe(4);
  });

  test("stale: thrown, allowed, or reported on a key", async () => {
    const env = setup(() => ({ rowCount: 0 }));
    const user = await loadedUser(env.repo, env.driver);
    const cs = change(user, { name: "x" });
    const thrown = await rejection(env.repo.update(cs));
    expect(thrown).toBeInstanceOf(StaleEntryError);
    expect((thrown as StaleEntryError).action).toBe("update");
    expect((await env.repo.updateOrThrow(cs, { allowStale: true })).name).toBe("x");
    const reported = await env.repo.update(cs, { staleError: { field: "lockVersion" } });
    if (reported.success) throw new Error("expected a failure");
    expect(reported.error.errors.lockVersion).toEqual([
      { message: "is stale", validation: "stale", meta: { stale: true } },
    ]);
    expect(reported.error.action).toBe("update");
  });

  test("returned fields and preloaded associations are kept on the row", async () => {
    const env = setup(() => ({ rowCount: 1, rows: [{ c0: 7, c1: "db@example.com" }] }));
    const user = await loadedUser(env.repo, env.driver);
    Object.defineProperty(user, "posts", { value: [], enumerable: true, writable: true });
    const updated = await env.repo.updateOrThrow(change(user, { name: "x" }), { returning: ["email"] });
    expect(env.statements[0]?.sql).toContain('returning "email" as "c0"');
    expect((updated as unknown as { posts: unknown[] }).posts).toEqual([]);
  });

  test("misuse is refused", async () => {
    const env = setup();
    const r = loose(env.repo);
    expect(await rejection(r.update(change(User, { email: "a" })))).toBeInstanceOf(QueryError);
    expect(await rejection(r.update("x"))).toBeInstanceOf(TypeError);
    const user = await loadedUser(env.repo, env.driver);
    expect(await rejection(r.update(change(user, { name: "x" }), { force: "yes" }))).toBeInstanceOf(
      TypeError,
    );
    expect(await rejection(r.update(change(user, { name: "x" }), { allowStale: 1 }))).toBeInstanceOf(
      TypeError,
    );
    for (const staleError of [
      "x",
      { field: "" },
      { field: "a", message: 1 },
      { field: "a", other: 1 },
      { field: "__proto__" },
    ]) {
      expect(await rejection(r.update(change(user, { name: "x" }), { staleError }))).toBeInstanceOf(
        TypeError,
      );
    }
    // A row without a key value, a schema without a key, a deleted row.
    const keyless = change(user, { name: "x" });
    Object.defineProperty(user, "id", { value: null });
    expect(await rejection(r.update(keyless))).toBeInstanceOf(QueryError);
    class Log extends Schema("logs", { line: t.string() }, { primaryKey: false }) {}
    env.driver.respond = () => ({ rows: [{ c0: "a" }] });
    const [line] = await env.repo.all(Log);
    expect(await rejection(r.update(change(line as Log, { line: "b" })))).toBeInstanceOf(QueryError);
    expect(await rejection(r.delete(line))).toBeInstanceOf(QueryError);
    expect(env.statements.filter((s) => !s.sql.startsWith("select"))).toEqual([]);
  });

  test("a constraint on update is matched or thrown", async () => {
    const env = setup(() => unique("users_email_key"));
    const user = await loadedUser(env.repo, env.driver);
    env.driver.respond = () => unique("users_email_key");
    const result = await env.repo.update(change(user, { email: "b" }).uniqueConstraint("email"));
    expect(result.success).toBe(false);
    const error = await rejection(env.repo.update(change(user, { email: "b" })));
    expect((error as Error).message).toContain("violated on update of");
    env.driver.respond = () => new DatabaseError("x");
    expect(await rejection(env.repo.update(change(user, { email: "b" })))).toBeInstanceOf(DatabaseError);
  });
});

// --- delete ---------------------------------------------------------------------------

describe("delete", () => {
  test("by key, a row or a changeset, returns the row deleted", async () => {
    const env = setup(() => ({ rowCount: 1 }));
    const user = await loadedUser(env.repo, env.driver);
    const deleted = await env.repo.deleteOrThrow(user);
    expect(env.statements[0]?.sql).toBe('delete from "users" where "id" = $1');
    expect(stateOf(deleted)).toBe("deleted");
    expect(deleted.email).toBe(user.email);
    await env.repo.deleteOrThrow(change(user).optimisticLock("lockVersion"));
    expect(env.statements[1]?.sql).toBe('delete from "users" where "id" = $1 and "lock_version" = $2');
    expect(env.events.at(-1)?.operation).toBe("delete");
  });

  test("stale: thrown, allowed, reported", async () => {
    const env = setup(() => ({ rowCount: 0 }));
    const user = await loadedUser(env.repo, env.driver);
    const thrown = await rejection(env.repo.delete(user));
    expect((thrown as StaleEntryError).action).toBe("delete");
    expect(stateOf(await env.repo.deleteOrThrow(user, { allowStale: true }))).toBe("deleted");
    const reported = await env.repo.delete(user, { staleError: { field: "id", message: "gone" } });
    if (reported.success) throw new Error("expected a failure");
    expect(reported.error.errorMessages()).toEqual({ id: ["gone"] });
  });

  test("an invalid changeset, or one a prepare function fails, sends nothing", async () => {
    const env = setup();
    const user = await loadedUser(env.repo, env.driver);
    const invalid = await env.repo.delete(change(user).addError("id", "no"));
    expect(invalid.success).toBe(false);
    const prepared = await env.repo.delete(change(user).prepareChanges((cs) => cs.addError("id", "no")));
    expect(prepared.success).toBe(false);
    expect(await rejection(env.repo.deleteOrThrow(change(user).addError("id", "no")))).toBeInstanceOf(
      InvalidChangesetError,
    );
    expect(env.statements).toEqual([]);
  });

  test("a violation is matched against noAssocConstraint or thrown", async () => {
    const violation = new ConstraintError({
      type: "foreignKey",
      constraint: "posts_author_id_fkey",
      table: "posts",
      column: undefined,
      detail: undefined,
    });
    const env = setup();
    const user = await loadedUser(env.repo, env.driver);
    env.driver.respond = () => violation;
    const result = await env.repo.delete(change(user).noAssocConstraint("posts"));
    if (result.success) throw new Error("expected a failure");
    expect(result.error.errorMessages()).toEqual({ posts: ["is still associated with this entry"] });
    expect(await rejection(env.repo.delete(user))).toBeInstanceOf(ConstraintError);
    env.driver.respond = () => new DatabaseError("x");
    expect(await rejection(env.repo.delete(user))).toBeInstanceOf(DatabaseError);
  });

  test("misuse is refused", async () => {
    const env = setup();
    const r = loose(env.repo);
    expect(await rejection(r.delete({ id: 1 }))).toBeInstanceOf(TypeError);
    expect(await rejection(r.delete(change(User, { email: "a" })))).toBeInstanceOf(QueryError);
    const user = await loadedUser(env.repo, env.driver);
    expect(await rejection(r.delete(user, { returning: true }))).toBeInstanceOf(TypeError);
  });
});

// --- insertOrUpdate -------------------------------------------------------------------

describe("insertOrUpdate", () => {
  test("inserts a new record and updates a loaded row", async () => {
    const env = setup(() => ({ rows: [{ c0: 1 }], rowCount: 1 }));
    await env.repo.insertOrUpdateOrThrow(change(Tag, { name: "a" }), { onConflict: "nothing" });
    const user = await loadedUser(env.repo, env.driver);
    env.driver.respond = () => ({ rowCount: 1 });
    await env.repo.insertOrUpdateOrThrow(change(user, { name: "b" }), { force: true });
    expect(env.events.map((event) => event.operation)).toEqual(["insert", "get", "update"]);
    expect(await rejection(loose(env.repo).insertOrUpdate("x"))).toBeInstanceOf(TypeError);
    expect(
      await rejection(env.repo.insertOrUpdateOrThrow(change(Tag, {}).addError("name", "no"))),
    ).toBeInstanceOf(InvalidChangesetError);
  });
});

// --- validateUniqueAsync --------------------------------------------------------------

describe("validateUniqueAsync", () => {
  test("queries only when a field changed, has a value and no error; excludes the row's own key", async () => {
    const env = setup(() => ({ rows: [{ c0: 1 }] }));
    const taken = await change(User, { email: "a" }).validateUniqueAsync("email", env.repo);
    expect(env.statements[0]?.sql).toBe(
      'select 1 as "c0" from "users" as "t" where "t"."email" = $1 limit $2',
    );
    expect(taken.errors.email).toEqual([
      { message: "has already been taken", validation: "uniqueAsync", meta: { fields: ["email"] } },
    ]);
    const custom = await change(User, { email: "a", name: "n" }).validateUniqueAsync(
      ["email", "name"],
      env.repo,
      {
        message: (meta) => `taken (${String(meta.fields)})`,
        errorKey: "login",
      },
    );
    expect(custom.errorMessages()).toEqual({ login: ["taken (email,name)"] });
    const text = await change(User, { email: "a" }).validateUniqueAsync("email", env.repo, {
      message: "in use",
    });
    expect(text.errorMessages()).toEqual({ email: ["in use"] });
    env.statements.splice(0);
    await change(User, { name: "a" }).validateUniqueAsync("email", env.repo);
    await change(User, { email: "a" }).addError("email", "bad").validateUniqueAsync("email", env.repo);
    await change(User, { email: "a", name: null }).validateUniqueAsync(["email", "name"], env.repo);
    expect(env.statements).toEqual([]);
    const user = await loadedUser(env.repo, env.driver);
    env.driver.respond = () => ({ rows: [] });
    const own = await change(user, { email: "b" }).validateUniqueAsync("email", env.repo);
    expect(own.valid).toBe(true);
    expect(env.statements[0]?.sql).toBe(
      'select 1 as "c0" from "users" as "t" where "t"."email" = $1 and not ("t"."id" = $2) limit $3',
    );
    const membership = change(Membership, { orgId: "0190d8a0-0000-7000-8000-00000000000a", userId: 1 });
    await membership.validateUniqueAsync(["orgId", "userId"], env.repo);
  });

  test("misuse is refused", async () => {
    const env = setup();
    expect(await rejection(change(User, { email: "a" }).validateUniqueAsync("email", {}))).toBeInstanceOf(
      TypeError,
    );
    expect(
      await rejection(
        cast({ data: {}, types: { q: t.string() } }, { q: "a" }, ["q"]).validateUniqueAsync("q", env.repo),
      ),
    ).toBeInstanceOf(QueryError);
    expect(await rejection(change(User, { email: "a" }).validateUniqueAsync([], env.repo))).toBeInstanceOf(
      QueryError,
    );
  });
});

// --- bulk -------------------------------------------------------------------------------

describe("insertAll", () => {
  test("one statement, defaults and one instant for every row's timestamps", async () => {
    const env = setup(() => ({ rowCount: 2 }));
    const { count, rows } = await env.repo.insertAll(User, [{ email: "a" }, { email: "b", age: 3 }]);
    expect({ count, rows }).toEqual({ count: 2, rows: null });
    const statement = env.statements[0] as Statement;
    expect(statement.sql).toBe(
      'insert into "users" ("email", "age", "role", "lock_version", "created_at", "updated_at") values ($1, default, $2, $3, $4, $5), ($6, $7, $8, $9, $10, $11)',
    );
    const stamps = [statement.params[3], statement.params[4], statement.params[9], statement.params[10]];
    expect(new Set(stamps).size).toBe(1);
    expect(env.events.map((event) => event.operation)).toEqual(["insertAll"]);
  });

  test("uuids are generated per row", async () => {
    const env = setup(() => ({ rowCount: 2 }));
    await env.repo.insertAll(Org, [{ name: "a" }, { name: "b" }]);
    const params = env.statements[0]?.params as unknown[];
    expect(params[0]).not.toBe(params[2]);
  });

  test("plain rows go in power-of-two chunks under the limit, in a transaction", async () => {
    const small: Capabilities = { ...POSTGRES_CAPABILITIES, maxParams: 10 };
    const env = setup(() => ({ rowCount: 1 }), small);
    const { count } = await env.repo.insertAll(
      Tag,
      Array.from({ length: 13 }, (_, i) => ({ name: `t${i}` })),
    );
    expect(env.statements.map((s) => (s.sql.startsWith("insert") ? s.params.length : s.sql))).toEqual([
      "begin",
      8,
      4,
      1,
      "commit",
    ]);
    expect(count).toBe(3);
    expect(env.driver.released).toBe(1);
  });

  test("a failing chunk rolls the transaction back; a failed rollback destroys the connection", async () => {
    const small: Capabilities = { ...POSTGRES_CAPABILITIES, maxParams: 2 };
    let fails = "insert";
    const env = setup(
      (sql) =>
        sql.startsWith(fails) || (fails === "both" && sql !== "begin") ? new Error(sql) : { rowCount: 1 },
      small,
    );
    const rows = [{ name: "a" }, { name: "b" }, { name: "c" }];
    expect(await rejection(env.repo.insertAll(Tag, rows))).toBeInstanceOf(Error);
    expect(env.statements.map((s) => s.sql.split(" ")[0])).toEqual(["begin", "insert", "rollback"]);
    fails = "both";
    env.statements.splice(0);
    expect(await rejection(env.repo.insertAll(Tag, rows))).toBeInstanceOf(Error);
    expect(env.statements.map((s) => s.sql.split(" ")[0])).toEqual(["begin", "insert", "rollback"]);
    expect(env.driver.destroyed).toBe(1);
  });

  test("rows with expressions use cells and chunk by their placeholders", async () => {
    const small: Capabilities = { ...POSTGRES_CAPABILITIES, maxParams: 8 };
    const env = setup(() => ({ rowCount: 1, rows: [{ c0: 1, c1: 1 }] }), small);
    const { rows } = await env.repo.insertAll(
      Post,
      [
        { authorId: 1, title: val("untyped title") },
        {
          authorId: scalar(
            from(User, "u")
              .select(({ u }) => u.id)
              .limit(1),
          ),
          title: "b",
        },
        { authorId: 1, title: fragment`concat(${"x"}, ${"y"})` as never },
      ],
      { returning: ["id", "authorId"] },
    );
    const inserts = env.statements.filter((s) => s.sql.startsWith("insert"));
    expect(inserts.length).toBeGreaterThan(1);
    expect(inserts.every((s) => s.params.length <= 8)).toBe(true);
    expect(rows).toHaveLength(inserts.length);
    expect(inserts[0]?.sql).toContain("$1, $2");
  });

  test("placeholders bind a value once per statement, and are checked", async () => {
    const env = setup(() => ({ rowCount: 2 }));
    const when = new Date("2026-01-01T00:00:00.000Z");
    await env.repo.insertAll(
      Post,
      [
        { authorId: 1, title: "a", publishedAt: param("when", t.timestamp()) },
        { authorId: 1, title: "b", publishedAt: param("when", t.timestamp()) },
      ],
      { placeholders: { when } },
    );
    expect(
      env.statements[0]?.params.filter((value) => value === when.toISOString() || value === when),
    ).toHaveLength(2);
    const rows = [{ authorId: 1, title: "a", publishedAt: param("when", t.timestamp()) }];
    expect(await rejection(env.repo.insertAll(Post, rows))).toBeInstanceOf(QueryError);
    expect(
      await rejection(env.repo.insertAll(Post, rows, { placeholders: { when, other: 1 } })),
    ).toBeInstanceOf(QueryError);
    expect(
      await rejection(env.repo.insertAll(Tag, [{ name: "a" }], { placeholders: { x: 1 } })),
    ).toBeInstanceOf(QueryError);
    expect(
      await rejection(loose(env.repo).insertAll(Tag, [{ name: "a" }], { placeholders: 1 })),
    ).toBeInstanceOf(TypeError);
  });

  test("returning: whole rows, or objects of the fields asked for; none for no rows", async () => {
    const env = setup(() => ({ rows: [{ c0: 1, c1: "a" }], rowCount: 1 }));
    const whole = await env.repo.insertAll(Tag, [{ name: "a" }], { returning: true });
    expect(whole.rows[0]).toBeInstanceOf(Tag);
    expect(stateOf(whole.rows[0] as Tag)).toBe("loaded");
    const listed = await env.repo.insertAll(Tag, [{ name: "a" }], { returning: ["id", "name"] });
    expect(listed.rows).toEqual([{ id: 1, name: "a" }]);
    expect(await env.repo.insertAll(Tag, [], { returning: true })).toEqual({ count: 0, rows: [] });
  });

  test("from a query", async () => {
    const env = setup(() => ({ rowCount: 2 }));
    await env.repo.insertAll(
      Tag,
      from(User, "u").select(({ u }) => ({ name: u.email })),
      { onConflict: "nothing" },
    );
    expect(env.statements[0]?.sql).toBe(
      'insert into "tags" ("name") select "u"."email" as "c0" from "users" as "u" on conflict do nothing',
    );
    const r = loose(env.repo);
    expect(await rejection(r.insertAll(Tag, from(User, "u")))).toBeInstanceOf(QueryError);
    expect(
      await rejection(
        r.insertAll(
          Tag,
          from(User, "u").select(({ u }) => ({ nope: u.email })),
        ),
      ),
    ).toBeInstanceOf(QueryError);
    class Stamp extends Schema("stamps", {
      id: t.integer().primaryKey(),
      code: t.string().writable("never"),
    }) {}
    expect(
      await rejection(
        r.insertAll(
          Stamp,
          from(User, "u").select(({ u }) => ({ code: u.email })),
        ),
      ),
    ).toBeInstanceOf(QueryError);
  });

  test("misuse is refused", async () => {
    const env = setup();
    const r = loose(env.repo);
    expect(await rejection(r.insertAll({}, []))).toBeInstanceOf(TypeError);
    expect(await rejection(r.insertAll(Tag, "rows"))).toBeInstanceOf(TypeError);
    expect(await rejection(r.insertAll(Tag, [1]))).toBeInstanceOf(TypeError);
    expect(await rejection(r.insertAll(Tag, [{ nope: 1 }]))).toBeInstanceOf(QueryError);
    expect(await rejection(r.insertAll(Tag, [{ name: from(Tag, "g") }]))).toBeInstanceOf(QueryError);
    class Stamp extends Schema("stamps", {
      id: t.integer().primaryKey(),
      code: t.string().writable("never"),
    }) {}
    expect(await rejection(r.insertAll(Stamp, [{ id: 1, code: "x" }]))).toBeInstanceOf(QueryError);
    expect(await rejection(r.insertAll(meta(User) as never, []))).toBeInstanceOf(TypeError);
    expect(env.statements).toEqual([]);
  });

  test("the wait for a connection counts against timeoutMs, and the signal stops it", async () => {
    const small: Capabilities = { ...POSTGRES_CAPABILITIES, maxParams: 1 };
    const env = setup(() => ({ rowCount: 1 }), small);
    let open: () => void = () => undefined;
    env.driver.gate = new Promise((resolve) => {
      open = resolve;
    });
    const rows = [{ name: "a" }, { name: "b" }];
    const timedOut = await rejection(env.repo.insertAll(Tag, rows, { timeoutMs: 5 }));
    expect((timedOut as DatabaseError).code).toBe("timeout");
    const controller = new AbortController();
    const aborted = env.repo.insertAll(Tag, rows, { signal: controller.signal });
    controller.abort();
    expect(((await rejection(aborted)) as DatabaseError).code).toBe("aborted");
    open();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Both connections that arrived late went back to the pool.
    expect(env.driver.released).toBe(2);
    env.driver.gate = undefined;
    const already = new AbortController();
    already.abort();
    expect(
      ((await rejection(env.repo.insertAll(Tag, rows, { signal: already.signal }))) as DatabaseError).code,
    ).toBe("aborted");
    // A budget that is enough: the chunks share it.
    expect((await env.repo.insertAll(Tag, rows, { timeoutMs: 5_000 })).count).toBe(2);
  });

  test("a failed acquire is passed on", async () => {
    const small: Capabilities = { ...POSTGRES_CAPABILITIES, maxParams: 1 };
    const env = setup(() => ({ rowCount: 1 }), small);
    env.driver.gate = Promise.reject(new DatabaseError("no", { code: "connection" }));
    env.driver.gate.catch(() => undefined);
    expect(
      await rejection(env.repo.insertAll(Tag, [{ name: "a" }, { name: "b" }], { timeoutMs: 1_000 })),
    ).toBeInstanceOf(DatabaseError);
  });
});

describe("updateAll and deleteAll", () => {
  test("compile as UPDATE and DELETE; rows only with returning", async () => {
    const env = setup(() => ({ rowCount: 2, rows: [{ c0: 5 }, { c0: 6 }] }));
    const updated = await env.repo.updateAll(from(Post, "p").where({ authorId: 1 }).set({ published: true }));
    expect(env.statements[0]?.sql).toBe(
      'update "posts" as "p" set "published" = $1 where "p"."author_id" = $2',
    );
    expect(updated).toEqual({ count: 2, rows: null });
    const returned = await env.repo.deleteAll(from(Post, "p").returning(({ p }) => p.id));
    expect(returned).toEqual({ count: 2, rows: [5, 6] });
    await env.repo.deleteAll(Tag);
    expect(env.statements[2]?.sql).toBe('delete from "tags" as "tags"');
    expect(env.events.map((event) => [event.operation, event.source])).toEqual([
      ["updateAll", "posts"],
      ["deleteAll", "posts"],
      ["deleteAll", "tags"],
    ]);
  });

  test("named parameters and options", async () => {
    const env = setup(() => ({ rowCount: 1 }));
    const q = from(Post, "p").where(({ p }) => p.authorId.eq(param("author", t.bigint({ mode: "number" }))));
    await env.repo.deleteAll(q, { author: 3 }, { schema: "archive" });
    expect(env.statements[0]?.sql).toBe('delete from "archive"."posts" as "p" where "p"."author_id" = $1');
    expect(env.statements[0]?.params).toEqual([3]);
  });

  test("an updateAll without set is refused", async () => {
    const env = setup();
    const r = loose(env.repo);
    expect(await rejection(r.updateAll(Post))).toBeInstanceOf(QueryError);
    expect(await rejection(r.updateAll(from(Post, "p")))).toBeInstanceOf(QueryError);
    expect(env.statements).toEqual([]);
  });
});
