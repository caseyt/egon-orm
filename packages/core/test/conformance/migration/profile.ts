// What a dialect package tells the migration conformance suite about its database. The
// suite itself is written once, against `egon-orm/migration`, and checks behaviour.
import type { DatabaseAdapter } from "egon-orm";
import type { TestDatabase } from "../../support/index.js";

export interface MigrationConformanceProfile {
  /** Shown in the suite's name. */
  readonly label: string;
  /** The test server's dialect, for `withDatabase`. */
  readonly server: TestDatabase["dialect"];
  /** Creates an adapter connected to `db`. */
  readonly makeAdapter: (db: TestDatabase, options: { readonly poolMax: number }) => DatabaseAdapter;
  /** SQL listing the tables of the current database schema: one row per table, its name in `name`. */
  readonly listTables: string;
  /** SQL listing the indexes of the current database schema: one row per index, its name in `name`. */
  readonly listIndexes: string;
  /** SQL listing the constraints of the current database schema: one row each, its name in `name`. */
  readonly listConstraints: string;
  /** A range column type with an index method for exclusion constraints; `undefined` without them. */
  readonly exclusion: { readonly type: string; readonly using: string } | undefined;
  /** An index method for array columns (`gin`); `undefined` without one. */
  readonly arrayIndexMethod: string | undefined;
  /** An extension the test server can install; `undefined` without extensions. */
  readonly extension: string | undefined;
}
