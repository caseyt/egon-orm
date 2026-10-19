// What a dialect package tells the read conformance suite about its database: how to make
// the adapter under test, and the few statements the suite cannot write in a
// dialect-independent way. Everything the suite checks is behaviour of the repo's reads.
import type { AnyFieldType, DatabaseAdapter, Expr } from "egon-orm";
import type { TestDatabase } from "../../support/index.js";

/** Options of {@link ReadConformanceProfile.makeAdapter}. */
export interface MakeReadAdapterOptions {
  /** The most connections the adapter's pool may open. */
  readonly poolMax: number;
}

export interface ReadConformanceProfile {
  /** Shown in the suite's name. */
  readonly label: string;
  /** The test server's dialect, for `createTestDatabase`. */
  readonly server: TestDatabase["dialect"];
  /** Creates the adapter under test, connected to `db`. */
  readonly makeAdapter: (db: TestDatabase, options: MakeReadAdapterOptions) => DatabaseAdapter;
  /** The placeholder of the n-th parameter, counting from 1. */
  readonly param: (n: number) => string;
  /** The column type that stores values of `type`; `undefined` when the database has none. */
  readonly columnType: (type: AnyFieldType) => string | undefined;
  /**
   * DDL (`;`-separated, no parameters) that creates the database schema `schema` with a
   * copy of the blog table `table` (same columns, no rows). `undefined` when the dialect
   * has no database schemas.
   */
  readonly copyTableInto: ((schema: string, table: string) => string) | undefined;
  /**
   * A statement (no parameters) that inserts `count` rows into
   * `stream_rows (id integer primary key, label text not null)`: ids 1..count, labels
   * `"row <id>"`.
   */
  readonly insertSeries: (count: number) => string;
  /**
   * A statement (no parameters) that inserts `count` rows into
   * `pairs (a integer not null, b text not null, primary key (a, b))`: `a` 1..count, `b`
   * `"k<a mod 7>"`.
   */
  readonly insertPairs: (count: number) => string;
  /** A column type that stores timestamps with microseconds; `undefined` when there is none. */
  readonly microsecondTimestamp: string | undefined;
  /**
   * A statement, written with the `fragment` tag, that takes `seconds` to run and returns
   * one row: what `repo.raw` runs to test cancellation.
   */
  readonly sleep: (seconds: number) => Expr<unknown>;
}
