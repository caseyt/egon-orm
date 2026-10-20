// The MySQL profile of the migration conformance suite.
import { fragment } from "egon-orm";
import type { MigrationConformanceProfile } from "../../core/test/conformance/migration/index.js";
import { MYSQL_READ_PROFILE } from "./read-profile.js";

export const MYSQL_MIGRATION_PROFILE: MigrationConformanceProfile = {
  label: "mysql",
  server: "mysql",
  makeAdapter: MYSQL_READ_PROFILE.makeAdapter,
  listTables:
    "select table_name as name from information_schema.tables where table_schema = database() and table_type = 'BASE TABLE'",
  // MySQL names a primary key PRIMARY: not an index of the migrations' own.
  listIndexes:
    "select distinct index_name as name from information_schema.statistics where table_schema = database() and index_name <> 'PRIMARY'",
  listConstraints:
    "select constraint_name as name from information_schema.table_constraints where constraint_schema = database() and constraint_name <> 'PRIMARY'",
  listColumns: (table) =>
    `select column_name as name from information_schema.columns where table_schema = database() and table_name = '${table}'`,
  param: () => "?",
  // MySQL runs no migration in a transaction (DDL commits): any statement does.
  outsideTransaction: fragment`do 0`,
  lockCount:
    "select count(*) as n from performance_schema.metadata_locks where object_type = 'USER LEVEL LOCK' and object_name like 'egon:%'",
  // A database schema is a database, named server-wide.
  ownSchemas: false,
  exclusion: undefined,
  arrayIndexMethod: undefined,
  extension: undefined,
  // Kept equal to the MySQL lines of docs/site/examples/migrations.ts#baseline.
  baseline: (version) => [
    ["create table if not exists schema_migrations (version bigint primary key, created_at datetime)", []],
    ["insert into schema_migrations (version, created_at) values (?, utc_timestamp())", [version]],
  ],
  stringSettings: [
    {
      label: "NO_BACKSLASH_ESCAPES",
      setup: fragment`set session sql_mode = concat(@@session.sql_mode, ',NO_BACKSLASH_ESCAPES')`,
    },
  ],
};
