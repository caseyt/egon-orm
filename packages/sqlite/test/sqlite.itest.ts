// SQLite specifics the conformance suites do not reach: the one handle serialises
// transactions (two never interleave), an in-memory database serves a whole repo, and
// values without a type (a Date, a boolean) bind as SQLite stores them.
import { CastError, change, createRepo, fragment, from, Schema, t, val } from "egon-orm";
import { describe, expect, test } from "vitest";
import { readFixture, User } from "../../core/test/support/index.js";
import { sqlite } from "../src/index.js";

describe("sqlite", () => {
  test('an in-memory database (":memory:") runs statements and transactions on the handle', async () => {
    const adapter = sqlite({ filename: ":memory:", planCacheSize: 10 });
    try {
      await adapter.execute("create table t (id integer primary key, v text not null unique)", []);
      const connection = await adapter.acquire();
      try {
        await connection.begin();
        await connection.execute("insert into t (v) values (?)", ["a"]);
        await connection.rollback();
      } finally {
        await connection.release();
      }
      expect((await adapter.execute("select count(*) as n from t", [])).rows).toEqual([{ n: 0 }]);
      await adapter.execute("insert into t (v) values (?)", ["a"]);
      await expect(adapter.execute("insert into t (v) values (?)", ["a"])).rejects.toMatchObject({
        type: "unique",
        constraint: "t_v_key",
      });
    } finally {
      await adapter.close();
    }
  });

  test("attached databases are opened with the handle and serve the schema option", async () => {
    const adapter = sqlite({ filename: ":memory:", attach: { audit: ":memory:" } });
    try {
      await adapter.execute("create table audit.entries (id integer primary key, what text)", []);
      await adapter.execute("insert into audit.entries (what) values (?)", ["login"]);
      expect((await adapter.execute("select what from audit.entries", [])).rows).toEqual([{ what: "login" }]);
    } finally {
      await adapter.close();
    }
  });

  test("two transactions on one adapter run one after the other, never interleaved", async () => {
    const adapter = sqlite({ filename: ":memory:" });
    const repo = createRepo({ adapter });
    try {
      await adapter.execute(
        "create table steps (n integer primary key autoincrement, label text not null)",
        [],
      );
      const log = (label: string) => adapter.execute("insert into steps (label) values (?)", [label]);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = repo.transaction(async (tx) => {
        await tx.raw(fragment`insert into steps (label) values (${"a1"})`);
        await gate;
        await tx.raw(fragment`insert into steps (label) values (${"a2"})`);
      });
      const second = repo.transaction(async (tx) => {
        await tx.raw(fragment`insert into steps (label) values (${"b1"})`);
      });
      // The plain statement waits for the handle too, behind both transactions.
      const outside = log("outside");
      // Give the others time to try for the handle while the first transaction holds it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await Promise.all([first, second, outside]);
      const { rows } = await adapter.execute("select label from steps order by n", []);
      expect(rows.map((row) => row.label)).toEqual(["a1", "a2", "b1", "outside"]);
    } finally {
      await repo.close();
    }
  });

  test('an in-memory database (":memory:") holds the blog schema and serves a repo', async () => {
    const adapter = sqlite({ filename: ":memory:" });
    const repo = createRepo({ adapter });
    try {
      await adapter.execute(await readFixture("blog", "sqlite"), []);
      const ann = await repo.insertOrThrow(change(User, { email: "ann@example.com", name: "Ann" }));
      expect(ann.id).toBe(1);
      expect(ann.createdAt).toBeInstanceOf(Date);
      const since = new Date(Date.now() - 60_000);
      const names = await repo.all(
        from(User, "u")
          .where(({ u }) => u.createdAt.gt(since))
          .where(() => val(true))
          .select(({ u }) => u.name),
      );
      expect(names).toEqual(["Ann"]);
    } finally {
      await repo.close();
    }
  });

  test("a t.integer() field reads integers as numbers, and refuses text stored in its column", async () => {
    const adapter = sqlite({ filename: ":memory:" });
    const repo = createRepo({ adapter });
    try {
      // SQLite keeps a value of any kind in any column: "12a" stays text in an integer column.
      await adapter.execute("create table counters (id integer primary key, n integer not null)", []);
      await adapter.execute("insert into counters values (1, 7)", []);
      class Counter extends Schema("counters", { id: t.integer().primaryKey(), n: t.integer() }) {}
      expect((await repo.all(from(Counter, "c"))).map((c) => [c.id, c.n])).toEqual([[1, 7]]);
      await adapter.execute("insert into counters values (2, '12a')", []);
      await expect(repo.all(from(Counter, "c"))).rejects.toThrow(CastError);
      await expect(repo.all(from(Counter, "c"))).rejects.toThrow(
        "Counter.n is declared t.integer(), but the database returned a string for it, not a number:",
      );
    } finally {
      await repo.close();
    }
  });
});
