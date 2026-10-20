// What a dialect package tells the preload conformance suite about its database: how to
// make the adapter under test, and the DDL of the suite's own tables. Everything the suite
// checks is behaviour of the repo's preloads.
import type { DatabaseAdapter, Expr } from "egon-orm";
import type { TestDatabase } from "../../support/index.js";

/** Options of {@link PreloadConformanceProfile.makeAdapter}. */
export interface MakePreloadAdapterOptions {
  /** The most connections the adapter's pool may open. */
  readonly poolMax: number;
}

export interface PreloadConformanceProfile {
  /** Shown in the suite's name. */
  readonly label: string;
  /** The test server's dialect, for `createTestDatabase`. */
  readonly server: TestDatabase["dialect"];
  /** Creates the adapter under test, connected to `db`. */
  readonly makeAdapter: (db: TestDatabase, options: MakePreloadAdapterOptions) => DatabaseAdapter;
  /**
   * DDL (`;`-separated) for the suite's own tables, besides the blog fixture:
   *
   * - `shelves (region text, code integer, label text not null, primary key (region, code))`;
   * - `volumes (id integer primary key, shelf_region text, shelf_code integer, title text not null)`;
   * - `categories (id integer primary key, parent_id integer, name text not null)`;
   * - `post_labels (post_id bigint not null, tag_id bigint not null, featured boolean not null)`.
   */
  readonly schema: string;
  /** DDL creating the database schema `schema` with a copy of the blog table `table`; `undefined` without database schemas. */
  readonly copyTableInto: ((schema: string, table: string, db: TestDatabase) => string) | undefined;
  /** DDL that drops the database schemas `copyTableInto` made, run when the suite ends. */
  readonly dropCopies?: ((db: TestDatabase) => string | undefined) | undefined;
  /** A statement (no parameters) that inserts `count` users, ids 1001 to 1000 + count, emails `u<id>@example.com`. */
  readonly insertUsers: (count: number) => string;
  /** A condition, written with the `fragment` tag, that takes `seconds` to evaluate and is true. */
  readonly sleep: (seconds: number) => Expr<boolean>;
}
