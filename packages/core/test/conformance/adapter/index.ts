// The adapter conformance suite: what every adapter must do against a real database,
// written once and run by each dialect package (`@egon-orm/postgres` now; SQLite and
// MySQL later) with a profile of its own. It checks the `Adapter` contract and the
// shared adapter's behaviour over that dialect's driver: connecting and closing, the
// round trip of every type, error normalisation, transactions and savepoints, queueing,
// streams, cancellation and the eviction of broken connections.
//
// Every adapter a test makes is checked for checked-out connections after the test and
// closed: the suite fails on a leaked connection.
import type {
  AdapterEvents,
  ConstraintViolationType,
  DatabaseAdapter,
  Executor,
  PoolEvent,
  QueryEvent,
} from "egon-orm";
import { CastError, ConstraintError, DatabaseError, isEgonError } from "egon-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { IDENTITY } from "../../../src/contracts/type.js";
import { migrationDialectOf } from "../../../src/migration/dialect.js";
import { resolveCodec } from "../../../src/types/index.js";
import { createTestDatabase, type TestDatabase, type TestDatabaseHandle } from "../../support/index.js";
import type { AdapterConformanceProfile, MakeAdapterOptions } from "./profile.js";
import { ROUND_TRIP_CASES } from "./values.js";

export type { AdapterConformanceProfile, MakeAdapterOptions, Violation } from "./profile.js";
export { ROUND_TRIP_CASES, type RoundTripCase } from "./values.js";

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check` holds, polling; fails after `timeoutMs`. */
async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await sleepMs(10);
  }
}

/** Connections currently checked out of an adapter's pool. */
export function checkedOut(stats: PoolEvent): number {
  return stats.size - stats.idle;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/**
 * Runs the conformance suite for one adapter. Call it at the top level of an
 * `*.itest.ts` file; it creates and drops a test database of its own.
 */
export function runAdapterConformance(profile: AdapterConformanceProfile): void {
  describe(`adapter conformance: ${profile.label}`, () => {
    let handle: TestDatabaseHandle;
    let db: TestDatabase;
    const made: DatabaseAdapter[] = [];

    function adapter(options: Partial<MakeAdapterOptions> = {}): DatabaseAdapter {
      const created = profile.makeAdapter(db, { poolMax: options.poolMax ?? 4 });
      made.push(created);
      return created;
    }

    beforeAll(async () => {
      handle = await createTestDatabase(profile.server, { label: "adapter" });
      db = handle.db;
      await db.exec(profile.schema);
    });

    afterEach(async () => {
      const adapters = made.splice(0);
      for (const each of adapters) {
        // Every connection a test checked out must be back by the time it ends.
        await eventually(() => checkedOut(each.poolStats()) === 0);
        await each.close();
      }
    });

    afterAll(async () => {
      await handle?.drop();
    });

    const p = (n: number): string => profile.param(n);

    describe("connecting and closing", () => {
      test("connects on first use, not when created", async () => {
        const a = adapter();
        expect(a.poolStats()).toEqual({ size: 0, idle: 0, waiting: 0 });
        await a.ping();
        expect(a.poolStats().size).toBe(1);
      });

      test("runs a statement with parameters on a pooled connection and returns its rows", async () => {
        const a = adapter();
        const result = await a.execute(`select ${p(1)} as a, ${p(2)} as b`, ["x", "y"]);
        expect(result.rows).toEqual([{ a: "x", b: "y" }]);
        expect(result.rowCount).toBe(1);
      });

      test("reports the rows a write affected", async () => {
        const a = adapter();
        const result = await a.execute(
          `update counters set value = value where id in (${p(1)}, ${p(2)})`,
          [1, 2],
        );
        expect(result.rowCount).toBe(2);
        expect(result.rows).toEqual([]);
      });

      test("close is idempotent and refuses work afterwards", async () => {
        const a = adapter();
        await a.ping();
        const first = a.close();
        expect(a.close()).toBe(first);
        await first;
        const error = await rejection(a.execute("select 1", []));
        expect(error).toBeInstanceOf(DatabaseError);
        expect(error).toMatchObject({ code: "connection" });
        await expect(a.acquire()).rejects.toMatchObject({ code: "connection" });
      });

      test("close waits for a checked-out connection to come back", async () => {
        const a = adapter();
        const connection = await a.acquire();
        let closed = false;
        const closing = a.close().then(() => {
          closed = true;
        });
        await sleepMs(50);
        expect(closed).toBe(false);
        await connection.execute("select 1", []);
        await connection.release();
        await closing;
        expect(closed).toBe(true);
      });

      test("close waits for statements that are running, which complete normally", async () => {
        const a = adapter({ poolMax: 2 });
        const running = [
          a.execute(profile.sleep(0.2), []),
          a.execute(profile.sleep(0.2), []),
          a.execute(profile.sleep(0.2), []),
        ];
        await sleepMs(20);
        await a.close();
        const results = await Promise.all(running);
        expect(results.map((result) => result.rowCount)).toEqual([1, 1, 1]);
      });

      test("reports connect and disconnect events with the pool's state", async () => {
        const a = adapter();
        const connects: PoolEvent[] = [];
        const disconnects: PoolEvent[] = [];
        a.on("connect", (event) => connects.push(event));
        a.on("disconnect", (event) => disconnects.push(event));
        const connection = await a.acquire();
        expect(connects).toHaveLength(1);
        expect(connects[0]?.size).toBe(1);
        if (a.capabilities.multipleConnections) {
          await connection.destroy();
        } else {
          // The one shared handle is not closed by destroy (a transaction left on it is
          // rolled back instead); it is closed with the adapter.
          await connection.destroy();
          expect(disconnects).toHaveLength(0);
          await a.close();
        }
        await eventually(() => disconnects.length === 1);
        expect(disconnects[0]?.size).toBe(0);
      });
    });

    describe("round trip of every type", () => {
      test.for(ROUND_TRIP_CASES.map((c) => [c.label, c] as const))("%s", async ([, roundTrip], { skip }) => {
        const columnType = profile.columnType(roundTrip.type);
        if (columnType === undefined) return skip("the database has no column type for it");
        const a = adapter();
        const requires = roundTrip.requires;
        if (requires !== undefined && !a.capabilities[requires]) {
          // The values are refused before they reach the database (checked).
          const codec = resolveCodec(roundTrip.type, a);
          for (const value of roundTrip.values) {
            if (value !== null) expect(() => codec.toDb(value)).toThrow(CastError);
          }
          return skip(`capability ${requires} is false`);
        }
        const table = `rt_${roundTrip.label.replace(/[^a-z]+/g, "_")}`;
        await db.exec(
          `drop table if exists ${table}; create table ${table} (k integer primary key, v ${columnType})`,
        );
        const codec = resolveCodec(roundTrip.type, a);
        const values = roundTrip.values;
        for (let k = 0; k < values.length; k++) {
          const value = values[k];
          const sent = value === null || codec.toDb === IDENTITY ? value : codec.toDb(value);
          await a.execute(`insert into ${table} (k, v) values (${p(1)}, ${p(2)})`, [k, sent]);
        }
        const { rows } = await a.execute(`select k, v from ${table} order by k`, []);
        expect(rows).toHaveLength(values.length);
        for (let k = 0; k < values.length; k++) {
          const raw = rows[k]?.v;
          const expected = values[k];
          if (expected === null) {
            expect(raw, `value ${k}`).toBeNull();
            continue;
          }
          const loaded = codec.fromDb === IDENTITY ? raw : codec.fromDb(raw);
          const equal = roundTrip.type.equal(expected, loaded);
          if (!equal) expect(loaded, `value ${k}`).toEqual(expected);
          expect(equal, `value ${k}`).toBe(true);
          // The value has the application representation, not the driver's.
          if (expected instanceof Uint8Array)
            expect(Object.getPrototypeOf(loaded)).toBe(Uint8Array.prototype);
          if (typeof expected === "bigint") expect(typeof loaded).toBe("bigint");
          if (expected instanceof Date) expect(loaded).toBeInstanceOf(Date);
        }
      });
    });

    describe("error normalisation", () => {
      const kinds: ConstraintViolationType[] = ["unique", "foreignKey", "check", "exclusion", "notNull"];
      test.for(kinds)(
        "a %s violation is a ConstraintError naming the constraint, keeping the driver error",
        async (kind, { skip }) => {
          const a = adapter();
          const violation = profile.violations[kind];
          // Exclusion constraints are a declared DDL feature (the migration table's
          // `features.exclusionConstraints`); every other kind exists on every database.
          if (kind === "exclusion" && !migrationDialectOf(a.dialect).features.exclusionConstraints) {
            expect(violation).toBeUndefined();
            return skip("feature exclusionConstraints of the migration table is false");
          }
          if (violation === undefined) throw new Error(`The profile has no ${kind} violation.`);
          const error = await rejection(a.execute(violation.sql, []));
          expect(error).toBeInstanceOf(ConstraintError);
          expect(error).toMatchObject({
            type: kind,
            constraint: violation.constraint,
            table: violation.table,
            column: violation.column,
            sql: violation.sql,
          });
          expect((error as ConstraintError).cause).toBeInstanceOf(Error);
          expect(isEgonError((error as ConstraintError).cause)).toBe(false);
        },
      );

      test("a syntax error is a DatabaseError with the SQL and the driver error", async () => {
        const a = adapter();
        const error = await rejection(a.execute("selec 1", []));
        expect(error).toBeInstanceOf(DatabaseError);
        expect(error).toMatchObject({ code: "database", retryable: false, sql: "selec 1" });
        expect((error as DatabaseError).cause).toBeInstanceOf(Error);
      });

      test("errors on a dedicated connection are normalised too, and the connection stays usable", async () => {
        const a = adapter();
        const connection = await a.acquire();
        try {
          const violation = profile.violations.unique;
          if (violation !== undefined) {
            await expect(connection.execute(violation.sql, [])).rejects.toBeInstanceOf(ConstraintError);
          }
          expect((await connection.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
        } finally {
          await connection.release();
        }
      });

      test("a lost update under repeatable read is a retryable serialization failure", async ({ skip }) => {
        const a = adapter();
        if (!a.capabilities.serializationFailures) return skip("capability serializationFailures is false");
        const first = await a.acquire();
        const second = await a.acquire();
        try {
          await first.begin({ isolation: "repeatable read" });
          await first.execute("select value from counters where id = 1", []);
          await second.execute("update counters set value = value + 1 where id = 1", []);
          const error = await rejection(
            first.execute("update counters set value = value + 10 where id = 1", []),
          );
          expect(error).toBeInstanceOf(DatabaseError);
          expect(error).toMatchObject({ code: "serializationFailure", retryable: true });
          await first.rollback();
        } finally {
          await first.release();
          await second.release();
        }
      });

      test("a deadlock is a retryable DatabaseError", async ({ skip }) => {
        const a = adapter();
        if (!a.capabilities.multipleConnections) return skip("capability multipleConnections is false");
        const first = await a.acquire();
        const second = await a.acquire();
        try {
          await first.begin();
          await second.begin();
          await first.execute("update counters set value = value + 1 where id = 1", []);
          await second.execute("update counters set value = value + 1 where id = 2", []);
          const blocked = first.execute("update counters set value = value + 1 where id = 2", []).then(
            () => undefined,
            (error: unknown) => error,
          );
          await sleepMs(50);
          const crossing = second.execute("update counters set value = value + 1 where id = 1", []).then(
            () => undefined,
            (error: unknown) => error,
          );
          const errors = (await Promise.all([blocked, crossing])).filter((error) => error !== undefined);
          expect(errors).toHaveLength(1);
          expect(errors[0]).toBeInstanceOf(DatabaseError);
          expect(errors[0]).toMatchObject({ code: "deadlock", retryable: true });
          await first.rollback();
          await second.rollback();
        } finally {
          await first.release();
          await second.release();
        }
      });
    });

    describe("transactions", () => {
      async function value(a: Executor, id: number): Promise<unknown> {
        const { rows } = await a.execute(`select value from counters where id = ${p(1)}`, [id]);
        return rows[0]?.value;
      }

      test("commit keeps the work and rollback discards it", async () => {
        const a = adapter();
        const connection = await a.acquire();
        // Without a second connection, the values are read on the transaction's own.
        const outside: Executor = a.capabilities.multipleConnections ? a : connection;
        try {
          await connection.execute(`update counters set value = ${p(1)} where id = 1`, [0]);
          await connection.begin();
          await connection.execute(`update counters set value = ${p(1)} where id = 1`, [5]);
          // Not visible outside before commit: only where there is an outside.
          if (a.capabilities.multipleConnections) expect(await value(a, 1)).toBe(0);
          await connection.commit();
          expect(await value(outside, 1)).toBe(5);
          await connection.begin();
          await connection.execute(`update counters set value = ${p(1)} where id = 1`, [9]);
          await connection.rollback();
          expect(await value(outside, 1)).toBe(5);
        } finally {
          await connection.release();
        }
      });

      test("savepoints roll back part of a transaction and can be released", async () => {
        const a = adapter();
        const connection = await a.acquire();
        try {
          await connection.begin();
          await connection.execute(`update counters set value = ${p(1)} where id = 2`, [1]);
          await connection.savepoint("before two");
          await connection.execute(`update counters set value = ${p(1)} where id = 2`, [2]);
          await connection.rollbackTo("before two");
          await connection.savepoint('quoted "name"');
          await connection.execute(`update counters set value = value + ${p(1)} where id = 2`, [10]);
          await connection.releaseSavepoint('quoted "name"');
          await connection.commit();
          expect(await value(connection, 2)).toBe(11);
        } finally {
          await connection.release();
        }
      });

      test("a failed statement inside a savepoint can be rolled back to it", async () => {
        const a = adapter();
        const connection = await a.acquire();
        try {
          await connection.begin();
          await connection.savepoint("sp");
          await expect(connection.execute("selec 1", [])).rejects.toBeInstanceOf(DatabaseError);
          await connection.rollbackTo("sp");
          expect((await connection.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
          await connection.commit();
        } finally {
          await connection.release();
        }
      });

      test.for(["read committed", "repeatable read", "serializable"] as const)(
        "begin takes the isolation level %s",
        async (isolation, { skip }) => {
          const a = adapter();
          if (!a.capabilities.isolationLevels.includes(isolation))
            return skip("not an isolation level of this database");
          const connection = await a.acquire();
          try {
            await connection.begin({ isolation });
            const { rows } = await connection.execute(profile.isolationLevel, []);
            expect(rows[0]?.level).toBe(isolation);
            await connection.commit();
          } finally {
            await connection.release();
          }
        },
      );

      test("a read-only transaction refuses writes; deferrable is accepted with serializable read only", async ({
        skip,
      }) => {
        const a = adapter();
        if (!a.capabilities.readOnlyTransactions) {
          const refusing = await a.acquire();
          try {
            expect(() => refusing.begin({ readOnly: true })).toThrow(`not supported by ${a.dialect}`);
          } finally {
            await refusing.release();
          }
          return skip(
            "capability readOnlyTransactions is false: begin({ readOnly: true }) is refused (checked)",
          );
        }
        const connection = await a.acquire();
        try {
          await connection.begin({ readOnly: true });
          await expect(
            connection.execute("update counters set value = 0 where id = 1", []),
          ).rejects.toBeInstanceOf(DatabaseError);
          await connection.rollback();
          // Deferrable only where the capability says so; otherwise begin refuses it (checked).
          if (a.capabilities.deferrableTransactions) {
            await connection.begin({ isolation: "serializable", readOnly: true, deferrable: true });
          } else {
            expect(() => connection.begin({ readOnly: true, deferrable: true })).toThrow(
              `not supported by ${a.dialect}`,
            );
            await connection.begin({ isolation: "serializable", readOnly: true });
          }
          expect((await connection.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
          await connection.commit();
        } finally {
          await connection.release();
        }
      });

      test("a connection released inside a transaction is closed, never handed to the next caller", async () => {
        const a = adapter({ poolMax: 1 });
        const connection = await a.acquire();
        const { rows } = await connection.execute(profile.backendId, []);
        const before = rows[0]?.id;
        await connection.begin();
        await connection.execute("update counters set value = 77 where id = 1", []);
        await connection.release();
        // With one shared handle there is no other session to hand out: the transaction left
        // on it is rolled back instead, which the value below shows.
        if (a.capabilities.multipleConnections) {
          const after = (await a.execute(profile.backendId, [])).rows[0]?.id;
          expect(after).not.toEqual(before);
        }
        expect(await value(a, 1)).not.toBe(77);
      });

      test("release is idempotent, and a released connection refuses statements", async () => {
        const a = adapter();
        const connection = await a.acquire();
        await connection.release();
        await connection.release();
        await connection.destroy();
        await expect(connection.execute("select 1", [])).rejects.toMatchObject({ code: "connection" });
      });
    });

    describe("pooling", () => {
      test("more concurrent statements than connections queue for one, and report the wait", async () => {
        const a = adapter({ poolMax: 2 });
        const exhausted: PoolEvent[] = [];
        const events: QueryEvent[] = [];
        a.on("poolExhausted", (event) => exhausted.push(event));
        a.on("query", (event) => events.push(event));
        const started = Date.now();
        const results = await Promise.all(Array.from({ length: 6 }, () => a.execute(profile.sleep(0.1), [])));
        expect(results).toHaveLength(6);
        expect(Date.now() - started).toBeGreaterThanOrEqual(250);
        expect(exhausted.length).toBeGreaterThan(0);
        expect(Math.max(...events.map((event) => event.queueMs))).toBeGreaterThan(50);
        expect(a.poolStats().size).toBeLessThanOrEqual(2);
      });

      test("concurrent statements up to the pool size run at the same time", async ({ skip }) => {
        const a = adapter({ poolMax: 4 });
        if (!a.capabilities.multipleConnections) return skip("capability multipleConnections is false");
        const started = Date.now();
        await Promise.all(Array.from({ length: 4 }, () => a.execute(profile.sleep(0.3), [])));
        expect(Date.now() - started).toBeLessThan(1_100);
      });
    });

    describe("streaming", () => {
      test("yields every row, in batches, and returns the connection", async () => {
        const a = adapter();
        const seen: unknown[] = [];
        for await (const row of a.stream(profile.series(1_000), [], { batchSize: 64 })) seen.push(row.n);
        expect(seen).toHaveLength(1_000);
        expect([seen[0], seen[999]]).toEqual([1, 1_000]);
        expect(checkedOut(a.poolStats())).toBe(0);
      });

      test("leaving the loop early closes the cursor and releases the connection", async () => {
        const a = adapter({ poolMax: 1 });
        const events: QueryEvent[] = [];
        a.on("query", (event) => events.push(event));
        let count = 0;
        for await (const _row of a.stream(profile.series(10_000), [], { batchSize: 10 })) {
          count++;
          if (count === 15) break;
        }
        expect(count).toBe(15);
        expect(checkedOut(a.poolStats())).toBe(0);
        // The one connection is usable again.
        expect((await a.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
        expect(events[0]?.rowCount).toBe(20);
      });

      test("an error midway rejects the loop with a normalised error and frees the connection", async () => {
        const a = adapter({ poolMax: 1 });
        const seen: unknown[] = [];
        const error = await rejection(
          (async () => {
            for await (const row of a.stream(profile.failingSeries(1_000, 500), [], { batchSize: 50 }))
              seen.push(row.n);
          })(),
        );
        expect(error).toBeInstanceOf(DatabaseError);
        expect(seen.length).toBeLessThan(500);
        expect((await a.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
      });

      test("a statement on a connection with a stream open is refused, not queued forever", async () => {
        const a = adapter();
        const connection = await a.acquire();
        try {
          const iterator = connection
            .stream(profile.series(100), [], { batchSize: 10 })
            [Symbol.asyncIterator]();
          await iterator.next();
          await expect(connection.execute("select 1", [])).rejects.toThrow(/A stream is still open/);
          await iterator.return?.();
          expect((await connection.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
        } finally {
          await connection.release();
        }
      });

      test("a stream whose connection is released midway stops with a connection error instead of hanging", async () => {
        const a = adapter({ poolMax: 1 });
        const connection = await a.acquire();
        const iterator = connection
          .stream(profile.series(100), [], { batchSize: 10 })
          [Symbol.asyncIterator]();
        const seen: unknown[] = [];
        for (let i = 0; i < 10; i++) seen.push((await iterator.next()).value?.n);
        await connection.release();
        // The ten rows of the first batch were already fetched; the next fetch would go to a
        // connection that has been closed.
        const error = await rejection(iterator.next());
        expect(error).toBeInstanceOf(DatabaseError);
        expect(error).toMatchObject({ code: "connection" });
        await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
        expect(seen).toHaveLength(10);
        // The pool's one connection was closed (a stream was open) and a new one serves on.
        expect((await a.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
      });

      test("streams on a dedicated connection inside a transaction, then the connection goes on", async () => {
        const a = adapter();
        const connection = await a.acquire();
        try {
          await connection.begin();
          let total = 0;
          for await (const _row of connection.stream(profile.series(300), [], { batchSize: 100 })) total++;
          expect(total).toBe(300);
          let partial = 0;
          for await (const _row of connection.stream(profile.series(300), [], { batchSize: 7 })) {
            if (++partial === 3) break;
          }
          expect((await connection.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
          await connection.commit();
        } finally {
          await connection.release();
        }
      });
    });

    describe("cancellation", () => {
      test("an AbortSignal cancels a running statement on the server", async ({ skip }) => {
        const a = adapter({ poolMax: 1 });
        if (!a.capabilities.cancel) return skip("capability cancel is false");
        const controller = new AbortController();
        const started = Date.now();
        const running = a.execute(profile.sleep(10), [], { signal: controller.signal });
        setTimeout(() => controller.abort(), 100);
        const error = await rejection(running);
        expect(error).toBeInstanceOf(DatabaseError);
        expect(error).toMatchObject({ code: "aborted", retryable: false });
        expect(Date.now() - started).toBeLessThan(5_000);
        // The same (only) connection runs the next statement normally.
        expect((await a.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
      });

      test("timeoutMs cancels a statement that runs too long", async ({ skip }) => {
        const a = adapter({ poolMax: 1 });
        if (!a.capabilities.cancel) return skip("capability cancel is false");
        const started = Date.now();
        const error = await rejection(a.execute(profile.sleep(10), [], { timeoutMs: 150 }));
        expect(error).toMatchObject({ code: "timeout" });
        expect(Date.now() - started).toBeLessThan(5_000);
        expect((await a.execute("select 1 as one", [], { timeoutMs: 5_000 })).rows).toEqual([{ one: 1 }]);
      });

      test("a signal that has already fired runs nothing", async () => {
        const a = adapter();
        const events: QueryEvent[] = [];
        a.on("query", (event) => events.push(event));
        await expect(
          a.execute("update counters set value = 1234 where id = 1", [], { signal: AbortSignal.abort() }),
        ).rejects.toMatchObject({ code: "aborted" });
        expect((await a.execute("select value from counters where id = 1", [])).rows[0]?.value).not.toBe(
          1234,
        );
        expect(events[0]?.error).toMatchObject({ code: "aborted" });
      });

      test("aborting while waiting for a connection gives up the wait", async () => {
        const a = adapter({ poolMax: 1 });
        const held = await a.acquire();
        const controller = new AbortController();
        const waiting = a.execute("select 1", [], { signal: controller.signal });
        await sleepMs(30);
        controller.abort();
        await expect(waiting).rejects.toMatchObject({ code: "aborted" });
        await held.release();
        expect((await a.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
      });

      test("timeoutMs also bounds the wait for a free connection", async () => {
        const a = adapter({ poolMax: 1 });
        const held = await a.acquire();
        const started = Date.now();
        const error = await rejection(a.execute("select 1", [], { timeoutMs: 200 }));
        expect(error).toMatchObject({ code: "timeout" });
        expect(Date.now() - started).toBeLessThan(1_500);
        await held.release();
        expect((await a.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
      });

      test("timeoutMs on a dedicated connection inside a transaction cancels the statement only", async ({
        skip,
      }) => {
        const a = adapter();
        if (!a.capabilities.cancel) return skip("capability cancel is false");
        const connection = await a.acquire();
        try {
          await connection.begin();
          await connection.savepoint("before");
          await expect(connection.execute(profile.sleep(10), [], { timeoutMs: 100 })).rejects.toMatchObject({
            code: "timeout",
          });
          await connection.rollbackTo("before");
          expect((await connection.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
          await connection.commit();
        } finally {
          await connection.release();
        }
      });

      test("timeoutMs cancels a COMMIT that waits; the transaction ends without its work", async ({
        skip,
      }) => {
        const a = adapter();
        if (!a.capabilities.cancel) return skip("capability cancel is false");
        const slowCommit = profile.slowCommit;
        if (slowCommit === undefined) return skip("the profile has no safe way to make a COMMIT wait");
        const connection = await a.acquire();
        try {
          await connection.begin();
          const before = (await connection.execute("select value from counters where id = 1", [])).rows;
          await connection.execute("update counters set value = 77 where id = 1", []);
          await connection.execute(slowCommit, []);
          const started = Date.now();
          const error = await rejection(connection.commit({ timeoutMs: 200 }));
          expect(Date.now() - started).toBeLessThan(3_000);
          expect(error).toBeInstanceOf(DatabaseError);
          expect(error).toMatchObject({ code: "timeout", sql: "commit" });
          // The database ended the transaction: nothing of it was committed. (The driver's
          // transaction status is read after the next round trip: it may lag the error.)
          expect((await connection.execute("select value from counters where id = 1", [])).rows).toEqual(
            before,
          );
          expect(connection.inTransaction()).toBe(false);
        } finally {
          await connection.release();
        }
      });

      test("a transaction statement whose budget is spent, or whose signal fired, is not sent", async () => {
        const a = adapter();
        const sqls: string[] = [];
        a.on("query", (event) => sqls.push(event.sql));
        const connection = await a.acquire();
        try {
          await expect(connection.begin(undefined, { signal: AbortSignal.abort() })).rejects.toMatchObject({
            code: "aborted",
          });
          expect(connection.inTransaction()).toBe(false);
          await connection.begin(undefined, { timeoutMs: 5_000 });
          const before = (await connection.execute("select value from counters where id = 1", [])).rows;
          await connection.execute("update counters set value = 78 where id = 1", []);
          await expect(connection.savepoint("s", { timeoutMs: 0 })).rejects.toMatchObject({
            code: "timeout",
          });
          await expect(connection.commit({ timeoutMs: 0 })).rejects.toMatchObject({ code: "timeout" });
          // The COMMIT was not sent: the transaction is still open, and rolls back.
          expect(connection.inTransaction()).toBe(true);
          await connection.rollback({ timeoutMs: 5_000 });
          expect(connection.inTransaction()).toBe(false);
          expect((await connection.execute("select value from counters where id = 1", [])).rows).toEqual(
            before,
          );
        } finally {
          await connection.release();
        }
        // The refused statements were reported as failed, but never reached the database.
        const refused = sqls.filter((sql) => /^(commit|savepoint)/.test(sql));
        expect(refused.map((sql) => sql.replace(/[`"]/g, ""))).toEqual(["savepoint s", "commit"]);
      });

      test("a BEGIN of two statements stopped between them leaves no isolation level for the next transaction", async ({
        skip,
      }) => {
        const a = adapter();
        if (!a.capabilities.isolationLevels.includes("serializable")) {
          return skip("the database has no isolation levels to choose from");
        }
        const connection = await a.acquire();
        try {
          // The signal fires once the first statement (`set transaction …`) has run: the
          // second is refused before it is sent.
          const controller = new AbortController();
          const off = a.on("query", (event) => {
            if (event.sql.startsWith("set transaction")) controller.abort();
          });
          let error: unknown;
          try {
            await connection.begin({ isolation: "serializable" }, { signal: controller.signal });
          } catch (caught) {
            error = caught;
          } finally {
            off();
          }
          if (error === undefined) {
            await connection.rollback();
            return skip("the database begins a transaction with one statement");
          }
          expect(error).toMatchObject({ code: "aborted" });
          expect(connection.inTransaction()).toBe(false);
          // The next transaction on the same connection has the default level.
          await connection.begin();
          const { rows } = await connection.execute(profile.isolationLevel, []);
          expect(rows).toHaveLength(1);
          expect(rows[0]?.level).not.toBe("serializable");
          await connection.rollback();
        } finally {
          await connection.release();
        }
      });

      test("an abort between stream reads keeps the connection", async () => {
        const a = adapter({ poolMax: 1 });
        const before = (await a.execute(profile.backendId, [])).rows[0]?.id;
        const controller = new AbortController();
        const error = await rejection(
          (async () => {
            for await (const _row of a.stream(profile.series(100), [], {
              batchSize: 10,
              signal: controller.signal,
            })) {
              controller.abort();
            }
          })(),
        );
        expect(error).toMatchObject({ code: "aborted" });
        expect((await a.execute(profile.backendId, [])).rows[0]?.id).toEqual(before);
      });

      test("an abort during a stream stops it", async () => {
        const a = adapter({ poolMax: 1 });
        const controller = new AbortController();
        let count = 0;
        const error = await rejection(
          (async () => {
            for await (const _row of a.stream(profile.series(10_000), [], {
              batchSize: 10,
              signal: controller.signal,
            })) {
              if (++count === 25) controller.abort();
            }
          })(),
        );
        expect(error).toMatchObject({ code: "aborted" });
        expect(count).toBeLessThanOrEqual(30);
        expect((await a.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
      });
    });

    describe("broken connections", () => {
      test("a connection whose server process was terminated fails with code connection and is evicted", async ({
        skip,
      }) => {
        const a = adapter({ poolMax: 2 });
        if (!a.capabilities.multipleConnections) return skip("capability multipleConnections is false");
        const connection = await a.acquire();
        const id = (await connection.execute(profile.backendId, [])).rows[0]?.id;
        // `terminate` returns once the server process has ended. Waiting a little more lets
        // the driver see the closed socket while the connection is checked out and idle:
        // the case that must neither crash the process nor hand the connection back.
        await profile.terminate(db, id);
        await sleepMs(100);
        const error = await rejection(connection.execute("select 1", []));
        expect(error).toBeInstanceOf(DatabaseError);
        expect(error).toMatchObject({ code: "connection" });
        await connection.release();
        // The pool goes on with a new connection.
        const next = (await a.execute(profile.backendId, [])).rows[0]?.id;
        expect(next).not.toEqual(id);
      });

      test("an idle pooled connection that dies is dropped, and the next statement gets a new one", async ({
        skip,
      }) => {
        const a = adapter({ poolMax: 1 });
        if (!a.capabilities.multipleConnections) return skip("capability multipleConnections is false");
        const disconnects: PoolEvent[] = [];
        a.on("disconnect", (event) => disconnects.push(event));
        const id = (await a.execute(profile.backendId, [])).rows[0]?.id;
        await profile.terminate(db, id);
        await eventually(() => disconnects.length === 1);
        const next = (await a.execute(profile.backendId, [])).rows[0]?.id;
        expect(next).not.toEqual(id);
      });
    });

    describe("telemetry", () => {
      test("a query event describes each statement, without parameters unless asked", async () => {
        const a = adapter();
        const plain: QueryEvent[] = [];
        const detailed: QueryEvent[] = [];
        a.on("query", (event) => plain.push(event));
        a.on("query", (event) => detailed.push(event), { params: true });
        const context = { requestId: "r-1" };
        const slots = [
          { kind: "inline", index: 0, toDb: undefined, redact: false },
          { kind: "inline", index: 1, toDb: undefined, redact: true },
        ] as const;
        await a.execute(`select ${p(1)} as a, ${p(2)} as b`, ["open", "secret"], { context, slots });
        expect(plain).toHaveLength(1);
        expect(plain[0]).toMatchObject({
          paramCount: 2,
          rowCount: 1,
          error: undefined,
          params: undefined,
          context,
        });
        expect(plain[0]?.durationMs).toBeGreaterThanOrEqual(0);
        expect(plain[0]?.queueMs).toBeGreaterThanOrEqual(0);
        expect(detailed[0]?.params).toEqual(["open", "**redacted**"]);
        expect(JSON.stringify(plain[0])).not.toContain("secret");
      });

      test("a failed statement's event carries the normalised error", async () => {
        const a = adapter();
        const events: AdapterEvents["query"][] = [];
        a.on("query", (event) => events.push(event));
        await expect(a.execute("selec 1", [])).rejects.toBeInstanceOf(DatabaseError);
        expect(events[0]?.error).toBeInstanceOf(DatabaseError);
        expect(events[0]?.sql).toBe("selec 1");
      });

      test("transaction statements are reported too", async () => {
        const a = adapter();
        const sqls: string[] = [];
        a.on("query", (event) => sqls.push(event.sql));
        const connection = await a.acquire();
        // A database that starts a transaction with more than one statement reports each.
        const levels = a.capabilities.isolationLevels.includes("serializable");
        await connection.begin(levels ? { isolation: "serializable" } : undefined);
        const begun = sqls.length;
        await connection.savepoint("s");
        await connection.releaseSavepoint("s");
        await connection.commit();
        await connection.release();
        expect(begun).toBeGreaterThanOrEqual(1);
        expect(sqls).toHaveLength(begun + 3);
        expect(sqls.slice(0, begun).join("; ")).toMatch(/\b(begin|start transaction)\b/);
        if (levels) expect(sqls.slice(0, begun).join("; ")).toMatch(/serializable/);
        expect(sqls[begun + 2]).toBe("commit");
      });

      test("the context given to a transaction statement reaches the listeners with each of its events, and no parameters", async () => {
        const a = adapter();
        const plain: QueryEvent[] = [];
        const detailed: QueryEvent[] = [];
        a.on("query", (event) => plain.push(event));
        a.on("query", (event) => detailed.push(event), { params: true });
        const levels = a.capabilities.isolationLevels.includes("serializable");
        const connection = await a.acquire();
        const context = { step: "transaction" };
        try {
          await connection.begin(levels ? { isolation: "serializable" } : undefined, { context });
          await connection.savepoint("s", { context });
          await connection.rollbackTo("s", { context });
          await connection.releaseSavepoint("s", { context });
          await connection.commit({ context, timeoutMs: 5_000 });
          await connection.begin(undefined, { context });
          await connection.rollback({ context });
        } finally {
          await connection.release();
        }
        expect(plain.length).toBeGreaterThanOrEqual(7);
        for (const event of plain) {
          expect(event).toMatchObject({ context, paramCount: 0, params: undefined, error: undefined });
        }
        expect(detailed.map((event) => event.params)).toEqual(plain.map(() => []));
        expect(plain.slice(-5).map((event) => event.sql.replace(/[`"]/g, ""))).toEqual([
          "rollback to savepoint s",
          "release savepoint s",
          "commit",
          plain.at(-2)?.sql,
          "rollback",
        ]);
      });
    });
  });
}
