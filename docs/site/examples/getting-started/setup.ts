// #region file
// setup.ts: creates the two tables. Run it once: npx tsx setup.ts
import { postgres } from "@egon-orm/postgres";
import { createMigrator, defineMigration } from "egon-orm/migration";

const createTables = defineMigration({
  up(m) {
    m.createTable("users", (table) => {
      table.id(); //                                   "id" bigserial primary key
      table.text("email").notNull().unique(); //       users_email_key, which uniqueConstraint("email") expects
      table.text("name");
      table.timestamps(); //                           created_at, updated_at
    });
    m.createTable("posts", (table) => {
      table.id();
      table.references("author_id", "users").notNull(); // a bigint, with a foreign key to users
      table.text("title").notNull();
      table.boolean("published").notNull().default(false);
      table.timestamps();
    });
  },
  down(m) {
    m.dropTable("posts"); // the undo, in reverse order
    m.dropTable("users");
  },
});

const adapter = postgres({ connectionString: process.env.DATABASE_URL });
await createMigrator({
  adapter,
  migrations: [{ version: 20261020090000, name: "create_tables", migration: createTables }],
}).up();
await adapter.close();
// #endregion file
