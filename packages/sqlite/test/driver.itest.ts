// The driver wrapper over a real in-memory SQLite database (better-sqlite3 runs in-process).
// src/driver.test.ts covers the same code over a fake handle, with no database.
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkRuntime, SQLITE_RUNTIME, SqliteDriver, type SqliteRuntime } from "../src/driver.js";
import type { OpenSettings } from "../src/options.js";

const SETTINGS: OpenSettings = {
  filename: ":memory:",
  readonly: false,
  pragmas: ["pragma foreign_keys = ON"],
  attach: [],
};

const drivers: SqliteDriver[] = [];

function makeDriver(settings: OpenSettings = SETTINGS, runtime?: SqliteRuntime) {
  const hooks = { connected: vi.fn(), disconnected: vi.fn() };
  const driver = new SqliteDriver(settings, hooks, runtime);
  driver.init();
  drivers.push(driver);
  return { driver, hooks };
}

afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.destroy();
});

describe("checkRuntime", () => {
  test("refuses better-sqlite3 13 under Node-API 9, and accepts every other pairing", () => {
    expect(() => checkRuntime("13.0.3", "9")).toThrow(/needs Node.js 22.14 or later/);
    expect(() => checkRuntime("13.0.3", undefined)).toThrow(/better-sqlite3@12/);
    expect(() => checkRuntime("13.0.3", "10")).not.toThrow();
    expect(() => checkRuntime("12.4.1", "9")).not.toThrow();
  });

  test("the real runtime opens a database", () => {
    const database = SQLITE_RUNTIME.open(SETTINGS);
    expect(database.open).toBe(true);
    database.close();
  });
});

describe("SqliteDriver", () => {
  test("opens the database on first use, with the pragmas, and reports it once", async () => {
    const { driver, hooks } = makeDriver({
      ...SETTINGS,
      pragmas: ["pragma foreign_keys = ON", "pragma user_version = 7"],
    });
    expect(hooks.connected).not.toHaveBeenCalled();
    const connection = await driver.acquire();
    expect(hooks.connected).toHaveBeenCalledTimes(1);
    expect((await connection.query("pragma user_version", [], undefined)).rows).toEqual([
      { user_version: 7 },
    ]);
    expect((await connection.query("pragma foreign_keys", [], undefined)).rows).toEqual([
      { foreign_keys: 1 },
    ]);
    await driver.release(connection, false);
    await driver.destroy();
    expect(hooks.disconnected).toHaveBeenCalledTimes(1);
    await driver.destroy();
    expect(hooks.disconnected).toHaveBeenCalledTimes(1);
  });

  test("a pragma that fails closes the database and fails the acquire", async () => {
    const close = vi.fn();
    const runtime: SqliteRuntime = {
      open: () => {
        const database = new Database(":memory:");
        const real = database.close.bind(database);
        database.close = () => {
          close();
          return real();
        };
        return database;
      },
    };
    const { driver, hooks } = makeDriver({ ...SETTINGS, pragmas: ["pragma nonsense("] }, runtime);
    await expect(driver.acquire()).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect(hooks.connected).not.toHaveBeenCalled();
  });

  test("a file that cannot be opened fails the acquire", async () => {
    const { driver } = makeDriver({ ...SETTINGS, filename: "/no/such/directory/x.db", readonly: true });
    await expect(driver.acquire()).rejects.toThrow();
  });

  test("reads integers as numbers where they fit and as bigints where they do not", async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquire();
    const { rows } = await connection.query(
      "select 1 as small, 9223372036854775807 as big, -9007199254740992 as below, 1.5 as real, 'x' as text",
      [],
      undefined,
    );
    expect(rows).toEqual([
      { small: 1, big: 9_223_372_036_854_775_807n, below: -9_007_199_254_740_992n, real: 1.5, text: "x" },
    ]);
    await driver.release(connection, false);
  });

  test("binds booleans as 1 and 0 and dates as timestamp text; leaves other values alone", async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquire();
    const at = new Date("2026-01-02T03:04:05.006Z");
    const { rows } = await connection.query(
      "select ? as t, ? as f, ? as d, ? as n",
      [true, false, at, 3],
      undefined,
    );
    expect(rows).toEqual([{ t: 1, f: 0, d: "2026-01-02T03:04:05.006Z", n: 3 }]);
    expect((await connection.query("select ? as d", [at], undefined)).rows).toEqual([
      { d: "2026-01-02T03:04:05.006Z" },
    ]);
    await driver.release(connection, false);
  });

  test("a write reports the rows it changed and the key it inserted, only when it inserted one", async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquire();
    await connection.query("create table t (id integer primary key autoincrement, v text)", [], undefined);
    expect(await connection.query("insert into t (v) values (?)", ["a"], undefined)).toEqual({
      rows: [],
      rowCount: 1,
      insertId: 1,
    });
    await connection.query(
      "update sqlite_sequence set seq = 9223372036854775000 where name = 't'",
      [],
      undefined,
    );
    expect((await connection.query("insert into t (v) values (?)", ["b"], undefined)).insertId).toBe(
      9_223_372_036_854_775_001n,
    );
    expect(await connection.query("update t set v = ? where id = ?", ["c", 99], undefined)).toEqual({
      rows: [],
      rowCount: 0,
      insertId: undefined,
    });
    await driver.release(connection, false);
  });

  test("a statement list without parameters runs as a script; with parameters it is refused", async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquire();
    expect(
      await connection.query("create table a (x integer); create table b (y integer)", [], undefined),
    ).toEqual({ rows: [], rowCount: 0, insertId: undefined });
    await expect(connection.query("select ?; select ?", [1, 2], undefined)).rejects.toThrow(
      /more than one statement/,
    );
    await expect(connection.query("select nonsense from", [], undefined)).rejects.toThrow(/incomplete input/);
    await driver.release(connection, false);
  });

  test("keeps at most 500 prepared statements, dropping the oldest", async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquire();
    for (let i = 0; i < 502; i++) await connection.query(`select ${i} as n`, [], undefined);
    expect((await connection.query("select 0 as n", [], undefined)).rows).toEqual([{ n: 0 }]);
    await driver.release(connection, false);
  });

  test("one caller at a time: the next acquire waits for the release, in order", async () => {
    const { driver } = makeDriver();
    const first = await driver.acquire();
    expect(driver.saturated()).toBe(true);
    const order: string[] = [];
    const second = driver.acquire().then((connection) => {
      order.push("second");
      return connection;
    });
    const third = driver.acquire().then((connection) => {
      order.push("third");
      return connection;
    });
    expect(driver.stats()).toEqual({ size: 1, idle: 0, waiting: 2 });
    await driver.release(first, false);
    const got = await second;
    expect(order).toEqual(["second"]);
    await driver.release(got, false);
    await driver.release(await third, false);
    expect(order).toEqual(["second", "third"]);
    expect(driver.saturated()).toBe(false);
    expect(driver.stats()).toEqual({ size: 1, idle: 1, waiting: 0 });
  });

  test("before it is opened, the pool is empty", () => {
    const { driver } = makeDriver();
    expect(driver.stats()).toEqual({ size: 0, idle: 0, waiting: 0 });
  });

  test("reports whether a transaction is open; a destroyed connection's transaction is rolled back", async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquire();
    await connection.query("create table t (v integer)", [], undefined);
    await connection.query("begin", [], undefined);
    await connection.query("insert into t values (1)", [], undefined);
    expect(connection.inTransaction()).toBe(true);
    await driver.release(connection, true);
    const again = await driver.acquire();
    expect(again.inTransaction()).toBe(false);
    expect((await again.query("select count(*) as n from t", [], undefined)).rows).toEqual([{ n: 0 }]);
    await expect(again.cancel()).resolves.toBeUndefined();
    await driver.release(again, true);
  });

  test("a failed rollback on release is swallowed", async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquire();
    await connection.query("begin", [], undefined);
    const database = driver.handle();
    const exec = vi.spyOn(database, "exec").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    await expect(driver.release(connection, true)).resolves.toBeUndefined();
    exec.mockRestore();
    database.exec("rollback");
  });

  test("a cursor reads in batches, converts integers, and ends", async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquire();
    const cursor = await connection.cursor(
      "with recursive s(n) as (select 1 union all select n + 1 from s where n < 5) select n from s",
      [],
    );
    expect(await cursor.read(2)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await cursor.read(10)).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }]);
    expect(await cursor.read(10)).toEqual([]);
    await cursor.close();
    await driver.release(connection, false);
  });

  test("a cursor left open is closed on release, so the handle can run the next statement", async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquire();
    const cursor = await connection.cursor("select 1 as n union all select 2", []);
    expect(await cursor.read(1)).toEqual([{ n: 1 }]);
    await driver.release(connection, false);
    expect(await cursor.read(1)).toEqual([]);
    const again = await driver.acquire();
    expect((await again.query("select 3 as n", [], undefined)).rows).toEqual([{ n: 3 }]);
    await driver.release(again, false);
  });

  test("a cursor whose statement fails mid-way rejects the read and ends", async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquire();
    const cursor = await connection.cursor(
      "with recursive s(n) as (select 1 union all select n + 1 from s where n < 3) select case when n = 2 then abs(-9223372036854775807 - 1) else n end as v from s",
      [],
    );
    await expect(cursor.read(10)).rejects.toThrow(/integer overflow/);
    expect(await cursor.read(10)).toEqual([]);
    await cursor.close();
    await driver.release(connection, false);
  });

  test("a cursor over a statement that cannot be prepared is refused", async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquire();
    await expect(connection.cursor("select from nowhere", [])).rejects.toThrow();
    await driver.release(connection, false);
  });
});
