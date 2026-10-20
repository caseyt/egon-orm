// The transaction conformance suite: what transactions, Batch and the sandbox must do
// against a real database, written once and run by each dialect package with a profile of
// its own. It covers commit and every kind of rollback, savepoints three deep, isolation
// levels (a serialisation failure between two connections, then retried), the timeout,
// use after completion, concurrent calls on one transaction, the pool after every outcome,
// checkouts, streams and bulk inserts inside a transaction, Batch, and the sandbox
// (including two test files that write the same unique email at the same time).
//
// One database per run of the suite, over the blog fixture plus the profile's tables.
// These tests commit (that is what they check), so every table is emptied before each one.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Batch,
  type Changeset,
  ConstraintError,
  cast,
  change,
  createBatch,
  createRepo,
  type DatabaseAdapter,
  DatabaseError,
  failure,
  from,
  QueryError,
  type Repo,
  type RepoOptions,
  type RepoQueryEvent,
  RollbackError,
  Schema,
  success,
  t,
} from "egon-orm";
import { createSandbox, expectQueries } from "egon-orm/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createTestDatabase,
  Profile,
  Tag,
  type TestDatabase,
  type TestDatabaseHandle,
  truncateAll,
  User,
} from "../../support/index.js";
import type { MakeTransactionAdapterOptions, TransactionConformanceProfile } from "./profile.js";
import { SANDBOX_DB_ENV, SANDBOX_PROFILE_ENV, SANDBOX_TOKEN_ENV } from "./sandbox-pair.js";

export type { MakeTransactionAdapterOptions, TransactionConformanceProfile } from "./profile.js";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function fail(message: string): never {
  throw new Error(message);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check()` holds, polling. */
async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await sleep(10);
  }
}

/** A promise and the function that resolves it. */
function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** The suite's own table: forty integer columns, so that a bulk insert of a few thousand rows takes several statements. */
const wideFields: Record<string, ReturnType<typeof t.integer>> = {};
for (let i = 0; i < 40; i++) wideFields[`c${i}`] = t.integer();
class WideRow extends Schema("wide_rows", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  ...wideFields,
}) {}

function wideRow(n: number): Record<string, number> {
  const row: Record<string, number> = {};
  for (let i = 0; i < 40; i++) row[`c${i}`] = i === 0 ? n : i;
  return row;
}

/** A user changeset that reports a taken email as a changeset error. */
function newUser(email: string) {
  return cast(User, { email }, ["email"]).uniqueConstraint("email");
}

const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
const vitestCli = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");

export function runTransactionConformance(profile: TransactionConformanceProfile): void {
  describe(`transaction conformance: ${profile.label}`, () => {
    let handle: TestDatabaseHandle;
    let db: TestDatabase;
    const adapters: DatabaseAdapter[] = [];

    function adapter(options: Partial<MakeTransactionAdapterOptions> = {}): DatabaseAdapter {
      const made = profile.makeAdapter(db, { poolMax: options.poolMax ?? 4 });
      adapters.push(made);
      return made;
    }

    function repo(options: Partial<RepoOptions> & Partial<MakeTransactionAdapterOptions> = {}): Repo {
      const { poolMax, ...rest } = options;
      return createRepo({
        adapter: rest.adapter ?? adapter(poolMax === undefined ? {} : { poolMax }),
        ...rest,
      });
    }

    /** Connections checked out of an adapter's pool. */
    const busy = (made: DatabaseAdapter): number => {
      const stats = made.poolStats();
      return stats.size - stats.idle;
    };

    /** What a second connection sees, outside every transaction. */
    async function committedTags(): Promise<string[]> {
      const rows = await db.query<{ name: string }>("select name from tags order by id");
      return rows.map((row) => row.name);
    }

    async function sessionOf(r: Repo): Promise<unknown> {
      const { rows } = await r.raw(profile.sessionId);
      return rows[0]?.id;
    }

    beforeAll(async () => {
      handle = await createTestDatabase(profile.server, { label: "transaction", fixtures: ["blog"] });
      db = handle.db;
      await db.exec(profile.schema);
    });

    beforeEach(async () => {
      await truncateAll(db);
    });

    afterEach(async () => {
      for (const each of adapters.splice(0)) {
        // Every connection a test checked out must be back by the time it ends.
        await eventually(() => busy(each) === 0);
        await each.close();
      }
    });

    afterAll(async () => {
      await handle?.drop();
    });

    // --- commit and rollback ----------------------------------------------------------

    describe("commit and rollback", () => {
      test("a callback that returns commits its writes and gives its value as success", async () => {
        const r = repo();
        const result = await r.transaction(async (tx) => {
          expect(tx.inTransaction).toBe(true);
          const tag = await tx.insertOrThrow(change(Tag, { name: "kept" }));
          // Not visible outside the transaction until it commits.
          expect(await committedTags()).toEqual([]);
          return tag.name;
        });
        expect(result).toEqual({ success: true, data: "kept" });
        expect(r.inTransaction).toBe(false);
        expect(await committedTags()).toEqual(["kept"]);
      });

      test("tx.rollback(reason) undoes the writes, stops the callback and returns the reason", async () => {
        const r = repo();
        let after = false;
        const result = await r.transaction(async (tx) => {
          await tx.insertOrThrow(change(Tag, { name: "undone" }));
          tx.rollback({ why: "changed my mind" });
          after = true;
        });
        expect(result).toEqual({ success: false, error: { why: "changed my mind" } });
        expect(after).toBe(false);
        expect(await committedTags()).toEqual([]);
      });

      test("a throw undoes the writes and rethrows the same error", async () => {
        const r = repo();
        const boom = new Error("boom");
        const error = await rejection(
          r.transaction(async (tx) => {
            await tx.insertOrThrow(change(Tag, { name: "undone" }));
            throw boom;
          }),
        );
        expect(error).toBe(boom);
        expect(await committedTags()).toEqual([]);
      });

      test("transactionOrThrow returns the value, and a rollback throws RollbackError with the reason", async () => {
        const r = repo();
        expect(
          await r.transactionOrThrow(async (tx) => (await tx.insertOrThrow(change(Tag, { name: "a" }))).name),
        ).toBe("a");
        const error = await rejection(
          r.transactionOrThrow(async (tx) => {
            await tx.insertOrThrow(change(Tag, { name: "b" }));
            return tx.rollback("over the limit");
          }),
        );
        expect(error).toBeInstanceOf(RollbackError);
        expect((error as RollbackError).reason).toBe("over the limit");
        expect(await committedTags()).toEqual(["a"]);
      });

      test("a failed write the callback did not handle rolls the transaction back", async () => {
        const r = repo();
        await r.insertOrThrow(change(User, { email: "taken@example.com" }));
        const result = await r.transaction(async (tx) => {
          await tx.insertOrThrow(change(Tag, { name: "with the user" }));
          const written = await tx.insert(newUser("taken@example.com"));
          expect(written.success).toBe(false);
          return "returned anyway";
        });
        if (result.success) fail("expected the transaction to roll back");
        expect(result.error).toBeInstanceOf(ConstraintError);
        expect(await committedTags()).toEqual([]);
        const thrown = await rejection(
          r.transactionOrThrow(async (tx) => {
            await tx.insert(newUser("taken@example.com"));
          }),
        );
        expect(thrown).toBeInstanceOf(RollbackError);
        expect((thrown as RollbackError).reason).toBeInstanceOf(ConstraintError);
      });

      test("after a failed statement, the transaction refuses further statements", async () => {
        const r = repo();
        await r.insertOrThrow(change(User, { email: "taken@example.com" }));
        const error = await rejection(
          r.transaction(async (tx) => {
            await tx.insert(newUser("taken@example.com"));
            await tx.insertOrThrow(change(Tag, { name: "never" }));
          }),
        );
        expect(error).toBeInstanceOf(QueryError);
        expect((error as QueryError).message).toContain("A statement in this transaction failed");
        expect((error as QueryError).cause).toBeInstanceOf(ConstraintError);
        expect(await committedTags()).toEqual([]);
      });
    });

    // --- nesting -----------------------------------------------------------------------

    describe("nested transactions", () => {
      test("savepoints three deep: an inner rollback keeps the outer work, and the outer transaction carries on", async () => {
        const r = repo();
        const result = await r.transaction(async (one) => {
          await one.insertOrThrow(change(Tag, { name: "one" }));
          const second = await one.transaction(async (two) => {
            await two.insertOrThrow(change(Tag, { name: "two" }));
            const third = await two.transaction(async (three) => {
              await three.insertOrThrow(change(Tag, { name: "three" }));
              expect(await three.count(Tag)).toBe(3);
              three.rollback("not this one");
            });
            expect(third).toEqual({ success: false, error: "not this one" });
            expect(await two.count(Tag)).toBe(2);
            await two.insertOrThrow(change(Tag, { name: "two again" }));
            return "second level done";
          });
          expect(second).toEqual({ success: true, data: "second level done" });
          return one.count(Tag);
        });
        expect(result).toEqual({ success: true, data: 3 });
        expect(await committedTags()).toEqual(["one", "two", "two again"]);
      });

      test("a throw in a nested transaction undoes only its work", async () => {
        const r = repo();
        await r.transaction(async (tx) => {
          await tx.insertOrThrow(change(Tag, { name: "outer" }));
          const error = await rejection(
            tx.transaction(async (inner) => {
              await inner.insertOrThrow(change(Tag, { name: "inner" }));
              throw new Error("inner failed");
            }),
          );
          expect((error as Error).message).toBe("inner failed");
          await tx.insertOrThrow(change(Tag, { name: "outer again" }));
        });
        expect(await committedTags()).toEqual(["outer", "outer again"]);
      });

      test("a failed statement in a nested transaction is undone with it, and the outer transaction stays usable", async () => {
        const r = repo();
        await r.insertOrThrow(change(User, { email: "taken@example.com" }));
        const result = await r.transaction(async (tx) => {
          const inner = await tx.transaction(async (savepoint) => {
            const written = await savepoint.insert(newUser("taken@example.com"));
            if (!written.success) savepoint.rollback(written.error.errors);
            return written;
          });
          expect(inner.success).toBe(false);
          await tx.insertOrThrow(change(Tag, { name: "after the savepoint" }));
          return "done";
        });
        expect(result).toEqual({ success: true, data: "done" });
        expect(await committedTags()).toEqual(["after the savepoint"]);
      });

      test("isolation, readOnly and retries cannot be given to a nested transaction", async () => {
        const r = repo();
        await r.transaction(async (tx) => {
          for (const options of [
            { isolation: "serializable" as const },
            { readOnly: true },
            { retries: 1 },
          ]) {
            expect(await rejection(tx.transaction(async () => undefined, options))).toBeInstanceOf(
              QueryError,
            );
          }
        });
      });

      test("the outer tx used inside a nested callback is refused", async () => {
        const r = repo();
        await r.transaction(async (tx) => {
          await tx.transaction(async () => {
            const error = await rejection(tx.all(Tag));
            expect((error as QueryError).message).toContain("A nested transaction is open on this tx");
          });
          expect(await tx.count(Tag)).toBe(0);
        });
      });
    });

    // --- isolation and retries ------------------------------------------------------------

    describe("isolation levels and retries", () => {
      test("the isolation level and read-only mode are those asked for", async () => {
        const r = repo();
        const capabilities = (adapters[adapters.length - 1] as DatabaseAdapter).capabilities;
        for (const isolation of ["read committed", "repeatable read", "serializable"] as const) {
          if (!capabilities.isolationLevels.includes(isolation)) {
            // A level the database does not have is refused before anything is sent.
            await expect(r.transaction(async () => undefined, { isolation })).rejects.toThrow(QueryError);
            continue;
          }
          const result = await r.transactionOrThrow(
            async (tx) => (await tx.raw(profile.isolationLevel)).rows[0]?.level,
            {
              isolation,
            },
          );
          expect(result).toBe(isolation);
        }
        const error = await rejection(
          r.transaction(async (tx) => tx.insertOrThrow(change(Tag, { name: "no" })), { readOnly: true }),
        );
        // A read-only transaction the database cannot start is refused before anything is
        // sent (capability readOnlyTransactions); one it can start refuses the write.
        expect(error).toBeInstanceOf(capabilities.readOnlyTransactions ? DatabaseError : QueryError);
        expect(await committedTags()).toEqual([]);
      });

      /**
       * Two serializable transactions on two connections that each read the tags and then
       * add one: whichever commits second has read what the first changed, so the database
       * refuses it. Both callbacks wait for each other after their read.
       */
      async function writeSkew(r: Repo, retries: number): Promise<{ results: unknown[]; attempts: number }> {
        let attempts = 0;
        let read = 0;
        const bothRead = gate();
        const body = (name: string) => async (tx: Repo) => {
          attempts++;
          const count = await tx.count(Tag);
          read++;
          if (read === 2) bothRead.open();
          // Only the first attempts wait for each other: a retry runs alone.
          if (attempts <= 2) await Promise.race([bothRead.promise, sleep(2_000)]);
          await tx.insertOrThrow(change(Tag, { name: `${name} saw ${count}` }));
          return name;
        };
        const settled = await Promise.allSettled([
          r.transaction(body("first"), { isolation: "serializable", retries }),
          r.transaction(body("second"), { isolation: "serializable", retries }),
        ]);
        return {
          results: settled.map((each) => (each.status === "fulfilled" ? each.value : each.reason)),
          attempts,
        };
      }

      test("two serializable transactions that conflict: one fails with a retryable serialisation failure", async (context) => {
        const r = repo();
        if (!adapters[adapters.length - 1]?.capabilities.multipleConnections) {
          return context.skip("capability multipleConnections is false");
        }
        const { results, attempts } = await writeSkew(r, 0);
        expect(attempts).toBe(2);
        const failures = results.filter((each) => each instanceof DatabaseError);
        expect(failures).toHaveLength(1);
        // A database that resolves the conflict with locks (capability serializationFailures
        // false: MySQL) fails one of the two with a deadlock instead, retryable all the same.
        const serializes = adapters[adapters.length - 1]?.capabilities.serializationFailures !== false;
        expect((failures[0] as DatabaseError).code).toBe(serializes ? "serializationFailure" : "deadlock");
        expect((failures[0] as DatabaseError).retryable).toBe(true);
        expect(await committedTags()).toHaveLength(1);
      });

      test("a deadlock the callback caught before running another statement is retried", async (context) => {
        const r = repo();
        if (!adapters[adapters.length - 1]?.capabilities.multipleConnections) {
          return context.skip("capability multipleConnections is false");
        }
        // Without RETURNING the two tags are read back.
        const { rows } = adapters[adapters.length - 1]?.capabilities.returning
          ? await r.insertAll(Tag, [{ name: "one" }, { name: "two" }], { returning: true })
          : await r
              .insertAll(Tag, [{ name: "one" }, { name: "two" }])
              .then(async () => ({ rows: await r.all(from(Tag, "t").orderBy(({ t }) => t.id)) }));
        const [one, two] = rows as [Tag, Tag];
        const attempts = { a: 0, b: 0 };
        let locked = 0;
        const bothLocked = gate();
        const body = (key: "a" | "b", first: number, second: number) => async (tx: Repo) => {
          attempts[key]++;
          await tx.updateAll(
            from(Tag, "t")
              .where({ id: first })
              .set({ name: `${key} first` }),
          );
          if (attempts[key] === 1) {
            locked++;
            if (locked === 2) bothLocked.open();
            await Promise.race([bothLocked.promise, sleep(3_000)]);
          }
          try {
            await tx.updateAll(
              from(Tag, "t")
                .where({ id: second })
                .set({ name: `${key} second` }),
            );
          } catch {
            // A helper that logs the error and carries on.
          }
          await tx.count(Tag);
          return key;
        };
        const results = await Promise.all([
          r.transaction(body("a", one.id, two.id), { retries: 2 }),
          r.transaction(body("b", two.id, one.id), { retries: 2 }),
        ]);
        expect(results).toEqual([
          { success: true, data: "a" },
          { success: true, data: "b" },
        ]);
        // The one the database chose as the deadlock's victim ran twice.
        expect(attempts.a + attempts.b).toBe(3);
      });

      test("with retries, the transaction that lost the conflict runs again and commits", async (context) => {
        const r = repo();
        if (!adapters[adapters.length - 1]?.capabilities.multipleConnections) {
          return context.skip("capability multipleConnections is false");
        }
        const { results, attempts } = await writeSkew(r, 2);
        expect(attempts).toBe(3);
        expect(results.map((each) => (each as { success: boolean }).success)).toEqual([true, true]);
        const tags = await committedTags();
        expect(tags).toHaveLength(2);
        // The retried one saw the other's tag.
        expect(tags.some((name) => name.endsWith("saw 1"))).toBe(true);
      });
    });

    // --- timeouts -----------------------------------------------------------------------

    describe("timeoutMs", () => {
      test("cancels the running statement and rolls back", async (context) => {
        const made = adapter({ poolMax: 2 });
        if (!made.capabilities.cancel) return context.skip("capability cancel is false");
        const r = repo({ adapter: made });
        const started = Date.now();
        const error = await rejection(
          r.transaction(
            async (tx) => {
              await tx.insertOrThrow(change(Tag, { name: "timed out" }));
              await tx.raw(profile.sleep(5));
            },
            { timeoutMs: 400 },
          ),
        );
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(error).toBeInstanceOf(DatabaseError);
        expect((error as DatabaseError).code).toBe("timeout");
        expect((error as Error).message).toContain("timeoutMs (400 ms)");
        expect(await committedTags()).toEqual([]);
        await eventually(() => busy(made) === 0);
        // The pool is fine afterwards.
        expect(await r.count(Tag)).toBe(0);
      });

      test("covers the time between statements too; tx is refused afterwards", async () => {
        const r = repo();
        let leaked: Repo | undefined;
        const error = await rejection(
          r.transaction(
            async (tx) => {
              leaked = tx;
              await tx.insertOrThrow(change(Tag, { name: "slow callback" }));
              await sleep(600);
              await tx.insertOrThrow(change(Tag, { name: "never" }));
            },
            { timeoutMs: 200 },
          ),
        );
        expect((error as DatabaseError).code).toBe("timeout");
        await sleep(600);
        expect(await rejection((leaked as Repo).count(Tag))).toBeInstanceOf(QueryError);
        expect(await committedTags()).toEqual([]);
      });
    });

    // --- use after completion and concurrency ------------------------------------------

    describe("use after completion and concurrent calls", () => {
      test("a call on tx after its callback ended throws QueryError", async () => {
        const r = repo();
        let leaked: Repo | undefined;
        await r.transaction(async (tx) => {
          leaked = tx;
        });
        const error = await rejection((leaked as Repo).all(Tag));
        expect(error).toBeInstanceOf(QueryError);
        expect((error as QueryError).message).toContain("transaction already completed");
        expect(() => (leaked as Repo).rollback("late")).toThrow(QueryError);
        expect(await rejection((leaked as Repo).transaction(async () => undefined))).toBeInstanceOf(
          QueryError,
        );
      });

      test("calls issued together on tx run one at a time, in the order they were issued", async () => {
        const r = repo();
        const names = Array.from({ length: 25 }, (_, i) => `tag ${String(i).padStart(2, "0")}`);
        await r.transaction(async (tx) => {
          const counts = await Promise.all([
            ...names.map((name) => tx.insertOrThrow(change(Tag, { name }))),
            tx.count(Tag),
          ]);
          expect(counts.at(-1)).toBe(25);
        });
        const rows = await db.query<{ name: string }>("select name from tags order by id");
        expect(rows.map((row) => row.name)).toEqual(names);
      });

      test("a statement that times out while it waits for the one before it never runs, and the transaction carries on", async (context) => {
        const r = repo();
        // Where a running statement blocks until it ends (capability cancel false), no timer
        // fires while the next one waits for it.
        if (!adapters[adapters.length - 1]?.capabilities.cancel) {
          return context.skip("capability cancel is false");
        }
        await r.transaction(async (tx) => {
          const [slow, waiting] = await Promise.allSettled([
            tx.raw(profile.sleep(0.4)),
            tx.insert(change(Tag, { name: "waited too long" }), { timeoutMs: 100 }),
          ]);
          expect(slow.status).toBe("fulfilled");
          expect(waiting.status).toBe("rejected");
          const error = (waiting as PromiseRejectedResult).reason as DatabaseError;
          expect(error.code).toBe("timeout");
          expect(error.message).toContain("was not run");
          // Nothing failed in the database: the transaction is still usable and commits.
          await tx.insertOrThrow(change(Tag, { name: "after" }));
        });
        expect(await committedTags()).toEqual(["after"]);
      });
    });

    // --- connections --------------------------------------------------------------------

    describe("connections", () => {
      test("every outcome returns the connection to the pool", async () => {
        const made = adapter({ poolMax: 2 });
        const r = repo({ adapter: made });
        await r.insertOrThrow(change(User, { email: "taken@example.com" }));
        const outcomes: (() => Promise<unknown>)[] = [
          () => r.transaction(async (tx) => tx.count(Tag)),
          () => r.transaction(async (tx) => tx.rollback("no")),
          () =>
            r.transaction(async () => {
              throw new Error("thrown");
            }),
          () => r.transaction(async (tx) => tx.insert(newUser("taken@example.com"))),
          () =>
            r.transaction(async (tx) => {
              await tx.insert(newUser("taken@example.com"));
              await tx.count(Tag);
            }),
          () => r.transaction(async (tx) => tx.raw(profile.sleep(2)), { timeoutMs: 100 }),
          () => r.transaction(async (tx) => tx.transaction(async (inner) => inner.rollback("inner"))),
          () => r.transactionOrThrow(async (tx) => tx.rollback("thrown as RollbackError")),
          () => r.checkout(async (c) => c.count(Tag)),
          () => r.transaction(createBatch().insert("dup", newUser("taken@example.com"))),
        ];
        for (const outcome of outcomes) {
          await outcome().catch(() => undefined);
          await eventually(() => busy(made) === 0);
        }
        // Still only the two connections it may open, and all of them work.
        expect(made.poolStats().size).toBeLessThanOrEqual(2);
        await Promise.all([r.count(Tag), r.count(Tag)]);
      });

      test("the repo outside the callback runs on another connection, outside the transaction", async (context) => {
        const r = repo();
        if (!adapters[adapters.length - 1]?.capabilities.multipleConnections) {
          return context.skip("capability multipleConnections is false");
        }
        await r.transaction(async (tx) => {
          await tx.insertOrThrow(change(Tag, { name: "inside" }));
          expect(await sessionOf(tx)).not.toEqual(await sessionOf(r));
          expect(await r.count(Tag)).toBe(0);
          await r.insertOrThrow(change(Tag, { name: "outside" }));
          tx.rollback("only the inside one");
        });
        expect(await committedTags()).toEqual(["outside"]);
      });
    });

    // --- checkout -----------------------------------------------------------------------

    describe("checkout", () => {
      test("gives one connection with no transaction, and transactions inside it run on that connection", async () => {
        const r = repo();
        await r.checkout(async (c) => {
          expect(c.inTransaction).toBe(false);
          const session = await sessionOf(c);
          expect(await sessionOf(c)).toEqual(session);
          await c.insertOrThrow(change(Tag, { name: "no transaction" }));
          // Committed at once: there is no transaction.
          expect(await committedTags()).toEqual(["no transaction"]);
          const inner = await c.transaction(async (tx) => {
            expect(await sessionOf(tx)).toEqual(session);
            await tx.insertOrThrow(change(Tag, { name: "rolled back" }));
            tx.rollback("no");
          });
          expect(inner.success).toBe(false);
          // With the options a transaction takes (a database without levels takes none).
          const levels = (adapters[adapters.length - 1] as DatabaseAdapter).capabilities.isolationLevels;
          const options = levels.includes("serializable") ? { isolation: "serializable" as const } : {};
          expect(await c.transactionOrThrow(async (tx) => tx.inTransaction, options)).toBe(true);
        });
        expect(await committedTags()).toEqual(["no transaction"]);
      });
    });

    // --- streams and bulk inserts inside a transaction -----------------------------------

    describe("streams and bulk writes inside a transaction", () => {
      test("tx.stream runs on the transaction's connection and sees its own writes", async () => {
        const r = repo();
        await r.transaction(async (tx) => {
          await tx.insertAll(
            Tag,
            Array.from({ length: 30 }, (_, i) => ({ name: `s${i}` })),
          );
          const names: string[] = [];
          for await (const tag of tx.stream(
            from(Tag, "t").orderBy(({ t }) => t.id),
            { batchSize: 7 },
          )) {
            names.push(tag.name ?? "");
          }
          expect(names).toHaveLength(30);
          tx.rollback("streamed");
        });
      });

      test("a bulk insert of several statements that fails runs in a savepoint: only it is undone", async () => {
        const r = repo();
        const rows = Array.from({ length: 2_400 }, (_, i) => wideRow(i));
        rows.push(wideRow(5)); // a duplicate of c0, in the last statement
        const result = await r.transaction(async (tx) => {
          await tx.insertOrThrow(change(Tag, { name: "before the bulk insert" }));
          const error = await rejection(tx.insertAll(WideRow, rows));
          expect(error).toBeInstanceOf(ConstraintError);
          expect(await tx.count(WideRow)).toBe(0);
          await tx.insertAll(WideRow, rows.slice(0, 2_000));
          return tx.count(WideRow);
        });
        expect(result).toEqual({ success: true, data: 2_000 });
        expect(await committedTags()).toEqual(["before the bulk insert"]);
      });
    });

    // --- Batch --------------------------------------------------------------------------

    describe("Batch", () => {
      const signUp = (email: string) =>
        createBatch()
          .insert("user", newUser(email))
          .insert("profile", ({ user }) => change(Profile, { userId: user.id, bio: "hello" }))
          .run("greeting", async (tx, { user }) =>
            success(`welcome ${user.email} (${await tx.count(User)})`),
          );

      test("runs every step in one transaction and returns each result under its name", async () => {
        const r = repo();
        const batch = signUp("ada@example.com")
          .put("source", "form")
          .one("again", ({ user }) => from(User, "u").where({ id: user.id }))
          .all("profiles", from(Profile, "p"))
          .exists("hasTags", from(Tag, "t"))
          .insertAll("tags", Tag, [{ name: "x" }, { name: "y" }])
          .updateAll("renamed", ({ user }) => from(Tag, "t").where({ name: "x" }).set({ name: user.email }))
          .deleteAll("deleted", from(Tag, "t").where({ name: "y" }))
          .merge(({ user }) => createBatch().insert("audit", change(Tag, { name: `signed up ${user.id}` })));
        const result = await r.transaction(batch);
        if (!result.success) fail("expected the batch to succeed");
        const data = result.data;
        expect(data.user.email).toBe("ada@example.com");
        expect(data.profile.userId).toBe(data.user.id);
        expect(data.greeting).toBe("welcome ada@example.com (1)");
        expect(data.source).toBe("form");
        expect(data.again?.id).toBe(data.user.id);
        expect(data.profiles).toHaveLength(1);
        expect(data.hasTags).toBe(false);
        expect(data.tags.count).toBe(2);
        expect(data.renamed.count).toBe(1);
        expect(data.deleted.count).toBe(1);
        expect(await committedTags()).toEqual(["ada@example.com", `signed up ${data.user.id}`]);
      });

      test("a failing write step rolls everything back and names the step, its changeset and what completed", async () => {
        const r = repo();
        await r.insertOrThrow(change(User, { email: "taken@example.com" }));
        const batch = createBatch()
          .insert("tag", change(Tag, { name: "rolled back" }))
          .insert("user", newUser("taken@example.com"))
          .insert("never", change(Tag, { name: "never" }));
        const result = await r.transaction(batch);
        if (result.success) fail("expected the batch to fail");
        expect(result.error.step).toBe("user");
        if (result.error.step !== "user") return;
        const changeset: Changeset<typeof User, true> = result.error.error;
        expect(changeset.errorMessages()).toEqual({ email: ["has already been taken"] });
        expect(Object.keys(result.error.completed)).toEqual(["tag"]);
        expect(await committedTags()).toEqual([]);
      });

      test("a run step that returns failure(x) fails the batch with x", async () => {
        const r = repo();
        const batch = signUp("ada@example.com").run("quota", async () => failure({ reason: "full" }));
        const result = await r.transaction(batch);
        if (result.success) fail("expected the batch to fail");
        expect(result.error).toMatchObject({ step: "quota", error: { reason: "full" } });
        expect(Object.keys(result.error.completed)).toEqual(["user", "profile", "greeting"]);
        expect(await r.count(User)).toBe(0);
      });

      test("a step that throws rolls back and the error propagates", async () => {
        const r = repo();
        const boom = new Error("boom");
        const batch = signUp("ada@example.com").run("explodes", async () => {
          throw boom;
        });
        expect(await rejection(r.transaction(batch))).toBe(boom);
        expect(await r.count(User)).toBe(0);
      });

      test("an invalid changeset given as it is fails the batch before any statement", async () => {
        const made = adapter();
        const r = repo({ adapter: made });
        const statements: string[] = [];
        made.on("query", (event) => statements.push(event.sql));
        const invalid = cast(User, {}, ["email"]).validateRequired(["email"]);
        const batch = createBatch()
          .insert("tag", change(Tag, { name: "never" }))
          .insert("user", invalid);
        const queries = await expectQueries(r, async () => {
          const result = await r.transaction(batch);
          if (result.success) fail("expected the batch to fail");
          expect(result.error).toEqual({ step: "user", error: invalid, completed: {} });
        });
        expect(queries).toEqual([]);
        expect(statements).toEqual([]);
      });

      test("merge builds steps from earlier results, inside the same transaction", async () => {
        const r = repo();
        const batch = createBatch()
          .insert("first", change(Tag, { name: "first" }))
          .merge(({ first }) =>
            createBatch()
              .insert("second", change(Tag, { name: `after ${first.name}` }))
              .run("check", async (tx) =>
                (await tx.count(Tag)) === 2 ? success(true) : failure("not seen"),
              ),
          );
        expect(Batch.toList(batch).map((each) => each.operation)).toEqual(["insert", "merge"]);
        const result = await r.transactionOrThrow(batch);
        expect(result.second.name).toBe("after first");
        expect(result.check).toBe(true);
      });

      test("a batch inside a transaction runs in a savepoint", async () => {
        const r = repo();
        await r.insertOrThrow(change(User, { email: "taken@example.com" }));
        await r.transaction(async (tx) => {
          await tx.insertOrThrow(change(Tag, { name: "outer" }));
          const inner = await tx.transaction(signUp("taken@example.com"));
          expect(inner.success).toBe(false);
          await tx.insertOrThrow(change(Tag, { name: "outer again" }));
        });
        expect(await committedTags()).toEqual(["outer", "outer again"]);
      });

      test("transactionOrThrow(batch) throws RollbackError carrying { step, error, completed }", async () => {
        const r = repo();
        const error = await rejection(
          r.transactionOrThrow(createBatch().run("nope", async () => failure("no"))),
        );
        expect(error).toBeInstanceOf(RollbackError);
        expect((error as RollbackError).reason).toEqual({ step: "nope", error: "no", completed: {} });
        expect((error as Error).message).toContain('step "nope"');
      });
    });

    // --- the sandbox --------------------------------------------------------------------

    describe("sandbox", () => {
      test("routes the repo through one transaction that rollback() undoes", async () => {
        const app = repo();
        const sandbox = await createSandbox(app);
        const sandboxed = await sandbox.begin();
        expect(sandboxed.inTransaction).toBe(true);
        expect(app.inTransaction).toBe(false);
        // Application code using the repo itself is inside the sandbox.
        await app.insertOrThrow(change(Tag, { name: "sandboxed" }));
        await app.insertAll(Tag, [{ name: "bulk" }]);
        expect(await app.count(Tag)).toBe(2);
        expect(await sandboxed.count(Tag)).toBe(2);
        expect(await sessionOf(app)).toEqual(await sessionOf(sandboxed));
        expect(await committedTags()).toEqual([]);
        await sandbox.rollback();
        expect(await app.count(Tag)).toBe(0);
        expect(await committedTags()).toEqual([]);
        // Rolling back twice, or before begin, does nothing.
        await sandbox.rollback();
      });

      test("the repo's transactions become savepoints of the sandbox's", async () => {
        const app = repo();
        const sandbox = await createSandbox(app);
        await sandbox.begin();
        try {
          await app.insertOrThrow(change(Tag, { name: "kept in the sandbox" }));
          const rolled = await app.transaction(async (tx) => {
            await tx.insertOrThrow(change(Tag, { name: "undone" }));
            tx.rollback("no");
          });
          expect(rolled.success).toBe(false);
          // Options only a real transaction takes are accepted and left out.
          const committed = await app.transaction(
            async (tx) => tx.insertOrThrow(change(Tag, { name: "released" })),
            {
              isolation: "serializable",
              retries: 2,
            },
          );
          expect(committed.success).toBe(true);
          const names = (await app.all(from(Tag, "t").orderBy(({ t }) => t.id))).map((tag) => tag.name);
          expect(names).toEqual(["kept in the sandbox", "released"]);
        } finally {
          await sandbox.rollback();
        }
        expect(await committedTags()).toEqual([]);
      });

      test("a write the database refuses in the sandbox undoes only itself, as it would outside the sandbox", async () => {
        const app = repo();
        const sandbox = await createSandbox(app);
        await sandbox.begin();
        try {
          await app.insertOrThrow(newUser("ada@example.com"));
          const again = await app.insert(newUser("ada@example.com"));
          expect(again.success).toBe(false);
          // The sandbox's transaction is still usable: the test carries on.
          expect(await app.count(User)).toBe(1);
          await app.insertOrThrow(newUser("grace@example.com"));
          expect(await app.count(User)).toBe(2);
        } finally {
          await sandbox.rollback();
        }
        expect(await db.query("select email from users")).toEqual([]);
      });

      test("the repo used inside its own transaction callback is refused at once, not left waiting", async () => {
        const app = repo();
        const sandbox = await createSandbox(app);
        await sandbox.begin();
        try {
          const started = Date.now();
          const result = await app.transaction(async (tx) => {
            await tx.insertOrThrow(newUser("a1@example.com"));
            const nested = await rejection(
              app.transaction(async (t2) => t2.insertOrThrow(newUser("a2@example.com"))),
            );
            const bulk = await rejection(
              app.insertAll(
                WideRow,
                Array.from({ length: 2_400 }, (_, i) => wideRow(i)),
              ),
            );
            const plain = await rejection(app.count(User));
            for (const error of [nested, bulk, plain]) {
              expect(error).toBeInstanceOf(QueryError);
              expect((error as Error).message).toContain("inside one of its own transaction callbacks");
            }
            return tx.count(User);
          });
          expect(result).toEqual({ success: true, data: 1 });
          expect(Date.now() - started).toBeLessThan(2_000);
          expect(await app.count(WideRow)).toBe(0);
        } finally {
          await sandbox.rollback();
        }
      });

      test("a write of the repo made while one of its transactions is open waits for it, and survives its rollback", async () => {
        const app = repo();
        const sandbox = await createSandbox(app);
        await sandbox.begin();
        try {
          const entered = gate();
          const finish = gate();
          const transaction = app.transaction(async (tx) => {
            await tx.insertOrThrow(change(Tag, { name: "d1" }));
            entered.open();
            await finish.promise;
            tx.rollback("undone");
          });
          await entered.promise;
          // A concurrent request: its write is made from outside the callback.
          let written = false;
          const concurrent = app.insertOrThrow(change(Tag, { name: "d2" })).then((tag) => {
            written = true;
            return tag;
          });
          await sleep(100);
          expect(written).toBe(false);
          finish.open();
          expect(await transaction).toEqual({ success: false, error: "undone" });
          expect((await concurrent).name).toBe("d2");
          expect((await app.all(Tag)).map((tag) => tag.name)).toEqual(["d2"]);
        } finally {
          await sandbox.rollback();
        }
        expect(await committedTags()).toEqual([]);
      });

      test("two sandboxes over two repos do not see each other's writes", async (context) => {
        const first = repo();
        const second = repo();
        // Two writing transactions at once, in one process (capability multipleConnections:
        // SQLite has one writer at a time, and its driver waits for a lock without yielding).
        if (!adapters[adapters.length - 1]?.capabilities.multipleConnections) {
          return context.skip("capability multipleConnections is false");
        }
        const one = await createSandbox(first);
        const two = await createSandbox(second);
        await one.begin();
        await two.begin();
        try {
          await first.insertOrThrow(change(Tag, { name: "first's" }));
          await second.insertOrThrow(change(Tag, { name: "second's" }));
          expect((await first.all(Tag)).map((tag) => tag.name)).toEqual(["first's"]);
          expect((await second.all(Tag)).map((tag) => tag.name)).toEqual(["second's"]);
        } finally {
          await one.rollback();
          await two.rollback();
        }
        expect(await committedTags()).toEqual([]);
      });

      test("begin twice without a rollback is refused", async () => {
        const app = repo();
        const sandbox = await createSandbox(app);
        await sandbox.begin();
        try {
          expect(await rejection(sandbox.begin())).toBeInstanceOf(QueryError);
          expect(await rejection((await createSandbox(app)).begin())).toBeInstanceOf(QueryError);
        } finally {
          await sandbox.rollback();
        }
      });

      test("expectQueries counts the statements of a piece of code, those of its transactions included", async () => {
        const app = repo();
        const sandbox = await createSandbox(app);
        await sandbox.begin();
        try {
          const queries = await expectQueries(app, async () => {
            await app.insertOrThrow(change(Tag, { name: "a" }));
            await app.transaction(async (tx) => tx.count(Tag));
          });
          expect(queries.map((event: RepoQueryEvent) => event.operation)).toEqual(["insert", "aggregate"]);
        } finally {
          await sandbox.rollback();
        }
      });

      test("two test files, each in its own sandbox, write the same unique email at the same time", {
        timeout: 120_000,
      }, async () => {
        const scratch = mkdtempSync(join(tmpdir(), "egon-sandbox-pair-"));
        const reportPath = join(scratch, "report.json");
        let report: PairReport | undefined;
        let outcome: { code: number | null; stdout: string; stderr: string };
        try {
          outcome = await runSandboxPair(reportPath, {
            [SANDBOX_PROFILE_ENV]: JSON.stringify(profile.module),
            [SANDBOX_DB_ENV]: JSON.stringify({ name: db.name, settings: db.settings }),
            [SANDBOX_TOKEN_ENV]: randomBytes(6).toString("hex"),
          });
          if (existsSync(reportPath)) report = JSON.parse(readFileSync(reportPath, "utf8")) as PairReport;
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
        const explain = `${outcome.stdout}\n${outcome.stderr}\n${JSON.stringify(report?.testResults ?? [], null, 2)}`;
        expect(outcome.code, explain).toBe(0);
        expect(report?.numPassedTests, explain).toBe(2);
        expect(
          (report?.testResults ?? []).map((file) => [file.name.split("/").at(-1), file.status]).sort(),
        ).toEqual([
          ["sandbox-a.pair.ts", "passed"],
          ["sandbox-b.pair.ts", "passed"],
        ]);
        // Neither file committed anything.
        expect(await db.query("select email from users")).toEqual([]);
      });
    });
  });
}

interface PairReport {
  readonly numPassedTests: number;
  readonly testResults: readonly { readonly name: string; readonly status: string }[];
}

/** Runs the two sandbox pair files in a Vitest run of their own, with two workers, so that they overlap. */
function runSandboxPair(
  reportPath: string,
  env: Readonly<Record<string, string>>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        vitestCli,
        "run",
        "--project",
        "core:sandbox-pair",
        "--maxWorkers=2",
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      { cwd: repoRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
