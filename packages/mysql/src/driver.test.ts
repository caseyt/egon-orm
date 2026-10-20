// The driver wrapper over fakes of mysql2's pool, connections and commands: no database.
import { EventEmitter } from "node:events";
import type { Connection, Pool, PoolOptions } from "mysql2";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MYSQL_RUNTIME, MysqlDriver, type MysqlRuntime } from "./driver.js";
import { type PoolSettings, resolveOptions } from "./options.js";

type Callback = (error: unknown, result?: unknown) => void;

/** A running statement whose rows the test emits. */
class FakeCommand extends EventEmitter {}

class FakeConnection extends EventEmitter {
  threadId: number | null = 17;
  readonly stream = new EventEmitter();
  readonly calls: { kind: "query" | "execute"; sql: string; params?: unknown[] }[] = [];
  answer: { error: unknown; result: unknown } = { error: null, result: [{ one: 1 }] };
  command = new FakeCommand();
  paused = 0;
  resumed = 0;
  released = 0;
  destroyed = 0;

  query(sql: string, callback?: Callback): unknown {
    this.calls.push({ kind: "query", sql });
    if (callback === undefined) return this.command;
    queueMicrotask(() => callback(this.answer.error, this.answer.result));
    return undefined;
  }

  execute(sql: string, params: unknown[], callback?: Callback): unknown {
    this.calls.push({ kind: "execute", sql, params });
    if (callback === undefined) return this.command;
    queueMicrotask(() => callback(this.answer.error, this.answer.result));
    return undefined;
  }

  pause(): void {
    this.paused++;
  }

  resume(): void {
    this.resumed++;
    this.emit("resumed");
  }

  release(): void {
    this.released++;
  }

  destroy(): void {
    this.destroyed++;
  }
}

class FakePool extends EventEmitter {
  readonly _allConnections: unknown[] = [];
  readonly _freeConnections: unknown[] = [];
  readonly _connectionQueue: unknown[] = [];
  next: { error: unknown; connection: FakeConnection | undefined } = {
    error: null,
    connection: new FakeConnection(),
  };
  hold = false;
  held: (() => void) | undefined = undefined;
  endError: unknown = null;
  ended = 0;

  getConnection(callback: (error: unknown, connection: FakeConnection | undefined) => void): void {
    const deliver = () => callback(this.next.error, this.next.connection);
    if (this.hold) this.held = deliver;
    else queueMicrotask(deliver);
  }

  end(callback: (error: unknown) => void): void {
    this.ended++;
    queueMicrotask(() => callback(this.endError));
  }
}

/** The connection that sends KILL QUERY. */
class FakeKiller extends EventEmitter {
  readonly executed: { sql: string; params: unknown[] }[] = [];
  answer: unknown = null;
  silent = false;
  destroyed = 0;

  execute(sql: string, params: unknown[], callback: (error: unknown) => void): void {
    this.executed.push({ sql, params });
    if (!this.silent) queueMicrotask(() => callback(this.answer));
  }

  destroy(): void {
    this.destroyed++;
  }
}

function setup(settings: PoolSettings = resolveOptions({ host: "db", pool: { max: 2 } })) {
  const pool = new FakePool();
  const killer = new FakeKiller();
  const killerConfigs: PoolOptions[] = [];
  const runtime: MysqlRuntime = {
    createPool: () => pool as unknown as Pool,
    createConnection: (config) => {
      killerConfigs.push(config);
      return killer as unknown as Connection;
    },
  };
  const hooks = { connected: vi.fn(), disconnected: vi.fn() };
  const driver = new MysqlDriver(settings, hooks, runtime);
  return { driver, pool, killer, killerConfigs, hooks };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MysqlDriver", () => {
  test("the real runtime makes mysql2 objects without connecting", async () => {
    const pool = MYSQL_RUNTIME.createPool({ host: "127.0.0.1", port: 1 });
    expect(typeof pool.getConnection).toBe("function");
    await new Promise<void>((resolve) => pool.end(() => resolve()));
    const connection = MYSQL_RUNTIME.createConnection({ host: "127.0.0.1", port: 1 });
    connection.on("error", () => undefined);
    connection.destroy();
  });

  test("used before init(), it says so", () => {
    const { driver } = setup();
    expect(() => driver.stats()).toThrow(/before init\(\)/);
  });

  test("a new connection's session is UTC and English, its errors are kept, and its close is reported", async () => {
    const { driver, pool, hooks } = setup();
    driver.init();
    const connection = new FakeConnection();
    pool.emit("connection", connection);
    expect(connection.calls).toEqual([
      { kind: "query", sql: "set time_zone = '+00:00', lc_messages = 'en_US'" },
    ]);
    await Promise.resolve();
    expect(connection.destroyed).toBe(0);
    expect(hooks.connected).toHaveBeenCalledTimes(1);
    expect(() => connection.emit("error", new Error("server gone"))).not.toThrow();
    connection.stream.emit("close");
    expect(hooks.disconnected).toHaveBeenCalledTimes(1);
  });

  test("a connection whose session cannot be set is destroyed, never used in the server's zone", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = new FakeConnection();
    connection.answer = { error: new Error("Unknown or incorrect time zone"), result: undefined };
    pool.emit("connection", connection);
    await Promise.resolve();
    expect(connection.destroyed).toBe(1);
  });

  test("a statement without values uses the text protocol, one with values a prepared statement", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    const fake = pool.next.connection as FakeConnection;
    expect(await connection.query("select 1 as one", [], undefined)).toEqual({
      rows: [{ one: 1 }],
      rowCount: 1,
      insertId: undefined,
    });
    await connection.query("select ? as one", [1], undefined);
    expect(fake.calls).toEqual([
      { kind: "query", sql: "select 1 as one" },
      { kind: "execute", sql: "select ? as one", params: [1] },
    ]);
  });

  test("a write reports its rows, the rows an UPDATE matched, its insert id and the transaction state", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    const fake = pool.next.connection as FakeConnection;
    fake.answer = { error: null, result: { affectedRows: 1, insertId: 7, serverStatus: 0x0003, info: "" } };
    expect(await connection.query("insert into t values (?)", [1], undefined)).toEqual({
      rows: [],
      rowCount: 1,
      insertId: 7,
    });
    expect(connection.inTransaction()).toBe(true);
    fake.answer = {
      error: null,
      result: {
        affectedRows: 1,
        insertId: 0,
        serverStatus: 0x0002,
        info: "Rows matched: 3  Changed: 1  Warnings: 0",
      },
    };
    expect(await connection.query("update t set v = ?", [1], undefined)).toEqual({
      rows: [],
      rowCount: 3,
      insertId: undefined,
    });
    expect(connection.inTransaction()).toBe(false);
    // The words are translated with lc_messages; the order is not.
    fake.answer = {
      error: null,
      result: { affectedRows: 0, insertId: 0, info: "Datensätze gefunden: 4  Geändert: 0  Warnungen: 0" },
    };
    expect((await connection.query("update t set v = v", [], undefined)).rowCount).toBe(4);
    // An insert's info ("Records: 2  Duplicates: 1 …") is not a count of rows written.
    fake.answer = {
      error: null,
      result: { affectedRows: 1, insertId: 9, info: "Records: 2  Duplicates: 1  Warnings: 0" },
    };
    expect((await connection.query("insert into t values (?), (?)", [1, 2], undefined)).rowCount).toBe(1);
    fake.answer = { error: null, result: { affectedRows: 1, insertId: "18446744073709551615" } };
    expect((await connection.query("insert into t values (?)", [1], undefined)).insertId).toBe(
      18_446_744_073_709_551_615n,
    );
    expect(connection.inTransaction()).toBe(false);
    fake.answer = { error: null, result: { affectedRows: 0, insertId: null } };
    expect((await connection.query("delete from t", [], undefined)).insertId).toBeUndefined();
    const failure = new Error("boom");
    fake.answer = { error: failure, result: undefined };
    await expect(connection.query("select 1", [], undefined)).rejects.toBe(failure);
  });

  test("release returns a connection to the pool, or destroys it", async () => {
    const { driver, pool } = setup();
    driver.init();
    const fake = pool.next.connection as FakeConnection;
    await driver.release(await driver.acquire(), false);
    await driver.release(await driver.acquire(), true);
    expect([fake.released, fake.destroyed]).toEqual([1, 1]);
  });

  test("an acquire that fails rejects with the driver's error", async () => {
    const { driver, pool } = setup();
    driver.init();
    const failure = new Error("ECONNREFUSED");
    pool.next = { error: failure, connection: undefined };
    await expect(driver.acquire()).rejects.toBe(failure);
  });

  test("with connectionTimeoutMs, a caller waits that long; a connection that comes later goes back", async () => {
    vi.useFakeTimers();
    const { driver, pool } = setup(resolveOptions({ pool: { max: 1, connectionTimeoutMs: 50 } }));
    driver.init();
    pool.hold = true;
    const waiting = driver.acquire();
    const settled = expect(waiting).rejects.toMatchObject({ code: "POOL_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(60);
    await settled;
    pool.held?.();
    expect((pool.next.connection as FakeConnection).released).toBe(1);
    // A late failure is dropped.
    pool.next = { error: new Error("late"), connection: undefined };
    const again = driver.acquire();
    const refused = expect(again).rejects.toMatchObject({ code: "POOL_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(60);
    await refused;
    pool.held?.();
  });

  test("with connectionTimeoutMs, a connection that comes in time clears the timer", async () => {
    const { driver } = setup(resolveOptions({ pool: { connectionTimeoutMs: 1000 } }));
    driver.init();
    const connection = await driver.acquire();
    await driver.release(connection, false);
  });

  test("stats read the pool's lists, and saturated() compares them with max", () => {
    const { driver, pool } = setup();
    driver.init();
    expect(driver.stats()).toEqual({ size: 0, idle: 0, waiting: 0 });
    expect(driver.saturated()).toBe(false);
    pool._allConnections.push(1, 2);
    pool._connectionQueue.push(1);
    expect(driver.stats()).toEqual({ size: 2, idle: 0, waiting: 1 });
    expect(driver.saturated()).toBe(true);
    pool._freeConnections.push(1);
    expect(driver.saturated()).toBe(false);
  });

  test("stats of a pool without the lists are zero", () => {
    const pool = { on: () => undefined } as unknown as Pool;
    const driver = new MysqlDriver(
      resolveOptions({}),
      { connected: () => undefined, disconnected: () => undefined },
      { createPool: () => pool, createConnection: () => ({}) as Connection },
    );
    driver.init();
    expect(driver.stats()).toEqual({ size: 0, idle: 0, waiting: 0 });
  });

  test("destroy ends the pool once it was created, and reports a failure to end it", async () => {
    const { driver, pool } = setup();
    await driver.destroy();
    expect(pool.ended).toBe(0);
    driver.init();
    await driver.destroy();
    expect(pool.ended).toBe(1);
    pool.endError = new Error("end failed");
    await expect(driver.destroy()).rejects.toThrow("end failed");
  });

  test("cancel sends a bound KILL QUERY on a connection of its own, without the pool's settings", async () => {
    const { driver, pool, killer, killerConfigs } = setup();
    driver.init();
    const connection = await driver.acquire();
    await connection.cancel();
    expect(killer.executed).toEqual([{ sql: "kill query ?", params: [17] }]);
    expect(killer.destroyed).toBe(1);
    expect(killerConfigs[0]).toMatchObject({ host: "db", timezone: "Z" });
    expect(killerConfigs[0]).not.toHaveProperty("connectionLimit");
    expect(killerConfigs[0]).not.toHaveProperty("maxIdle");
    (pool.next.connection as FakeConnection).threadId = null;
    await expect(connection.cancel()).rejects.toThrow(/no thread id/);
  });

  test("a KILL QUERY that fails, errors or gets no answer rejects", async () => {
    const { driver, killer } = setup();
    driver.init();
    killer.answer = new Error("not allowed");
    await expect(driver.cancel(5)).rejects.toThrow("not allowed");
    killer.answer = null;
    killer.silent = true;
    const failing = driver.cancel(5);
    killer.emit("error", new Error("socket"));
    await expect(failing).rejects.toThrow("socket");
    vi.useFakeTimers();
    const { driver: slow, killer: quiet } = setup(resolveOptions({ pool: { connectionTimeoutMs: 20 } }));
    slow.init();
    quiet.silent = true;
    const timing = expect(slow.cancel(5)).rejects.toThrow(/no answer within 20 ms/);
    await vi.advanceTimersByTimeAsync(30);
    await timing;
    // A second outcome after the first is ignored.
    quiet.emit("error", new Error("late"));
    const { driver: plain, killer: mute } = setup();
    plain.init();
    mute.silent = true;
    const defaulted = expect(plain.cancel(5)).rejects.toThrow(/within 10000 ms/);
    await vi.advanceTimersByTimeAsync(10_000);
    await defaulted;
  });
});

describe("MysqlCursor", () => {
  async function cursorOver(params: unknown[] = []) {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    const fake = pool.next.connection as FakeConnection;
    const cursor = await connection.cursor("select n from t", params);
    return { cursor, fake };
  }

  test("reads the rows a batch at a time, pausing the socket while a batch waits", async () => {
    const { cursor, fake } = await cursorOver();
    expect(fake.calls).toEqual([{ kind: "query", sql: "select n from t" }]);
    fake.once("resumed", () => {
      fake.command.emit("result", { n: 1 });
      fake.command.emit("result", { n: 2 });
    });
    expect(await cursor.read(2)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(fake.paused).toBe(1);
    fake.once("resumed", () => {
      fake.command.emit("result", { n: 3 });
      fake.command.emit("end");
    });
    expect(await cursor.read(2)).toEqual([{ n: 3 }]);
    expect(await cursor.read(2)).toEqual([]);
    await cursor.close();
  });

  test("a statement with values runs as a prepared statement", async () => {
    const { fake } = await cursorOver([1]);
    expect(fake.calls).toEqual([{ kind: "execute", sql: "select n from t", params: [1] }]);
  });

  test("an error is thrown once the rows before it are read", async () => {
    const { cursor, fake } = await cursorOver();
    const failure = new Error("killed");
    fake.once("resumed", () => {
      fake.command.emit("result", { n: 1 });
      fake.command.emit("error", failure);
    });
    expect(await cursor.read(5)).toEqual([{ n: 1 }]);
    await expect(cursor.read(5)).rejects.toBe(failure);
    expect(await cursor.read(5)).toEqual([]);
  });

  test("closing early drops the rest of the result, so the connection can be used again", async () => {
    const { cursor, fake } = await cursorOver();
    fake.once("resumed", () => fake.command.emit("result", { n: 1 }));
    expect(await cursor.read(1)).toEqual([{ n: 1 }]);
    fake.once("resumed", () => {
      fake.command.emit("result", { n: 2 });
      fake.command.emit("end");
    });
    await cursor.close();
    expect(await cursor.read(1)).toEqual([]);
  });
});
