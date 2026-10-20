// Bound values that only an operand or a column can type, run through the repo on
// Postgres: arithmetic of typed values in where, select, set and insertAll; a column
// compared with a CASE or coalesce of untyped values; and comparisons of untyped values.
// Each of these was refused by Postgres before (42725 "operator is not unique", or
// "operator does not exist: bigint = text").

import { createTestDatabase, Membership, Post, type TestDatabaseHandle, User } from "@egon-orm/test-support";
import type { Repo } from "egon-orm";
import { caseWhen, coalesce, createRepo, from, lit, param, t, val } from "egon-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { postgres } from "../src/index.js";

const ORG = "00000000-0000-4000-8000-000000000001";

let handle: TestDatabaseHandle;
let repo: Repo;
let close: () => Promise<void>;

beforeAll(async () => {
  handle = await createTestDatabase("postgres", { label: "casts", fixtures: ["blog"] });
  const db = handle.db;
  const adapter = postgres({
    host: db.settings.host,
    port: db.settings.port,
    user: db.settings.user,
    password: db.settings.password,
    database: db.name,
    pool: { max: 2 },
  });
  close = () => adapter.close();
  repo = createRepo({ adapter });
  await db.exec(`
    INSERT INTO users (id, email, name, age) VALUES (1, 'ann@example.com', 'Ann', 34), (2, 'bo@example.com', 'Bo', 15);
    INSERT INTO posts (id, author_id, title, published, views) VALUES
      (1, 1, 'First', true, 7), (2, 1, 'Second', false, 3), (3, 2, 'Third', true, 12);
    INSERT INTO orgs (id, name) VALUES ('${ORG}', 'Acme');
    INSERT INTO memberships (org_id, user_id) VALUES ('${ORG}', 2);
    SELECT setval('posts_id_seq', 100);
  `);
});

afterAll(async () => {
  await close?.();
  await handle?.drop();
});

const int = (n: number) => val(n, t.integer());
const titles = (rows: readonly { readonly title: string }[]) => rows.map((row) => row.title).sort();

describe("arithmetic of typed values", () => {
  test("in where", async () => {
    const rows = await repo.all(from(Post, "p").where(({ p }) => p.views.eq(int(3).add(4))));
    expect(titles(rows)).toEqual(["First"]);
    const named = await repo.all(
      from(Post, "p").where(({ p }) => p.views.gt(param("base", t.integer()).mul(2))),
      { base: 5 },
    );
    expect(titles(named)).toEqual(["Third"]);
  });

  test("in select, every operator and unary minus, as numbers", async () => {
    const [row] = await repo.all(
      from(User, "u")
        .where(({ u }) => u.id.eq(1))
        .select(() => ({
          add: int(7).add(2),
          sub: int(7).sub(2),
          mul: int(7).mul(2),
          div: int(7).div(2),
          mod: int(7).mod(2),
          neg: int(7).neg(),
          nested: int(2).mul(3).add(int(1)),
        })),
    );
    expect(row).toEqual({ add: 9, sub: 5, mul: 14, div: 3, mod: 1, neg: -7, nested: 7 });
  });

  test("in set", async () => {
    const { count } = await repo.updateAll(
      from(Post, "p")
        .where(({ p }) => p.id.eq(2))
        .set(() => ({ views: int(3).add(1) })),
    );
    expect(count).toBe(1);
    const [post] = await repo.all(from(Post, "p").where(({ p }) => p.id.eq(2)));
    expect(post?.views).toBe(4);
  });

  test("in insertAll cells", async () => {
    await repo.insertAll(Post, [
      { authorId: 1, title: "Cast one", views: int(3).add(1) },
      { authorId: 1, title: "Cast two", views: int(10).sub(int(2)) },
    ]);
    const cast = from(Post, "p").where(({ p }) => p.title.in(["Cast one", "Cast two"]));
    const rows = await repo.all(cast.orderBy(({ p }) => p.title).select(({ p }) => p.views));
    expect(rows).toEqual([4, 8]);
    // The tests below count the three seeded posts only.
    await repo.deleteAll(cast);
  });
});

describe("a column compared with a CASE or coalesce of untyped values takes the column's type", () => {
  test("eq and neq, with the CASE on either side", async () => {
    const eq = await repo.all(
      from(Post, "p").where(({ p }) => p.authorId.eq(caseWhen(p.published, 1).else(2))),
    );
    expect(titles(eq)).toEqual(["First"]);
    const neq = await repo.all(
      from(Post, "p").where(({ p }) => caseWhen(p.published, 1).else(2).neq(p.authorId)),
    );
    expect(titles(neq)).toEqual(["Second", "Third"]);
  });

  test("a coalesce", async () => {
    const rows = await repo.all(from(Post, "p").where(({ p }) => p.authorId.gte(coalesce(val(2), val(1)))));
    expect(titles(rows)).toEqual(["Third"]);
  });

  test("between", async () => {
    const rows = await repo.all(
      from(Post, "p").where(({ p }) => p.authorId.between(caseWhen(p.published, 2).else(0), 5)),
    );
    expect(titles(rows)).toEqual(["Second", "Third"]);
  });

  test("in and not in", async () => {
    const inList = await repo.all(
      from(Post, "p").where(({ p }) => p.authorId.in(coalesce(val([2]), val([1])))),
    );
    expect(titles(inList)).toEqual(["Third"]);
    const notIn = await repo.all(
      from(Post, "p").where(({ p }) => p.authorId.notIn(coalesce(val([2]), val([1])))),
    );
    expect(titles(notIn)).toEqual(["First", "Second"]);
  });

  test("a uuid column", async () => {
    const rows = await repo.all(
      from(Membership, "m")
        .where(({ m }) => m.orgId.eq(caseWhen(lit(true), val(ORG))))
        .select(({ m }) => m.userId),
    );
    expect(rows).toEqual([2]);
  });

  test("a CASE with a typed value: its typed values are cast", async () => {
    const rows = await repo.all(
      from(Post, "p").where(({ p }) =>
        p.authorId.eq(caseWhen(p.published, val(2, t.bigint({ mode: "number" }))).else(1)),
      ),
    );
    expect(titles(rows)).toEqual(["Second", "Third"]);
  });
});

describe("untyped values with widened types", () => {
  test("val('b').gt('a') and val(34).eq(u.age) run", async () => {
    const all = await repo.all(
      from(User, "u")
        .where(() => val("b").gt("a"))
        .select(({ u }) => u.id),
    );
    expect(all.sort()).toEqual([1, 2]);
    const aged = await repo.all(
      from(User, "u")
        .where(({ u }) => val(34).eq(u.age))
        .select(({ u }) => u.email),
    );
    expect(aged).toEqual(["ann@example.com"]);
  });
});
