// The Postgres profile of the migration conformance suite (step 18).
import { fragment } from "egon-orm";
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
  // Kept equal to docs/site/examples/migrations.ts#baseline.
  baseline: (version) => [
    [
      "create table if not exists schema_migrations (version bigint primary key, created_at timestamp(0))",
      [],
    ],
    ["insert into schema_migrations (version, created_at) values ($1, now() at time zone 'utc')", [version]],
  ],
  stringSettings: [
    {
      label: "standard_conforming_strings off",
      setup: fragment`set local standard_conforming_strings = off`,
    },
  ],
};
