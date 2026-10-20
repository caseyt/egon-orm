// MySQL specifics the conformance suites do not reach (tier 2: EGON_TEST_TIER2=1): the
// session time zone and datetime precision, writes read back by a composite key or a
// client-generated uuid key (MySQL has no RETURNING), and ON DUPLICATE KEY UPDATE on them.
import { change, createRepo, type DatabaseAdapter, from, type Repo } from "egon-orm";
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

  test("the session time zone is UTC whatever the server's is", async () => {
    const connection = await adapter.acquire();
    try {
      const { rows } = await connection.execute("select @@session.time_zone as zone", []);
      expect(rows).toEqual([{ zone: "+00:00" }]);
    } finally {
      await connection.release();
    }
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
});
