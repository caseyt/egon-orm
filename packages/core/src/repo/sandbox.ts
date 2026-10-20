/**
 * The test helpers of `egon-orm/testing`: the sandbox, which runs each test in a
 * transaction that is rolled back afterwards, and `expectQueries`, which collects the
 * statements a piece of code runs.
 *
 * @module
 */
import { QueryError } from "../errors.js";
import type { RepoQueryEvent } from "./options.js";
import type { Repo } from "./repo.js";
import { beginSandbox, endSandbox, type OpenSandbox, type RootScope, rootOf } from "./transaction.js";

/**
 * A sandbox over one repo: {@link Sandbox.begin} before each test, {@link Sandbox.rollback}
 * after it. Nothing a test writes is ever committed.
 *
 * @example
 * ```ts
 * const sandbox = await createSandbox(repo);
 * beforeEach(() => sandbox.begin());
 * afterEach(() => sandbox.rollback());
 * ```
 */
export interface Sandbox {
  /**
   * Checks out one connection, begins a transaction on it and routes every operation of
   * the repo through it, including code that imports the repo itself. The repo's own
   * transactions become savepoints of it. Returns a repo bound to the sandbox's
   * transaction, the same as `tx` in a transaction callback.
   *
   * @example
   * ```ts
   * beforeEach(() => sandbox.begin());
   * ```
   *
   * @throws QueryError when the sandbox has already begun and was not rolled back.
   */
  begin(): Promise<Repo>;

  /**
   * Rolls back everything since {@link Sandbox.begin}, returns the connection and gives
   * the repo back its pool. Does nothing when the sandbox has not begun.
   *
   * @example
   * ```ts
   * afterEach(() => sandbox.rollback());
   * ```
   */
  rollback(): Promise<void>;
}

class RepoSandbox implements Sandbox {
  readonly #root: RootScope;
  #open: OpenSandbox | undefined = undefined;
  #opening = false;

  constructor(root: RootScope) {
    this.#root = root;
  }

  async begin(): Promise<Repo> {
    if (this.#open !== undefined || this.#opening || this.#root.sandbox !== undefined) {
      throw new QueryError(
        "sandbox.begin() was called while a sandbox is already open on this repo. Call sandbox.rollback() after each test (afterEach) before the next begin().",
      );
    }
    this.#opening = true;
    try {
      this.#open = await beginSandbox(this.#root);
    } finally {
      this.#opening = false;
    }
    return this.#open.repo;
  }

  async rollback(): Promise<void> {
    const open = this.#open;
    if (open === undefined) return;
    this.#open = undefined;
    await endSandbox(this.#root, open);
  }
}

/**
 * Makes a sandbox for a repo made by `createRepo`. Each test file gets its own sandbox,
 * and with it its own connection: files run in parallel without seeing each other's
 * writes; the tests within one file run one after another.
 *
 * @example
 * ```ts
 * import { createSandbox } from "egon-orm/testing";
 * import { afterEach, beforeEach } from "vitest";
 * import { repo } from "../src/repo";
 *
 * const sandbox = await createSandbox(repo);
 * beforeEach(() => sandbox.begin());
 * afterEach(() => sandbox.rollback());
 * ```
 *
 * @throws TypeError when `repo` is not a repo made by `createRepo` (a transaction's repo,
 * for example).
 */
export async function createSandbox(repo: Repo): Promise<Sandbox> {
  const root = rootOf(repo);
  if (root === undefined) {
    throw new TypeError(
      "createSandbox(repo) takes the repo createRepo made, not the repo of a transaction, a checkout or another sandbox.",
    );
  }
  return new RepoSandbox(root);
}

/**
 * Runs `fn` and returns the `query` events of the statements the repo ran meanwhile, in
 * order: those of its transactions too. Use it to pin down how many queries a piece of
 * code runs, so that an N+1 cannot creep in. The statements that begin and end its
 * transactions (`BEGIN`, `SAVEPOINT`, `RELEASE SAVEPOINT`, `COMMIT`, …) are included, with
 * `operation: "transaction"`; the sandbox's own statements are not.
 *
 * @example
 * ```ts
 * const queries = await expectQueries(repo, () => loadFeed(userId));
 * expect(queries).toHaveLength(3);
 * expect(queries.map((q) => q.operation)).toEqual(["all", "all", "all"]);
 * ```
 *
 * @throws whatever `fn` throws.
 */
export async function expectQueries(repo: Repo, fn: () => unknown): Promise<RepoQueryEvent[]> {
  const events: RepoQueryEvent[] = [];
  const off = repo.on("query", (event) => {
    events.push(event);
  });
  try {
    await fn();
  } finally {
    off();
  }
  return events;
}
