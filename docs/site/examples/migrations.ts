// The checked sources of the code blocks in guide/migrations.md and reference/cli.md. Each
// `#region` is included in the page by name; everything outside a region is the
// scaffolding that makes the regions compile.
//
// A migration file exports its migration as the default export (the template of
// `egon gen migration` does); this file holds several, so they are named here.
import { postgres } from "@egon-orm/postgres";
import { cast, type createRepo, fragment, Schema, t } from "egon-orm";
import { createMigrator, defineMigration, type MigrationEvent } from "egon-orm/migration";

// #region create-users
// migrations/20261012093000_create_users.ts
export const createUsers = defineMigration({
  change(m) {
    m.createTable("users", (t) => {
      t.id(); //                                       "id" bigserial primary key
      t.text("email").notNull();
      t.text("name"); //                               columns allow null unless notNull()
      t.integer("age");
      t.enumText("role", ["admin", "member"]).notNull().default("member"); // text + check
      t.jsonb("settings");
      t.references("org_id", "orgs", { type: "uuid", onDelete: "cascade" });
      t.timestamps(); //                               created_at, updated_at
    });
    m.createIndex("users", ["email"], { unique: true }); // users_email_key
  },
});
// #endregion create-users

// #region up-down
// migrations/20261013080000_backfill_roles.ts
export const backfillRoles = defineMigration({
  up(m) {
    m.execute(fragment`update users set role = ${"member"} where role is null`);
  },
  down() {
    // Nothing to undo: the old rows had no role.
  },
});
// #endregion up-down

// #region alter
export const profileFields = defineMigration({
  change(m) {
    m.alterTable("users", (t) => {
      t.text("nickname"); //                                    add
      t.modify("age", "bigint", { from: "integer" }); //        from: needed to roll back
      t.remove("legacy_flag", "boolean"); //                    the type: needed to roll back
      t.rename("name", "full_name");
    });
  },
});
// #endregion alter

// #region indexes
export const searchIndexes = defineMigration({
  transaction: false, // CONCURRENTLY cannot run inside a transaction
  change(m) {
    m.createIndex("posts", ["author_id", "created_at"]); // posts_author_id_created_at_index
    m.createIndex("posts", ["tags"], { using: "gin", concurrently: true });
    m.createIndex("users", ["email"], {
      unique: true,
      where: fragment`deleted_at is null`,
      name: "users_live_email_key",
    });
    m.createIndex("users", [fragment`lower(${fragment.ident("email")})`], {
      name: "users_lower_email_index",
    });
  },
});
// #endregion indexes

// #region constraints
export const bookingRules = defineMigration({
  change(m) {
    m.createExtension("btree_gist");
    m.createConstraint("bookings", "bookings_nights_check", { check: fragment`nights > 0` });
    m.createConstraint("bookings", "bookings_room_during_excl", {
      exclude: fragment`room with =, during with &&`,
      using: "gist",
    });
  },
});
// #endregion constraints

// #region changeset-pairing
class User extends Schema("users", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
}) {
  static changeset(user: User | typeof User, params: unknown) {
    // Looks for users_email_key: the name createIndex("users", ["email"], { unique: true }) gave.
    return cast(user, params, ["email"]).uniqueConstraint("email");
  }
}

export async function signUp(repo: ReturnType<typeof createRepo>, email: string) {
  const result = await repo.insert(User.changeset(User, { email }));
  if (!result.success) return result.error.errorMessages(); // { email: ["has already been taken"] }
  return result.data;
}
// #endregion changeset-pairing

export async function runMigrations(): Promise<void> {
  // #region migrator
  const adapter = postgres({ connectionString: process.env.DATABASE_URL });
  const migrator = createMigrator({
    adapter,
    directory: "./migrations",
    log: (event: MigrationEvent) => {
      if (event.kind === "migrated")
        process.stdout.write(`${event.version} ${event.name}: ${event.durationMs} ms\n`);
    },
  });

  await migrator.up(); //                       every pending migration
  await migrator.up({ to: 20261013080000 }); // up to and including a version
  await migrator.down(); //                     the latest one
  await migrator.down({ step: 2 });
  const plan = await migrator.up({ dryRun: true }); // the SQL, nothing run
  const rows = await migrator.status(); //      [{ version, name, state: "up" | "down" | "missing" }]

  await adapter.close();
  // #endregion migrator
  void plan;
  void rows;
}

export function inMemory() {
  // #region in-memory
  const migrator = createMigrator({
    adapter: postgres({ connectionString: process.env.DATABASE_URL }),
    migrations: [
      { version: 20261012093000, name: "create_users", migration: createUsers },
      { version: 20261013080000, name: "backfill_roles", migration: backfillRoles },
    ],
  });
  // #endregion in-memory
  return migrator;
}

export function adopt() {
  // #region adopt
  const migrator = createMigrator({
    adapter: postgres({ connectionString: process.env.DATABASE_URL }),
    directory: "./migrations",
    table: "schema_migrations", // the existing tracking table
    timestampColumn: "inserted_at", // its timestamp column, if not created_at
  });
  // #endregion adopt
  return migrator;
}
