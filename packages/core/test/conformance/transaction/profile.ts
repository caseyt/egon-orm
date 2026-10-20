// What a dialect package tells the transaction conformance suite about its database: how
// to make the adapter under test, the few statements the suite cannot write in a
// dialect-independent way, and where the profile lives, so that the sandbox pair (two test
// files in a Vitest run of their own) can load it.
import type { DatabaseAdapter, Expr } from "egon-orm";
import type { TestDatabase } from "../../support/index.js";

/** Options of {@link TransactionConformanceProfile.makeAdapter}. */
export interface MakeTransactionAdapterOptions {
  /** The most connections the adapter's pool may open. */
  readonly poolMax: number;
}

export interface TransactionConformanceProfile {
  /** Shown in the suite's name. */
  readonly label: string;
  /** The test server's dialect, for `createTestDatabase`. */
  readonly server: TestDatabase["dialect"];
  /** Creates the adapter under test, connected to `db`. Uses only `db.name` and `db.settings`. */
  readonly makeAdapter: (db: TestDatabase, options: MakeTransactionAdapterOptions) => DatabaseAdapter;
  /** A statement that sleeps for `seconds` and returns one row. */
  readonly sleep: (seconds: number) => Expr<unknown>;
  /**
   * A statement that, run inside a transaction, makes its `COMMIT` take several seconds
   * (its DDL is part of {@link schema}); `undefined` when the database has no way, safe for a shared test server, to make a
   * `COMMIT` wait, and the suite's cancelled-`COMMIT` case is skipped.
   */
  readonly slowCommit: Expr<unknown> | undefined;
  /** A statement whose one row has the column `id`: an identifier of the session it runs on. */
  readonly sessionId: Expr<unknown>;
  /** A statement whose one row has the column `level`: the isolation level of the running transaction, as `IsolationLevel` spells it. */
  readonly isolationLevel: Expr<unknown>;
  /**
   * DDL (`;`-separated) for the suite's own tables, besides the blog fixture:
   * `wide_rows (id <generated key>, c0 … c39 integer not null)` with a unique constraint
   * `wide_rows_c0_key` on `c0`.
   */
  readonly schema: string;
  /**
   * Where the sandbox pair finds this profile: the URL of the module that exports it, and
   * the name of the export.
   */
  readonly module: { readonly url: string; readonly exportName: string };
  /**
   * How the two files of the sandbox pair find each other, on connections outside their
   * sandboxes: `announce` makes `marker` visible to every other session (and keeps it until
   * that session ends), `count` returns one row whose `n` is how many sessions announced
   * `marker`.
   */
  readonly rendezvous: {
    readonly announce: (marker: string) => Expr<unknown>;
    readonly count: (marker: string) => Expr<unknown>;
  };
}
