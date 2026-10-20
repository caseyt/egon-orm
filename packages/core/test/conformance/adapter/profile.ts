// What a dialect package tells the adapter conformance suite about its database: how to
// make the adapter under test, and the few statements the suite cannot write in a
// dialect-independent way. Everything the suite checks is behaviour of the `Adapter`
// contract; the profile only supplies SQL text and DDL.
import type { AnyFieldType, ConstraintViolationType, DatabaseAdapter } from "egon-orm";
import type { TestDatabase } from "../../support/index.js";

/** A statement that violates one kind of constraint, and what the error must report. */
export interface Violation {
  /** Runs against the tables of {@link AdapterConformanceProfile.schema}; no parameters. */
  readonly sql: string;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
}

/** Options of {@link AdapterConformanceProfile.makeAdapter}. */
export interface MakeAdapterOptions {
  /** The most connections the adapter's pool may open. */
  readonly poolMax: number;
}

export interface AdapterConformanceProfile {
  /** Shown in the suite's name. */
  readonly label: string;
  /** The test server's dialect, for `createTestDatabase`. */
  readonly server: TestDatabase["dialect"];
  /** Creates the adapter under test, connected to `db`. */
  readonly makeAdapter: (db: TestDatabase, options: MakeAdapterOptions) => DatabaseAdapter;
  /** The placeholder of the n-th parameter, counting from 1. */
  readonly param: (n: number) => string;
  /** The column type that stores values of `type`; `undefined` when the database has none. */
  readonly columnType: (type: AnyFieldType) => string | undefined;
  /** A statement (no parameters) that takes `seconds` to run and returns one row. */
  readonly sleep: (seconds: number) => string;
  /** A statement (no parameters) returning the rows 1..`count` in column `n`, in order. */
  readonly series: (count: number) => string;
  /** Like {@link series}, but the statement fails once it reaches row `failAt`. */
  readonly failingSeries: (count: number, failAt: number) => string;
  /** A statement whose one row holds the id of the server process behind the connection, in column `id`. */
  readonly backendId: string;
  /** Ends server process `id` from outside, on the test database's own connection; resolves once it has ended. */
  readonly terminate: (db: TestDatabase, id: unknown) => Promise<void>;
  /** A statement whose one row holds the current transaction's isolation level, as `IsolationLevel` text, in column `level`. */
  readonly isolationLevel: string;
  /**
   * DDL and seed rows (`;`-separated) for the violations, plus a table
   * `counters (id integer primary key, value integer not null)` holding the rows (1, 0)
   * and (2, 0), which the transaction tests use.
   */
  readonly schema: string;
  /**
   * A statement (no parameters) that, run inside a transaction, makes its `COMMIT` take
   * several seconds (its DDL is part of {@link schema}); `undefined` when the database has
   * no way to make a `COMMIT` wait, and the suite's cancelled-`COMMIT` case is skipped.
   */
  readonly slowCommit: string | undefined;
  /** One violating statement per constraint kind; `undefined` when the database has no such constraint. */
  readonly violations: Readonly<Record<ConstraintViolationType, Violation | undefined>>;
}
