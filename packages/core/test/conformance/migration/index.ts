// The migration conformance suite: what migrations and their runner must do against a real
// database, written once and run by each dialect package with a profile of its own. It
// covers the blog schema up, down and up again; two runners racing; a failing migration;
// the lock; adopting an existing tracking table; the pairing of migration names with the
// changeset constraint defaults; constants written as literals; and every operation.
//
// Every test takes a database of its own (withDatabase); nothing is shared between tests.
import { cast, createRepo, type DatabaseAdapter, t as field, fragment, Schema, timestamps } from "egon-orm";
import {
  createMigrator,
  defineMigration,
  type Migration,
  MigrationError,
  type MigrationSource,
  type MigratorOptions,
  type SqlFragment,
} from "egon-orm/migration";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { Post, type TestDatabase, User, withDatabase } from "../../support/index.js";
import { BLOG_MIGRATIONS, BLOG_TABLES } from "./blog.js";
import type { MigrationConformanceProfile } from "./profile.js";

export type { MigrationConformanceProfile } from "./profile.js";

/** A gate a migration can wait on: `open()` lets it go on. */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function creates(table: string): Migration {
  return defineMigration({
    change(m) {
      m.createTable(table, (t) => t.id());
    },
  });
}

export function runMigrationConformance(profile: MigrationConformanceProfile): void {
  describe(`migration conformance: ${profile.label}`, () => {
    /** Runs `fn` with a fresh database and adapters on it, closing the adapters afterwards. */
    function withAdapters<T>(
      label: string,
      fn: (db: TestDatabase, adapter: (poolMax?: number) => DatabaseAdapter) => Promise<T>,
    ): Promise<T> {
      return withDatabase(profile.server, { label }, async (db) => {
        const made: DatabaseAdapter[] = [];
        try {
          return await fn(db, (poolMax = 2) => {
            const adapter = profile.makeAdapter(db, { poolMax });
            made.push(adapter);
            return adapter;
          });
        } finally {
          await Promise.all(made.map((adapter) => adapter.close()));
        }
      });
    }

    async function names(db: TestDatabase, sql: string): Promise<string[]> {
      return (await db.query<{ name: string }>(sql)).map((row) => row.name).sort();
    }

    function migrator(
      adapter: DatabaseAdapter,
      migrations: readonly MigrationSource[],
      options: Partial<MigratorOptions> = {},
    ) {
      return createMigrator({ adapter, migrations, ...options });
    }

    test("the blog schema goes up, down to an empty database, and up again", () =>
      withAdapters("migrate_blog", async (db, adapter) => {
        const blog = migrator(adapter(), BLOG_MIGRATIONS);
        expect((await blog.up()).map((run) => run.name)).toEqual(
          BLOG_MIGRATIONS.map((source) => source.name),
        );
        expect(await names(db, profile.listTables)).toEqual([...BLOG_TABLES, "schema_migrations"].sort());
        expect(await names(db, profile.listIndexes)).toEqual(
          expect.arrayContaining([
            "users_email_key",
            "posts_author_id_index",
            "comments_post_id_index",
            "comments_author_id_index",
          ]),
        );
        expect(await names(db, profile.listConstraints)).toEqual(
          expect.arrayContaining([
            "users_role_check",
            "profiles_user_id_fkey",
            "profiles_user_id_key",
            "posts_author_id_fkey",
            "tags_name_key",
            "memberships_org_id_fkey",
          ]),
        );
        expect((await blog.status()).every((row) => row.state === "up")).toBe(true);

        // The repo writes to the migrated tables with the blog schema classes.
        const repo = createRepo({ adapter: adapter() });
        const user = await repo.insertOrThrow(cast(User, { email: "ada@example.com" }, ["email"]));
        await repo.insertOrThrow(cast(Post, { authorId: user.id, title: "Hello" }, ["authorId", "title"]));
        expect(user.role).toBe("member");

        expect((await blog.down({ all: true })).map((run) => run.name)).toEqual(
          BLOG_MIGRATIONS.map((source) => source.name).reverse(),
        );
        expect(await names(db, profile.listTables)).toEqual(["schema_migrations"]);
        expect(await db.query("select version from schema_migrations")).toEqual([]);
        expect((await blog.status()).every((row) => row.state === "down")).toBe(true);

        expect(await blog.up()).toHaveLength(BLOG_MIGRATIONS.length);
        expect(await names(db, profile.listTables)).toEqual([...BLOG_TABLES, "schema_migrations"].sort());
        // Rolling back one at a time, then redoing the last one.
        expect((await blog.down()).map((run) => run.name)).toEqual(["create_memberships"]);
        expect((await blog.up()).map((run) => run.name)).toEqual(["create_memberships"]);
      }));

    test("migration names are the ones the changeset constraint defaults look for", () =>
      withAdapters("migrate_names", async (_db, adapter) => {
        await migrator(adapter(), BLOG_MIGRATIONS).up();
        const repo = createRepo({ adapter: adapter() });
        const user = await repo.insertOrThrow(cast(User, { email: "grace@example.com" }, ["email"]));

        const duplicate = await repo.insert(
          cast(User, { email: "grace@example.com" }, ["email"]).uniqueConstraint("email"),
        );
        expect(duplicate.success).toBe(false);
        expect(!duplicate.success && duplicate.error.errorMessages()).toEqual({
          email: ["has already been taken"],
        });

        const orphan = await repo.insert(
          cast(Post, { authorId: user.id + 1000, title: "x" }, ["authorId", "title"]).assocConstraint(
            "author",
          ),
        );
        expect(!orphan.success && orphan.error.errorMessages()).toEqual({ author: ["does not exist"] });

        // A schema whose role is any string, so that the value reaches the enumText check.
        class AnyRole extends Schema("users", {
          id: field.bigint({ mode: "number" }).primaryKey().dbGenerated(),
          email: field.string(),
          role: field.string(),
          ...timestamps(),
        }) {}
        const notAllowed = await repo.insert(
          cast(AnyRole, { email: "x@example.com", role: "owner" }, ["email", "role"]).checkConstraint(
            "role",
            {
              name: "users_role_check",
            },
          ),
        );
        expect(!notAllowed.success && notAllowed.error.errorMessages()).toEqual({ role: ["is invalid"] });
        const allowed = await repo.insert(
          cast(AnyRole, { email: "y@example.com", role: "admin" }, ["email", "role"]),
        );
        expect(allowed.success).toBe(true);
      }));

    test("a name longer than the database keeps is shortened so that the changeset default still matches", () =>
      withAdapters("migrate_long", async (_db, adapter) => {
        const table = `t${"a".repeat(39)}`;
        const column = `c${"b".repeat(39)}`;
        await migrator(adapter(), [
          {
            version: 20260101000000,
            name: "long_names",
            migration: defineMigration({
              change(m) {
                m.createTable(table, (t) => {
                  t.id();
                  t.text(column).notNull();
                });
                m.createIndex(table, [column], { unique: true });
              },
            }),
          },
        ]).up();
        // The field name is the column name (all lower case, so the snake_case column is the same).
        class Long extends Schema(table, {
          id: field.bigint({ mode: "number" }).primaryKey().dbGenerated(),
          [column]: field.string(),
        }) {}
        const repo = createRepo({ adapter: adapter() });
        const values = { [column]: "same" };
        await repo.insertOrThrow(cast(Long, values, [column] as never));
        const duplicate = await repo.insert(
          cast(Long, values, [column] as never).uniqueConstraint(column as never),
        );
        expect(duplicate.success).toBe(false);
        expect(!duplicate.success && duplicate.error.errorMessages()).toEqual({
          [column]: ["has already been taken"],
        });
      }));

    test("two runners at once apply each version once, 50 times in a row", () =>
      withAdapters("migrate_race", async (db, adapter) => {
        const one = adapter();
        const two = adapter();
        for (let i = 0; i < 50; i++) {
          const migrations: MigrationSource[] = ["a", "b", "c"].map((suffix, n) => ({
            version: 20260101000000 + n,
            name: `create_${suffix}`,
            migration: creates(`race_${i}_${suffix}`),
          }));
          const table = `race_${i}_migrations`;
          const [first, second] = await Promise.all([
            migrator(one, migrations, { table }).up(),
            migrator(two, migrations, { table }).up(),
          ]);
          const applied = [...first, ...second].map((run) => run.version).sort();
          expect(applied).toEqual([20260101000000, 20260101000001, 20260101000002]);
          expect((await db.query(`select version from ${table}`)).length).toBe(3);
        }
      }));

    test("a runner waits for the lock, and gives up after lockTimeoutMs", () =>
      withAdapters("migrate_lock", async (db, adapter) => {
        const held = gate();
        const started = gate();
        const slow: MigrationSource[] = [
          {
            version: 20260101000000,
            name: "slow",
            migration: defineMigration({
              async change(m) {
                started.open();
                await held.wait;
                m.createTable("slow", (t) => t.id());
              },
            }),
          },
        ];
        const holder = migrator(adapter(), slow).up();
        await started.wait;
        const impatient = await migrator(adapter(), slow, { lockTimeoutMs: 200 })
          .up()
          .catch((error: unknown) => error);
        expect(impatient).toBeInstanceOf(MigrationError);
        expect((impatient as Error).message).toMatch(/Gave up waiting for the migration lock after 200 ms/);
        const patient = migrator(adapter(), slow).up();
        held.open();
        expect((await holder).map((run) => run.name)).toEqual(["slow"]);
        expect(await patient).toEqual([]);
        expect(await db.query("select version from schema_migrations")).toHaveLength(1);
      }));

    test("a lock timeout never leaves the lock held, even when the lock was granted as the time ran out", () =>
      withAdapters("migrate_lock_zero", async (db, adapter) => {
        // With lockTimeoutMs: 0 the timer fires while the (uncontended) lock is being granted.
        // One adapter: a connection that went back to its pool still holding the lock would
        // make every later attempt wait, and the check below would see the lock.
        const shared = adapter(1);
        for (let i = 0; i < 10; i++) {
          await migrator(shared, [], { lockTimeoutMs: 0 })
            .up()
            .catch(() => undefined);
        }
        const advisory = async (): Promise<number> =>
          (
            await db.query(
              "select count(*)::int as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())",
            )
          )[0]?.n as number;
        // A destroyed session ends on the server shortly after the client closes it.
        for (let wait = 0; wait < 50 && (await advisory()) > 0; wait++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(await advisory()).toBe(0);
        // And a runner without a timeout still gets the lock.
        expect(await migrator(adapter(), [], {}).up()).toEqual([]);
      }));

    test("a failing migration is rolled back: nothing of it stays and its version is not recorded", () =>
      withAdapters("migrate_fail", async (db, adapter) => {
        const migrations: MigrationSource[] = [
          { version: 20260101000000, name: "create_kept", migration: creates("kept") },
          {
            version: 20260102000000,
            name: "half",
            migration: defineMigration({
              up(m) {
                m.createTable("doomed", (t) => t.id());
                m.execute(fragment`insert into doomed (id) values (1)`);
                m.execute(fragment`insert into doomed (id) values (1)`);
              },
            }),
          },
          { version: 20260103000000, name: "create_never", migration: creates("never") },
        ];
        const error = await migrator(adapter(), migrations)
          .up()
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MigrationError);
        expect((error as MigrationError).version).toBe(20260102000000);
        expect((error as MigrationError).sql).toBe("insert into doomed (id) values (1)");
        expect(await names(db, profile.listTables)).toEqual(["kept", "schema_migrations"]);
        expect(
          (await db.query<{ version: unknown }>("select version from schema_migrations")).map((row) =>
            String(row.version),
          ),
        ).toEqual(["20260101000000"]);
      }));

    test("a recorded version whose migration is missing blocks rolling back past it", () =>
      withAdapters("migrate_missing", async (db, adapter) => {
        const all: MigrationSource[] = [
          { version: 20260101000000, name: "create_a", migration: creates("a") },
          { version: 20260102000000, name: "create_b", migration: creates("b") },
          { version: 20260103000000, name: "create_c", migration: creates("c") },
        ];
        await migrator(adapter(), all).up();
        const withoutB = migrator(adapter(), [all[0] as MigrationSource, all[2] as MigrationSource]);
        expect((await withoutB.status()).map((row) => row.state)).toEqual(["up", "missing", "up"]);
        await expect(withoutB.down({ all: true })).rejects.toThrow(
          /Cannot roll back past version 20260102000000/,
        );
        expect(await names(db, profile.listTables)).toEqual(["a", "b", "c", "schema_migrations"]);
        expect((await withoutB.down()).map((run) => run.name)).toEqual(["create_c"]);
      }));

    test("a tracking table made by another tool is adopted by naming its timestamp column", () =>
      withAdapters("migrate_adopt", async (db, adapter) => {
        await db.exec(
          "create table schema_migrations (version bigint primary key, inserted_at timestamp(0)); insert into schema_migrations (version, inserted_at) values (20250101000000, '2025-01-01 00:00:00')",
        );
        const migrations: MigrationSource[] = [
          { version: 20250101000000, name: "create_old", migration: creates("old") },
          { version: 20260101000000, name: "create_new", migration: creates("new") },
        ];
        const refused = await migrator(adapter(), migrations)
          .up()
          .catch((e: unknown) => e);
        expect((refused as Error).message).toMatch(/timestampColumn: "inserted_at"/);
        const adopted = migrator(adapter(), migrations, { timestampColumn: "inserted_at" });
        expect((await adopted.status()).map((row) => row.state)).toEqual(["up", "down"]);
        expect((await adopted.up()).map((run) => run.name)).toEqual(["create_new"]);
        const rows = await db.query<{ version: unknown; inserted_at: unknown }>(
          "select version, inserted_at from schema_migrations order by version",
        );
        expect(rows.map((row) => String(row.version))).toEqual(["20250101000000", "20260101000000"]);
        expect(rows[1]?.inserted_at).not.toBeNull();
        expect(await names(db, profile.listTables)).toEqual(["new", "schema_migrations"]);
      }));

    test("the guide's baseline recipe records a first migration as applied on a fresh database", () =>
      withAdapters("migrate_baseline", async (db, adapter) => {
        // The statements of the guide (docs/site/examples/migrations.ts#baseline), through an adapter.
        const admin = adapter();
        for (const [sql, params] of profile.baseline("20261001000000")) await admin.execute(sql, params);
        const runner = migrator(adapter(), [
          { version: 20261001000000, name: "initial", migration: creates("existing") },
          { version: 20261002000000, name: "create_next", migration: creates("next") },
        ]);
        expect((await runner.status()).map((row) => row.state)).toEqual(["up", "down"]);
        expect((await runner.up()).map((run) => run.name)).toEqual(["create_next"]);
        expect(await names(db, profile.listTables)).toEqual(["next", "schema_migrations"]);
      }));

    test("a dry run changes nothing, not even the tracking table", () =>
      withAdapters("migrate_dry", async (db, adapter) => {
        const runs = await migrator(adapter(), BLOG_MIGRATIONS).up({ dryRun: true });
        expect(runs).toHaveLength(BLOG_MIGRATIONS.length);
        expect(runs[0]?.statements[0]?.sql).toMatch(/^create table "users"/);
        expect(await names(db, profile.listTables)).toEqual([]);
      }));

    const stringModes: readonly { readonly label: string; readonly setup: SqlFragment | undefined }[] = [
      { label: "the server default", setup: undefined },
      ...profile.stringSettings,
    ];
    for (const mode of stringModes) {
      test(`constant defaults are written as literals that read back as themselves (${mode.label})`, () =>
        withAdapters("migrate_literals", async (db, adapter) => {
          const strings = [
            "it's",
            "a\\b",
            "\\'; drop table literals; --",
            "''",
            "\\",
            "\\x41",
            "line\nbreak\ttab\r",
            "$$ dollar $$",
            "E'x'",
            "émoji 🎉 \u2028",
            ...fc.sample(fc.string({ unit: fc.constantFrom("'", "\\", "x", "E", " ", ";") }), {
              numRuns: 20,
              seed: 18,
            }),
          ];
          await migrator(adapter(), [
            {
              version: 20260101000000,
              name: "literals",
              migration: defineMigration({
                up(m) {
                  // In the migration's transaction, so the DDL below is read under this setting.
                  if (mode.setup !== undefined) m.execute(mode.setup);
                  m.createTable("literals", (t) => {
                    t.integer("id").primaryKey();
                    for (const [i, value] of strings.entries()) t.text(`s${i}`).default(value);
                    t.integer("n").default(-42);
                    t.boolean("b").default(true);
                    t.jsonb("j").default({ quote: "it's", slash: "a\\b", line: "\n'" });
                    t.enumText("kind", ["back\\slash", "it's"]).default("back\\slash");
                  });
                },
              }),
            },
          ]).up();
          await db.query("insert into literals (id) values (1)");
          const [row] = await db.query("select * from literals");
          for (const [i, value] of strings.entries()) expect(row?.[`s${i}`]).toBe(value);
          expect(row?.n).toBe(-42);
          expect(row?.b).toBe(true);
          expect(row?.j).toEqual({ quote: "it's", slash: "a\\b", line: "\n'" });
          expect(row?.kind).toBe("back\\slash");
          await db.query("insert into literals (id, kind) values (2, $1)", ["it's"]);
          await expect(db.query("insert into literals (id, kind) values (3, $1)", ["other"])).rejects.toThrow(
            /literals_kind_check/,
          );
        }));
    }

    test("every operation runs, and rolling back undoes all of it", () =>
      withAdapters("migrate_ops", async (db, adapter) => {
        const everything: MigrationSource[] = [
          { version: 20260101000000, name: "create_base", migration: creates("base") },
          {
            version: 20260102000000,
            name: "everything",
            migration: defineMigration({
              change(m) {
                m.createSchema("extra");
                m.createTable(
                  "notes",
                  (t) => {
                    t.id();
                    t.text("body").notNull();
                    t.integer("score").notNull().default(0);
                    t.array("labels", "text");
                    t.references("base_id", "base", { onDelete: "setNull" });
                  },
                  { schema: "extra" },
                );
                m.alterTable("base", (t) => {
                  t.text("title");
                  t.integer("rank");
                  t.decimal("price", { precision: 8, scale: 2 }).default("1.50");
                });
                m.alterTable("base", (t) => {
                  t.modify("rank", "bigint", {
                    notNull: true,
                    default: 0,
                    from: { type: "integer", notNull: false, default: null },
                  });
                  t.rename("title", "heading");
                });
                m.createIndex("base", ["heading"], { unique: true, where: fragment`heading is not null` });
                m.createIndex("base", [fragment`lower(${fragment.ident("heading")})`], {
                  name: "base_lower_heading",
                });
                m.createIndex("base", ["rank"], { include: ["price"] });
                m.createIndex("notes", ["body"], { schema: "extra" });
                if (profile.arrayIndexMethod !== undefined) {
                  m.createIndex("notes", ["labels"], { schema: "extra", using: profile.arrayIndexMethod });
                }
                m.createConstraint("base", "base_rank_check", { check: fragment`rank >= 0` });
                m.renameTable("base", "bases");
                m.execute(
                  fragment`insert into bases (id, rank) values (${1}, ${2})`,
                  fragment`delete from bases where id = ${1}`,
                );
              },
            }),
          },
        ];
        if (profile.exclusion !== undefined) {
          const { type, using } = profile.exclusion;
          everything.push({
            version: 20260103000000,
            name: "bookings",
            migration: defineMigration({
              change(m) {
                m.createTable("bookings", (t) => {
                  t.id();
                  t.custom("during", type).notNull();
                });
                m.createConstraint("bookings", "bookings_during_excl", {
                  exclude: fragment`during with &&`,
                  using,
                });
              },
            }),
          });
        }
        if (profile.extension !== undefined) {
          const extension = profile.extension;
          everything.push({
            version: 20260104000000,
            name: "extension",
            migration: defineMigration({
              up(m) {
                m.createExtension(extension);
              },
              down(m) {
                m.dropExtension(extension);
              },
            }),
          });
        }
        const runner = migrator(adapter(), everything);
        await runner.up();
        expect(await names(db, profile.listIndexes)).toEqual(
          expect.arrayContaining(["base_heading_key", "base_lower_heading", "base_rank_index"]),
        );
        expect(await names(db, profile.listTables)).toEqual(
          ["bases", "schema_migrations", ...(profile.exclusion === undefined ? [] : ["bookings"])].sort(),
        );
        expect(await db.query("select id, rank from bases")).toEqual([{ id: "1", rank: "2" }]);
        await expect(db.query("insert into bases (id, rank) values (2, -1)")).rejects.toThrow(
          /base_rank_check/,
        );
        expect(await db.query("select count(*)::int as n from extra.notes")).toEqual([{ n: 0 }]);

        await runner.down({ to: 20260102000000 });
        expect(await names(db, profile.listTables)).toEqual(["base", "schema_migrations"]);
        const indexes = await names(db, profile.listIndexes);
        for (const name of [
          "base_heading_key",
          "base_lower_heading",
          "base_rank_index",
          "notes_body_index",
        ]) {
          expect(indexes).not.toContain(name);
        }
        expect(
          await db.query("select column_name from information_schema.columns where table_name = 'base'"),
        ).toEqual([{ column_name: "id" }]);
        expect(
          await db.query("select schema_name from information_schema.schemata where schema_name = 'extra'"),
        ).toEqual([]);
        // And up again.
        await runner.up();
        expect(await names(db, profile.listTables)).toContain("bases");
      }));

    test("a concurrent index needs transaction: false, and then builds", () =>
      withAdapters("migrate_concurrent", async (db, adapter) => {
        const index = (transaction: boolean): Migration =>
          defineMigration({
            transaction,
            change(m) {
              m.createIndex("base", ["id"], { concurrently: true, name: "base_id_concurrent" });
            },
          });
        const base: MigrationSource = {
          version: 20260101000000,
          name: "create_base",
          migration: creates("base"),
        };
        await expect(
          migrator(adapter(), [
            base,
            { version: 20260102000000, name: "index", migration: index(true) },
          ]).up(),
        ).rejects.toThrow(/transaction: false/);
        const runner = migrator(adapter(), [
          base,
          { version: 20260102000000, name: "index", migration: index(false) },
        ]);
        await runner.up();
        expect(await names(db, profile.listIndexes)).toContain("base_id_concurrent");
        await runner.down();
        expect(await names(db, profile.listIndexes)).not.toContain("base_id_concurrent");
      }));
  });
}
