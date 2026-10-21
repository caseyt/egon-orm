// #region config
// egon.config.ts: what `npx egon` reads. DATABASE_URL names the database it works on.
import { defineConfig } from "@egon-orm/cli";
import { postgres } from "@egon-orm/postgres";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("Set DATABASE_URL to the database to migrate.");
const url = new URL(databaseUrl);
const admin = new URL(url);
admin.pathname = "/postgres"; // the same server's default database

export default defineConfig({
  adapter: postgres({ connectionString: url.href }),
  migrations: { directory: "src/migrations" },
  // For `egon db create | drop | reset`: the database DATABASE_URL names, created or
  // dropped through the server's `postgres` database.
  database: {
    name: decodeURIComponent(url.pathname.slice(1)),
    admin: postgres({ connectionString: admin.href }),
  },
});
// #endregion config
