// The checked source of the config file shown in reference/cli.md and guide/migrations.md.
// #region config
// egon.config.ts
import { defineConfig } from "@egon-orm/cli";
import { postgres } from "@egon-orm/postgres";

export default defineConfig({
  adapter: postgres({ connectionString: process.env.DATABASE_URL }),
  migrations: {
    directory: "migrations", //      relative to this file; the default
    table: "schema_migrations", //   the default
  },
  // Only for `egon db create | drop | reset`:
  database: {
    name: "blog_dev",
    admin: postgres({ connectionString: process.env.ADMIN_DATABASE_URL }), // e.g. …/postgres
  },
});
// #endregion config
