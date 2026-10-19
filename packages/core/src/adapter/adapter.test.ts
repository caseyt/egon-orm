import { User } from "@egon-orm/test-support";
import { afterEach, describe, expect, test, vi } from "vitest";
import { bindParams, POSTGRES_CAPABILITIES } from "../compiler/index.js";
import type { Capabilities, PoolEvent, QueryEvent, RawResult } from "../contracts/adapter.js";
import type { FieldMeta } from "../contracts/schema.js";
import type { AnyFieldType } from "../contracts/type.js";
import { ConstraintError, DatabaseError, QueryError } from "../errors.js";
import { fragment, from, meta } from "../index.js";
import { bigintType } from "../types/index.js";
import { type AdapterDefinition, beginSql, createAdapter, DEFAULT_BATCH_SIZE } from "./adapter.js";
import type { DriverConnection, DriverCursor, DriverHooks, DriverWrapper } from "./driver.js";

// --- a driver wrapper without a database --------------------------------------------

const EMPTY: RawResult = { rows: [], rowCount: 0, insertId: undefined };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FakeCursor implements DriverCursor {
  reads: number[] = [];
  closed = 0;
  failAtRead: number | undefined = undefined;
  failClose = false;
  private position = 0;

  constructor(private readonly rows: readonly Record<string, unknown>[]) {}

  async read(count: number): Promise<readonly Record<string, unknown>[]> {
    this.reads.push(count);
    if (this.failAtRead === this.reads.length) throw new Error("division by zero");
    const batch = this.rows.slice(this.position, this.position + count);
    this.position += batch.length;
    return batch;
  }

  async close(): Promise<void> {
    this.closed++;
    if (this.failClose) throw new Error("close failed");
  }
}

class FakeConnection implements DriverConnection {
  readonly statements: { sql: string; params: readonly unknown[]; name: string | undefined }[] = [];
  respond: (sql: string) => Promise<RawResult> = async () => EMPTY;
  cursors: FakeCursor[] = [];
  cursorRows: readonly Record<string, unknown>[] = [];
  cursorError: Error | undefined = undefined;
  cancels = 0;
  cancelResult: () => Promise<void> = async () => undefined;
  transaction: () => boolean = () => false;

  constructor(readonly id: number) {}

  query(sql: string, params: readonly unknown[], name: string | undefined): Promise<RawResult> {
    this.statements.push({ sql, params, name });
    return this.respond(sql);
  }

  async cursor(sql: string, params: readonly unknown[]): Promise<DriverCursor> {
    this.statements.push({ sql, params, name: undefined });
    if (this.cursorError !== undefined) throw this.cursorError;
    const cursor = new FakeCursor(this.cursorRows);
    this.cursors.push(cursor);
    return cursor;
  }

  cancel(): Promise<void> {
    this.cancels++;
    return this.cancelResult();
  }

  inTransaction(): boolean {
    return this.transaction();
  }
}

class FakeDriver implements DriverWrapper {
  inits = 0;
  destroyed = 0;
  hooks: DriverHooks | undefined = undefined;
  readonly connections: FakeConnection[] = [];
  readonly released: { id: number; destroy: boolean }[] = [];
  nextAcquire: (() => Promise<DriverConnection>) | undefined = undefined;
  failRelease = false;
  isSaturated = false;
  saturatedCalls = 0;
  statsCalls = 0;
  connectionSetup: (connection: FakeConnection) => void = () => undefined;
  pool: PoolEvent = { size: 1, idle: 1, waiting: 0 };

  init(): void {
    this.inits++;
  }

  acquire(): Promise<DriverConnection> {
    const next = this.nextAcquire;
    if (next !== undefined) {
      this.nextAcquire = undefined;
      return next();
    }
    return Promise.resolve(this.newConnection());
  }

  newConnection(): FakeConnection {
    const connection = new FakeConnection(this.connections.length + 1);
    this.connectionSetup(connection);
    this.connections.push(connection);
    return connection;
  }

  async release(connection: DriverConnection, destroy: boolean): Promise<void> {
    this.released.push({ id: (connection as FakeConnection).id, destroy });
    if (this.failRelease) throw new Error("release failed");
  }

  async destroy(): Promise<void> {
    this.destroyed++;
  }

  stats(): PoolEvent {
    this.statsCalls++;
    return this.pool;
  }

  saturated(): boolean {
    this.saturatedCalls++;
    return this.isSaturated;
  }
}

const CAPABILITIES = {
  isolationLevels: ["read committed", "serializable"],
  lockModes: [],
} as unknown as Capabilities;

/** Maps errors whose message starts with "fatal" to a connection error, "unique" to a constraint error. */
function normalizeError(error: unknown, sql: string | undefined): unknown {
  if (!(error instanceof Error)) return error;
  if (error.message.startsWith("fatal")) {
    return new DatabaseError(
      "lost",
      sql === undefined ? { code: "connection", cause: error } : { code: "connection", sql, cause: error },
    );
  }
  if (error.message.startsWith("unique")) {
    return new ConstraintError({
      type: "unique",
      constraint: "c",
      table: "t",
      column: undefined,
      detail: undefined,
      cause: error,
    });
  }
  return error;
}

function setup(overrides: Partial<AdapterDefinition> = {}) {
  const driver = new FakeDriver();
  const factory = vi.fn((hooks: DriverHooks) => {
    driver.hooks = hooks;
    return driver;
  });
  const adapter = createAdapter({
    dialect: "postgres",
    capabilities: CAPABILITIES,
    quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
    driver: factory,
    driverCodecs: { bigint: { fromDb: (value) => BigInt(value as string) } },
    normalizeError,
    ...overrides,
  });
  return { adapter, driver, factory };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// --- tests ------------------------------------------------------------------------

describe("createAdapter", () => {
  test("exposes the dialect and capabilities, and type overrides built from the driver fixes", () => {
    const { adapter } = setup();
    expect(adapter.dialect).toBe("postgres");
    expect(adapter.capabilities).toBe(CAPABILITIES);
    expect(adapter.typeOverrides(bigintType() as AnyFieldType)?.fromDb("7")).toBe(7n);
  });

  test.each([0, -1, 1.5, Number.NaN, "100"])("refuses planCacheSize %s", (planCacheSize) => {
    expect(() => setup({ planCacheSize: planCacheSize as number })).toThrow(
      /planCacheSize must be a positive whole number/,
    );
  });

  test("accepts a planCacheSize", () => {
    expect(() => setup({ planCacheSize: 5 })).not.toThrow();
  });

  test("every compile method goes to the adapter's statement compiler", () => {
    const { adapter } = setup({ capabilities: POSTGRES_CAPABILITIES });
    const ast = from(User, "u")
      .where(({ u }) => u.id.eq(1))
      .select(({ u }) => u.email).ast;
    const plan = adapter.compile(ast, "all", undefined);
    expect(plan.sql).toBe('select "u"."email" as "c0" from "users" as "u" where "u"."id" = $1');
    expect(adapter.compile(ast, "all", undefined)).toBe(plan);
    expect(adapter.compileExplain(ast, "all", undefined, {}).sql).toBe(`explain ${plan.sql}`);
    expect(adapter.compileFragment(fragment`select 1`.node as never).sql).toBe("select 1");
    const users = meta(User);
    const id = users.fieldsByName.get("id") as FieldMeta;
    const email = users.fieldsByName.get("email") as FieldMeta;
    expect(
      adapter.compileInsert(
        users,
        [email],
        { source: { kind: "values", rows: 1 }, returning: [id], onConflict: undefined },
        undefined,
      ).sql,
    ).toBe('insert into "users" ("email") values ($1) returning "id" as "c0"');
    expect(adapter.compileUpdate(users, [email], [id], [], undefined).sql).toBe(
      'update "users" set "email" = $1 where "id" = $2',
    );
    expect(adapter.compileDelete(users, [id], [], "tenant_1").sql).toBe(
      'delete from "tenant_1"."users" where "id" = $1',
    );
  });

  test("a compiled value is converted with the adapter's type overrides", () => {
    const { adapter } = setup({ driverCodecs: { text: { toDb: (value) => String(value).toUpperCase() } } });
    const ast = from(User, "u").where(({ u }) => u.email.eq("a@b.c")).ast;
    const plan = adapter.compile(ast, "all", undefined);
    expect(bindParams(plan.slots, ast.params)).toEqual(["A@B.C"]);
  });

  test("creates the driver on first use only, and once", async () => {
    const { adapter, driver, factory } = setup();
    expect(factory).not.toHaveBeenCalled();
    expect(adapter.poolStats()).toEqual({ size: 0, idle: 0, waiting: 0 });
    await adapter.execute("select 1", []);
    await adapter.execute("select 2", []);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(driver.inits).toBe(1);
    expect(adapter.poolStats()).toBe(driver.pool);
  });

  test("a driver that fails to start is tried again on the next use", async () => {
    let attempts = 0;
    const driver = new FakeDriver();
    const { adapter } = setup({
      driver: () => {
        attempts++;
        if (attempts === 1) throw new TypeError("bad config");
        return driver;
      },
    });
    await expect(adapter.execute("select 1", [])).rejects.toThrow("bad config");
    await expect(adapter.execute("select 1", [])).resolves.toBe(EMPTY);
  });

  test("ping runs a trivial statement", async () => {
    const { adapter, driver } = setup();
    await expect(adapter.ping()).resolves.toBeUndefined();
    expect(driver.connections[0]?.statements[0]?.sql).toBe("select 1");
  });

  test("normalizeError uses the dialect's normaliser, and leaves Egon errors alone", () => {
    const { adapter } = setup();
    const fatal = adapter.normalizeError(new Error("fatal: socket"));
    expect(fatal).toBeInstanceOf(DatabaseError);
    expect((fatal as DatabaseError).sql).toBeUndefined();
    const own = new QueryError("mine");
    expect(adapter.normalizeError(own)).toBe(own);
    expect(adapter.normalizeError("not an error")).toBe("not an error");
  });
});

describe("execute on the pool", () => {
  test("runs on a checked-out connection, returns the result and returns the connection", async () => {
    const { adapter, driver } = setup();
    const result: RawResult = { rows: [{ one: 1 }], rowCount: 1, insertId: undefined };
    driver.connectionSetup = (connection) => {
      connection.respond = async () => result;
    };
    await expect(adapter.execute("select $1", [5], { statementName: "s1" })).resolves.toBe(result);
    expect(driver.connections[0]?.statements).toEqual([{ sql: "select $1", params: [5], name: "s1" }]);
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
  });

  test("a driver error is normalised with the SQL, and the connection goes back", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.respond = async () => {
        throw new Error("unique violation");
      };
    };
    await expect(adapter.execute("insert", [])).rejects.toBeInstanceOf(ConstraintError);
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
  });

  test("a fatal error closes the connection instead of returning it", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.respond = async () => {
        throw new Error("fatal: socket closed");
      };
    };
    const error = await rejection(adapter.execute("select 1", []));
    expect(error).toMatchObject({ code: "connection", sql: "select 1" });
    expect(driver.released).toEqual([{ id: 1, destroy: true }]);
  });

  test("an unrecognised error passes through unchanged", async () => {
    const { adapter, driver } = setup();
    const odd = new RangeError("odd");
    driver.connectionSetup = (connection) => {
      connection.respond = async () => {
        throw odd;
      };
    };
    await expect(adapter.execute("select 1", [])).rejects.toBe(odd);
  });

  test("a connection left inside a transaction is closed, not returned", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.transaction = () => true;
    };
    await adapter.execute("begin", []);
    expect(driver.released).toEqual([{ id: 1, destroy: true }]);
  });

  test("a connection whose transaction state cannot be read is closed", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.transaction = () => {
        throw new Error("gone");
      };
    };
    await adapter.execute("select 1", []);
    expect(driver.released).toEqual([{ id: 1, destroy: true }]);
  });

  test("a failure to return the connection does not fail the statement", async () => {
    const { adapter, driver } = setup();
    driver.failRelease = true;
    await expect(adapter.execute("select 1", [])).resolves.toBe(EMPTY);
  });

  test("a failure to check a connection out is normalised and returns nothing", async () => {
    const { adapter, driver } = setup();
    driver.nextAcquire = () => Promise.reject(new Error("fatal: refused"));
    await expect(adapter.execute("select 1", [])).rejects.toMatchObject({
      code: "connection",
      sql: "select 1",
    });
    expect(driver.released).toEqual([]);
  });

  test.each([
    [{ timeoutMs: -1 }, /timeoutMs option must be a non-negative number/],
    [{ timeoutMs: Number.POSITIVE_INFINITY }, /timeoutMs option/],
    [{ timeoutMs: "5" }, /timeoutMs option/],
    [{ signal: { aborted: false } }, /signal option must be an AbortSignal/],
  ])("refuses the options %o before checking anything out", async (options, message) => {
    const { adapter, factory } = setup();
    await expect(adapter.execute("select 1", [], options as never)).rejects.toThrow(message);
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("telemetry", () => {
  test("measures nothing when nobody listens", async () => {
    const { adapter } = setup();
    const clock = vi.spyOn(performance, "now");
    await adapter.execute("select 1", []);
    expect(clock).not.toHaveBeenCalled();
  });

  test("reports a successful statement with its timings, row count and context", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.respond = async () => ({ rows: [{}, {}], rowCount: 2, insertId: undefined });
    };
    const events: QueryEvent[] = [];
    adapter.on("query", (event) => events.push(event));
    const context = { operation: "all" };
    await adapter.execute("select $1", [1], { context });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sql: "select $1",
      paramCount: 1,
      rowCount: 2,
      error: undefined,
      context,
      params: undefined,
    });
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(events[0]?.queueMs).toBeGreaterThanOrEqual(0);
  });

  test("reports a failed statement with its normalised error", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.respond = async () => {
        throw new Error("unique violation");
      };
    };
    const events: QueryEvent[] = [];
    adapter.on("query", (event) => events.push(event));
    await expect(adapter.execute("insert", [])).rejects.toBeInstanceOf(ConstraintError);
    expect(events[0]?.error).toBeInstanceOf(ConstraintError);
    expect(events[0]?.rowCount).toBe(0);
  });

  test("a failed checkout counts as time in the queue", async () => {
    const { adapter, driver } = setup();
    driver.nextAcquire = () => Promise.reject(new Error("fatal: refused"));
    const events: QueryEvent[] = [];
    adapter.on("query", (event) => events.push(event));
    await expect(adapter.execute("select 1", [])).rejects.toBeInstanceOf(DatabaseError);
    expect(events[0]?.durationMs).toBe(0);
    expect(events[0]?.queueMs).toBeGreaterThanOrEqual(0);
  });

  test("parameters reach only a listener that asked, redacted by slot", async () => {
    const { adapter } = setup();
    const events: QueryEvent[] = [];
    adapter.on("query", (event) => events.push(event), { params: true });
    await adapter.execute("select $1, $2", ["a", "b"], {
      slots: [
        { kind: "inline", index: 0, toDb: undefined, redact: false },
        { kind: "inline", index: 1, toDb: undefined, redact: true },
      ],
    });
    expect(events[0]?.params).toEqual(["a", "**redacted**"]);
  });

  test("poolExhausted fires when a checkout has to wait, and the pool is not asked when nobody listens", async () => {
    const { adapter, driver } = setup();
    driver.isSaturated = true;
    await adapter.execute("select 1", []);
    expect(driver.saturatedCalls).toBe(0);
    const events: PoolEvent[] = [];
    adapter.on("poolExhausted", (event) => events.push(event));
    await adapter.execute("select 1", []);
    expect(events).toEqual([driver.pool]);
    driver.isSaturated = false;
    await adapter.execute("select 1", []);
    expect(events).toHaveLength(1);
  });

  test("connect and disconnect hooks become events with the pool's state, only when someone listens", async () => {
    const { adapter, driver } = setup();
    await adapter.ping();
    const hooks = driver.hooks as DriverHooks;
    hooks.connected();
    hooks.disconnected();
    expect(driver.statsCalls).toBe(0);
    const connects: PoolEvent[] = [];
    const disconnects: PoolEvent[] = [];
    adapter.on("connect", (event) => connects.push(event));
    adapter.on("disconnect", (event) => disconnects.push(event));
    hooks.connected();
    hooks.disconnected();
    expect(connects).toEqual([driver.pool]);
    expect(disconnects).toEqual([driver.pool]);
  });

  test("statements on a dedicated connection are reported with no queue time", async () => {
    const { adapter } = setup();
    const events: QueryEvent[] = [];
    adapter.on("query", (event) => events.push(event));
    const connection = await adapter.acquire();
    await connection.begin();
    await connection.release();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sql: "begin", queueMs: 0 });
  });
});

describe("cancellation", () => {
  test("a signal that has already fired runs nothing and checks nothing out", async () => {
    const { adapter, driver } = setup();
    const error = await rejection(adapter.execute("update", [], { signal: AbortSignal.abort() }));
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ code: "aborted", sql: "update", retryable: false });
    expect((error as Error).cause).toBeUndefined();
    expect(driver.connections).toHaveLength(0);
  });

  test("an abort cancels the statement and rejects once it has ended and the cancel was delivered", async () => {
    const { adapter, driver } = setup();
    const statement = deferred<RawResult>();
    const cancel = deferred<void>();
    const driverError = new Error("canceling statement due to user request");
    driver.connectionSetup = (connection) => {
      connection.respond = () => statement.promise;
      connection.cancelResult = () => {
        statement.reject(driverError);
        return cancel.promise;
      };
    };
    const controller = new AbortController();
    let settled = false;
    const running = adapter.execute("select pg_sleep(10)", [], { signal: controller.signal }).finally(() => {
      settled = true;
    });
    await tick();
    controller.abort();
    controller.abort();
    await tick();
    expect(driver.connections[0]?.cancels).toBe(1);
    expect(settled).toBe(false); // the cancel request is still on its way
    cancel.resolve();
    const error = await rejection(running);
    expect(error).toMatchObject({ code: "aborted", cause: driverError });
    expect((error as Error).message).toMatch(/AbortSignal fired/);
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
  });

  test("a statement that completes despite the abort still rejects as aborted, with no cause", async () => {
    const { adapter, driver } = setup();
    const statement = deferred<RawResult>();
    driver.connectionSetup = (connection) => {
      connection.respond = () => statement.promise;
      connection.cancelResult = async () => {
        statement.resolve(EMPTY);
      };
    };
    const controller = new AbortController();
    const running = adapter.execute("update", [], { signal: controller.signal });
    await tick();
    controller.abort();
    const error = await rejection(running);
    expect(error).toMatchObject({ code: "aborted" });
    expect((error as Error).cause).toBeUndefined();
  });

  test("a cancel request that fails leaves the statement to finish; the call rejects and the connection is closed", async () => {
    const { adapter, driver } = setup();
    const statement = deferred<RawResult>();
    driver.connectionSetup = (connection) => {
      connection.respond = () => statement.promise;
      connection.cancelResult = async () => {
        throw new Error("could not connect to cancel");
      };
    };
    const controller = new AbortController();
    const running = adapter.execute("select 1", [], { signal: controller.signal });
    await tick();
    controller.abort();
    await tick();
    statement.resolve(EMPTY);
    await expect(running).rejects.toMatchObject({ code: "aborted" });
    // The request may still arrive late and cancel the next statement: never reuse it.
    expect(driver.released).toEqual([{ id: 1, destroy: true }]);
  });

  test("a delivered cancel request leaves the connection reusable", async () => {
    const { adapter, driver } = setup();
    const statement = deferred<RawResult>();
    driver.connectionSetup = (connection) => {
      connection.respond = () => statement.promise;
      connection.cancelResult = async () => statement.reject(new Error("canceled"));
    };
    const controller = new AbortController();
    const running = adapter.execute("select 1", [], { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "aborted" });
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
  });

  test("timeoutMs cancels a statement that runs longer", async () => {
    const { adapter, driver } = setup();
    const statement = deferred<RawResult>();
    driver.connectionSetup = (connection) => {
      connection.respond = () => statement.promise;
      connection.cancelResult = async () => statement.reject(new Error("canceled"));
    };
    const error = await rejection(adapter.execute("select pg_sleep(10)", [], { timeoutMs: 5 }));
    expect(error).toMatchObject({ code: "timeout" });
    expect((error as Error).message).toContain("timeoutMs (5 ms)");
  });

  test("a timeout and an abort together send one cancel request; the first reason wins", async () => {
    const { adapter, driver } = setup();
    const statement = deferred<RawResult>();
    const cancel = deferred<void>();
    driver.connectionSetup = (connection) => {
      connection.respond = () => statement.promise;
      connection.cancelResult = () => cancel.promise;
    };
    const controller = new AbortController();
    const running = adapter.execute("select 1", [], { timeoutMs: 1, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    statement.reject(new Error("canceled"));
    cancel.resolve();
    await expect(running).rejects.toMatchObject({ code: "timeout" });
    expect(driver.connections[0]?.cancels).toBe(1);
  });

  test("a statement that ends in time is not cancelled, and its timer and listener are cleared", async () => {
    const { adapter, driver } = setup();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await expect(
      adapter.execute("select 1", [], { timeoutMs: 10_000, signal: controller.signal }),
    ).resolves.toBe(EMPTY);
    expect(driver.connections[0]?.cancels).toBe(0);
    expect(remove).toHaveBeenCalled();
    expect(clear).toHaveBeenCalled();
  });

  test("a failing statement with a timeout rejects with its own error", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.respond = async () => {
        throw new Error("unique violation");
      };
    };
    await expect(adapter.execute("insert", [], { timeoutMs: 10_000 })).rejects.toBeInstanceOf(
      ConstraintError,
    );
  });

  test("an abort while waiting for a connection gives up the wait; the late connection goes back", async () => {
    const { adapter, driver } = setup();
    const checkout = deferred<DriverConnection>();
    driver.nextAcquire = () => checkout.promise;
    const controller = new AbortController();
    const waiting = adapter.execute("select 1", [], { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted", sql: "select 1" });
    let closed = false;
    const closing = adapter.close().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false); // the abandoned checkout is still out
    checkout.resolve(driver.newConnection());
    await closing;
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
    expect(driver.connections[0]?.statements).toEqual([]);
  });

  test("timeoutMs bounds the wait for a connection; the late connection goes back", async () => {
    const { adapter, driver } = setup();
    const checkout = deferred<DriverConnection>();
    driver.nextAcquire = () => checkout.promise;
    const error = await rejection(adapter.execute("select 1", [], { timeoutMs: 5 }));
    expect(error).toMatchObject({ code: "timeout", sql: "select 1" });
    expect((error as Error).message).toContain(
      "waited longer than its timeoutMs (5 ms) for a free connection",
    );
    let closed = false;
    const closing = adapter.close().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);
    checkout.resolve(driver.newConnection());
    await closing;
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
    expect(driver.connections[0]?.statements).toEqual([]);
  });

  test("an abort while waiting reports the wait, not the statement", async () => {
    const { adapter, driver } = setup();
    const checkout = deferred<DriverConnection>();
    driver.nextAcquire = () => checkout.promise;
    const controller = new AbortController();
    const waiting = rejection(
      adapter.execute("select 1", [], { signal: controller.signal, timeoutMs: 10_000 }),
    );
    await tick();
    controller.abort();
    expect(((await waiting) as Error).message).toContain("AbortSignal fired while it waited");
    checkout.resolve(driver.newConnection());
  });

  test("timeoutMs is one budget: the statement gets what the wait left of it", async () => {
    const { adapter, driver } = setup();
    driver.nextAcquire = () =>
      new Promise((resolve) => setTimeout(() => resolve(driver.newConnection()), 40));
    const timers = vi.spyOn(globalThis, "setTimeout");
    await adapter.execute("select 1", [], { timeoutMs: 1_000 });
    const delays = timers.mock.calls
      .map((call) => call[1])
      .filter((delay) => typeof delay === "number" && delay > 100);
    expect(delays[0]).toBe(1_000); // the wait
    expect(delays[1]).toBeLessThan(970); // the statement
  });

  test("a checkout that fails after the caller gave up is ignored", async () => {
    const { adapter, driver } = setup();
    const checkout = deferred<DriverConnection>();
    driver.nextAcquire = () => checkout.promise;
    const controller = new AbortController();
    const waiting = adapter.execute("select 1", [], { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    checkout.reject(new Error("fatal: refused"));
    await adapter.close();
    expect(driver.destroyed).toBe(1);
  });

  test("a checkout with a signal that succeeds or fails before any abort behaves as without one", async () => {
    const { adapter, driver } = setup();
    const signal = new AbortController().signal;
    await expect(adapter.execute("select 1", [], { signal })).resolves.toBe(EMPTY);
    driver.nextAcquire = () => Promise.reject(new Error("fatal: refused"));
    await expect(adapter.execute("select 1", [], { signal })).rejects.toMatchObject({ code: "connection" });
  });
});

describe("close", () => {
  test("is idempotent, destroys the driver once and refuses work afterwards", async () => {
    const { adapter, driver } = setup();
    await adapter.ping();
    const first = adapter.close();
    expect(adapter.close()).toBe(first);
    await first;
    expect(driver.destroyed).toBe(1);
    const error = await rejection(adapter.execute("select 1", []));
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ code: "connection", sql: "select 1" });
    await expect(adapter.acquire()).rejects.toMatchObject({ code: "connection", sql: undefined });
    await expect(adapter.stream("select 1", [])[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "connection",
    });
  });

  test("of an adapter that was never used creates no driver", async () => {
    const { adapter, factory } = setup();
    await adapter.close();
    expect(factory).not.toHaveBeenCalled();
  });

  test("waits for running statements and checked-out connections", async () => {
    const { adapter, driver } = setup();
    const statement = deferred<RawResult>();
    driver.connectionSetup = (connection) => {
      if (connection.id === 1) connection.respond = () => statement.promise;
    };
    const running = adapter.execute("select 1", []);
    const connection = await adapter.acquire();
    let closed = false;
    const closing = adapter.close().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);
    statement.resolve(EMPTY);
    await running;
    await tick();
    expect(closed).toBe(false);
    await connection.release();
    await closing;
    expect(driver.destroyed).toBe(1);
  });

  test("a failed checkout of a dedicated connection does not keep the adapter open", async () => {
    const { adapter, driver } = setup();
    driver.nextAcquire = () => Promise.reject(new Error("fatal: refused"));
    await expect(adapter.acquire()).rejects.toMatchObject({ code: "connection" });
    await adapter.close();
  });
});

describe("streams on the pool", () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ n: i + 1 }));

  async function collect(iterable: AsyncIterable<Record<string, unknown>>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const row of iterable) out.push(row.n);
    return out;
  }

  test("yields every row in batches of batchSize, then closes the cursor and returns the connection", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.cursorRows = rows;
    };
    const events: QueryEvent[] = [];
    adapter.on("query", (event) => events.push(event));
    expect(await collect(adapter.stream("select n", [1], { batchSize: 100 }))).toHaveLength(250);
    const cursor = driver.connections[0]?.cursors[0];
    expect(cursor?.reads).toEqual([100, 100, 100, 100]);
    expect(cursor?.closed).toBe(1);
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
    expect(events[0]).toMatchObject({ sql: "select n", rowCount: 250, error: undefined });
  });

  test("fetches 100 rows at a time by default", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.cursorRows = rows;
    };
    await collect(adapter.stream("select n", []));
    expect(driver.connections[0]?.cursors[0]?.reads[0]).toBe(DEFAULT_BATCH_SIZE);
  });

  test("leaving the loop early closes the cursor and returns the connection", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.cursorRows = rows;
    };
    let count = 0;
    for await (const _row of adapter.stream("select n", [], { batchSize: 10 })) {
      if (++count === 3) break;
    }
    expect(driver.connections[0]?.cursors[0]?.closed).toBe(1);
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
  });

  test("a failed read is normalised, and the connection is closed rather than reused", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.cursorRows = rows;
      const open = connection.cursor.bind(connection);
      connection.cursor = async (sql, params) => {
        const cursor = (await open(sql, params)) as FakeCursor;
        cursor.failAtRead = 2;
        return cursor;
      };
    };
    const events: QueryEvent[] = [];
    adapter.on("query", (event) => events.push(event));
    await expect(collect(adapter.stream("select n", [], { batchSize: 100 }))).rejects.toThrow(
      "division by zero",
    );
    expect(driver.released).toEqual([{ id: 1, destroy: true }]);
    expect(events[0]).toMatchObject({ rowCount: 100 });
    expect(events[0]?.error).toBeInstanceOf(Error);
  });

  test("a cursor that cannot be closed closes the connection", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.cursorRows = rows.slice(0, 3);
      const open = connection.cursor.bind(connection);
      connection.cursor = async (sql, params) => {
        const cursor = (await open(sql, params)) as FakeCursor;
        cursor.failClose = true;
        return cursor;
      };
    };
    expect(await collect(adapter.stream("select n", []))).toEqual([1, 2, 3]);
    expect(driver.released).toEqual([{ id: 1, destroy: true }]);
  });

  test("a cursor that cannot be opened is a normalised error, and the connection goes back", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.cursorError = new Error("unique violation");
    };
    await expect(collect(adapter.stream("select n", []))).rejects.toBeInstanceOf(ConstraintError);
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
  });

  test("a failed checkout ends the stream with a normalised error and reports it", async () => {
    const { adapter, driver } = setup();
    driver.nextAcquire = () => Promise.reject(new Error("fatal: refused"));
    const events: QueryEvent[] = [];
    adapter.on("query", (event) => events.push(event));
    await expect(collect(adapter.stream("select n", []))).rejects.toMatchObject({ code: "connection" });
    expect(events[0]).toMatchObject({ durationMs: 0, rowCount: 0 });
  });

  test("an abort between batches stops the stream without another read, and keeps the connection", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.cursorRows = rows;
    };
    const controller = new AbortController();
    let count = 0;
    const error = await rejection(
      (async () => {
        for await (const _row of adapter.stream("select n", [], {
          batchSize: 10,
          signal: controller.signal,
        })) {
          if (++count === 10) controller.abort();
        }
      })(),
    );
    expect(error).toMatchObject({ code: "aborted" });
    expect(driver.connections[0]?.cursors[0]?.reads).toEqual([10]);
    expect(driver.connections[0]?.cursors[0]?.closed).toBe(1);
    expect(driver.connections[0]?.cancels).toBe(0);
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
  });

  test("an abort while a read is in flight cancels it and closes the connection", async () => {
    const { adapter, driver } = setup();
    const read = deferred<readonly Record<string, unknown>[]>();
    driver.connectionSetup = (connection) => {
      connection.cancelResult = async () => read.reject(new Error("canceled"));
      connection.cursor = async () => ({ read: () => read.promise, close: async () => undefined });
    };
    const controller = new AbortController();
    const iterating = rejection(
      (async () => {
        for await (const _row of adapter.stream("select n", [], { signal: controller.signal })) {
          // never reached
        }
      })(),
    );
    await tick();
    controller.abort();
    expect(await iterating).toMatchObject({ code: "aborted" });
    expect(driver.connections[0]?.cancels).toBe(1);
    expect(driver.released).toEqual([{ id: 1, destroy: true }]);
  });

  test.each([0, -5, 2.5, "10"])("refuses batchSize %s", async (batchSize) => {
    const { adapter } = setup();
    await expect(collect(adapter.stream("select n", [], { batchSize: batchSize as number }))).rejects.toThrow(
      /batchSize option must be a positive whole number/,
    );
  });
});

describe("dedicated connections", () => {
  test("run every statement on the same connection and return it once", async () => {
    const { adapter, driver } = setup();
    const connection = await adapter.acquire();
    await connection.execute("select 1", []);
    await connection.execute("select 2", [], { statementName: "two" });
    await connection.release();
    await connection.release();
    await connection.destroy();
    expect(driver.connections).toHaveLength(1);
    expect(driver.connections[0]?.statements.map((s) => [s.sql, s.name])).toEqual([
      ["select 1", undefined],
      ["select 2", "two"],
    ]);
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
  });

  test("destroy closes the connection instead of returning it, once", async () => {
    const { adapter, driver } = setup();
    const connection = await adapter.acquire();
    await connection.destroy();
    await connection.destroy();
    await connection.release();
    expect(driver.released).toEqual([{ id: 1, destroy: true }]);
  });

  test("refuse statements and streams after release or destroy", async () => {
    const { adapter } = setup();
    const released = await adapter.acquire();
    await released.release();
    await expect(released.execute("select 1", [])).rejects.toThrow(/was released; acquire a new one/);
    await expect(released.stream("select 1", [])[Symbol.asyncIterator]().next()).rejects.toThrow(
      /was released/,
    );
    const destroyed = await adapter.acquire();
    await destroyed.destroy();
    await expect(destroyed.execute("select 1", [])).rejects.toThrow(/was destroyed/);
  });

  test("release waits for the statement still running", async () => {
    const { adapter, driver } = setup();
    const statement = deferred<RawResult>();
    driver.connectionSetup = (connection) => {
      connection.respond = () => statement.promise;
    };
    const connection = await adapter.acquire();
    const running = connection.execute("select pg_sleep(1)", []);
    const releasing = connection.release();
    await tick();
    expect(driver.released).toEqual([]);
    statement.resolve(EMPTY);
    await running;
    await releasing;
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
  });

  test("a fatal error marks the connection, which release then closes", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.respond = async () => {
        throw new Error("fatal: terminated");
      };
    };
    const events: QueryEvent[] = [];
    adapter.on("query", (event) => events.push(event));
    const connection = await adapter.acquire();
    await expect(connection.execute("select 1", [])).rejects.toMatchObject({
      code: "connection",
      sql: "select 1",
    });
    expect(events[0]?.error).toMatchObject({ code: "connection" });
    await connection.release();
    expect(driver.released).toEqual([{ id: 1, destroy: true }]);
  });

  test("a non-fatal error leaves the connection reusable", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.respond = async (sql) => {
        if (sql === "insert") throw new Error("unique violation");
        return EMPTY;
      };
    };
    const connection = await adapter.acquire();
    await expect(connection.execute("insert", [])).rejects.toBeInstanceOf(ConstraintError);
    await connection.release();
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
  });

  test("a connection still inside a transaction is closed on release", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.transaction = () => true;
    };
    const connection = await adapter.acquire();
    await connection.begin();
    await connection.release();
    expect(driver.released).toEqual([{ id: 1, destroy: true }]);
  });

  test("a dedicated connection whose cancel request failed takes no more statements, and is closed", async () => {
    const { adapter, driver } = setup();
    const statement = deferred<RawResult>();
    driver.connectionSetup = (connection) => {
      connection.respond = (sql) => (sql === "slow" ? statement.promise : Promise.resolve(EMPTY));
      connection.cancelResult = async () => {
        statement.resolve(EMPTY);
        throw new Error("The cancel request got no answer within 10000 ms.");
      };
    };
    const connection = await adapter.acquire();
    await expect(connection.execute("slow", [], { timeoutMs: 1 })).rejects.toMatchObject({ code: "timeout" });
    const error = await rejection(connection.rollback());
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ code: "connection", sql: "rollback" });
    expect((error as Error).message).toContain("A cancel request for this connection failed");
    await connection.release();
    expect(driver.released).toEqual([{ id: 1, destroy: true }]);
    expect(driver.connections[0]?.statements.map((s) => s.sql)).toEqual(["slow"]);
  });

  test("abort and timeout work on a dedicated connection", async () => {
    const { adapter, driver } = setup();
    const statement = deferred<RawResult>();
    driver.connectionSetup = (connection) => {
      connection.respond = () => statement.promise;
      connection.cancelResult = async () => statement.reject(new Error("canceled"));
    };
    const connection = await adapter.acquire();
    await expect(connection.execute("select 1", [], { timeoutMs: 1 })).rejects.toMatchObject({
      code: "timeout",
    });
    await expect(connection.execute("select 1", [], { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "aborted",
    });
    await connection.release();
  });

  test("a statement with a signal that never fires completes normally and is reported", async () => {
    const { adapter, driver } = setup();
    const events: QueryEvent[] = [];
    adapter.on("query", (event) => events.push(event));
    const connection = await adapter.acquire();
    await expect(
      connection.execute("select 1", [], { signal: new AbortController().signal, timeoutMs: 10_000 }),
    ).resolves.toBe(EMPTY);
    await connection.release();
    expect(driver.connections[0]?.cancels).toBe(0);
    expect(events[0]).toMatchObject({ sql: "select 1", error: undefined });
  });

  test("transaction statements", async () => {
    const { adapter, driver } = setup();
    const connection = await adapter.acquire();
    await connection.begin();
    await connection.begin({ isolation: "serializable", readOnly: true, deferrable: true });
    await connection.savepoint('a "b"');
    await connection.rollbackTo("a");
    await connection.releaseSavepoint("a");
    await connection.commit();
    await connection.rollback();
    await connection.release();
    expect(driver.connections[0]?.statements.map((s) => s.sql)).toEqual([
      "begin",
      "begin isolation level serializable, read only, deferrable",
      'savepoint "a ""b"""',
      'rollback to savepoint "a"',
      'release savepoint "a"',
      "commit",
      "rollback",
    ]);
  });

  test.each([
    ["savepoint", ""],
    ["rollbackTo", 42],
    ["releaseSavepoint", "nul\u0000byte"],
  ] as const)("%s refuses the name %o", async (method, name) => {
    const { adapter } = setup();
    const connection = await adapter.acquire();
    expect(() => connection[method](name as string)).toThrow(/savepoint name must be a non-empty string/);
    await connection.release();
  });

  test("streams on the connection keep it, and a broken stream marks it", async () => {
    const { adapter, driver } = setup();
    const rows = [{ n: 1 }, { n: 2 }, { n: 3 }];
    driver.connectionSetup = (connection) => {
      connection.cursorRows = rows;
    };
    const events: QueryEvent[] = [];
    adapter.on("query", (event) => events.push(event));
    const connection = await adapter.acquire();
    const seen: unknown[] = [];
    for await (const row of connection.stream("select n", [], { batchSize: 2 })) seen.push(row.n);
    expect(seen).toEqual([1, 2, 3]);
    expect(events[0]).toMatchObject({ rowCount: 3, queueMs: 0 });
    expect(driver.released).toEqual([]);
    (driver.connections[0] as FakeConnection).cursorError = new Error("unique violation");
    await expect(
      (async () => {
        for await (const _row of connection.stream("select n", [])) {
          // never reached
        }
      })(),
    ).rejects.toBeInstanceOf(ConstraintError);
    await connection.release();
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
  });

  test("a failed read in a stream on the connection marks it for closing", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.cursorRows = [{ n: 1 }, { n: 2 }];
      const open = connection.cursor.bind(connection);
      connection.cursor = async (sql, params) => {
        const cursor = (await open(sql, params)) as FakeCursor;
        cursor.failAtRead = 1;
        return cursor;
      };
    };
    const connection = await adapter.acquire();
    await expect(
      (async () => {
        for await (const _row of connection.stream("select n", [])) {
          // never reached
        }
      })(),
    ).rejects.toThrow("division by zero");
    await connection.release();
    expect(driver.released).toEqual([{ id: 1, destroy: true }]);
  });

  test("a statement or stream on a connection with a stream open is refused, and nothing hangs", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.cursorRows = [{ n: 1 }, { n: 2 }];
    };
    const connection = await adapter.acquire();
    const iterator = connection.stream("select n", [], { batchSize: 1 })[Symbol.asyncIterator]();
    await iterator.next();
    await expect(connection.execute("select 1", [])).rejects.toThrow(QueryError);
    await expect(connection.commit()).rejects.toThrow(/A stream is still open on this connection/);
    await expect(connection.stream("select 2", [])[Symbol.asyncIterator]().next()).rejects.toThrow(
      QueryError,
    );
    await iterator.return?.();
    await expect(connection.execute("select 1", [])).resolves.toBe(EMPTY);
    await connection.release();
    expect(driver.released).toEqual([{ id: 1, destroy: false }]);
    expect(driver.connections[0]?.statements.map((s) => s.sql)).toEqual(["select n", "select 1"]);
  });

  test("a stream whose connection was released stops with a connection error, and its loop ends", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.cursorRows = [{ n: 1 }, { n: 2 }, { n: 3 }];
    };
    const connection = await adapter.acquire();
    const iterator = connection.stream("select n", [], { batchSize: 1 })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ n: 1 });
    await connection.release();
    const error = await rejection(iterator.next());
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ code: "connection", sql: "select n" });
    // The cursor of a connection that has ended is not closed: that would wait forever.
    const cursor = driver.connections[0]?.cursors[0];
    expect(cursor?.reads).toEqual([1]);
    expect(cursor?.closed).toBe(0);
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
  });

  test("leaving the loop of a stream whose connection was released settles at once", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.cursorRows = [{ n: 1 }, { n: 2 }];
    };
    const connection = await adapter.acquire();
    const iterator = connection.stream("select n", [], { batchSize: 1 })[Symbol.asyncIterator]();
    await iterator.next();
    await connection.destroy();
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    expect(driver.connections[0]?.cursors[0]?.closed).toBe(0);
  });

  test("a stream left open when the connection is released closes the connection", async () => {
    const { adapter, driver } = setup();
    driver.connectionSetup = (connection) => {
      connection.cursorRows = [{ n: 1 }, { n: 2 }];
    };
    const connection = await adapter.acquire();
    const iterator = connection.stream("select n", [], { batchSize: 1 })[Symbol.asyncIterator]();
    await iterator.next();
    await connection.release();
    expect(driver.released).toEqual([{ id: 1, destroy: true }]);
    await iterator.return?.();
  });
});

describe("beginSql", () => {
  const all = {
    isolationLevels: ["read committed", "repeatable read", "serializable"],
  } as unknown as Capabilities;

  test.each([
    [undefined, "begin"],
    [{}, "begin"],
    [{ isolation: "read committed" }, "begin isolation level read committed"],
    [{ isolation: "repeatable read" }, "begin isolation level repeatable read"],
    [{ readOnly: false }, "begin read write"],
    [{ deferrable: false }, "begin not deferrable"],
    [
      { isolation: "serializable", readOnly: true, deferrable: true },
      "begin isolation level serializable, read only, deferrable",
    ],
  ] as const)("%o is %s", (options, sql) => {
    expect(beginSql(options, all)).toBe(sql);
  });

  test("refuses an isolation level the dialect lacks with QueryError", () => {
    expect(() => beginSql({ isolation: "repeatable read" }, CAPABILITIES)).toThrow(QueryError);
  });

  test.each([
    ["a string", "serializable", /options must be a plain object/],
    ["an unknown level", { isolation: "snapshot" }, /unknown isolation level "snapshot"/],
    ["a non-boolean readOnly", { readOnly: "yes" }, /readOnly must be a boolean/],
    ["a non-boolean deferrable", { deferrable: 1 }, /deferrable must be a boolean/],
  ])("refuses %s", (_label, options, message) => {
    expect(() => beginSql(options as never, all)).toThrow(message);
  });
});
