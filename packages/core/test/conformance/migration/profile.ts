// What a dialect package tells the migration conformance suite about its database. The
// suite itself is written once, against `egon-orm/migration`, and checks behaviour.
import type { DatabaseAdapter } from "egon-orm";
import type { SqlFragment } from "egon-orm/migration";
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
  /**
   * SQL listing the constraints of the current database schema: one row each, its name in
   * `name`; `undefined` when the database keeps no list of them (SQLite).
   */
  readonly listConstraints: string | undefined;
  /** SQL listing the columns of `table` in the current database schema: one row each, its name in `name`. */
  readonly listColumns: (table: string) => string;
  /** The placeholder of the n-th parameter of the test helper's own queries, counting from 1. */
  readonly param: (n: number) => string;
  /** SQL whose one row's `n` counts the migration locks held in this database; `undefined` without locks. */
  readonly lockCount: string | undefined;
  /**
   * Whether a migration lock is held on `db`, for a database whose locks SQL cannot count
   * (`lockCount` undefined): SQLite tries to take the write lock itself.
   */
  readonly lockHeld?: ((db: TestDatabase) => Promise<boolean>) | undefined;
  /**
   * Whether the suite may create database schemas of its own: false where a schema is a
   * database named server-wide (MySQL), so that two runs on one server would collide.
   */
  readonly ownSchemas: boolean;
  /** A range column type with an index method for exclusion constraints; `undefined` without them. */
  readonly exclusion: { readonly type: string; readonly using: string } | undefined;
  /** An index method for array columns (`gin`); `undefined` without one. */
  readonly arrayIndexMethod: string | undefined;
  /** An extension the test server can install; `undefined` without extensions. */
  readonly extension: string | undefined;
  /**
   * The guide's recipe for recording a first migration as applied on a database never
   * migrated: the statements (with their parameters) that create the tracking table and
   * insert `version`.
   */
  readonly baseline: (version: string) => readonly (readonly [string, readonly unknown[]])[];
  /**
   * Other string-literal settings to read the constants back under, each a statement a
   * migration runs in its transaction before its DDL (Postgres:
   * `set local standard_conforming_strings = off`). Empty when there are none.
   */
  readonly stringSettings: readonly { readonly label: string; readonly setup: SqlFragment }[];
}
