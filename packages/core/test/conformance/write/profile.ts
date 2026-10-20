// What a dialect package tells the write conformance suite about its database: how to make
// the adapter under test, and the few statements the suite cannot write in a
// dialect-independent way. Everything the suite checks is behaviour of the repo's writes.
import type { AnyFieldType, DatabaseAdapter, Expr } from "egon-orm";
import type { TestDatabase } from "../../support/index.js";

/** Options of {@link WriteConformanceProfile.makeAdapter}. */
export interface MakeWriteAdapterOptions {
  /** The most connections the adapter's pool may open. */
  readonly poolMax: number;
}

export interface WriteConformanceProfile {
  /** Shown in the suite's name. */
  readonly label: string;
  /** The test server's dialect, for `createTestDatabase`. */
  readonly server: TestDatabase["dialect"];
  /** Creates the adapter under test, connected to `db`. */
  readonly makeAdapter: (db: TestDatabase, options: MakeWriteAdapterOptions) => DatabaseAdapter;
  /** The column type that stores values of `type`; `undefined` when the database has none. */
  readonly columnType: (type: AnyFieldType) => string | undefined;
  /** The column definition of a key the database generates: `bigserial primary key` on Postgres. */
  readonly generatedKey: string;
  /**
   * DDL (`;`-separated) for the suite's own tables, besides the blog fixture:
   *
   * - `books (id <generatedKey>, title text not null, pages integer not null)` with the
   *   check constraint `books_pages_check` (`pages > 0`);
   * - `bookings (id <generatedKey>, room integer not null, during <a range of integers>)`
   *   with the exclusion constraint `bookings_during_excl` on overlapping `during`;
   *   `undefined` in {@link rangeType} when the database has none (then leave it out);
   * - `stamps (id <generatedKey>, label text not null, code text not null default 'db-code',
   *   note text default 'db-note', made_at <timestamp with time zone> not null default now())`.
   */
  readonly schema: string;
  /** The column type of `bookings.during`, written as `'[1,5)'`; `undefined` when there is none. */
  readonly rangeType: string | undefined;
  /** DDL creating the database schema `schema` with a copy of the blog table `table`; `undefined` without database schemas. */
  readonly copyTableInto: ((schema: string, table: string) => string) | undefined;
  /** An integer expression, written with the `fragment` tag, that takes `seconds` to evaluate and is 0. */
  readonly sleep: (seconds: number) => Expr<number>;
}
