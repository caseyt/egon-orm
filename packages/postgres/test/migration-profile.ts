// The Postgres profile of the migration conformance suite (step 18).
import type { MigrationConformanceProfile } from "../../core/test/conformance/migration/index.js";
import { POSTGRES_READ_PROFILE } from "./read-profile.js";

export const POSTGRES_MIGRATION_PROFILE: MigrationConformanceProfile = {
  label: "postgres",
  server: "postgres",
  makeAdapter: POSTGRES_READ_PROFILE.makeAdapter,
  listTables:
    "select table_name as name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'",
  listIndexes: "select indexname as name from pg_indexes where schemaname = current_schema()",
  listConstraints:
    "select constraint_name as name from information_schema.table_constraints where constraint_schema = current_schema()",
  exclusion: { type: "int4range", using: "gist" },
  arrayIndexMethod: "gin",
  extension: "citext",
};
