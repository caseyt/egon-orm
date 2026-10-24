import { EventEmitter } from "node:events";
import { QueryError } from "egon-orm";
import pg from "pg";
import Cursor from "pg-cursor";
import { afterEach, describe, expect, test, vi } from "vitest";
import { sendCancelRequest } from "./cancel.js";
import { type CursorClass, PG_RUNTIME, PgDriver, type PgRuntime } from "./driver.js";
import type { PoolSource } from "./options.js";
import { PG_TYPES } from "./values.js";

// --- pg without a database -----------------------------------------------------------

class FakeClient extends EventEmitter {
  processID: unknown = 4242;
  secretKey: unknown = 777;
  host: unknown = "db";
  port: unknown = 5433;
  ssl: unknown = false;
  sslNegotiation: unknown = "postgres";
  connection: unknown = { stream: { remoteAddress: "10.0.0.7", remotePort: 6432 } };
  status: string | null = "I";
  readonly queries: unknown[] = [];
  readonly releases: unknown[] = [];
  answer: unknown = { rows: [{ one: 1 }], rowCount: 1 };

  query(config: unknown): unknown {
    this.queries.push(config);
    if (config instanceof FakeCursor) return config;
    return Promise.resolve(this.answer);
  }

  release(destroy?: unknown): void {
    this.releases.push(destroy);
  }

  getTransactionStatus(): string | null {
    return this.status;
  }
}

class FakeCursor {
  static created: FakeCursor[] = [];
  readonly reads: number[] = [];
  closed = 0;

  constructor(
    readonly text: string,
    readonly values: unknown[],
    readonly config: unknown,
  ) {
    FakeCursor.created.push(this);
  }

  async read(count: number): Promise<unknown[]> {
    this.reads.push(count);
    return [{ n: 1 }];
  }

  async close(): Promise<void> {
    this.closed++;
  }
}

class FakePool extends EventEmitter {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  ended = 0;
  readonly client = new FakeClient();

  constructor(readonly options: Record<string, unknown> = { max: 3 }) {
    super();
  }

  async connect(): Promise<FakeClient> {
    return this.client;
  }

  async end(): Promise<void> {
    this.ended++;
  }
}

function setup(source?: PoolSource) {
  const pool = new FakePool();
  const runtime: PgRuntime = {
    createPool: vi.fn(() => pool as unknown as pg.Pool),
    sendCancel: vi.fn(async () => undefined),
    loadCursor: vi.fn(async () => FakeCursor as unknown as CursorClass),
  };
  const hooks = { connected: vi.fn(), disconnected: vi.fn() };
  const driver = new PgDriver(source ?? { owned: true, config: { max: 3, host: "db" } }, hooks, runtime);
  return { driver, pool, runtime, hooks };
}

afterEach(() => {
  FakeCursor.created = [];
  vi.restoreAllMocks();
  vi.doUnmock("pg-cursor");
  vi.resetModules();
});

// --- tests ------------------------------------------------------------------------

describe("the pool", () => {
  test("is created on init from the configuration, with listeners for its events", () => {
    const { driver, pool, runtime, hooks } = setup();
    driver.init();
    expect(runtime.createPool).toHaveBeenCalledWith({ max: 3, host: "db" });
    expect(pool.listenerCount("error")).toBe(1);
    pool.emit("connect");
    pool.emit("remove");
    expect(hooks.connected).toHaveBeenCalledTimes(1);
    expect(hooks.disconnected).toHaveBeenCalledTimes(1);
    // An idle connection's error does not end the process.
    expect(() => pool.emit("error", new Error("terminated"))).not.toThrow();
  });

  test("reports its state, and whether a checkout would wait", () => {
    const { driver, pool } = setup();
    driver.init();
    pool.totalCount = 3;
    pool.idleCount = 1;
    pool.waitingCount = 2;
    expect(driver.stats()).toEqual({ size: 3, idle: 1, waiting: 2 });
    expect(driver.saturated()).toBe(false);
    pool.idleCount = 0;
    expect(driver.saturated()).toBe(true);
    pool.totalCount = 2;
    expect(driver.saturated()).toBe(false);
  });

  test.each([{}, { max: 0 }])(
    "without a usable max in its options (%o) counts ten connections as full",
    (options) => {
      const pool = new FakePool(options);
      const { driver } = setup({ owned: false, pool: pool as unknown as pg.Pool });
      driver.init();
      pool.totalCount = 10;
      expect(driver.saturated()).toBe(true);
    },
  );

  test("without options at all counts ten connections as full", () => {
    const pool = new FakePool();
    (pool as { options: unknown }).options = undefined;
    const { driver } = setup({ owned: false, pool: pool as unknown as pg.Pool });
    driver.init();
    pool.totalCount = 10;
    expect(driver.saturated()).toBe(true);
  });

  test("is ended by destroy when the adapter created it, and its event listeners are removed", async () => {
    const { driver, pool } = setup();
    driver.init();
    await driver.destroy();
    expect(pool.ended).toBe(1);
    expect(pool.listenerCount("connect") + pool.listenerCount("remove")).toBe(0);
  });

  test("an error a closing connection reports after destroy does not end the process", async () => {
    // pg-pool's end() resolves before its clients' sockets have closed; a session the server
    // terminates in that window (DROP DATABASE ... WITH (FORCE)) is reported as a pool error.
    const { driver, pool } = setup();
    driver.init();
    await driver.destroy();
    expect(pool.listenerCount("error")).toBe(1);
    expect(() =>
      pool.emit("error", new Error("terminating connection due to administrator command")),
    ).not.toThrow();
  });

  test("a pool you bring gets no error listener and is not ended, only unsubscribed from", async () => {
    const pool = new FakePool();
    pool.on("connect", () => undefined);
    const { driver, runtime } = setup({ owned: false, pool: pool as unknown as pg.Pool });
    driver.init();
    expect(runtime.createPool).not.toHaveBeenCalled();
    expect(pool.listenerCount("error")).toBe(0);
    expect(pool.listenerCount("connect")).toBe(2);
    await driver.destroy();
    expect(pool.ended).toBe(0);
    expect(pool.listenerCount("connect")).toBe(1);
  });

  test("destroy before init does nothing", async () => {
    const { driver, runtime } = setup();
    await driver.destroy();
    expect(runtime.createPool).not.toHaveBeenCalled();
  });

  test("using the wrapper before init is a programming error", () => {
    const { driver } = setup();
    expect(() => driver.stats()).toThrow(/before init/);
  });
});

describe("connections", () => {
  test("run statements with this adapter's parsers, and return pg's rows and row count", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    await expect(connection.query("select $1", [1], undefined)).resolves.toEqual({
      rows: [{ one: 1 }],
      rowCount: 1,
      insertId: undefined,
    });
    await connection.query("select $1", [2], "named");
    expect(pool.client.queries).toEqual([
      { text: "select $1", values: [1], types: PG_TYPES },
      { text: "select $1", values: [2], types: PG_TYPES, name: "named" },
    ]);
  });

  test("report the last result of a statement list, and no row count as zero", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    pool.client.answer = [
      { rows: [{ a: 1 }], rowCount: 1 },
      { rows: [], rowCount: null },
    ];
    await expect(connection.query("select 1; begin", [], undefined)).resolves.toEqual({
      rows: [],
      rowCount: 0,
      insertId: undefined,
    });
  });

  test("go back to the pool, or are closed", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    await driver.release(connection, false);
    await driver.release(connection, true);
    expect(pool.client.releases).toEqual([false, true]);
  });

  test("know whether they are inside a transaction", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    const answers: boolean[] = [];
    for (const status of ["I", "T", "E", null]) {
      pool.client.status = status;
      answers.push(connection.inTransaction());
    }
    expect(answers).toEqual([false, true, true, false]);
  });

  test("open cursors with this adapter's parsers", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    const cursor = await connection.cursor("select n", [1]);
    await expect(cursor.read(5)).resolves.toEqual([{ n: 1 }]);
    await cursor.close();
    const created = FakeCursor.created[0];
    expect(created).toMatchObject({
      text: "select n",
      values: [1],
      config: { types: PG_TYPES },
      reads: [5],
      closed: 1,
    });
    expect(pool.client.queries).toEqual([created]);
  });
});

describe("cancelling", () => {
  test("sends the protocol's cancel request to the address the client is connected to, with its backend key", async () => {
    const { driver, runtime } = setup();
    driver.init();
    await (await driver.acquire()).cancel();
    expect(runtime.sendCancel).toHaveBeenCalledWith(
      {
        host: "10.0.0.7",
        port: 6432,
        serverName: "db",
        processId: 4242,
        secretKey: 777,
        ssl: false,
        sslNegotiation: "postgres",
      },
      10_000,
    );
  });

  test("falls back to the configured host and port without a remote address (a Unix socket)", async () => {
    const { driver, pool, runtime } = setup();
    driver.init();
    pool.client.host = "/var/run/postgresql";
    pool.client.connection = { stream: { remoteAddress: undefined } };
    await (await driver.acquire()).cancel();
    expect(vi.mocked(runtime.sendCancel).mock.calls[0]?.[0]).toMatchObject({
      host: "/var/run/postgresql",
      port: 5433,
      serverName: "/var/run/postgresql",
    });
  });

  test.each([
    [true, "postgres", true, "postgres"],
    [{ ca: "pem" }, "direct", { ca: "pem" }, "direct"],
    [undefined, "require", false, "postgres"],
    [null, undefined, false, "postgres"],
  ])(
    "takes the client's TLS settings: ssl %o, negotiation %o",
    async (ssl, negotiation, expectedSsl, expectedNegotiation) => {
      const { driver, pool, runtime } = setup();
      driver.init();
      pool.client.ssl = ssl;
      pool.client.sslNegotiation = negotiation;
      await (await driver.acquire()).cancel();
      expect(vi.mocked(runtime.sendCancel).mock.calls[0]?.[0]).toMatchObject({
        ssl: expectedSsl,
        sslNegotiation: expectedNegotiation,
      });
    },
  );

  test("is bounded by the pool's connection timeout, also for a pool you bring", async () => {
    const owned = setup({ owned: true, config: { connectionTimeoutMillis: 1_500 } });
    owned.driver.init();
    await (await owned.driver.acquire()).cancel();
    expect(vi.mocked(owned.runtime.sendCancel).mock.calls[0]?.[1]).toBe(1_500);
    const pool = new FakePool({ max: 2, connectionTimeoutMillis: 2_500 });
    const theirs = setup({ owned: false, pool: pool as unknown as pg.Pool });
    theirs.driver.init();
    await (await theirs.driver.acquire()).cancel();
    expect(vi.mocked(theirs.runtime.sendCancel).mock.calls[0]?.[1]).toBe(2_500);
  });

  test("defaults the host and port the way pg does", async () => {
    const { driver, pool, runtime } = setup();
    driver.init();
    pool.client.host = "";
    pool.client.port = undefined;
    pool.client.connection = undefined;
    await (await driver.acquire()).cancel();
    expect(vi.mocked(runtime.sendCancel).mock.calls[0]?.[0]).toMatchObject({
      host: "localhost",
      port: 5432,
      serverName: "localhost",
    });
  });

  test("reports a failed request", async () => {
    const { driver, runtime } = setup();
    vi.mocked(runtime.sendCancel).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    driver.init();
    await expect((await driver.acquire()).cancel()).rejects.toThrow("ECONNREFUSED");
  });

  test.each([
    ["process id", { processID: null }],
    ["secret key", { secretKey: undefined }],
  ])("refuses a client without a backend %s", async (_label, fields) => {
    const { driver, pool, runtime } = setup();
    driver.init();
    Object.assign(pool.client, fields);
    await expect((await driver.acquire()).cancel()).rejects.toThrow(/no backend key/);
    expect(runtime.sendCancel).not.toHaveBeenCalled();
  });
});

describe("a checked-out client that fails between statements", () => {
  test("does not end the process, and is closed on release", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    expect(pool.client.listenerCount("error")).toBe(1);
    expect(() =>
      pool.client.emit("error", new Error("terminating connection due to administrator command")),
    ).not.toThrow();
    await driver.release(connection, false);
    expect(pool.client.releases).toEqual([true]);
    expect(pool.client.listenerCount("error")).toBe(0);
  });

  test("a healthy client stops listening when it goes back", async () => {
    const { driver, pool } = setup();
    driver.init();
    await driver.release(await driver.acquire(), false);
    expect(pool.client.listenerCount("error")).toBe(0);
    expect(pool.client.listenerCount("end")).toBe(0);
    expect(pool.client.releases).toEqual([false]);
  });
});

describe("a cursor whose connection ends", () => {
  // pg-cursor's close() resolves on the next readyForQuery, which an ended connection never sends.
  const hangingClose = () =>
    vi.spyOn(FakeCursor.prototype, "close").mockReturnValue(new Promise(() => undefined));

  test("fails a close that is waiting when the connection ends, and is closed on release", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    const cursor = await connection.cursor("select n", []);
    hangingClose();
    const closing = cursor.close();
    pool.client.emit("end");
    await expect(closing).rejects.toThrow(/connection ended before the cursor was closed/);
    await driver.release(connection, false);
    expect(pool.client.releases).toEqual([true]);
    expect(pool.client.listenerCount("end")).toBe(0);
  });

  test("fails a close at once when the connection has already ended", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    const cursor = await connection.cursor("select n", []);
    pool.client.emit("end");
    const close = hangingClose();
    await expect(cursor.close()).rejects.toThrow(/connection ended/);
    expect(close).not.toHaveBeenCalled();
  });

  test("passes on a close that fails by itself", async () => {
    const { driver } = setup();
    driver.init();
    const cursor = await (await driver.acquire()).cursor("select n", []);
    vi.spyOn(FakeCursor.prototype, "close").mockRejectedValue(new Error("portal gone"));
    await expect(cursor.close()).rejects.toThrow("portal gone");
  });
});

describe("pg-cursor", () => {
  test("is loaded once", async () => {
    const { driver, runtime } = setup();
    await Promise.all([driver.cursorClass(), driver.cursorClass()]);
    await driver.cursorClass();
    expect(runtime.loadCursor).toHaveBeenCalledTimes(1);
  });

  test("a failed load is tried again next time", async () => {
    const { driver, runtime } = setup();
    vi.mocked(runtime.loadCursor).mockRejectedValueOnce(
      new QueryError("query.unsupportedFeature", "missing"),
    );
    await expect(driver.cursorClass()).rejects.toThrow("missing");
    await expect(driver.cursorClass()).resolves.toBe(FakeCursor);
    expect(runtime.loadCursor).toHaveBeenCalledTimes(2);
  });

  test("the real loader gives pg-cursor's class", async () => {
    await expect(PG_RUNTIME.loadCursor()).resolves.toBe(Cursor);
  });

  test("the real loader explains how to install pg-cursor when it is missing", async () => {
    vi.doMock("pg-cursor", () => {
      throw new Error("Cannot find package 'pg-cursor'");
    });
    const { PG_RUNTIME: fresh } = await import("./driver.js");
    const error = await fresh.loadCursor().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("QueryError");
    expect((error as Error).message).toContain(
      'query.pgCursorMissing: Streaming rows from Postgres needs the "pg-cursor" package, which is not installed. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-pgcursormissing',
    );
  });
});

describe("the real runtime", () => {
  test("creates pg pools without connecting, and sends cancel requests with cancel.ts", async () => {
    const pool = PG_RUNTIME.createPool({ max: 1 });
    expect(pool).toBeInstanceOf(pg.Pool);
    expect(pool.totalCount).toBe(0);
    await pool.end();
    expect(PG_RUNTIME.sendCancel).toBe(sendCancelRequest);
  });
});
