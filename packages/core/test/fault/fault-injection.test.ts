// Fault injection (step 21, robustness): every await point of a write, a transaction, a
// Batch, a nested write, a preload and a stream is made to fail in turn, through a fake
// driver that counts its asynchronous calls (acquire, query, cursor, read, close, release)
// and fails the Nth one. Each operation is first run without a fault to count its calls,
// then once for every N. After each run:
//
// - no connection is still checked out, and the adapter closes (it waits for any);
// - a connection left inside a transaction was destroyed, not put back in the pool;
// - the operation failed with the injected error (itself or in its `cause` chain), not
//   with an error a cleanup step raised afterwards.
//
// Two kinds of fault: "once" fails the Nth call only; "outage" fails the Nth call and every
// call after it, as a database that went away would, so that the cleanup (rollback,
// release) fails too and the first error must still be the one that surfaces.

import { describe, expect, test } from "vitest";
import { createAdapter } from "../../src/adapter/adapter.js";
import type { DriverConnection, DriverCursor, DriverWrapper } from "../../src/adapter/driver.js";
import { POSTGRES_CAPABILITIES } from "../../src/compiler/index.js";
import type { PoolEvent, RawResult } from "../../src/contracts/adapter.js";
import {
  type AnySchema,
  change,
  createBatch,
  createRepo,
  from,
  hasMany,
  meta,
  type Repo,
  Schema,
  success,
  t,
} from "../../src/index.js";

// --- schemas and data ----------------------------------------------------------------------

class Crew extends Schema("crews", { id: t.integer().primaryKey().dbGenerated(), name: t.string() }) {
  static boats = hasMany(() => Boat, { foreignKey: "crewId", onReplace: "delete" });
}

class Boat extends Schema("boats", {
  id: t.integer().primaryKey().dbGenerated(),
  crewId: t.integer(),
  name: t.string(),
}) {}

const DATA: Readonly<Record<string, { schema: AnySchema; rows: readonly Record<string, unknown>[] }>> = {
  crews: { schema: Crew, rows: [{ id: 1, name: "Swift" }] },
  boats: {
    schema: Boat,
    rows: [
      { id: 10, crewId: 1, name: "a" },
      { id: 11, crewId: 1, name: "b" },
    ],
  },
};

/** A row of `schema` as the compiler selects it: persisted fields as `c0`, `c1`, …. */
function selected(schema: AnySchema, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  meta(schema).persisted.forEach((field, i) => {
    out[`c${i}`] = values[field.name] ?? null;
  });
  return out;
}

/** Answers a statement as a database holding {@link DATA} would, closely enough for the repo. */
function answer(sql: string, next: () => number): RawResult {
  if (sql.startsWith("insert")) return { rows: [{ c0: next() }], rowCount: 1, insertId: undefined };
  if (sql.startsWith("update") || sql.startsWith("delete"))
    return { rows: [], rowCount: 1, insertId: undefined };
  if (sql.startsWith("select")) {
    const table = /from "([^"]+)"/.exec(sql)?.[1] ?? "";
    const found = DATA[table];
    if (sql.startsWith("select count("))
      return { rows: [{ c0: found?.rows.length ?? 0 }], rowCount: 1, insertId: undefined };
    const rows = found === undefined ? [] : found.rows.map((row) => selected(found.schema, row));
    return { rows, rowCount: rows.length, insertId: undefined };
  }
  // begin, commit, rollback, savepoints.
  return { rows: [], rowCount: 0, insertId: undefined };
}

// --- the faulty driver -----------------------------------------------------------------------

/** The error the driver raises at the chosen call. One instance per run, so it is recognisable. */
class InjectedFault extends Error {
  constructor(
    readonly call: number,
    readonly point: string,
  ) {
    super(`injected fault at call ${call} (${point})`);
    this.name = "InjectedFault";
  }
}

type Mode = "once" | "outage";

class FaultyDriver implements DriverWrapper {
  /** Asynchronous driver calls so far, and what each one was. */
  calls = 0;
  readonly points: string[] = [];
  /** The first fault raised, and every fault. */
  first: InjectedFault | undefined;
  /**
   * The first fault the caller must see: one raised anywhere but in a release or in closing
   * a cursor. Those two the adapter absorbs by design (the rows or the statement's outcome
   * are what the caller needs), and closes the connection instead of pooling it.
   */
  firstReported: InjectedFault | undefined;
  faults = 0;
  acquired = 0;
  released = 0;
  /**
   * Connections handed back to the pool (not destroyed) while inside a transaction, or
   * after a cursor on them failed to close.
   */
  dirtyReturns = 0;
  /** Releases of a connection that was already released. */
  doubleReleases = 0;
  /** The call that fails (counted from the driver's creation); 0 fails none. */
  failAt = 0;
  private id = 1000;

  constructor(private readonly mode: Mode) {}

  /** Counts one await point; throws when it is the one to fail. */
  private point(name: string): void {
    this.calls++;
    this.points.push(name);
    const fail =
      this.mode === "once" ? this.calls === this.failAt : this.failAt > 0 && this.calls >= this.failAt;
    if (!fail) return;
    const fault = new InjectedFault(this.calls, name);
    this.faults++;
    this.first ??= fault;
    if (name !== "release" && name !== "cursor.close") this.firstReported ??= fault;
    throw fault;
  }

  init(): void {}

  async acquire(): Promise<DriverConnection> {
    this.point("acquire");
    this.acquired++;
    return new FaultyConnection(this, () => this.id++);
  }

  async release(connection: DriverConnection, destroy: boolean): Promise<void> {
    const faulty = connection as FaultyConnection;
    if (faulty.released) this.doubleReleases++;
    faulty.released = true;
    this.released++;
    if (!destroy && (faulty.depth > 0 || faulty.cursorFailed)) this.dirtyReturns++;
    this.point("release");
  }

  async destroy(): Promise<void> {}

  stats(): PoolEvent {
    return { size: this.acquired - this.released, idle: 0, waiting: 0 };
  }

  saturated(): boolean {
    return false;
  }

  /** Called by a connection for each of its own await points. */
  at(name: string): void {
    this.point(name);
  }
}

class FaultyConnection implements DriverConnection {
  released = false;
  /** Set when closing a cursor on this connection failed: it must not go back to the pool. */
  cursorFailed = false;
  /** Transaction depth by the statements that succeeded: begin opens, commit or rollback closes. */
  depth = 0;

  constructor(
    private readonly driver: FaultyDriver,
    private readonly next: () => number,
  ) {}

  async query(sql: string): Promise<RawResult> {
    this.driver.at(`query: ${sql.split(" ").slice(0, 3).join(" ")}`);
    if (sql === "begin" || sql.startsWith("begin ") || sql.startsWith("start transaction")) this.depth = 1;
    else if (sql === "commit" || sql === "rollback") this.depth = 0;
    return answer(sql, this.next);
  }

  async cursor(sql: string): Promise<DriverCursor> {
    this.driver.at("cursor");
    const { rows } = answer(sql, this.next);
    let offset = 0;
    return {
      read: async (count) => {
        this.driver.at("cursor.read");
        const batch = rows.slice(offset, offset + count);
        offset += batch.length;
        return batch;
      },
      close: async () => {
        try {
          this.driver.at("cursor.close");
        } catch (error) {
          this.cursorFailed = true;
          throw error;
        }
      },
    };
  }

  async cancel(): Promise<void> {
    this.driver.at("cancel");
  }

  inTransaction(): boolean {
    return this.depth > 0;
  }
}

// --- running a scenario --------------------------------------------------------------------

interface Scenario {
  /** Runs before the fault is armed: reads that give the operation its loaded rows. */
  readonly prepare?: (repo: Repo) => Promise<unknown>;
  /** The operation; resolves with its outcome (a Result for the non-throwing forms). */
  readonly run: (repo: Repo, prepared: unknown) => Promise<unknown>;
}

interface Outcome {
  readonly driver: FaultyDriver;
  readonly settled:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: unknown };
  readonly closed: boolean;
  /** The driver calls `prepare` made, before the fault was armed. */
  readonly offset: number;
}

/** Calls made by `prepare` are not counted against the operation: the fault is armed after it. */
async function execute(scenario: Scenario, failAt: number, mode: Mode): Promise<Outcome> {
  const driver = new FaultyDriver(mode);
  const adapter = createAdapter({
    dialect: "postgres",
    capabilities: POSTGRES_CAPABILITIES,
    quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
    driver: () => driver,
    driverCodecs: {},
    normalizeError: (error) => error,
  });
  const repo = createRepo({ adapter });
  const prepared = scenario.prepare === undefined ? undefined : await scenario.prepare(repo);
  const offset = driver.calls;
  // The Nth call of the operation fails.
  driver.failAt = failAt > 0 ? offset + failAt : 0;
  let settled: Outcome["settled"];
  try {
    settled = { ok: true, value: await scenario.run(repo, prepared) };
  } catch (error) {
    settled = { ok: false, error };
  }
  // The outage is over: closing the adapter must not depend on the driver failing or not.
  driver.failAt = 0;
  const closed = await Promise.race([
    adapter.close().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(resolve, 1_000, false)),
  ]);
  return { driver, settled, closed, offset };
}

/** The error, its `cause` chain, and the error a Result failure or a batch failure holds. */
function chain(value: unknown): unknown[] {
  const seen: unknown[] = [];
  const visit = (item: unknown): void => {
    if (item === undefined || item === null || seen.includes(item)) return;
    seen.push(item);
    if (typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    visit(record.cause);
    if (record.success === false) visit(record.error);
    if ("step" in record && "completed" in record) visit(record.error);
    if (Array.isArray(record.errors)) for (const inner of record.errors) visit(inner);
  };
  visit(value);
  return seen;
}

/** Every point a fault-free run awaits, failed in turn, in both modes. */
async function injectEverywhere(scenario: Scenario): Promise<{ points: readonly string[]; runs: number }> {
  const clean = await execute(scenario, 0, "once");
  // Without a fault the operation succeeds: anything else is a broken scenario, shown as it is.
  if (!clean.settled.ok) throw clean.settled.error;
  if (clean.settled.ok && typeof clean.settled.value === "object" && clean.settled.value !== null) {
    expect((clean.settled.value as { success?: unknown }).success, "a Result is a success").not.toBe(false);
  }
  const points = clean.driver.points.slice(clean.offset);
  const total = points.length;
  expect(total).toBeGreaterThan(0);
  let runs = 0;
  for (const mode of ["once", "outage"] as const) {
    for (let n = 1; n <= total; n++) {
      const outcome = await execute(scenario, n, mode);
      runs++;
      const { driver, settled } = outcome;
      const where = `${mode} fault at call ${n} of ${total} (${points[n - 1]})`;
      expect(driver.first, `${where}: the fault was raised`).toBeDefined();
      expect(driver.acquired - driver.released, `${where}: no connection checked out`).toBe(0);
      expect(driver.doubleReleases, `${where}: no connection released twice`).toBe(0);
      expect(driver.dirtyReturns, `${where}: no connection pooled inside a transaction`).toBe(0);
      expect(outcome.closed, `${where}: the adapter closes`).toBe(true);
      const expected = driver.firstReported;
      if (expected === undefined) {
        // Only a release or a cursor close failed: the operation still succeeds, and the
        // connection was destroyed (checked by dirtyReturns above).
        expect(settled, `${where}: a failed release or close does not fail the operation`).toMatchObject({
          ok: true,
        });
        continue;
      }
      const surfaced = settled.ok ? chain(settled.value) : chain(settled.error);
      expect(surfaced, `${where}: the injected error surfaces`).toContain(expected);
    }
  }
  return { points, runs };
}

// --- scenarios -------------------------------------------------------------------------------

const loadCrew = (repo: Repo) => repo.getOrThrow(Crew, 1);
const loadCrewWithBoats = (repo: Repo) => repo.oneOrThrow(from(Crew, "c").preload("boats"));

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  insert: { run: (repo) => repo.insert(change(Crew, { name: "New" })) },
  // With a budget, the checkout and the statement take the interruptible path.
  "insert with timeoutMs": {
    run: (repo) => repo.insert(change(Crew, { name: "New" }), { timeoutMs: 5_000 }),
  },
  "read with an AbortSignal": {
    run: (repo) => repo.all(from(Crew, "c").preload("boats"), { signal: new AbortController().signal }),
  },
  insertOrThrow: { run: (repo) => repo.insertOrThrow(change(Crew, { name: "New" })) },
  update: {
    prepare: loadCrew,
    run: (repo, crew) => repo.update(change(crew as Crew, { name: "Renamed" })),
  },
  delete: { prepare: loadCrew, run: (repo, crew) => repo.delete(crew as Crew) },
  insertOrUpdate: {
    run: (repo) =>
      repo.insertOrUpdate(change(Crew, { name: "Up" }), { onConflict: { target: ["id"], update: "all" } }),
  },
  insertAll: { run: (repo) => repo.insertAll(Crew, [{ name: "a" }, { name: "b" }]) },
  updateAll: { run: (repo) => repo.updateAll(from(Crew, "c").set({ name: "all" })) },
  deleteAll: { run: (repo) => repo.deleteAll(from(Boat, "b")) },
  transaction: {
    run: (repo) =>
      repo.transaction(async (tx) => {
        const crew = await tx.insertOrThrow(change(Crew, { name: "In a transaction" }));
        await tx.updateOrThrow(change(crew, { name: "Changed" }));
        return crew.id;
      }),
  },
  "nested transaction (savepoint)": {
    run: (repo) =>
      repo.transactionOrThrow(async (tx) => {
        await tx.insertOrThrow(change(Crew, { name: "Outer" }));
        return tx.transactionOrThrow(async (inner) =>
          inner.insertOrThrow(change(Boat, { crewId: 1, name: "Inner" })),
        );
      }),
  },
  "transaction rolled back on purpose": {
    run: async (repo) => {
      const result = await repo.transaction(async (tx) => {
        await tx.insertOrThrow(change(Crew, { name: "Gone" }));
        tx.rollback("on purpose");
      });
      // The rollback is the expected outcome here; report it as a success of the scenario.
      if (result.success) throw new Error("not rolled back");
      return result.error === "on purpose" ? "rolled back" : result;
    },
  },
  Batch: {
    run: (repo) =>
      repo.transaction(
        createBatch()
          .insert("crew", change(Crew, { name: "Batch" }))
          .insert("boat", ({ crew }) => change(Boat, { crewId: crew.id, name: "From a batch" }))
          .run("count", async (tx) => success(await tx.count(from(Boat, "b"))))
          .update("rename", ({ crew }) => change(crew, { name: "Renamed" })),
      ),
  },
  "nested insert": {
    run: (repo) =>
      repo.insert(change(Crew, { name: "Swift" }).putAssoc("boats", [{ name: "a" }, { name: "b" }])),
  },
  "nested update (replace children)": {
    prepare: loadCrewWithBoats,
    run: (repo, crew) =>
      repo.update(change(crew as Crew & { boats: Boat[] }, {}).putAssoc("boats", [{ name: "c" }])),
  },
  "preload (query)": { run: (repo) => repo.all(from(Crew, "c").preload("boats")) },
  "preload (rows)": { prepare: loadCrew, run: (repo, crew) => repo.preload(Crew, crew as Crew, "boats") },
  "preload inside a transaction": {
    run: (repo) => repo.transactionOrThrow((tx) => tx.all(from(Crew, "c").preload("boats"))),
  },
  stream: {
    run: async (repo) => {
      const names: string[] = [];
      for await (const boat of repo.stream(from(Boat, "b"), { batchSize: 1 })) names.push(boat.name);
      return names;
    },
  },
  "stream left early": {
    run: async (repo) => {
      for await (const boat of repo.stream(from(Boat, "b"), { batchSize: 1, timeoutMs: 5_000 }))
        return boat.name;
      return undefined;
    },
  },
  checkout: {
    run: (repo) =>
      repo.checkout(async (conn) => {
        await conn.insertOrThrow(change(Crew, { name: "Pinned" }));
        return conn.all(from(Crew, "c"));
      }),
  },
};

describe("a fault at any await point leaves no connection checked out and surfaces the original error", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(name, async () => {
      const { runs } = await injectEverywhere(scenario);
      expect(runs).toBeGreaterThan(0);
    });
  }
});
