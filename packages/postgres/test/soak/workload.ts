// The soak workload (step 21, robustness): a mixed load of reads, writes, transactions,
// batches, nested writes, preloads, streams and timeouts against Postgres, through a pool
// of a few connections, while a separate session terminates the workload's own backends at
// random (pg_terminate_backend). It reports what a leak, an unhandled rejection or a
// memory leak would show: connections still checked out at the end, backends left on the
// server after close(), process-level error events, and heap samples over the run.
//
// Only the workload's own backends are killed: the killer filters pg_stat_activity by the
// workload's application_name and by its database, and never touches its own session.
//
// Run by soak.soak.ts (`pnpm test:soak`), which is not part of the normal CI run.

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Post, type TestDatabase, User } from "@egon-orm/test-support";
import {
  ConstraintError,
  cast,
  change,
  createBatch,
  createRepo,
  DatabaseError,
  fragment,
  from,
  isEgonError,
  type Repo,
  RollbackError,
  Schema,
  success,
  t,
} from "egon-orm";
import { postgres } from "../../src/index.js";

/** A table with a fixed total: every transfer moves an amount between two accounts in one transaction. */
export class Account extends Schema("soak_accounts", {
  id: t.integer().primaryKey(),
  balance: t.integer(),
}) {}

/** The DDL of the workload's own table, beside the blog fixture. */
export const SOAK_DDL = `
  CREATE TABLE soak_accounts (id integer PRIMARY KEY, balance integer NOT NULL);
  INSERT INTO soak_accounts (id, balance) SELECT g, 1000 FROM generate_series(1, 10) AS g;
`;

/** The sum of every balance, which no transfer may change. */
export const SOAK_TOTAL = 10_000;

/** Settings of one soak run. */
export interface SoakOptions {
  /** The database to run against: the blog fixture plus {@link SOAK_DDL}. */
  readonly db: TestDatabase;
  /** How long the workload runs, in milliseconds. */
  readonly durationMs: number;
  /** Concurrent workers, each running one operation at a time. */
  readonly workers: number;
  /** The pool's `max`. */
  readonly poolMax: number;
  /** The pause after each operation of a worker, in milliseconds: [min, max]. */
  readonly pauseMs: readonly [number, number];
  /** The time between two kills, in milliseconds: [min, max]. */
  readonly killEveryMs: readonly [number, number];
  /** The time between two heap samples, in milliseconds. */
  readonly sampleEveryMs: number;
  /** Called with a line of progress now and then. */
  readonly progress?: (line: string) => void;
}

/** One heap sample, taken after a full garbage collection. */
export interface HeapSample {
  readonly atMs: number;
  readonly heapUsedMb: number;
  readonly rssMb: number;
}

/** What a soak run observed. */
export interface SoakReport {
  readonly durationMs: number;
  /** Workers whose operation had not finished a minute after the deadline. */
  readonly stuckWorkers: number;
  readonly operations: Readonly<Record<string, number>>;
  /** Failures the workload expects while its connections are being killed, by kind. */
  readonly expectedFailures: Readonly<Record<string, number>>;
  /** Anything else: each one is a defect. At most 50 are kept, with their count. */
  readonly unexpectedFailures: readonly string[];
  readonly unexpectedFailureCount: number;
  readonly kills: number;
  readonly unhandledRejections: number;
  readonly uncaughtExceptions: number;
  /** The most backends of the workload seen on the server at one time. */
  readonly maxBackends: number;
  /** Pool events over the run. */
  readonly connects: number;
  readonly disconnects: number;
  /** `repo.poolStats()` once the workers had stopped: checked out = size - idle. */
  readonly finalPool: { readonly size: number; readonly idle: number; readonly waiting: number };
  /** Whether `close()` resolved within 10 seconds (it waits for every checked-out connection). */
  readonly closedCleanly: boolean;
  /** The workload's backends still on the server 5 seconds after `close()`. */
  readonly backendsAfterClose: number;
  /** The sum of the account balances at the end; must be {@link SOAK_TOTAL}. */
  readonly accountTotal: number;
  readonly heap: readonly HeapSample[];
  /** Median heap of the last samples minus that of the first samples after warm-up, in MB. */
  readonly heapGrowthMb: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const between = (range: readonly [number, number]): number =>
  range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)] as T;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** A full collection: `--expose-gc` turned on at run time, then `gc` taken from a fresh context. */
function collector(): () => void {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  return gc;
}

/** Rejected with this when an operation's own expectation fails (not a database fault). */
class WorkloadError extends Error {}

type Operation = (repo: Repo, state: WorkerState) => Promise<void>;

interface WorkerState {
  readonly worker: number;
  sequence: number;
}

/** The kinds of failure a killed connection or a deliberate timeout can cause. */
function expectedKind(error: unknown): string | undefined {
  if (error instanceof DatabaseError && (error.code === "connection" || error.code === "timeout")) {
    return `DatabaseError:${error.code}`;
  }
  // A transaction whose connection was killed fails its statement with a connection error;
  // the transaction rethrows that error, so it is classified above. A rollback that the
  // callback asked for is an operation's own outcome and never reaches here.
  return undefined;
}

function describeError(error: unknown): string {
  if (isEgonError(error)) return `${error.name}(${error.code}): ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  return String(error);
}

const email = (state: WorkerState): string => `w${state.worker}-${state.sequence++}-${Date.now()}@soak.test`;

/** A random existing user id, or undefined when there are none. */
async function someUserId(repo: Repo): Promise<number | undefined> {
  const user = await repo.first(
    from(User, "u")
      .orderBy(({ u }) => u.id.desc())
      .offset(Math.floor(Math.random() * 20)),
  );
  return user?.id;
}

const OPERATIONS: Readonly<Record<string, { readonly weight: number; readonly run: Operation }>> = {
  insert: {
    weight: 6,
    run: async (repo, state) => {
      const result = await repo.insert(
        cast(User, { email: email(state), name: "Soak", age: 30 }, ["email", "name", "age"])
          .validateRequired(["email"])
          .uniqueConstraint("email"),
      );
      if (!result.success)
        throw new WorkloadError(`insert failed: ${JSON.stringify(result.error.errorMessages())}`);
    },
  },
  duplicate: {
    // A unique violation the changeset declares comes back as a failure, not a throw.
    weight: 1,
    run: async (repo, state) => {
      const address = email(state);
      await repo.insertOrThrow(change(User, { email: address }));
      const again = await repo.insert(change(User, { email: address }).uniqueConstraint("email"));
      if (again.success) throw new WorkloadError("a duplicate email was inserted");
    },
  },
  update: {
    weight: 5,
    run: async (repo) => {
      const id = await someUserId(repo);
      if (id === undefined) return;
      const user = await repo.get(User, id);
      if (user === null) return;
      await repo.update(cast(user, { name: `n${Math.random()}`, age: 40 }, ["name", "age"]), {
        allowStale: true,
      });
    },
  },
  delete: {
    weight: 2,
    run: async (repo) => {
      const post = await repo.first(from(Post, "p").orderBy(({ p }) => p.id));
      if (post === null) return;
      // Another worker may have deleted it first: that is a stale entry, not a fault.
      await repo.delete(post, { allowStale: true });
    },
  },
  read: {
    weight: 8,
    run: async (repo) => {
      const users = await repo.all(
        from(User, "u")
          .orderBy(({ u }) => u.id.desc())
          .limit(20)
          .preload("posts", (q) => q.orderBy(({ posts }) => posts.id).limit(3)),
      );
      await repo.count(from(Post, "p"));
      if (users.length > 20) throw new WorkloadError("limit ignored");
    },
  },
  transfer: {
    // The invariant: every transfer keeps the total, whatever was killed and when.
    weight: 6,
    run: async (repo) => {
      const fromId = between([1, 10]);
      const toId = (fromId % 10) + 1;
      const amount = between([1, 25]);
      await repo.transactionOrThrow(async (tx) => {
        // Both rows locked in key order, so that two transfers never wait on each other in a cycle.
        const rows = await tx.all(
          from(Account, "a")
            .where(({ a }) => a.id.in([fromId, toId]))
            .orderBy(({ a }) => a.id)
            .lock("update"),
        );
        const source = rows.find((row) => row.id === fromId);
        const target = rows.find((row) => row.id === toId);
        if (source === undefined || target === undefined) throw new WorkloadError("an account is missing");
        await tx.updateOrThrow(change(source, { balance: source.balance - amount }));
        await tx.updateOrThrow(change(target, { balance: target.balance + amount }));
      });
    },
  },
  rollback: {
    weight: 2,
    run: async (repo, state) => {
      try {
        await repo.transactionOrThrow(async (tx) => {
          await tx.insertOrThrow(change(User, { email: email(state) }));
          tx.rollback("on purpose");
        });
        throw new WorkloadError("the transaction did not roll back");
      } catch (error) {
        if (!(error instanceof RollbackError)) throw error;
      }
    },
  },
  savepoint: {
    weight: 2,
    run: async (repo, state) => {
      await repo.transactionOrThrow(async (tx) => {
        const user = await tx.insertOrThrow(change(User, { email: email(state) }));
        const inner = await tx.transaction(async (nested) => {
          await nested.insertOrThrow(change(Post, { authorId: user.id, title: "inner" }));
          nested.rollback("inner only");
        });
        if (inner.success) throw new WorkloadError("the savepoint did not roll back");
      });
    },
  },
  batch: {
    weight: 4,
    run: async (repo, state) => {
      const result = await repo.transaction(
        createBatch()
          .insert("user", change(User, { email: email(state) }))
          .insert("post", ({ user }) => change(Post, { authorId: user.id, title: "from a batch" }))
          .run("count", async (tx) => success(await tx.count(from(Post, "p")))),
      );
      if (!result.success) {
        const failed = result.error.error;
        if (failed instanceof Error) throw failed;
        throw new WorkloadError(`batch step ${result.error.step} failed`);
      }
    },
  },
  nested: {
    weight: 4,
    run: async (repo, state) => {
      await repo.insertOrThrow(
        change(User, { email: email(state) }).putAssoc("posts", [{ title: "one" }, { title: "two" }]),
      );
    },
  },
  stream: {
    weight: 2,
    run: async (repo) => {
      let seen = 0;
      const stop = between([1, 60]);
      for await (const post of repo.stream(
        from(Post, "p").orderBy(({ p }) => p.id),
        { batchSize: 10 },
      )) {
        if (post.id <= 0) throw new WorkloadError("bad row");
        seen++;
        if (seen >= stop) break;
      }
    },
  },
  insertAll: {
    weight: 2,
    run: async (repo) => {
      const id = await someUserId(repo);
      if (id === undefined) return;
      await repo.insertAll(
        Post,
        Array.from({ length: 5 }, (_, i) => ({ authorId: id, title: `bulk ${i}` })),
      );
    },
  },
  timeout: {
    // The statement outlives its budget: the adapter cancels it and the call fails with "timeout".
    weight: 1,
    run: async (repo) => {
      try {
        await repo.raw(fragment`select pg_sleep(${0.3})`, { timeoutMs: 30 });
        throw new WorkloadError("the statement did not time out");
      } catch (error) {
        if (!(error instanceof DatabaseError) || error.code !== "timeout") throw error;
      }
    },
  },
  trim: {
    // Keeps the tables small, so that the load stays the same over the whole run.
    weight: 1,
    run: async (repo) => {
      const newest = await repo.first(from(Post, "p").orderBy(({ p }) => p.id.desc()));
      if (newest !== null) await repo.deleteAll(from(Post, "p").where(({ p }) => p.id.lt(newest.id - 300)));
      const user = await repo.first(from(User, "u").orderBy(({ u }) => u.id.desc()));
      if (user === null) return;
      const old = from(User, "u").where(({ u }) => u.id.lt(user.id - 300));
      await repo.deleteAll(from(Post, "p").where(({ p }) => p.authorId.lt(user.id - 300)));
      await repo.deleteAll(old);
    },
  },
};

const WEIGHTED: readonly string[] = Object.entries(OPERATIONS).flatMap(([name, { weight }]) =>
  Array.from({ length: weight }, () => name),
);

/** Runs the workload and reports what it saw. Never throws for a fault it is meant to find. */
export async function runSoak(options: SoakOptions): Promise<SoakReport> {
  const { db } = options;
  const applicationName = `egon-soak-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const adapter = postgres({
    host: db.settings.host,
    port: db.settings.port,
    user: db.settings.user,
    password: db.settings.password,
    database: db.name,
    applicationName,
    pool: { max: options.poolMax, idleTimeoutMs: 5_000, connectionTimeoutMs: 10_000 },
  });
  const repo = createRepo({ adapter });

  const operations: Record<string, number> = {};
  const expectedFailures: Record<string, number> = {};
  const unexpected: string[] = [];
  let unexpectedCount = 0;
  let kills = 0;
  let unhandledRejections = 0;
  let uncaughtExceptions = 0;
  let maxBackends = 0;
  let connects = 0;
  let disconnects = 0;
  const onRejection = (reason: unknown): void => {
    unhandledRejections++;
    if (unexpected.length < 50) unexpected.push(`unhandled rejection: ${describeError(reason)}`);
  };
  const onException = (error: unknown): void => {
    uncaughtExceptions++;
    if (unexpected.length < 50) unexpected.push(`uncaught exception: ${describeError(error)}`);
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  repo.on("connect", () => {
    connects++;
  });
  repo.on("disconnect", () => {
    disconnects++;
  });

  const gc = collector();
  const heap: HeapSample[] = [];
  const start = Date.now();
  const deadline = start + options.durationMs;
  const sample = (): void => {
    gc();
    const usage = process.memoryUsage();
    heap.push({
      atMs: Date.now() - start,
      heapUsedMb: Math.round((usage.heapUsed / 2 ** 20) * 100) / 100,
      rssMb: Math.round((usage.rss / 2 ** 20) * 100) / 100,
    });
  };

  const backends = async (): Promise<number[]> => {
    const rows = await db.query<{ pid: number }>(
      "select pid from pg_stat_activity where application_name = $1 and datname = $2 and pid <> pg_backend_pid()",
      [applicationName, db.name],
    );
    return rows.map((row) => row.pid);
  };

  /** What each worker is running, and since when: shown for a worker that never finishes. */
  const running: { name: string; since: number }[] = Array.from({ length: options.workers }, () => ({
    name: "",
    since: 0,
  }));
  const worker = async (index: number): Promise<void> => {
    const state: WorkerState = { worker: index, sequence: 0 };
    const slot = running[index] as { name: string; since: number };
    while (Date.now() < deadline) {
      const name = pick(WEIGHTED);
      const operation = OPERATIONS[name];
      if (operation === undefined) continue;
      operations[name] = (operations[name] ?? 0) + 1;
      slot.name = name;
      slot.since = Date.now();
      try {
        await operation.run(repo, state);
      } catch (error) {
        const kind = expectedKind(error);
        if (kind !== undefined) {
          expectedFailures[kind] = (expectedFailures[kind] ?? 0) + 1;
        } else if (error instanceof ConstraintError && name === "trim") {
          // A row another worker referenced in the meantime: the trim is best effort.
          expectedFailures["ConstraintError:trim"] = (expectedFailures["ConstraintError:trim"] ?? 0) + 1;
        } else {
          unexpectedCount++;
          if (unexpected.length < 50) unexpected.push(`${name}: ${describeError(error)}`);
        }
      }
      slot.name = "";
      await sleep(between(options.pauseMs));
    }
  };

  const killer = async (): Promise<void> => {
    while (Date.now() < deadline) {
      await sleep(between(options.killEveryMs));
      if (Date.now() >= deadline) break;
      try {
        const pids = await backends();
        maxBackends = Math.max(maxBackends, pids.length);
        if (pids.length === 0) continue;
        const pid = pick(pids);
        // Only a backend of this workload: same application_name, same database.
        const rows = await db.query<{ killed: boolean }>(
          "select pg_terminate_backend(pid) as killed from pg_stat_activity where pid = $1 and application_name = $2 and datname = $3",
          [pid, applicationName, db.name],
        );
        if (rows[0]?.killed === true) kills++;
      } catch (error) {
        unexpectedCount++;
        if (unexpected.length < 50) unexpected.push(`killer: ${describeError(error)}`);
      }
    }
  };

  const sampler = async (): Promise<void> => {
    let lastReport = Date.now();
    sample();
    while (Date.now() < deadline) {
      await sleep(Math.min(options.sampleEveryMs, Math.max(0, deadline - Date.now())));
      sample();
      if (options.progress !== undefined && Date.now() - lastReport >= 15_000) {
        lastReport = Date.now();
        const total = Object.values(operations).reduce((a, b) => a + b, 0);
        const last = heap[heap.length - 1];
        options.progress(
          `soak ${Math.round((Date.now() - start) / 1000)}s: ${total} operations, ${kills} kills, ` +
            `${unexpectedCount} unexpected, heap ${last?.heapUsedMb ?? 0} MB, pool ${JSON.stringify(repo.poolStats())}`,
        );
      }
    }
  };

  let stuck = 0;
  try {
    const all = Promise.all([
      ...Array.from({ length: options.workers }, (_, i) => worker(i)),
      killer(),
      sampler(),
    ]);
    // A worker still busy a minute after the deadline is stuck: report it instead of waiting forever.
    const finished = await Promise.race([
      all.then(() => true),
      sleep(Math.max(0, deadline - Date.now()) + 60_000).then(() => false),
    ]);
    if (!finished) {
      for (const [index, slot] of running.entries()) {
        if (slot.name === "") continue;
        stuck++;
        unexpectedCount++;
        unexpected.push(`stuck: worker ${index} in "${slot.name}" for ${Date.now() - slot.since} ms`);
      }
    }
  } finally {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  }

  // Every worker has finished its last operation: nothing may still be checked out.
  const finalPool = repo.poolStats();
  const accounts = await db.query<{ total: string }>("select sum(balance) as total from soak_accounts");
  const accountTotal = Number(accounts[0]?.total ?? Number.NaN);
  const closedCleanly = await Promise.race([repo.close().then(() => true), sleep(10_000).then(() => false)]);
  let backendsAfterClose = (await backends()).length;
  for (let i = 0; i < 50 && backendsAfterClose > 0; i++) {
    await sleep(100);
    backendsAfterClose = (await backends()).length;
  }

  // Warm-up: the first fifth of the samples (at least one) is not compared.
  const warm = heap.slice(Math.max(1, Math.floor(heap.length / 5)));
  const window = Math.max(1, Math.min(5, Math.floor(warm.length / 3)));
  const heapGrowthMb =
    Math.round(
      (median(warm.slice(-window).map((s) => s.heapUsedMb)) -
        median(warm.slice(0, window).map((s) => s.heapUsedMb))) *
        100,
    ) / 100;

  return {
    durationMs: Date.now() - start,
    stuckWorkers: stuck,
    operations,
    expectedFailures,
    unexpectedFailures: unexpected,
    unexpectedFailureCount: unexpectedCount,
    kills,
    unhandledRejections,
    uncaughtExceptions,
    maxBackends,
    connects,
    disconnects,
    finalPool: { size: finalPool.size, idle: finalPool.idle, waiting: finalPool.waiting },
    closedCleanly,
    backendsAfterClose,
    accountTotal,
    heap,
    heapGrowthMb,
  };
}
