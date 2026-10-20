// SQLite migrations the shared suite cannot write for every database: the table rebuild of
// SQLite's own documentation (foreign keys off, which only works outside a transaction), and
// the claim a runner leaves while it runs a migration without a transaction.
import { fragment } from "egon-orm";
import {
  createMigrator,
  defineMigration,
  MigrationError,
  type MigrationEvent,
  type MigrationSource,
} from "egon-orm/migration";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabaseHandle } from "../../core/test/support/index.js";
import { sqlite } from "../src/index.js";

let handle: TestDatabaseHandle;

beforeEach(async () => {
  handle = await createTestDatabase("sqlite", { label: "sqlite_migrate" });
});

afterEach(async () => {
  await handle?.drop();
});

describe("migrations without a transaction", () => {
  test("a table rebuild with foreign keys off keeps the rows that point at it", async () => {
    await handle.db.exec(`
      create table parents (id integer primary key, name text);
      create table children (id integer primary key, parent_id integer not null references parents (id));
      insert into parents values (1, 'one');
      insert into children values (10, 1);
    `);
    // SQLite cannot change a column: copy the table, drop it, rename the copy. With foreign
    // keys on, dropping parents deletes it under children and fails.
    const rebuild: MigrationSource[] = [
      {
        version: 20260101000000,
        name: "rebuild_parents",
        migration: defineMigration({
          transaction: false,
          up(m) {
            m.execute(fragment`pragma foreign_keys = off`);
            m.execute(
              fragment`create table parents_new (id integer primary key, name text not null default '')`,
            );
            m.execute(
              fragment`insert into parents_new (id, name) select id, coalesce(name, '') from parents`,
            );
            m.execute(fragment`drop table parents`);
            m.execute(fragment`alter table parents_new rename to parents`);
            // The adapter's one handle keeps the pragma after the migration: turn it back on,
            // and fail when a row breaks a foreign key (pragma foreign_key_check lists them).
            m.execute(fragment`pragma foreign_keys = on`);
            m.execute(fragment`drop table if exists temp.fk_violations`);
            m.execute(fragment`create temp table fk_violations (n integer check (n = 0))`);
            m.execute(fragment`insert into fk_violations select count(*) from pragma_foreign_key_check`);
            m.execute(fragment`drop table fk_violations`);
          },
        }),
      },
    ];
    const adapter = sqlite({ filename: handle.db.settings.database });
    try {
      expect((await createMigrator({ adapter, migrations: rebuild }).up()).map((run) => run.name)).toEqual([
        "rebuild_parents",
      ]);
      expect((await adapter.execute("pragma foreign_keys", [])).rows).toEqual([{ foreign_keys: 1 }]);
      expect((await adapter.execute("pragma foreign_key_check", [])).rows).toEqual([]);
      expect((await adapter.execute("select id from children", [])).rows).toEqual([{ id: 10 }]);
    } finally {
      await adapter.close();
    }
  });

  test("the check at the end of a rebuild fails it when a row is left without its parent", async () => {
    await handle.db.exec(`
      create table parents (id integer primary key);
      create table children (id integer primary key, parent_id integer not null references parents (id));
      insert into parents values (1);
      insert into children values (10, 1);
    `);
    const lossy: MigrationSource[] = [
      {
        version: 20260101000000,
        name: "lose_parents",
        migration: defineMigration({
          transaction: false,
          up(m) {
            m.execute(fragment`pragma foreign_keys = off`);
            m.execute(fragment`create table parents_new (id integer primary key)`);
            m.execute(fragment`drop table parents`);
            m.execute(fragment`alter table parents_new rename to parents`);
            m.execute(fragment`pragma foreign_keys = on`);
            m.execute(fragment`drop table if exists temp.fk_violations`);
            m.execute(fragment`create temp table fk_violations (n integer check (n = 0))`);
            m.execute(fragment`insert into fk_violations select count(*) from pragma_foreign_key_check`);
            m.execute(fragment`drop table fk_violations`);
          },
        }),
      },
    ];
    const adapter = sqlite({ filename: handle.db.settings.database });
    try {
      const error = await createMigrator({ adapter, migrations: lossy })
        .up()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as Error).message).toMatch(/ran without a transaction.*check constraint was violated/);
      // Not recorded, and no claim left behind.
      expect(await createMigrator({ adapter, migrations: lossy }).status()).toEqual([
        { version: 20260101000000, name: "lose_parents", state: "down" },
      ]);
    } finally {
      await adapter.close();
    }
  });

  test("a runner waits while another runner's claim is recorded, and runs once it is gone", async () => {
    const adapter = sqlite({ filename: handle.db.settings.database });
    const migrations: MigrationSource[] = [
      {
        version: 20260101000000,
        name: "create_a",
        migration: defineMigration({
          change(m) {
            m.createTable("a", (t) => t.id());
          },
        }),
      },
    ];
    try {
      // The tracking table, then the claim another runner leaves while it runs a migration
      // without a transaction.
      expect(await createMigrator({ adapter, migrations: [] }).up()).toEqual([]);
      await handle.db.query("insert into schema_migrations (version, created_at) values (-1, 'now')");
      const events: MigrationEvent[] = [];
      const waiting = await createMigrator({
        adapter,
        migrations,
        lockTimeoutMs: 200,
        log: (event) => events.push(event),
      })
        .up()
        .catch((error: unknown) => error);
      expect(waiting).toBeInstanceOf(MigrationError);
      expect((waiting as Error).message).toMatch(/delete the row with version -1/);
      expect((await handle.db.query("select name from sqlite_master where name = 'a'")).length).toBe(0);
      // It said so once, with how to clear a claim left behind.
      const warnings = events.filter((event) => event.kind === "warning");
      expect(warnings).toHaveLength(1);
      expect((warnings[0] as { message: string }).message).toMatch(/delete the row with version -1/);
      // status shows the claim, apart from the migrations: it is not an applied version.
      expect(await createMigrator({ adapter, migrations }).status()).toEqual([
        { version: -1, name: undefined, state: "claimed" },
        { version: 20260101000000, name: "create_a", state: "down" },
      ]);
      await handle.db.query("delete from schema_migrations where version = -1");
      expect((await createMigrator({ adapter, migrations }).up()).map((run) => run.name)).toEqual([
        "create_a",
      ]);
    } finally {
      await adapter.close();
    }
  });
});
