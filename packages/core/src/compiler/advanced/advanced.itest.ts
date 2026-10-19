// The step 09 features on a real Postgres: every statement of the snapshot matrix runs
// (inside a rolled-back transaction), and one realistic query per feature checks the rows
// it returns.
import { createTestDatabase, Membership, Post, type TestDatabaseHandle, User } from "@egon-orm/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { OutputPlan } from "../../contracts/adapter.js";
import {
  caseWhen,
  count,
  cte,
  dynamic,
  exists,
  field,
  from,
  lit,
  not,
  param,
  prepare,
  rowNumber,
  scalar,
  selectedAs,
  subquery,
  sum,
  t,
  tuple,
  val,
} from "../../index.js";
import type { QueryLike } from "../../query/builder.js";
import { bindParams, type NamedValues } from "../bind.js";
import { createCompiler } from "../compiler.js";
import { postgresDialect } from "../dialect.js";
import { ADVANCED_QUERIES, CATEGORY_DDL, Category } from "./advanced-queries.js";

const SEED = `
INSERT INTO users (id, email, name, age, role) VALUES
  (1, 'ann@example.com', 'Ann', 34, 'admin'),
  (2, 'bo@example.com', NULL, 15, 'member'),
  (3, 'cy@example.com', 'Cy', 41, 'member'),
  (4, 'di@example.com', 'Di', 28, 'member');
INSERT INTO posts (id, author_id, title, published, views, tags, created_at) VALUES
  (1, 1, 'Ann one', true, 120, '{ts}', '2026-02-01T00:00:00Z'),
  (2, 1, 'Ann two', false, 3, NULL, '2026-03-01T00:00:00Z'),
  (3, 1, 'Ann three', true, 50, NULL, '2026-04-01T00:00:00Z'),
  (4, 1, 'Ann four', true, 7, NULL, '2026-05-01T00:00:00Z'),
  (5, 2, 'Bo one', true, 9, NULL, '2026-02-15T00:00:00Z'),
  (6, 3, 'Cy one', false, 0, NULL, '2025-12-01T00:00:00Z');
INSERT INTO comments (post_id, author_id, body) VALUES (1, 2, 'nice'), (2, NULL, 'anon'), (6, 1, 'old');
INSERT INTO categories (id, parent_id, name) VALUES
  (1, NULL, 'root'), (2, 1, 'child a'), (3, 1, 'child b'), (4, 2, 'grandchild'), (5, NULL, 'other root');
SELECT setval('users_id_seq', 100), setval('posts_id_seq', 100), setval('categories_id_seq', 100);
`;

let handle: TestDatabaseHandle;

beforeAll(async () => {
  handle = await createTestDatabase("postgres", { label: "advanced", fixtures: ["blog"] });
  await handle.db.exec(CATEGORY_DDL);
  await handle.db.exec(SEED);
});

afterAll(async () => {
  await handle?.drop();
});

const compiler = createCompiler(postgresDialect);

/** The output columns of a plan whose values are 64-bit integers, which the driver returns as text. */
function bigintColumns(output: OutputPlan | undefined): string[] {
  if (output === undefined) return [];
  if (output.kind === "value") return output.type?.db.kind === "bigint" ? [output.alias] : [];
  if (output.kind === "object") return output.values.flatMap(bigintColumns);
  return [];
}

/**
 * Runs a query, returning the rows with the output columns as the compiler names them
 * (`c0`, `c1`, …); 64-bit integers are read as numbers, as the repo will read them.
 */
async function rows(
  query: QueryLike,
  named?: NamedValues,
  operation: "all" | "updateAll" | "deleteAll" = "all",
): Promise<Record<string, unknown>[]> {
  const plan = compiler.compile(query.ast, operation, undefined);
  const result = await handle.db.query(plan.sql, bindParams(plan.slots, query.ast.params, named));
  const big = bigintColumns(plan.output);
  for (const row of result)
    for (const column of big) if (row[column] !== null) row[column] = Number(row[column]);
  return result;
}

/** Runs `body` in a transaction that is rolled back. */
async function rolledBack<T>(body: () => Promise<T>): Promise<T> {
  await handle.db.query("begin");
  try {
    return await body();
  } finally {
    await handle.db.query("rollback");
  }
}

describe("every statement of the matrix runs on Postgres", () => {
  for (const entry of ADVANCED_QUERIES) {
    test(entry.name, async () => {
      const result = await rolledBack(() => rows(entry.query, entry.named, entry.operation));
      expect(Array.isArray(result)).toBe(true);
    });
  }
});

test("top three posts per author by views, with a window function in a subquery", async () => {
  const ranked = from(Post, "p").select(({ p }) => ({
    id: p.id,
    authorId: p.authorId,
    rn: rowNumber().over({ partitionBy: [p.authorId], orderBy: [p.views.desc(), p.id] }),
  }));
  const top = from(subquery(ranked), "r")
    .where(({ r }) => r.rn.lte(3))
    .orderBy(({ r }) => [r.authorId, r.rn])
    .select(({ r }) => ({ id: r.id, rank: r.rn }));
  expect(await rows(top)).toEqual([
    { c0: 1, c1: 1 },
    { c0: 3, c1: 2 },
    { c0: 4, c1: 3 },
    { c0: 5, c1: 1 },
    { c0: 6, c1: 1 },
  ]);
});

test("a recursive category tree from its root", async () => {
  const roots = from(Category, "c").where(({ c }) => c.id.eq(1));
  const children = from(Category, "c").join(cte("tree", Category), "t", ({ c, t }) => c.parentId.eq(t.id));
  const tree = from(cte("tree", Category), "t")
    .withCte("tree", roots.unionAll(children), { recursive: true })
    .orderBy(({ t }) => t.id)
    .select(({ t }) => t.name);
  expect((await rows(tree)).map((row) => row.c0)).toEqual(["root", "child a", "child b", "grandchild"]);
});

test("keyset pagination walks every post once, newest first", async () => {
  const page = from(Post, "p")
    .where(({ p }) =>
      tuple(p.createdAt, p.id).lt(
        tuple(param("cursorAt", t.timestamp()), param("cursorId", t.bigint({ mode: "number" }))),
      ),
    )
    .orderBy(({ p }) => [p.createdAt.desc(), p.id.desc()])
    .limit(2)
    .select(({ p }) => ({ id: p.id, createdAt: p.createdAt }));
  const seen: unknown[] = [];
  let cursor = { cursorAt: new Date("2100-01-01T00:00:00Z"), cursorId: 0 };
  for (;;) {
    const batch = await rows(page, cursor);
    if (batch.length === 0) break;
    for (const row of batch) seen.push(row.c0);
    const last = batch[batch.length - 1] as { c0: number; c1: Date };
    cursor = { cursorAt: last.c1, cursorId: last.c0 };
  }
  expect(seen).toEqual([4, 3, 2, 5, 1, 6]);
});

test("rows of typed bound values compare as numbers, not as text", async () => {
  // As text, '10' < '9': the condition would be false and filter every row out.
  const q = from(Post, "p")
    .where(() => tuple(val(10, t.integer()), val(1, t.integer())).gt(tuple(val(9, t.integer()), 0)))
    .select(({ p }) => p.id);
  expect((await rows(q)).length).toBe(6);
  const one = from(Post, "p")
    .where(() => tuple(val(10, t.integer())).gt(tuple(val(9) as never)))
    .select(({ p }) => p.id);
  expect((await rows(one)).length).toBe(6);
});

test("a source over a source reads the middle query's column names, not the inner selectedAs names", async () => {
  const inner = from(Post, "p").select(({ p }) => ({ a: selectedAs(p.id, "zz") }));
  const q = from(subquery(from(subquery(inner), "s")), "m")
    .orderBy(({ m }) => m.a)
    .select(({ m }) => ({ v: m.a }));
  expect((await rows(q)).map((row) => row.c0)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("users with no posts, with not exists", async () => {
  const lonely = from(User, "u")
    .where(({ u }) => not(exists(from(Post, "p").where(({ p }) => p.authorId.eq(u.id)))))
    .select(({ u }) => u.email);
  expect(await rows(lonely)).toEqual([{ c0: "di@example.com" }]);
});

test("bulk publish with returning, then the rows are published", async () => {
  await rolledBack(async () => {
    const publish = from(Post, "p")
      .where(({ p }) => p.authorId.eq(1))
      .where(({ p }) => p.published.not())
      .set(({ p }) => ({ published: true, views: p.views.add(1), tagList: p.tagList.append("republished") }))
      .returning(({ p }) => ({ id: p.id, views: p.views, tags: p.tagList }));
    expect(await rows(publish, undefined, "updateAll")).toEqual([{ c0: 2, c1: 4, c2: ["republished"] }]);
    const left = from(Post, "p")
      .where(({ p }) => p.published.not())
      .select(({ p }) => p.id);
    expect(await rows(left)).toEqual([{ c0: 6 }]);
  });
});

test("set: an untyped CASE is refused for a uuid column; a typed one runs on Postgres", async () => {
  // Without a type the database reads the CASE as text: "column is of type uuid but
  // expression is of type text". It is refused when the query is built instead.
  const untyped = () =>
    from(Membership, "m").set(() => ({
      orgId: caseWhen(lit(true), "00000000-0000-0000-0000-000000000000") as never,
    }));
  expect(untyped).toThrow(/set\(\{ orgId \}\) was given a value with no type/);
  await rolledBack(async () => {
    const [org] = await handle.db.query<{ id: string }>(
      "INSERT INTO orgs (name) VALUES ('Beta') RETURNING id",
    );
    const moved = org?.id as string;
    await handle.db.query("INSERT INTO orgs (id, name) SELECT gen_random_uuid(), 'Gamma'");
    const [first] = await handle.db.query<{ id: string }>("SELECT id FROM orgs WHERE name = 'Gamma'");
    await handle.db.query("INSERT INTO memberships (org_id, user_id) VALUES ($1, 1)", [first?.id]);
    const typed = from(Membership, "m")
      .where(({ m }) => m.userId.eq(1))
      .set(({ m }) => ({ orgId: caseWhen(m.userId.eq(1), val(moved, t.uuid())).else(m.orgId) }))
      .returning(({ m }) => m.orgId);
    expect(await rows(typed, undefined, "updateAll")).toEqual([{ c0: moved }]);
    // A CASE of NULLs only needs a type too; with one it runs.
    const clear = from(Post, "p")
      .where(({ p }) => p.id.eq(1))
      .set(({ p }) => ({ body: caseWhen(p.published, val(null, t.string().nullable())).else(lit(null)) }))
      .returning(({ p }) => p.body);
    expect(await rows(clear, undefined, "updateAll")).toEqual([{ c0: null }]);
  });
});

test("a delete with a join returns the rows it deleted", async () => {
  await rolledBack(async () => {
    const drop = from(Post, "p")
      .join(User, "u", ({ p, u }) => p.authorId.eq(u.id))
      .where(({ u }) => u.email.eq("cy@example.com"))
      .returning(({ p }) => p.id);
    expect(await rows(drop, undefined, "deleteAll")).toEqual([{ c0: 6 }]);
  });
});

test("set operations combine rows, and the combined rows are ordered and limited", async () => {
  const authors = from(Post, "p").select(({ p }) => ({ id: p.authorId }));
  const everyone = from(User, "u").select(({ u }) => ({ id: u.id }));
  expect((await rows(everyone.except(authors).orderBy(({ u }) => u.id))).map((r) => r.c0)).toEqual([4]);
  expect(
    (
      await rows(
        everyone
          .intersect(authors)
          .orderBy(({ u }) => u.id)
          .limit(2),
      )
    ).map((r) => r.c0),
  ).toEqual([1, 2]);
  expect((await rows(authors.unionAll(authors))).length).toBe(12);
});

test("a scalar subquery counts each user's posts", async () => {
  const counted = from(User, "u")
    .orderBy(({ u }) => u.id)
    .select(({ u }) => ({
      id: u.id,
      posts: scalar(
        from(Post, "p")
          .where(({ p }) => p.authorId.eq(u.id))
          .select(() => count()),
      ),
    }));
  expect(await rows(counted)).toEqual([
    { c0: 1, c1: 4 },
    { c0: 2, c1: 1 },
    { c0: 3, c1: 1 },
    { c0: 4, c1: 0 },
  ]);
});

test("named parameters on both sides of a subquery bind, and the plan is reused for other values", async () => {
  const inner = from(Post, "p")
    .where(({ p }) => p.views.gte(param("minViews", t.integer())))
    .groupBy(({ p }) => p.authorId)
    .select(({ p }) => ({ authorId: p.authorId, total: sum(p.views) }));
  const outer = from(User, "u")
    .join(subquery(inner), "s", ({ u, s }) => s.authorId.eq(u.id))
    .where(({ u }) => u.age.gte(param("minAge", t.integer())))
    .orderBy(({ u }) => u.id)
    .select(({ u, s }) => ({ id: u.id, total: s.total }));
  const before = compiler.stats();
  expect(await rows(outer, { minViews: 5, minAge: 18 })).toEqual([{ c0: 1, c1: 177 }]);
  expect(await rows(outer, { minViews: 0, minAge: 10 })).toEqual([
    { c0: 1, c1: 180 },
    { c0: 2, c1: 9 },
    { c0: 3, c1: 0 },
  ]);
  const after = compiler.stats();
  expect(after.misses - before.misses).toBe(1);
  expect(after.hits - before.hits).toBeGreaterThanOrEqual(1);
});

test("a prepared query keeps one plan for every set of values", async () => {
  const byEmail = prepare(
    from(User, "u")
      .where(({ u }) => u.email.eq(param("email", t.string())))
      .select(({ u }) => u.name),
  );
  const run = async (email: string) => {
    const plan = byEmail.plan(compiler, "all", undefined);
    return handle.db.query(plan.sql, bindParams(plan.slots, byEmail.ast.params, { email }));
  };
  expect(await run("ann@example.com")).toEqual([{ c0: "Ann" }]);
  expect(await run("di@example.com")).toEqual([{ c0: "Di" }]);
  expect(byEmail.plan(compiler)).toBe(byEmail.plan(compiler, "all", undefined));
});

test("dynamic filters and a column chosen at run time", async () => {
  const filters = [
    dynamic<{ u: typeof User }>(({ u }) => u.age.gte(18)),
    dynamic<{ u: typeof User }>(({ u }) => u.role.eq("member")),
  ];
  const sortColumn: string = "email";
  const q = from(User, "u")
    .where(filters.reduce((acc, f) => acc.and(f), dynamic.true()))
    .orderBy(({ u }) => field(u, sortColumn).desc())
    .select(({ u }) => u.id);
  expect(await rows(q)).toEqual([{ c0: 4 }, { c0: 3 }]);
});
