// The driver wrapper over a fake better-sqlite3 handle: no database is opened. The same code
// runs against a real in-memory database in test/driver.itest.ts.
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkRuntime, requireFor, SqliteDriver, type SqliteHandle, type SqliteRuntime } from "./driver.js";
import type { OpenSettings } from "./options.js";

const SETTINGS: OpenSettings = {
  filename: "fake.db",
  readonly: false,
  pragmas: ["pragma foreign_keys = ON"],
  attach: [],
};

type Row = Record<string, unknown>;

/** What a fake statement does: read rows, or write and report changes. */
interface Script {
  readonly rows?: (values: unknown[]) => Row[];
  readonly run?: (values: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  readonly fail?: Error;
}

class FakeStatement {
  readonly reader: boolean;

  constructor(
    private readonly script: Script,
    private readonly bound: unknown[][],
  ) {
    this.reader = script.rows !== undefined;
  }

  all(values: unknown[]): Row[] {
    this.bound.push(values);
    if (this.script.fail !== undefined) throw this.script.fail;
    return this.script.rows?.(values) ?? [];
  }

  run(values: unknown[]) {
    this.bound.push(values);
    if (this.script.fail !== undefined) throw this.script.fail;
    return this.script.run?.(values) ?? { changes: 0, lastInsertRowid: 0 };
  }

  iterate(values: unknown[]): IterableIterator<Row> {
    this.bound.push(values);
    const rows = this.script.rows?.(values) ?? [];
    const fail = this.script.fail;
    let i = 0;
    const iterator: IterableIterator<Row> = {
      next: () => {
        if (fail !== undefined && i === 1) throw fail;
        if (i < rows.length) return { done: false, value: rows[i++] as Row };
        return { done: true, value: undefined };
      },
      return: () => {
        returned.count++;
        return { done: true, value: undefined };
      },
      [Symbol.iterator]: () => iterator,
    };
    return iterator;
  }
}

const returned = { count: 0 };

class FakeHandle {
  open = true;
  inTransaction = false;
  safeIntegers: boolean | undefined = undefined;
  readonly execs: string[] = [];
  readonly prepared: string[] = [];
  readonly bound: unknown[][] = [];
  scripts = new Map<string, Script>();
  execFails: Error | undefined = undefined;
  prepareFails: Error | undefined = undefined;
  closed = 0;

  defaultSafeIntegers(on: boolean): void {
    this.safeIntegers = on;
  }

  exec(sql: string): void {
    if (this.execFails !== undefined) throw this.execFails;
    this.execs.push(sql);
    if (sql === "rollback") this.inTransaction = false;
  }

  prepare(sql: string): FakeStatement {
    if (this.prepareFails !== undefined) throw this.prepareFails;
    this.prepared.push(sql);
    return new FakeStatement(this.scripts.get(sql) ?? { rows: () => [] }, this.bound);
  }

  close(): void {
    this.closed++;
    this.open = false;
  }
}

const drivers: SqliteDriver[] = [];

function setup(settings: OpenSettings = SETTINGS) {
  const handle = new FakeHandle();
  const opened: OpenSettings[] = [];
  const runtime: SqliteRuntime = {
    open: (given) => {
      opened.push(given);
      return handle as unknown as SqliteHandle;
    },
  };
  const hooks = { connected: vi.fn(), disconnected: vi.fn() };
  const driver = new SqliteDriver(settings, hooks, runtime);
  driver.init();
  drivers.push(driver);
  return { driver, handle, hooks, opened };
}

afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.destroy();
  returned.count = 0;
});

describe("checkRuntime", () => {
  test("refuses better-sqlite3 13 under Node-API 9, and accepts every other pairing", () => {
    expect(() => checkRuntime("13.0.3", "9")).toThrow(/needs Node.js 22.14 or later/);
    expect(() => checkRuntime("13.0.3", undefined)).toThrow(/better-sqlite3@12/);
    expect(() => checkRuntime("13.0.3", "10")).not.toThrow();
    expect(() => checkRuntime("12.11.1", "9")).not.toThrow();
  });
});

describe("opening", () => {
  test("opens on first use: safe integers, the pragmas, the attached databases, reported once", async () => {
    const { driver, handle, hooks, opened } = setup({
      ...SETTINGS,
      pragmas: ["pragma foreign_keys = ON", "pragma user_version = 7"],
      attach: [["audit", "audit.db"]],
    });
    expect(opened).toEqual([]);
    expect(driver.stats()).toEqual({ size: 0, idle: 0, waiting: 0 });
    const connection = await driver.acquire();
    expect(handle.safeIntegers).toBe(true);
    expect(handle.execs).toEqual(["pragma foreign_keys = ON", "pragma user_version = 7"]);
    expect(handle.prepared).toEqual(['attach database ? as "audit"']);
    expect(handle.bound).toEqual(["audit.db"]);
    expect(hooks.connected).toHaveBeenCalledTimes(1);
    await driver.release(connection, false);
    await driver.acquire().then((again) => driver.release(again, false));
    expect(opened).toHaveLength(1);
    await driver.destroy();
    expect(handle.closed).toBe(1);
    expect(hooks.disconnected).toHaveBeenCalledTimes(1);
    await driver.destroy();
    expect(hooks.disconnected).toHaveBeenCalledTimes(1);
  });

  test("a pragma that fails closes the handle and fails the acquire", async () => {
    const { driver, handle, hooks } = setup();
    handle.execFails = new Error("near pragma: syntax error");
    await expect(driver.acquire()).rejects.toThrow("near pragma");
    expect(handle.closed).toBe(1);
    expect(hooks.connected).not.toHaveBeenCalled();
  });

  test("a file that cannot be opened fails the acquire", async () => {
    const driver = new SqliteDriver(
      SETTINGS,
      { connected: vi.fn(), disconnected: vi.fn() },
      {
        open: () => {
          throw new Error("unable to open database file");
        },
      },
    );
    driver.init();
    await expect(driver.acquire()).rejects.toThrow("unable to open database file");
  });
});

describe("statements", () => {
  test("a read gives its rows, with integers as numbers where they fit", async () => {
    const { driver, handle } = setup();
    handle.scripts.set("select", {
      rows: () => [{ small: 1n, big: 2n ** 60n, low: -(2n ** 60n), text: "x" }],
    });
    const connection = await driver.acquire();
    expect(await connection.query("select", [], undefined)).toEqual({
      rows: [{ small: 1, big: 2n ** 60n, low: -(2n ** 60n), text: "x" }],
      rowCount: 1,
      insertId: undefined,
    });
    await driver.release(connection, false);
  });

  test("booleans bind as 1 and 0 and dates as timestamp text; other values as they are", async () => {
    const { driver, handle } = setup();
    const connection = await driver.acquire();
    const at = new Date("2026-01-02T03:04:05.006Z");
    await connection.query("select", [true, false, at, 3, "s"], undefined);
    await connection.query("select", [at], undefined);
    const plain = [1, "a"];
    await connection.query("select", plain, undefined);
    expect(handle.bound).toEqual([
      [1, 0, "2026-01-02T03:04:05.006Z", 3, "s"],
      ["2026-01-02T03:04:05.006Z"],
      plain,
    ]);
    expect(handle.bound[2]).toBe(plain);
    await driver.release(connection, false);
  });

  test("a write reports the rows it changed and the key it inserted, only when it inserted one", async () => {
    const { driver, handle } = setup();
    handle.scripts.set("insert small", { run: () => ({ changes: 1, lastInsertRowid: 7n }) });
    handle.scripts.set("insert big", { run: () => ({ changes: 1, lastInsertRowid: 2n ** 60n }) });
    handle.scripts.set("insert number", { run: () => ({ changes: 1, lastInsertRowid: 8 }) });
    handle.scripts.set("update none", { run: () => ({ changes: 0, lastInsertRowid: 7n }) });
    const connection = await driver.acquire();
    expect(await connection.query("insert small", [], undefined)).toEqual({
      rows: [],
      rowCount: 1,
      insertId: 7,
    });
    expect((await connection.query("insert big", [], undefined)).insertId).toBe(2n ** 60n);
    expect((await connection.query("insert number", [], undefined)).insertId).toBe(8);
    expect(await connection.query("update none", [], undefined)).toEqual({
      rows: [],
      rowCount: 0,
      insertId: undefined,
    });
    await driver.release(connection, false);
  });

  test("a statement list without values runs as a script; with values, or another error, it fails", async () => {
    const { driver, handle } = setup();
    const connection = await driver.acquire();
    handle.prepareFails = new RangeError("The supplied SQL string contains more than one statement");
    expect(await connection.query("a; b", [], undefined)).toEqual({
      rows: [],
      rowCount: 0,
      insertId: undefined,
    });
    expect(handle.execs).toContain("a; b");
    await expect(connection.query("a; b", [1], undefined)).rejects.toThrow(/more than one statement/);
    handle.prepareFails = new Error("near x: syntax error");
    await expect(connection.query("x", [], undefined)).rejects.toThrow("syntax error");
    handle.prepareFails = undefined;
    handle.scripts.set("boom", { rows: () => [], fail: new Error("constraint failed") });
    await expect(connection.query("boom", [], undefined)).rejects.toThrow("constraint failed");
    await driver.release(connection, false);
  });

  test("prepared statements are kept, 500 at most, the oldest dropped first", async () => {
    const { driver, handle } = setup();
    const connection = await driver.acquire();
    await connection.query("select 0", [], undefined);
    await connection.query("select 0", [], undefined);
    expect(handle.prepared.filter((sql) => sql === "select 0")).toHaveLength(1);
    for (let i = 1; i <= 500; i++) await connection.query(`select ${i}`, [], undefined);
    await connection.query("select 0", [], undefined);
    expect(handle.prepared.filter((sql) => sql === "select 0")).toHaveLength(2);
    await driver.release(connection, false);
  });
});

describe("the one handle", () => {
  test("one caller at a time: acquires wait for the release, in order", async () => {
    const { driver } = setup();
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
    await driver.release(await second, false);
    await driver.release(await third, false);
    expect(order).toEqual(["second", "third"]);
    expect(driver.saturated()).toBe(false);
    expect(driver.stats()).toEqual({ size: 1, idle: 1, waiting: 0 });
  });

  test("a destroyed connection's open transaction is rolled back instead of the handle closed", async () => {
    const { driver, handle } = setup();
    const connection = await driver.acquire();
    handle.inTransaction = true;
    expect(connection.inTransaction()).toBe(true);
    await expect(connection.cancel()).resolves.toBeUndefined();
    await driver.release(connection, true);
    expect(handle.execs).toContain("rollback");
    expect(handle.closed).toBe(0);
    // Without a transaction there is nothing to roll back.
    const again = await driver.acquire();
    await driver.release(again, true);
    expect(handle.execs.filter((sql) => sql === "rollback")).toHaveLength(1);
  });

  test("a rollback that fails on release is swallowed", async () => {
    const { driver, handle } = setup();
    const connection = await driver.acquire();
    handle.inTransaction = true;
    handle.execFails = new Error("disk I/O error");
    await expect(driver.release(connection, true)).resolves.toBeUndefined();
  });
});

describe("cursors", () => {
  test("read in batches, convert integers, and end", async () => {
    const { driver, handle } = setup();
    handle.scripts.set("rows", { rows: () => [{ n: 1n }, { n: 2n }, { n: 3n }] });
    const connection = await driver.acquire();
    const cursor = await connection.cursor("rows", [true]);
    expect(handle.bound).toEqual([[1]]);
    expect(await cursor.read(2)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await cursor.read(5)).toEqual([{ n: 3 }]);
    expect(await cursor.read(5)).toEqual([]);
    await cursor.close();
    expect(returned.count).toBe(0);
    await driver.release(connection, false);
  });

  test("a cursor left open is closed on release, ending its statement", async () => {
    const { driver, handle } = setup();
    handle.scripts.set("rows", { rows: () => [{ n: 1n }, { n: 2n }] });
    const connection = await driver.acquire();
    const cursor = await connection.cursor("rows", []);
    expect(await cursor.read(1)).toEqual([{ n: 1 }]);
    await driver.release(connection, false);
    expect(returned.count).toBe(1);
    expect(await cursor.read(1)).toEqual([]);
  });

  test("a statement that fails mid-way rejects the read and ends the cursor", async () => {
    const { driver, handle } = setup();
    handle.scripts.set("rows", { rows: () => [{ n: 1n }, { n: 2n }], fail: new Error("integer overflow") });
    const connection = await driver.acquire();
    const cursor = await connection.cursor("rows", []);
    await expect(cursor.read(5)).rejects.toThrow("integer overflow");
    expect(await cursor.read(5)).toEqual([]);
    await driver.release(connection, false);
  });

  test("a statement that cannot be prepared is refused", async () => {
    const { driver, handle } = setup();
    const connection = await driver.acquire();
    handle.prepareFails = new Error("near from: syntax error");
    await expect(connection.cursor("select from", [])).rejects.toThrow("syntax error");
    handle.prepareFails = undefined;
    await driver.release(connection, false);
  });
});

describe("requireFor", () => {
  test("uses the module's URL when there is one", () => {
    const load = requireFor(import.meta.url, undefined);
    expect(load).toBeTypeOf("function");
    expect((load!("better-sqlite3/package.json") as { name: string }).name).toBe("better-sqlite3");
  });

  test("falls back to the CommonJS require when a bundle left import.meta empty", () => {
    const commonJs = (id: string): unknown => ({ id });
    expect(requireFor(undefined, commonJs)).toBe(commonJs);
  });

  test("is undefined when there is neither, so that the version check is skipped", () => {
    expect(requireFor(undefined, undefined)).toBeUndefined();
  });
});
