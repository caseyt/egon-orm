// Bound values that only an operand or a column can type, run through the repo on
// Postgres: arithmetic of typed values in where, select, set and insertAll; a column
// compared with a CASE or coalesce of untyped values; comparisons of untyped values; and a
// typed value beside a column of another type in arithmetic.
// Each of these was refused by Postgres before (42725 "operator is not unique", or
// "operator does not exist: bigint = text").

import { createTestDatabase, Membership, Post, type TestDatabaseHandle, User } from "@egon-orm/test-support";
import type { Repo } from "egon-orm";
import { caseWhen, coalesce, createRepo, defineType, from, lit, param, subquery, t, val } from "egon-orm";
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

  test("a typed value beside other arithmetic keeps its own type (review round 1)", async () => {
    const [row] = await repo.all(
      from(User, "u")
        .where(({ u }) => u.id.eq(1))
        .select(() => ({
          half: val(7.5, t.float()).div(int(2).add(1)),
          big: val(2 ** 40, t.bigint({ mode: "number" })).add(int(1).add(1)),
        })),
    );
    expect(row).toEqual({ half: 2.5, big: 2 ** 40 + 2 });
  });

  test("a CASE with a typed value beside a column (review round 1)", async () => {
    const rows = await repo.all(
      from(Post, "p")
        .where(({ p }) => p.id.in([1, 3]))
        .orderBy(({ p }) => p.id)
        .select(({ p }) => p.views.add(caseWhen(p.published, int(10)).else(0))),
    );
    expect(rows).toEqual([17, 22]);
  });

  test("a CASE or coalesce with no typed value takes the type of a typed value beside it (review round 1)", async () => {
    const [row] = await repo.all(
      from(User, "u")
        .where(({ u }) => u.id.eq(1))
        .select(() => ({
          coalesced: int(1).add(coalesce(val(null as number | null), val(2))),
          cases: caseWhen(lit(true), int(1)).add(caseWhen(lit(true), 2)),
          eq: int(1).eq(coalesce(val(null as number | null), val(1))),
          caseEq: caseWhen(lit(true), int(1)).eq(caseWhen(lit(true), 1)),
          between: int(1).between(caseWhen(lit(true), 0), caseWhen(lit(true), 5)),
        })),
    );
    expect(row).toEqual({ coalesced: 3, cases: 3, eq: true, caseEq: true, between: true });
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

describe("a CASE with no typed value nested in a coalesce that has one (review round 2)", () => {
  test("in a select", async () => {
    const [row] = await repo.all(
      from(User, "u")
        .where(({ u }) => u.id.eq(1))
        .select(() => ({
          fallback: coalesce(caseWhen(lit(false), 1), int(5)),
          first: coalesce(caseWhen(lit(true), 1), int(5)),
          nested: caseWhen(lit(false), int(1)).else(coalesce(caseWhen(lit(true), 2), int(3))),
        })),
    );
    expect(row).toEqual({ fallback: 5, first: 1, nested: 2 });
  });

  test("compared with a column", async () => {
    const rows = await repo.all(
      from(User, "u")
        .where(({ u }) => u.age.eq(coalesce(caseWhen(u.id.eq(1), 34), int(0))))
        .select(({ u }) => u.email),
    );
    expect(rows).toEqual(["ann@example.com"]);
  });

  test("an untyped CASE nested in a typed CASE, compared with a column", async () => {
    const rows = await repo.all(
      from(User, "u")
        .where(({ u }) => u.age.eq(caseWhen(u.id.eq(1), int(34)).else(caseWhen(lit(true), 15))))
        .orderBy(({ u }) => u.id)
        .select(({ u }) => u.email),
    );
    expect(rows).toEqual(["ann@example.com", "bo@example.com"]);
  });
});

describe("a NULL result before a typed one in a selected CASE (review round 3)", () => {
  test("takes the type of the result beside it", async () => {
    const rows = await repo.all(
      from(User, "u")
        .orderBy(({ u }) => u.id)
        .select(({ u }) => ({
          age: caseWhen(u.age.gt(20), val(null)).else(u.age),
          typed: caseWhen(u.id.eq(1), val(null)).else(val(3, t.integer())),
          plain: caseWhen(u.id.eq(1), null).else(val(3, t.integer())),
        })),
    );
    expect(rows).toEqual([
      { age: null, typed: null, plain: null },
      { age: 15, typed: 3, plain: 3 },
    ]);
  });

  test("a nested CASE of NULLs takes a column result's type (review round 4)", async () => {
    const rows = await repo.all(
      from(User, "u")
        .orderBy(({ u }) => u.id)
        .select(({ u }) => caseWhen(u.age.gt(20), u.age).else(caseWhen(lit(true), null))),
    );
    expect(rows).toEqual([34, null]);
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

describe("a typed value beside a column of another type in arithmetic keeps its type (owner decision, 2026-10-20)", () => {
  // Left to the column, the value took its type: an integer column divided as integers
  // (7 / 2 was 3), and a fraction beside it was refused (22P02).
  test("in select, on either side, and as a named parameter", async () => {
    const [row] = await repo.all(
      from(Post, "p")
        .where(({ p }) => p.id.eq(1))
        .select(({ p }) => ({
          half: p.views.div(val(2, t.float())),
          share: val(14, t.float()).div(p.views),
          plus: p.views.add(val(0.5, t.float())),
          named: p.views.div(param("by", t.float())),
          // A value of the column's own type is still left to it: integer division.
          whole: p.views.div(int(2)),
        })),
      { by: 4 },
    );
    expect(row).toEqual({ half: 3.5, share: 2, plus: 7.5, named: 1.75, whole: 3 });
  });

  test("in where", async () => {
    const rows = await repo.all(
      from(Post, "p")
        .where(({ p }) => p.views.div(val(2, t.float())).eq(val(3.5, t.float())))
        .select(({ p }) => p.title),
    );
    expect(rows).toEqual(["First"]);
  });

  test("a comparison leaves the value to the column; the guide's cast of the column compares a fraction", async () => {
    const fraction = from(Post, "p").where(({ p }) => p.views.lt(val(7.5, t.float())));
    expect(repo.toSql(fraction).sql).toContain('where "p"."views" < $1');
    await expect(repo.all(fraction)).rejects.toMatchObject({ code: "database", cause: { code: "22P02" } });
    const rows = await repo.all(
      from(Post, "p")
        .where(({ p }) => p.views.cast(t.float()).lt(val(7.5, t.float())))
        .orderBy(({ p }) => p.id)
        .select(({ p }) => p.title),
    );
    expect(rows).toEqual(["First", "Second"]);
  });

  test("the result is read as the wider type: a bigint, or a float beside a bigint column (review round 1)", async () => {
    const [row] = await repo.all(
      from(Post, "p")
        .where(({ p }) => p.id.eq(1))
        .select(({ p }) => ({
          // int4 + int8 is int8, which pg returns as text: read as the bigint, a number.
          wide: p.views.add(val(1, t.bigint({ mode: "number" }))),
          // A bigint({ mode: "number" }) column halved: a float, not an unsafe integer.
          keyHalf: p.authorId.div(val(2, t.float())),
        })),
    );
    expect(row).toEqual({ wide: 8, keyHalf: 0.5 });
    expect(typeof row?.wide).toBe("number");
    expect(typeof row?.keyHalf).toBe("number");
  });

  test("a custom numeric type has no place in the order: left to the column, as before (review round 1)", async () => {
    const cents = defineType<number, string | number>({
      name: "cents",
      db: { kind: "custom", sql: "numeric(10, 2)" },
      cast: (v) => ({ success: true, data: Number(v) }),
      fromDb: (v) => Number(v),
      toDb: (v) => v,
    });
    const by = val(2, t.type(cents));
    const q = from(Post, "p").where(({ p }) => p.id.eq(1));
    expect(repo.toSql(q.select(({ p }) => p.views.div(by))).sql).toContain('"p"."views" / $1');
    // The value takes the column's type: integer division, read as an integer.
    expect(await repo.all(q.select(({ p }) => p.views.div(by)))).toEqual([3]);
    // The guide's workaround, a built-in type, runs on every database: read conformance.
  });

  test("beside a column of a subquery that selects values the value is cast too (review round 1)", async () => {
    const inner = from(Post, "x")
      .where(({ x }) => x.id.eq(1))
      .select(({ x }) => ({ k: x.views }));
    const [half] = await repo.all(from(subquery(inner), "s").select(({ s }) => s.k.div(val(2, t.float()))));
    expect(half).toBe(3.5);
  });

  test("in set", async () => {
    await repo.insertAll(Post, [{ authorId: 1, title: "Scaled", views: 2 }]);
    const scaled = from(Post, "p").where(({ p }) => p.title.eq("Scaled"));
    try {
      await repo.updateAll(scaled.set(({ p }) => ({ views: p.views.mul(val(2.5, t.float())) })));
      expect(await repo.all(scaled.select(({ p }) => p.views))).toEqual([5]);
    } finally {
      await repo.deleteAll(scaled);
    }
  });
});
