// The SQLite profile of the migration conformance suite.
import { fragment } from "egon-orm";
import type { MigrationConformanceProfile } from "../../core/test/conformance/migration/index.js";
import { SQLITE_READ_PROFILE } from "./read-profile.js";

export const SQLITE_MIGRATION_PROFILE: MigrationConformanceProfile = {
  label: "sqlite",
  server: "sqlite",
  makeAdapter: SQLITE_READ_PROFILE.makeAdapter,
  listTables:
    "select name from sqlite_master where type = 'table' and name not like 'sqlite\\_%' escape '\\'",
  // An unnamed unique constraint gets an automatic index (sqlite_autoindex_…): not listed.
  listIndexes:
    "select name from sqlite_master where type = 'index' and name not like 'sqlite\\_%' escape '\\'",
  // SQLite keeps no list of named constraints.
  listConstraints: undefined,
  listColumns: (table) => `select name from pragma_table_info('${table}')`,
  param: () => "?",
  // The lock is a write transaction, which no SQL lists: another handle tries to take it.
  // Refused inside a transaction.
  outsideTransaction: fragment`vacuum`,
  lockCount: undefined,
  lockHeld: async (db) => {
    try {
      await db.query("pragma busy_timeout = 0");
      await db.query("begin immediate");
    } catch {
      return true;
    }
    await db.query("rollback");
    return false;
  },
  ownSchemas: false,
  exclusion: undefined,
  arrayIndexMethod: undefined,
  extension: undefined,
  // Kept equal to the SQLite lines of docs/site/examples/migrations.ts#baseline.
  baseline: (version) => [
    ["create table if not exists schema_migrations (version integer primary key, created_at text)", []],
    [
      "insert into schema_migrations (version, created_at) values (?, strftime('%Y-%m-%d %H:%M:%S', 'now'))",
      [version],
    ],
  ],
  // SQLite has no escape character in string literals, and no setting that adds one.
  stringSettings: [],
};
