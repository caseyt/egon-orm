// MySQL specifics the conformance suites do not reach (tier 2: EGON_TEST_TIER2=1): the
// session time zone and datetime precision, writes read back by a composite key or a
// client-generated uuid key (MySQL has no RETURNING), and ON DUPLICATE KEY UPDATE on them.
import {
  change,
  coalesce,
  createRepo,
  type DatabaseAdapter,
  from,
  type Repo,
  Schema,
  t,
  val,
} from "egon-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createTestDatabase,
  Membership,
  Org,
  Post,
  type TestDatabaseHandle,
  tier2Enabled,
  User,
} from "../../core/test/support/index.js";
import { makeMysql } from "./profile.js";

/** A table with a client-generated key and another unique column. */
class Account extends Schema("accounts", {
  id: t.uuid().primaryKey().autogenerate(),
  email: t.string(),
  name: t.string(),
}) {}

describe.runIf(tier2Enabled())("mysql", () => {
  let handle: TestDatabaseHandle;
  let adapter: DatabaseAdapter;
  let repo: Repo;

  beforeAll(async () => {
    handle = await createTestDatabase("mysql", { label: "mysql", fixtures: ["blog"] });
    adapter = makeMysql(handle.db, 2);
    repo = createRepo({ adapter });
    await handle.db.query("insert into users (id, email) values (1, 'ann@example.com')");
  });

  afterAll(async () => {
    await adapter?.close();
    await handle?.drop();
  });

  test("the session time zone is UTC and its messages English, whatever the server's are", async () => {
    const connection = await adapter.acquire();
    try {
      const { rows } = await connection.execute(
        "select @@session.time_zone as zone, @@session.lc_messages as messages",
        [],
      );
      expect(rows).toEqual([{ zone: "+00:00", messages: "en_US" }]);
    } finally {
      await connection.release();
    }
  });

  test("an UPDATE counts the rows it matched in any message language", async () => {
    await handle.db.query("create table counted (id integer primary key, n integer not null)");
    await handle.db.query("insert into counted values (1, 1), (2, 2), (3, 3)");
    const connection = await adapter.acquire();
    try {
      await connection.execute("set lc_messages = 'de_DE'", []);
      // Nothing changes, so the count can only come from the rows matched.
      const result = await connection.execute("update counted set n = n where n > ?", [0]);
      expect(result.rowCount).toBe(3);
    } finally {
      await connection.execute("set lc_messages = 'en_US'", []);
      await connection.release();
    }
  });

  test("an upsert that met a row it cannot read back writes nothing, and says so", async () => {
    await handle.db.query(
      "create table accounts (id char(36) primary key, email varchar(255) not null unique, name varchar(255) not null)",
    );
    const first = await repo.insertOrThrow(change(Account, { email: "a@example.com", name: "first" }));
    await expect(
      repo.insert(change(Account, { email: "a@example.com", name: "second" }), {
        onConflict: { update: ["name"] },
      }),
    ).rejects.toThrow(/could not be read back by the key it was given.*Nothing was written/);
    expect(await handle.db.query("select id, name from accounts")).toEqual([{ id: first.id, name: "first" }]);
    // Inside a transaction, a savepoint undoes the upsert and the transaction carries on.
    await repo.transaction(async (tx) => {
      await expect(
        tx.insert(change(Account, { email: "a@example.com", name: "third" }), {
          onConflict: { update: ["name"] },
        }),
      ).rejects.toThrow(/Nothing was written/);
      await tx.insertOrThrow(change(Account, { email: "b@example.com", name: "kept" }));
    });
    expect(await handle.db.query("select name from accounts order by email")).toEqual([
      { name: "first" },
      { name: "kept" },
    ]);
  });

  test("a uuid is written in lowercase, so either case is one key", async () => {
    const upper = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
    await repo.insertOrThrow(change(Org, { id: upper, name: "Upper" }));
    expect(await handle.db.query("select id from orgs where name = 'Upper'")).toEqual([
      { id: upper.toLowerCase() },
    ]);
    expect((await repo.getOrThrow(Org, upper.toLowerCase())).id).toBe(upper.toLowerCase());
    expect((await repo.getOrThrow(Org, upper)).name).toBe("Upper");
    await expect(
      repo.insertOrThrow(change(Org, { id: upper.toLowerCase(), name: "Again" })),
    ).rejects.toThrow();
  });

  test("a datetime(6) is read to the millisecond: the microseconds a Date cannot hold are dropped", async () => {
    await handle.db.query(
      "insert into posts (id, author_id, title, created_at) values (1, 1, 'precise', '2026-03-29 01:30:00.123456')",
    );
    const [value] = await repo.all(
      from(Post, "p")
        .where(({ p }) => p.id.eq(1))
        .select(({ p }) => p.createdAt),
    );
    expect(value?.toISOString()).toBe("2026-03-29T01:30:00.123Z");
  });

  test("a Date is written as its UTC wall time, so it reads back as the same instant", async () => {
    const at = new Date("2026-10-25T01:30:00.250Z");
    const user = await repo.insertOrThrow(change(User, { email: "zone@example.com", createdAt: at }));
    expect(user.createdAt.toISOString()).toBe(at.toISOString());
    const [row] = await handle.db.query<{ text: string }>(
      "select date_format(created_at, '%Y-%m-%d %H:%i:%s.%f') as text from users where id = ?",
      [user.id],
    );
    expect(row?.text).toBe("2026-10-25 01:30:00.250000");
  });

  test("a row with a client-generated uuid key is read back by that key", async () => {
    const org = await repo.insertOrThrow(change(Org, { name: "Acme" }));
    expect(org.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await repo.getOrThrow(Org, org.id)).toEqual(org);
  });

  test("a row with a composite key is read back by its key, and an upsert on it updates in place", async () => {
    const org = await repo.insertOrThrow(change(Org, { name: "Composite" }));
    const first = await repo.insertOrThrow(change(Membership, { orgId: org.id, userId: 1 }));
    expect(first).toMatchObject({ orgId: org.id, userId: 1, role: "member" });
    const again = await repo.insertOrThrow(change(Membership, { orgId: org.id, userId: 1, role: "admin" }), {
      onConflict: { update: ["role"] },
    });
    expect(again).toMatchObject({ orgId: org.id, userId: 1, role: "admin" });
    const rows = await handle.db.query("select role from memberships where org_id = ?", [org.id]);
    expect(rows).toEqual([{ role: "admin" }]);
  });

  test("an upsert on an auto-increment key reports the key of the row it updated", async () => {
    const first = await repo.insertOrThrow(change(User, { email: "twice@example.com", name: "One" }));
    await repo.insertOrThrow(change(User, { email: "other@example.com" }));
    const again = await repo.insertOrThrow(change(User, { email: "twice@example.com", name: "Two" }), {
      onConflict: { update: ["name"] },
    });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("Two");
  });

  test("an upsert that changes nothing still reports the key of the row it met", async () => {
    // MySQL reports no insert id for an update that changed nothing, unless the statement
    // sets it with last_insert_id(key).
    const first = await repo.insertOrThrow(change(User, { email: "same@example.com", name: "Same" }));
    await repo.insertOrThrow(change(User, { email: "later@example.com" }));
    const again = await repo.insertOrThrow(change(User, { email: "same@example.com", name: "Same" }), {
      onConflict: { update: ["name"] },
    });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("Same");
  });

  test('onConflict "nothing" leaves the existing row alone', async () => {
    await repo.insertOrThrow(change(User, { email: "keep@example.com", name: "Kept" }));
    await repo.insert(change(User, { email: "keep@example.com", name: "Lost" }), { onConflict: "nothing" });
    const rows = await handle.db.query("select name from users where email = 'keep@example.com'");
    expect(rows).toEqual([{ name: "Kept" }]);
  });

  test("an onConflict target is refused: MySQL picks the conflicting key itself", async () => {
    await expect(
      repo.insert(change(User, { email: "t@example.com" }), {
        onConflict: { target: ["email"], update: ["name"] },
      }),
    ).rejects.toThrow("An onConflict target is not supported by mysql.");
  });

  test("a t.integer() field over a bigint column reads numbers: mysql2 sends one as a number", async () => {
    // The blog keys are bigint AUTO_INCREMENT; pg would send them as text (see the Postgres suite).
    class LooseUser extends Schema("users", {
      id: t.integer().primaryKey().dbGenerated(),
      email: t.string(),
    }) {}
    const rows = await repo.all(from(LooseUser, "u").where(({ u }) => u.id.eq(1)));
    expect(rows.map((row) => row.id)).toEqual([1]);
    await handle.db.query("create table measures (id integer primary key, amount decimal(10, 2) not null)");
    await handle.db.query("insert into measures values (1, 1.50)");
    // A decimal arrives as text; the float codec reads numeric text as a number.
    class Measure extends Schema("measures", { id: t.integer().primaryKey(), amount: t.float() }) {}
    expect((await repo.all(from(Measure, "m"))).map((m) => m.amount)).toEqual([1.5]);
  });

  test("a division of two integers is written with DIV and reads the integer quotient", async () => {
    // MySQL's / returns DECIMAL text ("3.5000"), which a t.integer() result refuses; DIV
    // divides as integers, truncating towards zero, as Postgres and SQLite do (owner
    // decision, 2026-10-20).
    await handle.db.query("create table halves (id integer primary key, n integer not null)");
    await handle.db.query("insert into halves values (1, 7), (2, -7)");
    class Half extends Schema("halves", { id: t.integer().primaryKey(), n: t.integer() }) {}
    const q = from(Half, "h")
      .orderBy(({ h }) => h.id)
      .select(({ h }) => ({ d: h.n.div(2) }));
    expect(repo.toSql(q).sql).toContain("`h`.`n` div ?");
    expect(await repo.all(q)).toEqual([{ d: 3 }, { d: -3 }]);
    // A float operand keeps /, and reads the fraction.
    expect(
      await repo.all(
        from(Half, "h")
          .where({ id: 1 })
          .select(({ h }) => ({ f: h.n.div(val(2, t.float())) })),
      ),
    ).toEqual([{ f: 3.5 }]);
    // Other integer arithmetic reads numbers.
    expect(
      await repo.all(
        from(Half, "h")
          .where({ id: 1 })
          .select(({ h }) => ({ m: h.n.mul(2), s: h.n.add(1) })),
      ),
    ).toEqual([{ m: 14, s: 8 }]);
    // An operand whose type the query does not know (a function) keeps /, and its decimal
    // result is refused by the t.integer() read (guide/types.md, "Good to know").
    const unknown = from(Half, "h")
      .where({ id: 1 })
      .select(({ h }) => ({ d: coalesce(h.n, val(0, t.integer())).div(2) }));
    expect(repo.toSql(unknown).sql).toContain(") / ");
    await expect(repo.all(unknown)).rejects.toThrow(
      '"d" is declared t.integer(), but the database returned a string for it, not a number',
    );
    // A fraction bound as an integer is refused before it is sent (DIV would truncate it).
    await expect(repo.all(from(Half, "h").select(({ h }) => ({ d: h.n.div(2.5) })))).rejects.toThrow(
      /^[a-z]+(?:\.\w+)?: Parameter 1 has the type t\.integer\(\) .* but its value is not a whole number\./,
    );
  });

  test("a division of two integers is exact above 2^53", async () => {
    // The same test runs on Postgres and SQLite: one result everywhere.
    await handle.db.query("create table bigs (id integer primary key, b bigint not null)");
    await handle.db.query("insert into bigs values (1, 1152921504606846975)");
    class Big extends Schema("bigs", { id: t.integer().primaryKey(), b: t.bigint({ mode: "number" }) }) {}
    const q = from(Big, "x").select(({ x }) => ({
      plain: x.b.div(1024),
      typed: x.b.div(val(1024, t.bigint({ mode: "number" }))),
    }));
    expect(await repo.all(q)).toEqual([{ plain: 1125899906842623, typed: 1125899906842623 }]);
    // A fraction beside the number-mode bigint is refused too (DIV would truncate it).
    await expect(repo.all(from(Big, "x").select(({ x }) => ({ d: x.b.div(2.5) })))).rejects.toThrow(
      /^[a-z]+(?:\.\w+)?: Parameter 1 has the type t\.bigint\(\{ mode: "number" \}\) .* but its value is not a whole number\./,
    );
  });

  test("an insert whose read-back row fails to decode says that the write was applied", async () => {
    // MySQL has no RETURNING: the row is read back after the insert, by an ordinary read.
    await handle.db.query(
      "create table tallies (id integer primary key auto_increment, label text not null, score decimal(10, 2) not null default 1.50)",
    );
    class Tally extends Schema("tallies", {
      id: t.integer().primaryKey().dbGenerated(),
      label: t.string(),
      score: t.integer().dbGenerated(),
    }) {}
    await expect(repo.insert(change(Tally, { label: "first" }))).rejects.toThrow(
      /^[a-z]+(?:\.\w+)?: Tally\.score is declared t\.integer\(\), but the database returned a string.* The write itself was applied: outside a transaction it stays; inside one it commits or rolls back with the transaction\.$/,
    );
    // The row is there: the insert ran before the read-back failed.
    expect(await repo.count(from(Tally, "t"))).toBe(1);
    // An upsert and its read-back are one unit: the failed read-back undoes the upsert, and
    // the error says so.
    await expect(
      repo.insert(change(Tally, { label: "second" }), { onConflict: { update: ["label"] } }),
    ).rejects.toThrow(
      /^[a-z]+(?:\.\w+)?: Tally\.score is declared t\.integer\(\).* The write was undone: an upsert and its read-back run as one unit\.$/,
    );
    expect(await repo.count(from(Tally, "t"))).toBe(1);
  });
});
