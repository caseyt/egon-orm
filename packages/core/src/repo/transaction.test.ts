// Unit tests of transactions, savepoints, checkouts, the sandbox and Batch's running, over
// the real adapter and a scripted driver: no database. Each test pins the exact statements
// sent, in order, for one path, including the paths where BEGIN, COMMIT, ROLLBACK,
// SAVEPOINT, RELEASE or ROLLBACK TO fail. What a real database does with them is checked by
// the transaction conformance suite.
import { Tag } from "@egon-orm/test-support";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createAdapter, type DatabaseAdapter } from "../adapter/adapter.js";
import type { DriverConnection, DriverCursor, DriverWrapper } from "../adapter/driver.js";
import { POSTGRES_CAPABILITIES } from "../compiler/index.js";
import type { PoolEvent, RawResult } from "../contracts/adapter.js";
import { ConstraintError, DatabaseError, QueryError, RollbackError } from "../errors.js";
import { change, createBatch, failure, fragment, from, success } from "../index.js";
import { createSandbox, expectQueries } from "../testing.js";
import { insertAll } from "./bulk.js";
import { QueryHub, ReadCore } from "./read.js";
import { createRepo, type Repo } from "./repo.js";
import { atomically } from "./transaction.js";

// --- a scripted driver -----------------------------------------------------------------

type Row = Record<string, unknown>;

/** A pool whose connections record every statement and answer as scripted. */
class ScriptedPool implements DriverWrapper {
  /** Every statement sent, on any connection, in order. */
  readonly sent: string[] = [];
  /** The error a statement fails with, if any. */
  fail: (sql: string) => unknown = () => undefined;
  /** How long a statement runs, in milliseconds. */
  delay: (sql: string) => number = () => 0;
  /** The rows a statement returns. */
  rows: (sql: string) => Row[] = () => [{ n: 1 }];
  cursorRows: Row[] = [];
  cursorFailure: unknown = undefined;
  running = 0;
  mostAtOnce = 0;
  acquired = 0;
  released = 0;
  destroyed = 0;
  cancels = 0;
  /** When set, `acquire` waits for it. */
  gate: Promise<void> | undefined = undefined;

  init(): void {}

  async acquire(): Promise<DriverConnection> {
    if (this.gate !== undefined) await this.gate;
    this.acquired++;
    const pool = this;
    let inTransaction = false;
    let running: ((error: unknown) => void) | undefined;
    return {
      query(text: string): Promise<RawResult> {
        const sql = readable(text);
        pool.sent.push(sql);
        pool.running++;
        pool.mostAtOnce = Math.max(pool.mostAtOnce, pool.running);
        return new Promise<RawResult>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const done = (): void => {
            pool.running--;
            running = undefined;
            const error = pool.fail(sql);
            if (error !== undefined) {
              reject(error);
              return;
            }
            if (sql.startsWith("begin")) inTransaction = true;
            if (sql === "commit" || sql === "rollback") inTransaction = false;
            const rows = pool.rows(sql);
            resolve({ rows, rowCount: rows.length, insertId: undefined });
          };
          running = (error) => {
            if (timer !== undefined) clearTimeout(timer);
            pool.running--;
            running = undefined;
            reject(error);
          };
          const ms = pool.delay(sql);
          if (ms > 0) timer = setTimeout(done, ms);
          else queueMicrotask(done);
        });
      },
      async cursor(sql: string): Promise<DriverCursor> {
        pool.sent.push(sql);
        let at = 0;
        return {
          async read(count: number) {
            if (pool.cursorFailure !== undefined) throw pool.cursorFailure;
            const out = pool.cursorRows.slice(at, at + count);
            at += count;
            return out;
          },
          async close() {},
        };
      },
      async cancel(): Promise<void> {
        pool.cancels++;
        running?.(new Error("canceling statement due to user request"));
      },
      inTransaction: () => inTransaction,
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

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function setup(options: { warn?: boolean } = {}) {
  const pool = new ScriptedPool();
  const adapter: DatabaseAdapter = createAdapter({
    dialect: "postgres",
    capabilities: POSTGRES_CAPABILITIES,
    quoteIdentifier: quote,
    driver: () => pool,
    driverCodecs: {},
    normalizeError: (error) => error,
  });
  const repo = createRepo({ adapter, warnOnRootUseInTransaction: options.warn ?? false });
  return { pool, adapter, repo };
}

/**
 * A statement that is just the identifier `text` (spaces become `_`), which the scripted
 * pool logs back as `text`, so that the log reads as the test does.
 */
const say = (text: string) => fragment`${fragment.ident(text.replaceAll(" ", "_"))}`;

/** The statement as the tests name it: `"not_awaited"` is logged as `not awaited`; anything else as it is. */
function readable(sql: string): string {
  const quoted = /^"([A-Za-z0-9_]+)"$/.exec(sql);
  return quoted === null ? sql : (quoted[1] as string).replaceAll("_", " ");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const databaseError = (message = "the database said no") => new DatabaseError(message, { code: "database" });

const serializationFailure = () =>
  new DatabaseError("could not serialize access", { code: "serializationFailure" });

const violation = () =>
  new ConstraintError({
    type: "unique",
    constraint: "tags_name_key",
    table: "tags",
    column: undefined,
    detail: undefined,
  });

afterEach(() => {
  vi.restoreAllMocks();
});

// --- commit and rollback -----------------------------------------------------------------

describe("statement sequences", () => {
  test("a callback that returns: BEGIN, its statements, COMMIT; the connection goes back to the pool", async () => {
    const { pool, repo } = setup();
    const result = await repo.transaction(async (tx) => {
      await tx.raw(say("one"));
      await tx.raw(say("two"));
      return "value";
    });
    expect(result).toEqual({ success: true, data: "value" });
    expect(pool.sent).toEqual(["begin", "one", "two", "commit"]);
    expect([pool.acquired, pool.released, pool.destroyed]).toEqual([1, 1, 0]);
  });

  test("a callback that returns a plain value, not a promise, commits too", async () => {
    const { pool, repo } = setup();
    expect(await repo.transaction(() => 7)).toEqual({ success: true, data: 7 });
    expect(pool.sent).toEqual(["begin", "commit"]);
  });

  test("tx.rollback(reason): BEGIN, the statements before it, ROLLBACK, and the reason as the failure", async () => {
    const { pool, repo } = setup();
    let after = false;
    const result = await repo.transaction(async (tx) => {
      await tx.raw(say("one"));
      tx.rollback({ code: 42 });
      after = true;
    });
    expect(result).toEqual({ success: false, error: { code: 42 } });
    expect(after).toBe(false);
    expect(pool.sent).toEqual(["begin", "one", "rollback"]);
    expect(pool.released).toBe(1);
  });

  test("a rollback the callback catches still rolls back with its reason", async () => {
    const { pool, repo } = setup();
    const result = await repo.transaction(async (tx) => {
      try {
        tx.rollback("first reason");
      } catch {
        // swallowed
      }
      try {
        tx.rollback("second reason");
      } catch {
        // swallowed too: the first reason stays
      }
      expect(await rejection(tx.raw(say("refused")))).toBeInstanceOf(QueryError);
      return "returned";
    });
    expect(result).toEqual({ success: false, error: "first reason" });
    expect(pool.sent).toEqual(["begin", "rollback"]);
  });

  test("a throw: ROLLBACK, and the same error rethrown", async () => {
    const { pool, repo } = setup();
    const boom = new Error("boom");
    const error = await rejection(
      repo.transaction(async (tx) => {
        await tx.raw(say("one"));
        throw boom;
      }),
    );
    expect(error).toBe(boom);
    expect(pool.sent).toEqual(["begin", "one", "rollback"]);
  });

  test("a synchronous throw from the callback is handled as a throw", async () => {
    const { pool, repo } = setup();
    const boom = new Error("sync");
    expect(
      await rejection(
        repo.transaction(() => {
          throw boom;
        }),
      ),
    ).toBe(boom);
    expect(pool.sent).toEqual(["begin", "rollback"]);
  });

  test("isolation and readOnly are written into BEGIN", async () => {
    const { pool, repo } = setup();
    await repo.transaction(async () => undefined, { isolation: "serializable", readOnly: true });
    await repo.transaction(async () => undefined, { readOnly: false });
    await repo.transaction(async () => undefined, { isolation: "read committed" });
    expect(pool.sent).toEqual([
      "begin isolation level serializable, read only",
      "commit",
      "begin read write",
      "commit",
      "begin isolation level read committed",
      "commit",
    ]);
  });

  test("transactionOrThrow returns the value; a rollback throws RollbackError", async () => {
    const { repo } = setup();
    expect(await repo.transactionOrThrow(async () => "v")).toBe("v");
    const error = await rejection(repo.transactionOrThrow(async (tx) => tx.rollback("why")));
    expect(error).toBeInstanceOf(RollbackError);
    expect((error as RollbackError).reason).toBe("why");
    expect((error as RollbackError).code).toBe("rollback");
    expect((error as Error).message).toContain("tx.rollback(reason) was called");
  });
});

// --- failures of the transaction statements --------------------------------------------

describe("when a transaction statement fails", () => {
  test("BEGIN fails: the error is thrown, nothing else is sent, the callback never runs", async () => {
    const { pool, repo } = setup();
    const refused = databaseError("no begin");
    pool.fail = (sql) => (sql === "begin" ? refused : undefined);
    const fn = vi.fn();
    expect(await rejection(repo.transaction(fn))).toBe(refused);
    expect(fn).not.toHaveBeenCalled();
    expect(pool.sent).toEqual(["begin"]);
    expect(pool.released + pool.destroyed).toBe(1);
  });

  test("COMMIT fails: its error is thrown and the connection, still in a transaction, is closed", async () => {
    const { pool, repo } = setup();
    const refused = databaseError("no commit");
    pool.fail = (sql) => (sql === "commit" ? refused : undefined);
    expect(await rejection(repo.transaction(async (tx) => tx.raw(say("one"))))).toBe(refused);
    expect(pool.sent).toEqual(["begin", "one", "commit"]);
    expect(pool.destroyed).toBe(1);
  });

  test("ROLLBACK fails after a throw: the original error is rethrown with the failure as suppressed; the connection is closed", async () => {
    const { pool, repo } = setup();
    const lost = databaseError("no rollback");
    pool.fail = (sql) => (sql === "rollback" ? lost : undefined);
    const boom = new Error("boom");
    const error = await rejection(
      repo.transaction(async () => {
        throw boom;
      }),
    );
    expect(error).toBe(boom);
    expect((error as { suppressed?: unknown }).suppressed).toBe(lost);
    expect(Object.keys(error as object)).not.toContain("suppressed");
    expect(pool.sent).toEqual(["begin", "rollback"]);
    expect([pool.released, pool.destroyed]).toEqual([0, 1]);
  });

  test("a thrown value that cannot carry suppressed is rethrown as it is", async () => {
    const { pool, repo } = setup();
    pool.fail = (sql) => (sql === "rollback" ? databaseError() : undefined);
    const frozen = Object.freeze(new Error("frozen"));
    expect(
      await rejection(
        repo.transaction(async () => {
          throw frozen;
        }),
      ),
    ).toBe(frozen);
    expect(
      await rejection(
        repo.transaction(async () => {
          throw "a string";
        }),
      ),
    ).toBe("a string");
    const owned = Object.assign(new Error("has one"), { suppressed: "its own" });
    const error = await rejection(
      repo.transaction(async () => {
        throw owned;
      }),
    );
    expect((error as { suppressed: unknown }).suppressed).toBe("its own");
  });

  test("ROLLBACK fails after tx.rollback(reason): the failure is thrown and the connection closed", async () => {
    const { pool, repo } = setup();
    const lost = databaseError("no rollback");
    pool.fail = (sql) => (sql === "rollback" ? lost : undefined);
    expect(await rejection(repo.transaction(async (tx) => tx.rollback("reason")))).toBe(lost);
    expect(pool.destroyed).toBe(1);
  });

  test("SAVEPOINT fails: the nested call throws, and the transaction can only roll back", async () => {
    const { pool, repo } = setup();
    const refused = databaseError("no savepoint");
    pool.fail = (sql) => (sql.startsWith("savepoint") ? refused : undefined);
    const result = await repo.transaction(async (tx) => {
      expect(await rejection(tx.transaction(async () => "never"))).toBe(refused);
      return "returned";
    });
    expect(result).toEqual({ success: false, error: refused });
    expect(pool.sent).toEqual(["begin", 'savepoint "egon_1"', "rollback"]);
  });

  test("RELEASE fails: the nested call throws, and the enclosing transaction can only roll back as a whole", async () => {
    const { pool, repo } = setup();
    const refused = databaseError("no release");
    pool.fail = (sql) => (sql.startsWith("release") ? refused : undefined);
    const result = await repo.transaction(async (tx) => {
      expect(await rejection(tx.transaction(async (inner) => inner.raw(say("inner"))))).toBe(refused);
      const error = await rejection(tx.raw(say("refused")));
      expect((error as QueryError).message).toContain("could not roll back to one of its savepoints");
      expect(await rejection(tx.transaction(async () => undefined))).toBeInstanceOf(QueryError);
      return "returned";
    });
    expect(result).toEqual({ success: false, error: refused });
    expect(pool.sent).toEqual([
      "begin",
      'savepoint "egon_1"',
      "inner",
      'release savepoint "egon_1"',
      "rollback",
    ]);
    const thrown = await rejection(
      repo.transactionOrThrow(async (tx) => tx.transaction(async () => undefined)),
    );
    expect(thrown).toBe(refused);
  });

  test("ROLLBACK TO fails after a throw: the original is rethrown with suppressed, and the enclosing transaction rolls back", async () => {
    const { pool, repo } = setup();
    const lost = databaseError("no rollback to");
    pool.fail = (sql) => (sql.startsWith("rollback to") ? lost : undefined);
    const boom = new Error("inner boom");
    const outcome = await repo.transaction(async (tx) => {
      const error = await rejection(
        tx.transaction(async () => {
          throw boom;
        }),
      );
      expect(error).toBe(boom);
      expect((error as { suppressed?: unknown }).suppressed).toBe(lost);
    });
    expect(outcome).toEqual({ success: false, error: lost });
    expect(pool.sent).toEqual(["begin", 'savepoint "egon_1"', 'rollback to savepoint "egon_1"', "rollback"]);
    // The connection itself is fine: the full ROLLBACK worked.
    expect(pool.destroyed).toBe(0);
  });

  test("when two savepoints fail to roll back, the first failure is the one that stops the transaction", async () => {
    const { pool, repo } = setup();
    const failures: unknown[] = [];
    pool.fail = (sql) => {
      if (!sql.startsWith("rollback to")) return undefined;
      const error = databaseError(`lost ${failures.length}`);
      failures.push(error);
      return error;
    };
    const outcome = await repo.transaction(async (tx) => {
      await tx
        .transaction(async (one) => {
          await one.transaction(async () => {
            throw new Error("deepest");
          });
        })
        .catch(() => undefined);
    });
    expect(failures).toHaveLength(2);
    expect(outcome).toEqual({ success: false, error: failures[0] });
  });

  test("a nested transaction waiting for its turn is refused when the one before it broke the transaction", async () => {
    const { pool, repo } = setup();
    const refused = databaseError("no release");
    pool.fail = (sql) => (sql.startsWith("release") ? refused : undefined);
    await repo.transaction(async (tx) => {
      const [first, second] = await Promise.allSettled([
        tx.transaction(async () => undefined),
        tx.transaction(async () => undefined),
      ]);
      expect((first as PromiseRejectedResult).reason).toBe(refused);
      expect(((second as PromiseRejectedResult).reason as Error).message).toContain("could not roll back");
    });
    expect(pool.sent.filter((sql) => sql.startsWith("savepoint"))).toHaveLength(1);
  });

  test("ROLLBACK TO fails after inner.rollback(reason): the failure is thrown", async () => {
    const { pool, repo } = setup();
    const lost = databaseError("no rollback to");
    pool.fail = (sql) => (sql.startsWith("rollback to") ? lost : undefined);
    await repo.transaction(async (tx) => {
      expect(await rejection(tx.transaction(async (inner) => inner.rollback("x")))).toBe(lost);
    });
    expect(pool.sent.at(-1)).toBe("rollback");
  });
});

// --- statement failures inside a transaction ----------------------------------------------

describe("a statement that fails inside a transaction", () => {
  test("refuses every later statement without sending it, and the transaction ends in a rollback", async () => {
    const { pool, repo } = setup();
    const refused = violation();
    pool.fail = (sql) => (sql === "one" ? refused : undefined);
    const result = await repo.transaction(async (tx) => {
      expect(await rejection(tx.raw(say("one")))).toBe(refused);
      const error = await rejection(tx.raw(say("two")));
      expect(error).toBeInstanceOf(QueryError);
      expect((error as Error).cause).toBe(refused);
      return "returned anyway";
    });
    expect(result).toEqual({ success: false, error: refused });
    expect(pool.sent).toEqual(["begin", "one", "rollback"]);
    const thrown = await rejection(
      repo.transactionOrThrow(async (tx) => tx.raw(say("one")).catch(() => "caught")),
    );
    expect(thrown).toBeInstanceOf(RollbackError);
    expect((thrown as RollbackError).reason).toBe(refused);
    expect((thrown as Error).message).toContain("a statement in it failed");
  });

  test("an error that did not come from the database (here a plain Error) does not end the transaction", async () => {
    const { pool, repo } = setup();
    pool.fail = (sql) => (sql === "one" ? new Error("driver trouble") : undefined);
    const result = await repo.transaction(async (tx) => {
      await tx.raw(say("one")).catch(() => undefined);
      await tx.raw(say("two"));
      return "ok";
    });
    expect(result).toEqual({ success: true, data: "ok" });
    expect(pool.sent).toEqual(["begin", "one", "two", "commit"]);
  });

  test("statements queued behind the failed one are not sent", async () => {
    const { pool, repo } = setup();
    pool.delay = (sql) => (sql === "one" ? 20 : 0);
    pool.fail = (sql) => (sql === "one" ? databaseError() : undefined);
    await repo.transaction(async (tx) => {
      const settled = await Promise.allSettled([
        tx.raw(say("one")),
        tx.raw(say("two")),
        tx.raw(say("three")),
      ]);
      expect(settled.map((each) => each.status)).toEqual(["rejected", "rejected", "rejected"]);
      expect((settled[1] as PromiseRejectedResult).reason).toBeInstanceOf(QueryError);
    });
    expect(pool.sent).toEqual(["begin", "one", "rollback"]);
  });

  test("is undone with the savepoint it happened in", async () => {
    const { pool, repo } = setup();
    pool.fail = (sql) => (sql === "bad" ? violation() : undefined);
    const result = await repo.transaction(async (tx) => {
      const inner = await tx.transaction(async (savepoint) => {
        await savepoint.raw(say("bad")).catch(() => undefined);
        return "inner returned";
      });
      expect(inner.success).toBe(false);
      await tx.raw(say("after"));
      return "outer";
    });
    expect(result).toEqual({ success: true, data: "outer" });
    expect(pool.sent).toEqual([
      "begin",
      'savepoint "egon_1"',
      "bad",
      'rollback to savepoint "egon_1"',
      "after",
      "commit",
    ]);
  });

  test("makes a nested transaction impossible until it is rolled back", async () => {
    const { pool, repo } = setup();
    pool.fail = (sql) => (sql === "bad" ? databaseError() : undefined);
    await repo.transaction(async (tx) => {
      await tx.raw(say("bad")).catch(() => undefined);
      expect(await rejection(tx.transaction(async () => undefined))).toBeInstanceOf(QueryError);
    });
    expect(pool.sent).toEqual(["begin", "bad", "rollback"]);
  });

  test("in a checkout, with no transaction, does not stop the next statement", async () => {
    const { pool, repo } = setup();
    pool.fail = (sql) => (sql === "bad" ? databaseError() : undefined);
    await repo.checkout(async (c) => {
      await c.raw(say("bad")).catch(() => undefined);
      await c.raw(say("next"));
    });
    expect(pool.sent).toEqual(["bad", "next"]);
  });

  test("a failed stream read inside a transaction counts as a failed statement", async () => {
    const { pool, repo } = setup();
    pool.cursorFailure = databaseError("read failed");
    const result = await repo.transaction(async (tx) => {
      const error = await rejection(
        (async () => {
          for await (const _ of tx.stream(from(Tag, "t"))) {
            // nothing
          }
        })(),
      );
      expect(error).toBeInstanceOf(DatabaseError);
      return "returned";
    });
    expect(result.success).toBe(false);
  });
});

// --- nesting -----------------------------------------------------------------------------

describe("nested transactions", () => {
  test("savepoints are named by depth, released on success and rolled back to on failure", async () => {
    const { pool, repo } = setup();
    await repo.transaction(async (one) => {
      await one.transaction(async (two) => {
        await two.transaction(async (three) => {
          await three.raw(say("deepest"));
          three.rollback("undo");
        });
        await two.raw(say("middle"));
      });
    });
    expect(pool.sent).toEqual([
      "begin",
      'savepoint "egon_1"',
      'savepoint "egon_2"',
      "deepest",
      'rollback to savepoint "egon_2"',
      "middle",
      'release savepoint "egon_1"',
      "commit",
    ]);
  });

  test("a throw in a nested callback rolls back to its savepoint and is rethrown", async () => {
    const { pool, repo } = setup();
    const boom = new Error("inner");
    await repo.transaction(async (tx) => {
      expect(
        await rejection(
          tx.transaction(async () => {
            throw boom;
          }),
        ),
      ).toBe(boom);
      await tx.raw(say("after"));
    });
    expect(pool.sent).toEqual([
      "begin",
      'savepoint "egon_1"',
      'rollback to savepoint "egon_1"',
      "after",
      "commit",
    ]);
  });

  test("the outer tx.rollback called in a nested callback rolls back both", async () => {
    const { pool, repo } = setup();
    const result = await repo.transaction(async (outer) => {
      await outer.transaction(async () => {
        outer.rollback("from inside");
      });
      return "never";
    });
    expect(result).toEqual({ success: false, error: "from inside" });
    expect(pool.sent).toEqual(["begin", 'savepoint "egon_1"', 'rollback to savepoint "egon_1"', "rollback"]);
  });

  test("isolation, readOnly and retries on a nested transaction are refused before anything is sent", async () => {
    const { pool, repo } = setup();
    await repo.transaction(async (tx) => {
      for (const options of [
        { isolation: "repeatable read" as const },
        { readOnly: false },
        { retries: 2 },
      ]) {
        const error = await rejection(tx.transaction(async () => undefined, options));
        expect(error).toBeInstanceOf(QueryError);
        expect((error as Error).message).toContain("savepoint");
      }
      // retries: 0 and timeoutMs are fine.
      await tx.transaction(async () => undefined, { retries: 0, timeoutMs: 1_000 });
    });
    expect(pool.sent).toEqual(["begin", 'savepoint "egon_1"', 'release savepoint "egon_1"', "commit"]);
  });

  test("a statement on the outer tx while a nested transaction is open is refused", async () => {
    const { pool, repo } = setup();
    await repo.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        const error = await rejection(tx.raw(say("outer")));
        expect((error as Error).message).toContain("A nested transaction is open");
        await inner.raw(say("inner"));
      });
    });
    expect(pool.sent).toEqual([
      "begin",
      'savepoint "egon_1"',
      "inner",
      'release savepoint "egon_1"',
      "commit",
    ]);
  });

  test("nested transactions started together run one after the other", async () => {
    const { pool, repo } = setup();
    pool.delay = (sql) => (sql === "a" ? 15 : 0);
    await repo.transaction(async (tx) => {
      const [a, b] = await Promise.all([
        tx.transaction(async (inner) => inner.raw(say("a"))),
        tx.transaction(async (inner) => inner.raw(say("b"))),
      ]);
      expect([a.success, b.success]).toEqual([true, true]);
    });
    expect(pool.sent).toEqual([
      "begin",
      'savepoint "egon_1"',
      "a",
      'release savepoint "egon_1"',
      'savepoint "egon_1"',
      "b",
      'release savepoint "egon_1"',
      "commit",
    ]);
  });

  test("a nested transaction still running when the callback returns rolls the transaction back", async () => {
    const { pool, repo } = setup();
    let inner: Repo | undefined;
    const started: Promise<unknown>[] = [];
    const error = await rejection(
      repo.transaction(async (tx) => {
        started.push(
          tx.transaction(async (savepoint) => {
            inner = savepoint;
            await sleep(30);
            await savepoint.raw(say("too late"));
          }),
        );
        // A second one waits for the first, and is refused when the transaction ends.
        started.push(tx.transaction(async () => undefined));
        await sleep(5);
      }),
    );
    expect((error as Error).message).toContain("A nested transaction was still running");
    const [first, second] = await Promise.allSettled(started);
    expect((first as PromiseRejectedResult).reason).toBeInstanceOf(QueryError);
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(QueryError);
    expect(await rejection((inner as Repo).raw(say("after")))).toBeInstanceOf(QueryError);
    expect(pool.sent).toEqual(["begin", 'savepoint "egon_1"', "rollback"]);
  });

  test("a nested transaction whose callback returns after its parent ended is refused", async () => {
    const { pool, repo } = setup();
    const late: Promise<unknown>[] = [];
    await repo
      .transaction(async (tx) => {
        late.push(
          tx.transaction(async () => {
            await sleep(20);
            return "too late";
          }),
        );
        await sleep(1);
      })
      .catch(() => undefined);
    expect(((await rejection(late[0] as Promise<unknown>)) as Error).message).toContain("already completed");
    expect(pool.sent).toEqual(["begin", 'savepoint "egon_1"', "rollback"]);
  });

  test("a nested transaction whose callback throws after its parent ended rethrows that error", async () => {
    const { repo } = setup();
    const late: Promise<unknown>[] = [];
    const boom = new Error("late boom");
    await repo
      .transaction(async (tx) => {
        late.push(
          tx.transaction(async () => {
            await sleep(20);
            throw boom;
          }),
        );
        await sleep(1);
      })
      .catch(() => undefined);
    expect(await rejection(late[0] as Promise<unknown>)).toBe(boom);
  });

  test("tx.transaction after tx.rollback(), or after the transaction ended, is refused", async () => {
    const { repo } = setup();
    let leaked: Repo | undefined;
    await repo.transaction(async (tx) => {
      leaked = tx;
      try {
        tx.rollback("stop");
      } catch {
        // keep going
      }
      expect(await rejection(tx.transaction(async () => undefined))).toBeInstanceOf(QueryError);
    });
    expect(await rejection((leaked as Repo).transaction(async () => undefined))).toBeInstanceOf(QueryError);
  });
});

// --- concurrency and use after completion ---------------------------------------------------

describe("one connection, one statement at a time", () => {
  test("statements issued together are sent one at a time, in order", async () => {
    const { pool, repo } = setup();
    pool.delay = () => 3;
    await repo.transaction(async (tx) => {
      await Promise.all(["a", "b", "c", "d"].map((text) => tx.raw(say(text))));
    });
    expect(pool.sent).toEqual(["begin", "a", "b", "c", "d", "commit"]);
    expect(pool.mostAtOnce).toBe(1);
  });

  test("a statement that waits counts the wait against its timeoutMs and is not sent when it runs out", async () => {
    const { pool, repo } = setup();
    pool.delay = (sql) => (sql === "slow" ? 60 : 0);
    await repo.transaction(async (tx) => {
      const [slow, waiting] = await Promise.allSettled([
        tx.raw(say("slow")),
        tx.raw(say("waiting"), { timeoutMs: 20 }),
      ]);
      expect(slow.status).toBe("fulfilled");
      const error = (waiting as PromiseRejectedResult).reason as DatabaseError;
      expect(error.code).toBe("timeout");
      expect(error.message).toContain("was not run");
      await tx.raw(say("after"));
    });
    expect(pool.sent).toEqual(["begin", "slow", "after", "commit"]);
  });

  test("a waiting statement whose budget is spent when its turn comes is not sent", async () => {
    const { pool, repo } = setup();
    pool.delay = (sql) => (sql === "slow" ? 40 : 0);
    // Keep the timer that would reject it from firing first.
    const timers = vi.spyOn(globalThis, "setTimeout");
    await repo.transaction(async (tx) => {
      const slow = tx.raw(say("slow"));
      timers.mockImplementationOnce(((fn: () => void) => ({ fn })) as never);
      const waiting = tx.raw(say("waiting"), { timeoutMs: 10 });
      await slow;
      const error = (await rejection(waiting)) as DatabaseError;
      expect(error.code).toBe("timeout");
    });
    expect(pool.sent).toEqual(["begin", "slow", "commit"]);
  });

  test("a waiting statement keeps the rest of its timeoutMs when its turn comes", async () => {
    const { pool, repo } = setup();
    pool.delay = (sql) => (sql === "slow" ? 40 : sql === "second" ? 40 : 0);
    await repo
      .transaction(async (tx) => {
        const [, second] = await Promise.allSettled([
          tx.raw(say("slow")),
          tx.raw(say("second"), { timeoutMs: 60 }),
        ]);
        // 40 ms of waiting leaves about 20 for a statement that takes 40: it is cancelled.
        expect(((second as PromiseRejectedResult).reason as DatabaseError).code).toBe("timeout");
        expect(pool.cancels).toBe(1);
      })
      .catch(() => undefined);
    expect(pool.sent.slice(0, 3)).toEqual(["begin", "slow", "second"]);
  });

  test("a waiting statement whose signal fires is not sent", async () => {
    const { pool, repo } = setup();
    pool.delay = (sql) => (sql === "slow" ? 30 : 0);
    await repo.transaction(async (tx) => {
      const controller = new AbortController();
      const slow = tx.raw(say("slow"));
      const waiting = tx.raw(say("waiting"), { signal: controller.signal });
      controller.abort();
      expect(((await rejection(waiting)) as DatabaseError).code).toBe("aborted");
      await slow;
      // A signal that fired before the statement was issued: not sent either.
      const before = new AbortController();
      before.abort();
      const busy = tx.raw(say("busy"));
      expect(((await rejection(tx.raw(say("never"), { signal: before.signal }))) as DatabaseError).code).toBe(
        "aborted",
      );
      await busy;
      // A signal on a statement that waited and was not aborted is still passed on.
      const later = new AbortController();
      const third = tx.raw(say("third"));
      await Promise.all([third, tx.raw(say("fourth"), { signal: later.signal })]);
    });
    expect(pool.sent).toEqual(["begin", "slow", "busy", "third", "fourth", "commit"]);
  });

  test("a call on tx after its callback ended throws QueryError and sends nothing", async () => {
    const { pool, repo } = setup();
    let leaked: Repo | undefined;
    await repo.transaction(async (tx) => {
      leaked = tx;
    });
    const tx = leaked as Repo;
    expect(((await rejection(tx.raw(say("late")))) as Error).message).toContain(
      "transaction already completed",
    );
    expect(() => tx.rollback("late")).toThrow("transaction already completed");
    const stream = tx.stream(from(Tag, "t"));
    expect(await rejection(stream[Symbol.asyncIterator]().next())).toBeInstanceOf(QueryError);
    expect(pool.sent).toEqual(["begin", "commit"]);
  });

  test("statements the callback issued and did not await still run before COMMIT", async () => {
    const { pool, repo } = setup();
    pool.delay = () => 5;
    let leaked: Promise<unknown> | undefined;
    await repo.transaction(async (tx) => {
      await tx.raw(say("one"));
      leaked = tx.raw(say("not awaited"));
      leaked.catch(() => undefined);
    });
    await leaked;
    expect(pool.sent).toEqual(["begin", "one", "not awaited", "commit"]);
  });

  test("statements still waiting when the callback throws are not sent", async () => {
    const { pool, repo } = setup();
    pool.delay = () => 5;
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    await repo
      .transaction(async (tx) => {
        pending = Promise.allSettled([tx.raw(say("one")), tx.raw(say("waiting"))]);
        throw new Error("stop");
      })
      .catch(() => undefined);
    const settled = await (pending as Promise<PromiseSettledResult<unknown>[]>);
    expect(settled.map((each) => each.status)).toEqual(["fulfilled", "rejected"]);
    expect(pool.sent).toEqual(["begin", "one", "rollback"]);
  });
});

// --- streams in a transaction ----------------------------------------------------------------

describe("streams in a transaction", () => {
  test("run on the transaction's connection; other statements are refused while one is open", async () => {
    const { pool, repo } = setup();
    pool.cursorRows = [
      { c0: 1, c1: "a" },
      { c0: 2, c1: "b" },
    ];
    await repo.transaction(async (tx) => {
      const names: unknown[] = [];
      for await (const tag of tx.stream(from(Tag, "t"))) {
        names.push(tag.name);
        const error = await rejection(tx.raw(say("during")));
        expect((error as Error).message).toContain("A stream is still open");
      }
      expect(names).toEqual(["a", "b"]);
      await tx.raw(say("after"));
    });
    expect(pool.sent).toEqual([
      "begin",
      'select "t"."id" as "c0", "t"."name" as "c1" from "tags" as "t"',
      "after",
      "commit",
    ]);
  });

  test("a stream left open when the callback returns rolls back and closes the connection", async () => {
    const { pool, repo } = setup();
    pool.cursorRows = [
      { c0: 1, c1: "a" },
      { c0: 2, c1: "b" },
    ];
    const error = await rejection(
      repo.transaction(async (tx) => {
        const iterator = tx.stream(from(Tag, "t"), { batchSize: 1 })[Symbol.asyncIterator]();
        await iterator.next();
        return "left open";
      }),
    );
    expect((error as Error).message).toContain("A stream on tx was still open");
    expect(pool.destroyed).toBe(1);
  });

  test("a stream in a transaction with timeoutMs gets what is left of it", async () => {
    const { pool, repo } = setup();
    pool.cursorRows = [{ c0: 1, c1: "a" }];
    await repo.transaction(
      async (tx) => {
        for await (const _ of tx.stream(from(Tag, "t"), { timeoutMs: 10_000 })) {
          // one row
        }
        for await (const _ of tx.stream(from(Tag, "t"))) {
          // one row
        }
        // Its own, shorter, timeoutMs stays.
        for await (const _ of tx.stream(from(Tag, "t"), { timeoutMs: 1_000 })) {
          // one row
        }
      },
      { timeoutMs: 5_000 },
    );
    expect(pool.sent.at(-1)).toBe("commit");
  });
});

// --- timeoutMs -----------------------------------------------------------------------------------

describe("timeoutMs on a transaction", () => {
  test("cancels the running statement, rolls back, and rejects with the transaction's budget in the message", async () => {
    const { pool, repo } = setup();
    pool.delay = (sql) => (sql === "slow" ? 1_000 : 0);
    let late: unknown;
    const error = await rejection(
      repo.transaction(
        async (tx) => {
          await tx.raw(say("slow")).catch((e: unknown) => {
            late = e;
          });
          await tx.raw(say("never"));
        },
        { timeoutMs: 30 },
      ),
    );
    expect((error as DatabaseError).code).toBe("timeout");
    expect((error as Error).message).toContain("timeoutMs (30 ms)");
    expect(pool.cancels).toBe(1);
    await sleep(5);
    expect((late as DatabaseError).code).toBe("timeout");
    expect((late as Error).message).toContain("timeoutMs (30 ms)");
    expect(pool.sent).toEqual(["begin", "slow", "rollback"]);
  });

  test("still ends in the timeout when the callback catches the stopped statement's error and returns", async () => {
    const { pool, repo } = setup();
    pool.delay = (sql) => (sql === "slow" ? 1_000 : 0);
    const error = await rejection(
      repo.transaction(
        async (tx) => {
          await tx.raw(say("slow")).catch(() => undefined);
          return "returned";
        },
        { timeoutMs: 30 },
      ),
    );
    expect((error as DatabaseError).code).toBe("timeout");
    expect(pool.sent).toEqual(["begin", "slow", "rollback"]);
  });

  test("runs out between statements too, and tx is refused afterwards", async () => {
    const { pool, repo } = setup();
    let leaked: Repo | undefined;
    const error = await rejection(
      repo.transaction(
        async (tx) => {
          leaked = tx;
          await sleep(50);
        },
        { timeoutMs: 10 },
      ),
    );
    expect((error as DatabaseError).code).toBe("timeout");
    expect(await rejection((leaked as Repo).raw(say("late")))).toBeInstanceOf(QueryError);
    expect(pool.sent).toEqual(["begin", "rollback"]);
  });

  test("a statement's own shorter timeoutMs stays its own", async () => {
    const { pool, repo } = setup();
    pool.delay = (sql) => (sql === "slow" ? 200 : 0);
    const result = await repo.transaction(
      async (tx) => {
        const error = (await rejection(tx.raw(say("slow"), { timeoutMs: 10 }))) as DatabaseError;
        expect(error.message).toContain("timeoutMs (10 ms)");
        return "returned";
      },
      { timeoutMs: 5_000 },
    );
    // The cancelled statement failed in the database: the transaction rolls back.
    expect(result.success).toBe(false);
  });

  test("a statement issued once the budget is spent, before the timer fires, is refused with a timeout", async () => {
    const { pool, repo } = setup();
    const error = await rejection(
      repo.transaction(
        async (tx) => {
          const end = performance.now() + 15;
          while (performance.now() < end) {
            // Busy: the timer cannot fire.
          }
          await tx.raw(say("too late"));
        },
        { timeoutMs: 5 },
      ),
    );
    expect((error as DatabaseError).code).toBe("timeout");
    expect(pool.sent).toEqual(["begin", "rollback"]);
  });

  test("covers the wait for a connection", async () => {
    const { pool, repo } = setup();
    let open: () => void = () => undefined;
    pool.gate = new Promise((resolve) => {
      open = resolve;
    });
    const error = await rejection(repo.transaction(async () => "never", { timeoutMs: 10 }));
    expect((error as DatabaseError).code).toBe("timeout");
    expect((error as Error).message).toContain("The transaction was not run");
    open();
  });

  test("on a nested transaction, rolls back to its savepoint; the outer one carries on", async () => {
    const { pool, repo } = setup();
    pool.delay = (sql) => (sql === "slow" ? 500 : 0);
    const result = await repo.transaction(async (tx) => {
      const error = await rejection(
        tx.transaction(async (inner) => inner.raw(say("slow")), { timeoutMs: 20 }),
      );
      expect((error as DatabaseError).code).toBe("timeout");
      await tx.raw(say("after"));
      return "outer";
    });
    expect(result).toEqual({ success: true, data: "outer" });
    expect(pool.sent).toEqual([
      "begin",
      'savepoint "egon_1"',
      "slow",
      'rollback to savepoint "egon_1"',
      "after",
      "commit",
    ]);
  });

  test("a nested transaction inherits the outer budget when it is the shorter", async () => {
    const { pool, repo } = setup();
    pool.delay = (sql) => (sql === "slow" ? 500 : 0);
    const error = await rejection(
      repo.transaction(
        async (tx) => tx.transaction(async (inner) => inner.raw(say("slow")), { timeoutMs: 10_000 }),
        {
          timeoutMs: 20,
        },
      ),
    );
    expect((error as DatabaseError).code).toBe("timeout");
    expect((error as Error).message).toContain("timeoutMs (20 ms)");
    await sleep(10);
    expect(pool.sent).toEqual(["begin", 'savepoint "egon_1"', "slow", "rollback"]);
  });
});

// --- retries -----------------------------------------------------------------------------------

describe("retries", () => {
  test("a retryable error thrown by the callback runs it again on a new connection", async () => {
    const { pool, repo } = setup();
    let attempts = 0;
    pool.fail = (sql) => (sql === "write" && attempts === 1 ? serializationFailure() : undefined);
    const result = await repo.transaction(
      async (tx) => {
        attempts++;
        await tx.raw(say("write"));
        return attempts;
      },
      { retries: 2 },
    );
    expect(result).toEqual({ success: true, data: 2 });
    expect(pool.sent).toEqual(["begin", "write", "rollback", "begin", "write", "commit"]);
    expect(pool.acquired).toBe(2);
  });

  test("a retryable COMMIT failure, and a retryable failure the callback swallowed, are retried too", async () => {
    const { pool, repo } = setup();
    let commits = 0;
    pool.fail = (sql) => (sql === "commit" && commits++ === 0 ? serializationFailure() : undefined);
    expect(await repo.transaction(async () => "done", { retries: 1 })).toEqual({
      success: true,
      data: "done",
    });
    let attempts = 0;
    pool.fail = (sql) => (sql === "write" && attempts === 1 ? serializationFailure() : undefined);
    const swallowed = await repo.transaction(
      async (tx) => {
        attempts++;
        await tx.raw(say("write")).catch(() => undefined);
        return attempts;
      },
      { retries: 1 },
    );
    expect(swallowed).toEqual({ success: true, data: 2 });
  });

  test("gives up after the last retry, and never retries what is not retryable", async () => {
    const { pool, repo } = setup();
    pool.fail = (sql) => (sql === "write" ? serializationFailure() : undefined);
    let attempts = 0;
    const error = await rejection(
      repo.transaction(
        async (tx) => {
          attempts++;
          await tx.raw(say("write"));
        },
        { retries: 2 },
      ),
    );
    expect((error as DatabaseError).code).toBe("serializationFailure");
    expect(attempts).toBe(3);
    attempts = 0;
    const exhausted = await repo.transaction(
      async (tx) => {
        attempts++;
        await tx.raw(say("write")).catch(() => undefined);
      },
      { retries: 1 },
    );
    expect(exhausted.success).toBe(false);
    expect(attempts).toBe(2);
    attempts = 0;
    pool.fail = (sql) => (sql === "write" ? databaseError() : undefined);
    await rejection(
      repo.transaction(
        async (tx) => {
          attempts++;
          await tx.raw(say("write"));
        },
        { retries: 3 },
      ),
    );
    expect(attempts).toBe(1);
    // An explicit rollback is not retried either.
    attempts = 0;
    await repo.transaction(
      async (tx) => {
        attempts++;
        tx.rollback("no");
      },
      { retries: 3 },
    );
    expect(attempts).toBe(1);
  });

  test("does not retry when the pause would run past timeoutMs", async () => {
    const { pool, repo } = setup();
    pool.fail = (sql) => (sql === "write" ? serializationFailure() : undefined);
    vi.spyOn(Math, "random").mockReturnValue(1);
    let attempts = 0;
    await rejection(
      repo.transaction(
        async (tx) => {
          attempts++;
          await tx.raw(say("write"));
        },
        { retries: 5, timeoutMs: 12 },
      ),
    );
    expect(attempts).toBe(1);
  });
});

// --- options -----------------------------------------------------------------------------------

describe("options and arguments", () => {
  test("wrong options are a TypeError, before a connection is taken", async () => {
    const { pool, repo } = setup();
    const wrong: unknown[] = [
      "serializable",
      null,
      [],
      { isolation: "chaos" },
      { isolation: 3 },
      { readOnly: "yes" },
      { retries: -1 },
      { retries: 1.5 },
      { retries: "2" },
      { timeoutMs: -1 },
      { timeoutMs: Number.NaN },
      { timeoutMs: "5" },
      { readOnly: {} },
      { deferrable: true },
    ];
    for (const options of wrong) {
      const error = await rejection(repo.transaction(async () => undefined, options as never));
      expect(error, JSON.stringify(options)).toBeInstanceOf(TypeError);
    }
    expect(pool.acquired).toBe(0);
  });

  test("an argument that is neither a callback nor a batch is a TypeError", async () => {
    const { repo } = setup();
    expect(await rejection(repo.transaction("select 1" as never))).toBeInstanceOf(TypeError);
    expect(await rejection(repo.transactionOrThrow({} as never))).toBeInstanceOf(TypeError);
    expect(await rejection(repo.checkout(42 as never))).toBeInstanceOf(TypeError);
  });

  test("an isolation level the database does not have is a QueryError from BEGIN", async () => {
    const pool = new ScriptedPool();
    const adapter = createAdapter({
      dialect: "postgres",
      capabilities: { ...POSTGRES_CAPABILITIES, isolationLevels: ["serializable"] },
      quoteIdentifier: quote,
      driver: () => pool,
      driverCodecs: {},
      normalizeError: (error) => error,
    });
    const repo = createRepo({ adapter });
    expect(
      await rejection(repo.transaction(async () => undefined, { isolation: "read committed" })),
    ).toBeInstanceOf(QueryError);
    expect(pool.released).toBe(1);
  });

  test("rollback() outside a transaction is a QueryError", async () => {
    const { repo } = setup();
    expect(() => repo.rollback("no")).toThrow(QueryError);
    await repo.checkout(async (c) => {
      expect(() => c.rollback("no")).toThrow("only available inside a transaction");
    });
  });

  test("close() on a transaction's repo is refused; on the root repo it closes the pool", async () => {
    const { repo } = setup();
    await repo.transaction(async (tx) => {
      expect(await rejection(tx.close())).toBeInstanceOf(QueryError);
    });
    await repo.close();
  });

  test("inTransaction: false on the root and in a checkout, true on tx", async () => {
    const { repo } = setup();
    expect(repo.inTransaction).toBe(false);
    await repo.transaction(async (tx) => {
      expect(tx.inTransaction).toBe(true);
      await tx.transaction(async (inner) => {
        expect(inner.inTransaction).toBe(true);
      });
    });
    await repo.checkout(async (c) => {
      expect(c.inTransaction).toBe(false);
      await c.transaction(async (tx) => expect(tx.inTransaction).toBe(true));
    });
  });
});

// --- checkout ----------------------------------------------------------------------------------

describe("checkout", () => {
  test("one connection, no transaction statements; the connection goes back afterwards", async () => {
    const { pool, repo } = setup();
    const value = await repo.checkout(async (c) => {
      await c.raw(say("one"));
      await c.raw(say("two"));
      return "v";
    });
    expect(value).toBe("v");
    expect(pool.sent).toEqual(["one", "two"]);
    expect([pool.acquired, pool.released]).toEqual([1, 1]);
  });

  test("a transaction in a checkout runs BEGIN and COMMIT on its connection, with its options and retries", async () => {
    const { pool, repo } = setup();
    let attempts = 0;
    pool.fail = (sql) => (sql === "write" && attempts === 1 ? serializationFailure() : undefined);
    await repo.checkout(async (c) => {
      await c.transaction(
        async (tx) => {
          attempts++;
          await tx.raw(say("write"));
          await tx.transaction(async (inner) => inner.raw(say("nested")));
        },
        { isolation: "serializable", retries: 1 },
      );
      await c.raw(say("after"));
    });
    expect(pool.sent).toEqual([
      "begin isolation level serializable",
      "write",
      "rollback",
      "begin isolation level serializable",
      "write",
      'savepoint "egon_1"',
      "nested",
      'release savepoint "egon_1"',
      "commit",
      "after",
    ]);
    expect(pool.acquired).toBe(1);
  });

  test("a non-retryable failure of a transaction in a checkout is thrown; a statement failure the callback swallowed is retried", async () => {
    const { pool, repo } = setup();
    pool.fail = (sql) => (sql === "write" ? databaseError() : undefined);
    await repo.checkout(async (c) => {
      expect(
        await rejection(c.transaction(async (tx) => tx.raw(say("write")), { retries: 2 })),
      ).toBeInstanceOf(DatabaseError);
      let attempts = 0;
      pool.fail = (sql) => (sql === "write" && attempts === 1 ? serializationFailure() : undefined);
      const result = await c.transaction(
        async (tx) => {
          attempts++;
          await tx.raw(say("write")).catch(() => undefined);
          return attempts;
        },
        { retries: 1 },
      );
      expect(result).toEqual({ success: true, data: 2 });
    });
  });

  test("a transaction in a checkout keeps to its timeoutMs, and the checkout carries on", async () => {
    const { pool, repo } = setup();
    pool.delay = (sql) => (sql === "slow" ? 500 : 0);
    await repo.checkout(async (c) => {
      const error = await rejection(c.transaction(async (tx) => tx.raw(say("slow")), { timeoutMs: 20 }));
      expect((error as DatabaseError).code).toBe("timeout");
      await c.raw(say("after"));
    });
    expect(pool.sent).toEqual(["begin", "slow", "rollback", "after"]);
  });

  test("statements are refused while a transaction is open in it, and after it ended", async () => {
    const { repo } = setup();
    let leaked: Repo | undefined;
    await repo.checkout(async (c) => {
      leaked = c;
      await c.transaction(async () => {
        expect(await rejection(c.raw(say("outer")))).toBeInstanceOf(QueryError);
        expect(await rejection(c.transaction(async () => undefined))).toBeInstanceOf(QueryError);
      });
    });
    expect(((await rejection((leaked as Repo).raw(say("late")))) as Error).message).toContain(
      "This checkout already ended",
    );
  });

  test("statements it issued and did not await run before the connection goes back", async () => {
    const { pool, repo } = setup();
    pool.delay = () => 5;
    let leaked: Promise<unknown> | undefined;
    await repo.checkout(async (c) => {
      leaked = c.raw(say("not awaited"));
    });
    await leaked;
    expect(pool.sent).toEqual(["not awaited"]);
    expect(pool.released).toBe(1);
  });

  test("a transaction left running when the checkout ends is cut off; the connection is closed, being in a transaction", async () => {
    const { pool, repo } = setup();
    let running: Promise<unknown> | undefined;
    await repo.checkout(async (c) => {
      running = c.transaction(async (tx) => {
        await sleep(20);
        await tx.raw(say("late"));
      });
      await sleep(1);
    });
    expect(await rejection(running as Promise<unknown>)).toBeInstanceOf(QueryError);
    expect(pool.destroyed).toBe(1);
  });

  test("on a transaction's repo, the callback gets that same repo", async () => {
    const { pool, repo } = setup();
    await repo.transaction(async (tx) => {
      const same = await tx.checkout(async (c) => {
        expect(c).toBe(tx);
        return "same";
      });
      expect(same).toBe("same");
    });
    let leaked: Repo | undefined;
    await repo.transaction(async (tx) => {
      leaked = tx;
    });
    expect(await rejection((leaked as Repo).checkout(async () => undefined))).toBeInstanceOf(QueryError);
    expect(pool.acquired).toBe(2);
  });
});

// --- the bulk primitive ---------------------------------------------------------------------------

describe("insertAll of several statements", () => {
  const capabilities = { ...POSTGRES_CAPABILITIES, maxParams: 1 };

  function small() {
    const pool = new ScriptedPool();
    const adapter = createAdapter({
      dialect: "postgres",
      capabilities,
      quoteIdentifier: quote,
      driver: () => pool,
      driverCodecs: {},
      normalizeError: (error) => error,
    });
    pool.rows = () => [];
    return { pool, adapter, repo: createRepo({ adapter }) };
  }

  const head = (sql: string) => sql.split(" ").slice(0, 2).join(" ");

  test("on the pool: a transaction of its own", async () => {
    const { pool, repo } = small();
    await repo.insertAll(Tag, [{ name: "a" }, { name: "b" }]);
    expect(pool.sent.map(head)).toEqual(["begin", "insert into", "insert into", "commit"]);
  });

  test("inside a transaction: a savepoint, so that its failure leaves the transaction usable", async () => {
    const { pool, repo } = small();
    let calls = 0;
    pool.fail = (sql) => (sql.startsWith("insert") && ++calls === 2 ? violation() : undefined);
    await repo.transaction(async (tx) => {
      expect(await rejection(tx.insertAll(Tag, [{ name: "a" }, { name: "b" }]))).toBeInstanceOf(
        ConstraintError,
      );
      await tx.insertAll(Tag, [{ name: "c" }, { name: "d" }]);
    });
    expect(pool.sent.map(head)).toEqual([
      "begin",
      'savepoint "egon_1"',
      "insert into",
      "insert into",
      "rollback to",
      'savepoint "egon_1"',
      "insert into",
      "insert into",
      "release savepoint",
      "commit",
    ]);
  });

  test("inside a checkout: BEGIN and COMMIT on its connection", async () => {
    const { pool, repo } = small();
    await repo.checkout(async (c) => {
      await c.insertAll(Tag, [{ name: "a" }, { name: "b" }]);
    });
    expect(pool.sent.map(head)).toEqual(["begin", "insert into", "insert into", "commit"]);
    expect(pool.acquired).toBe(1);
  });

  test("is refused on a transaction that cannot take statements", async () => {
    const { pool, repo } = small();
    pool.fail = (sql) => (sql === "bad" ? databaseError() : undefined);
    await repo.transaction(async (tx) => {
      await tx.raw(say("bad")).catch(() => undefined);
      expect(await rejection(tx.insertAll(Tag, [{ name: "a" }, { name: "b" }]))).toBeInstanceOf(QueryError);
    });
  });

  test("on one connection that the caller manages: the statements join it", async () => {
    const { pool, adapter } = small();
    const connection = await adapter.acquire();
    const core = new ReadCore(adapter, connection, undefined, true, new QueryHub(adapter, false));
    await insertAll(core, Tag, [{ name: "a" }, { name: "b" }], undefined);
    expect(pool.sent.map(head)).toEqual(["insert into", "insert into"]);
    await connection.release();
  });

  test("work that swallowed a failed statement still fails: its savepoint is rolled back and the failure thrown", async () => {
    const { pool, adapter } = small();
    const refused = databaseError();
    pool.fail = (sql) => (sql === "bad" ? refused : undefined);
    const core = new ReadCore(adapter, adapter, undefined, true, new QueryHub(adapter, false));
    const swallow = async (executor: {
      execute(sql: string, params: readonly unknown[]): Promise<unknown>;
    }) => {
      await executor.execute('"bad"', []).catch(() => undefined);
      return "returned";
    };
    expect(await rejection(atomically(core, undefined, undefined, swallow))).toBe(refused);
    expect(pool.sent.slice(-3)).toEqual(["begin", "bad", "rollback"]);
  });

  test("BEGIN of its own transaction fails: the error is thrown and the connection returned", async () => {
    const { pool, repo } = small();
    const refused = databaseError("no begin");
    pool.fail = (sql) => (sql === "begin" ? refused : undefined);
    expect(await rejection(repo.insertAll(Tag, [{ name: "a" }, { name: "b" }]))).toBe(refused);
    expect(pool.released).toBe(1);
  });
});

// --- the development-mode warning ----------------------------------------------------------

describe("warnOnRootUseInTransaction", () => {
  function warnings(): string[] {
    const seen: string[] = [];
    vi.spyOn(process, "emitWarning").mockImplementation(((message: string) => {
      seen.push(message);
    }) as never);
    return seen;
  }

  test("warns once per transaction when the root repo is used inside its callback", async () => {
    const seen = warnings();
    const { repo } = setup({ warn: true });
    await repo.transaction(async (tx) => {
      await tx.raw(say("inside"));
      await repo.raw(say("outside"));
      await repo.raw(say("outside again"));
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("used inside one of its own transaction callbacks");
    // Outside a callback: no warning.
    await repo.raw(say("plain"));
    expect(seen).toHaveLength(1);
  });

  test("covers the root's transactions, checkouts, streams and bulk writes, not those of the tx", async () => {
    const seen = warnings();
    const { repo, pool } = setup({ warn: true });
    pool.cursorRows = [];
    const uses: ((tx: Repo) => Promise<unknown>)[] = [
      () => repo.transaction(async () => undefined),
      () => repo.checkout(async () => undefined),
      async () => {
        for await (const _ of repo.stream(from(Tag, "t"))) {
          // nothing
        }
      },
      () =>
        repo.insertAll(
          Tag,
          Array.from({ length: 70_000 }, () => ({ name: "x" })),
        ),
      (tx) => tx.transaction(async (inner) => inner.raw(say("nested"))),
    ];
    for (const use of uses) {
      seen.splice(0);
      await repo.transaction(async (tx) => {
        await use(tx);
      });
      expect(seen).toHaveLength(use === uses.at(-1) ? 0 : 1);
    }
  });

  test("is never installed when NODE_ENV is production", async () => {
    const seen = warnings();
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { repo } = setup({ warn: true });
      await repo.transaction(async () => {
        await repo.raw(say("outside"));
      });
    } finally {
      process.env.NODE_ENV = before;
    }
    expect(seen).toEqual([]);
  });

  test("is off unless asked for", async () => {
    const seen = warnings();
    const { repo } = setup();
    await repo.transaction(async () => {
      await repo.raw(say("outside"));
    });
    expect(seen).toEqual([]);
  });
});

// --- the sandbox -----------------------------------------------------------------------------------

describe("the sandbox", () => {
  test("begin: BEGIN on one connection, through which the repo runs; rollback: ROLLBACK and the pool back", async () => {
    const { pool, repo } = setup();
    const sandbox = await createSandbox(repo);
    const sandboxed = await sandbox.begin();
    await repo.raw(say("app"));
    await sandboxed.raw(say("test"));
    await repo.transaction(async (tx) => tx.raw(say("app transaction")));
    await repo.transaction(async (tx) => tx.rollback("no"));
    expect(pool.acquired).toBe(1);
    await sandbox.rollback();
    await repo.raw(say("back on the pool"));
    // Each statement made on the sandbox's own level runs in a savepoint of its own.
    expect(pool.sent).toEqual([
      "begin",
      'savepoint "egon_statement"',
      "app",
      'release savepoint "egon_statement"',
      'savepoint "egon_statement"',
      "test",
      'release savepoint "egon_statement"',
      'savepoint "egon_1"',
      "app transaction",
      'release savepoint "egon_1"',
      'savepoint "egon_1"',
      'rollback to savepoint "egon_1"',
      "rollback",
      "back on the pool",
    ]);
    expect(pool.acquired).toBe(2);
    expect(pool.released).toBe(2);
  });

  test("the repo's concurrent transactions take turns, and its statements may run between them", async () => {
    const { pool, repo } = setup();
    pool.delay = (sql) => (sql === "first" ? 10 : 0);
    const sandbox = await createSandbox(repo);
    await sandbox.begin();
    await Promise.all([
      repo.transaction(async (tx) => {
        await tx.raw(say("first"));
      }),
      repo.transaction(async (tx) => tx.raw(say("second"))),
      repo.raw(say("plain")),
    ]);
    await sandbox.rollback();
    // The plain statement was issued while the first savepoint was being set, so it runs
    // next; the second transaction waits for the first one's end.
    expect(pool.sent.filter((sql) => !sql.startsWith("begin") && sql !== "rollback")).toEqual([
      'savepoint "egon_1"',
      'savepoint "egon_statement"',
      "plain",
      'release savepoint "egon_statement"',
      "first",
      'release savepoint "egon_1"',
      'savepoint "egon_1"',
      "second",
      'release savepoint "egon_1"',
    ]);
  });

  test("a statement of the sandbox's own level that fails undoes only itself: the next one runs", async () => {
    const { pool, repo } = setup();
    const refused = violation();
    pool.fail = (sql) => (sql === "duplicate" ? refused : undefined);
    const sandbox = await createSandbox(repo);
    await sandbox.begin();
    expect(await rejection(repo.raw(say("duplicate")))).toBe(refused);
    await repo.raw(say("next"));
    // An aborted signal: refused before anything is sent.
    const aborted = new AbortController();
    aborted.abort();
    expect(
      ((await rejection(repo.raw(say("never"), { signal: aborted.signal }))) as DatabaseError).code,
    ).toBe("aborted");
    await sandbox.rollback();
    expect(pool.sent).toEqual([
      "begin",
      'savepoint "egon_statement"',
      "duplicate",
      'rollback to savepoint "egon_statement"',
      'savepoint "egon_statement"',
      "next",
      'release savepoint "egon_statement"',
      "rollback",
    ]);
  });

  test("when the statement's savepoint cannot be rolled back to, the sandbox can only be rolled back", async () => {
    const { pool, repo } = setup();
    const refused = violation();
    const lost = databaseError("no rollback to");
    pool.fail = (sql) => (sql === "duplicate" ? refused : sql.startsWith("rollback to") ? lost : undefined);
    const sandbox = await createSandbox(repo);
    await sandbox.begin();
    const error = await rejection(repo.raw(say("duplicate")));
    expect(error).toBe(refused);
    expect((error as { suppressed?: unknown }).suppressed).toBe(lost);
    expect(((await rejection(repo.raw(say("next")))) as Error).message).toContain("could not roll back");
    // Two such failures of statements issued together: the first one is the one kept.
    await sandbox.rollback();
    await sandbox.begin();
    const losses: unknown[] = [];
    pool.fail = (sql) => {
      if (sql === "duplicate") return refused;
      if (!sql.startsWith("rollback to")) return undefined;
      losses.push(databaseError(`lost ${losses.length}`));
      return losses.at(-1);
    };
    await Promise.allSettled([repo.raw(say("duplicate")), repo.raw(say("duplicate"))]);
    expect(losses).toHaveLength(2);
    expect(((await rejection(repo.raw(say("next")))) as Error).cause).toBe(losses[0]);
    await sandbox.rollback();
  });

  test("an aborted signal is refused before anything is sent in a transaction too", async () => {
    const { pool, repo } = setup();
    const aborted = new AbortController();
    aborted.abort();
    const result = await repo.transaction(async (tx) => {
      expect(
        ((await rejection(tx.raw(say("never"), { signal: aborted.signal }))) as DatabaseError).code,
      ).toBe("aborted");
      // It never ran, so the transaction did not fail.
      await tx.raw(say("after"));
      return "ok";
    });
    expect(result).toEqual({ success: true, data: "ok" });
    expect(pool.sent).toEqual(["begin", "after", "commit"]);
  });

  test("the sandbox's own repo takes nested transactions leniently, and cannot be rolled back by rollback()", async () => {
    const { pool, repo } = setup();
    const sandbox = await createSandbox(repo);
    const sandboxed = await sandbox.begin();
    expect(sandboxed.inTransaction).toBe(true);
    expect(repo.inTransaction).toBe(false);
    expect(() => sandboxed.rollback("no")).toThrow("sandbox.rollback()");
    expect(() => repo.rollback("no")).toThrow(QueryError);
    await sandboxed.transaction(async () => undefined, { isolation: "serializable", retries: 3 });
    await sandboxed.checkout(async (c) => expect(c).toBe(sandboxed));
    await repo.checkout(async (c) => expect(c).toBe(repo));
    await sandbox.rollback();
    expect(pool.acquired).toBe(1);
    expect(await rejection(sandboxed.raw(say("late")))).toBeInstanceOf(QueryError);
  });

  test("begin twice, or while another sandbox of the repo is open, is a QueryError", async () => {
    const { pool, repo } = setup();
    const sandbox = await createSandbox(repo);
    pool.delay = () => 5;
    const first = sandbox.begin();
    expect(await rejection(sandbox.begin())).toBeInstanceOf(QueryError);
    await first;
    expect(await rejection(sandbox.begin())).toBeInstanceOf(QueryError);
    expect(await rejection((await createSandbox(repo)).begin())).toBeInstanceOf(QueryError);
    await sandbox.rollback();
    await sandbox.rollback();
    // It can begin again afterwards.
    await sandbox.begin();
    await sandbox.rollback();
  });

  test("a BEGIN that fails returns the connection; a ROLLBACK that fails closes it and is thrown", async () => {
    const { pool, repo } = setup();
    const sandbox = await createSandbox(repo);
    const refused = databaseError("no begin");
    pool.fail = (sql) => (sql === "begin" ? refused : undefined);
    expect(await rejection(sandbox.begin())).toBe(refused);
    expect(pool.released).toBe(1);
    const lost = databaseError("no rollback");
    pool.fail = (sql) => (sql === "rollback" ? lost : undefined);
    await sandbox.begin();
    expect(await rejection(sandbox.rollback())).toBe(lost);
    expect(pool.destroyed).toBe(1);
    // The repo is back on the pool anyway.
    pool.fail = () => undefined;
    await repo.raw(say("pool"));
    expect(pool.acquired).toBe(3);
  });

  test("a transaction left running at rollback is cut off", async () => {
    const { repo } = setup();
    const sandbox = await createSandbox(repo);
    await sandbox.begin();
    const running = repo.transaction(async (tx) => {
      await sleep(20);
      await tx.raw(say("late"));
    });
    await sleep(1);
    await sandbox.rollback();
    expect(await rejection(running)).toBeInstanceOf(QueryError);
  });

  test("only takes a repo made by createRepo", async () => {
    const { repo } = setup();
    expect(await rejection(createSandbox({} as Repo))).toBeInstanceOf(TypeError);
    expect(await rejection(createSandbox(null as unknown as Repo))).toBeInstanceOf(TypeError);
    await repo.transaction(async (tx) => {
      expect(await rejection(createSandbox(tx))).toBeInstanceOf(TypeError);
    });
  });

  test("with the root-use warning on, the repo goes back to its watching executor afterwards", async () => {
    const seen: string[] = [];
    vi.spyOn(process, "emitWarning").mockImplementation(((message: string) => {
      seen.push(message);
    }) as never);
    const { repo } = setup({ warn: true });
    const sandbox = await createSandbox(repo);
    await sandbox.begin();
    // Inside the sandbox, the warning is given too.
    await repo.transaction(async (tx) => {
      await tx.raw(say("inside"));
      await repo.raw(say("outside"));
    });
    await repo.raw(say("not in a callback"));
    expect(seen).toHaveLength(1);
    await sandbox.rollback();
    await repo.transaction(async () => {
      await repo.raw(say("outside"));
    });
    expect(seen).toHaveLength(2);
  });
});

describe("expectQueries", () => {
  test("returns the repo's query events while fn runs, and stops listening afterwards", async () => {
    const { repo } = setup();
    const queries = await expectQueries(repo, async () => {
      await repo.raw(say("one"));
      await repo.transaction(async (tx) => tx.raw(say("two")));
    });
    expect(queries.map((event) => [event.operation, readable(event.sql)])).toEqual([
      ["raw", "one"],
      ["raw", "two"],
    ]);
    const boom = new Error("boom");
    expect(
      await rejection(
        expectQueries(repo, () => {
          throw boom;
        }),
      ),
    ).toBe(boom);
    // Nothing is listening any more.
    const later = await expectQueries(repo, () => undefined);
    expect(later).toEqual([]);
  });
});

// --- running a batch --------------------------------------------------------------------------------

describe("running a batch", () => {
  const tagRow = (sql: string) => (sql.startsWith("insert") ? [{ c0: 1, c1: "t" }] : [{ n: 1 }]);

  test("its steps run in order between BEGIN and COMMIT", async () => {
    const { pool, repo } = setup();
    pool.rows = tagRow;
    const batch = createBatch()
      .insert("tag", change(Tag, { name: "t" }))
      .run("check", async (tx) => success((await tx.raw(say("check"))).rows.length))
      .put("constant", 5);
    const result = await repo.transaction(batch);
    expect(result).toMatchObject({ success: true, data: { check: 1, constant: 5 } });
    expect(pool.sent.map((sql) => sql.split(" ")[0])).toEqual(["begin", "insert", "check", "commit"]);
  });

  test("an invalid changeset given as it is fails without taking a connection", async () => {
    const { pool, repo } = setup();
    const invalid = change(Tag, {}).addError("name", "is wrong");
    const result = await repo.transaction(createBatch().put("x", 1).update("bad", invalid));
    expect(result).toEqual({ success: false, error: { step: "bad", error: invalid, completed: {} } });
    expect(pool.acquired).toBe(0);
    const thrown = await rejection(repo.transactionOrThrow(createBatch().insert("bad", invalid)));
    expect((thrown as RollbackError).message).toContain('step "bad"');
  });

  test("a failing step rolls back with { step, error, completed }", async () => {
    const { pool, repo } = setup();
    pool.rows = tagRow;
    const result = await repo.transaction(
      createBatch()
        .insert("tag", change(Tag, { name: "t" }))
        .run("nope", () => failure("full")),
    );
    if (result.success) throw new Error("expected a failure");
    expect(result.error.step).toBe("nope");
    expect(result.error.error).toBe("full");
    expect(Object.keys(result.error.completed)).toEqual(["tag"]);
    expect(pool.sent.at(-1)).toBe("rollback");
  });

  test("a batch on tx runs in a savepoint", async () => {
    const { pool, repo } = setup();
    await repo.transaction(async (tx) => {
      const inner = await tx.transaction(createBatch().run("nope", () => failure("x")));
      expect(inner.success).toBe(false);
      expect(await tx.transactionOrThrow(createBatch().put("y", 2))).toEqual({ y: 2 });
    });
    expect(pool.sent).toEqual([
      "begin",
      'savepoint "egon_1"',
      'rollback to savepoint "egon_1"',
      'savepoint "egon_1"',
      'release savepoint "egon_1"',
      "commit",
    ]);
  });

  test("a rollback reason that is not a batch failure keeps the general message", async () => {
    const { repo } = setup();
    const error = await rejection(
      repo.transactionOrThrow(
        createBatch().run("manual", (tx) => {
          tx.rollback("by hand");
          return success(1);
        }),
      ),
    );
    expect((error as RollbackError).reason).toBe("by hand");
    expect((error as Error).message).toContain("tx.rollback(reason) was called");
  });
});
