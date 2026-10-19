// Every statement of the SQL snapshot matrices is executed against Postgres, to prove that
// the emitted SQL is valid and that its parameters bind (results are not asserted here;
// the snapshot tests pin the text). Each statement runs in a transaction that is rolled
// back, so writes do not affect the next one.
import { createTestDatabase, type TestDatabaseHandle, User } from "@egon-orm/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { QueryAst } from "../contracts/query.js";
import { caseWhen, coalesce, from, lit, t, val } from "../index.js";
import { bindParams } from "./bind.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { ALL_CASES } from "./sql-cases.js";
import { EXTRA_DDL } from "./sql-fixtures.js";

const SEED = `
INSERT INTO users (id, email, name, age, role, settings) VALUES
  (1, 'ann@example.com', 'Ann', 34, 'admin', '{"theme": "dark", "tags": ["a", "b"]}'),
  (2, 'bo@example.com', NULL, 15, 'member', NULL),
  (3, 'cy@example.com', 'Cy', NULL, 'member', '{"theme": "light"}');
INSERT INTO profiles (user_id, bio) VALUES (1, 'hello');
INSERT INTO posts (id, author_id, title, published, views, tags, published_at) VALUES
  (1, 1, 'First', true, 120, '{ts,orm}', now()),
  (2, 1, 'Second', false, 3, '{sql}', NULL),
  (3, 2, 'Third', true, 7, NULL, NULL);
INSERT INTO comments (post_id, author_id, body) VALUES (1, 2, 'nice'), (2, NULL, 'anon');
INSERT INTO tags (id, name) VALUES (1, 'ts'), (2, 'sql');
INSERT INTO posts_tags (post_id, tag_id) VALUES (1, 1), (2, 2);
INSERT INTO orgs (name) VALUES ('Acme');
INSERT INTO memberships (org_id, user_id) SELECT id, 1 FROM orgs;
INSERT INTO events (name, payload) VALUES ('signup', '{"plan": "free"}');
SELECT setval('users_id_seq', 100), setval('posts_id_seq', 100), setval('tags_id_seq', 100);
`;

let handle: TestDatabaseHandle;

beforeAll(async () => {
  handle = await createTestDatabase("postgres", { label: "compiler", fixtures: ["blog"] });
  await handle.db.exec(EXTRA_DDL);
  await handle.db.exec(SEED);
});

afterAll(async () => {
  await handle?.drop();
});

const compiler = createCompiler(postgresDialect);

for (const [area, cases] of ALL_CASES) {
  describe(`${area} statements run on Postgres`, () => {
    for (const sqlCase of cases) {
      test(sqlCase.name, async () => {
        const plan = sqlCase.compile(compiler);
        const params = bindParams(plan.slots, sqlCase.params, sqlCase.named);
        const db = handle.db;
        await db.query("begin");
        try {
          const rows = await db.query(plan.sql, params);
          expect(Array.isArray(rows)).toBe(true);
        } finally {
          await db.query("rollback");
        }
      });
    }
  });
}

test("a selected value with a type comes back as that type; text without one comes back as text", async () => {
  const q = from(User, "u")
    .select(() => ({ n: val(5, t.integer()), b: val(true, t.boolean()), s: val("x"), none: val(null) }))
    .limit(1);
  const plan = compiler.compile(q.ast, "all", undefined);
  const rows = await handle.db.query(plan.sql, bindParams(plan.slots, q.ast.params));
  expect(rows).toEqual([{ c0: 5, c1: true, c2: "x", c3: null }]);
});

test("a selected coalesce of a typed CASE and a value comes back as the CASE's type", async () => {
  const q = from(User, "u")
    .select(() => ({ n: coalesce(caseWhen(lit(true), val(1, t.integer())), 2) }))
    .limit(1);
  const plan = compiler.compile(q.ast, "all", undefined);
  const rows = await handle.db.query(plan.sql, bindParams(plan.slots, q.ast.params));
  expect(rows).toEqual([{ c0: 1 }]);
});

test("a coalesce with a typed argument compared with an untyped value is true on Postgres", async () => {
  const q = from(User, "u")
    .select(() => ({ same: coalesce(val(1, t.integer()), val(2)).eq(val(1)) }))
    .limit(1);
  const plan = compiler.compile(q.ast, "all", undefined);
  const rows = await handle.db.query(plan.sql, bindParams(plan.slots, q.ast.params));
  expect(rows).toEqual([{ c0: true }]);
});

test("comparisons: a typed side compares numbers, two untyped strings compare as text", async () => {
  const run = async (q: { readonly ast: QueryAst }) => {
    const plan = compiler.compile(q.ast, "all", undefined);
    return handle.db.query(plan.sql, bindParams(plan.slots, q.ast.params));
  };
  // 10 > 9 as numbers; as text it would be false and filter every row out.
  const b: string = "b";
  const numbers = await run(
    from(User, "u")
      .where(() => val(10, t.integer()).gt(9))
      .select(({ u }) => u.id),
  );
  expect(numbers.length).toBe(3);
  const text = await run(
    from(User, "u")
      .where(() => val(b).gt("a"))
      .select(({ u }) => u.id),
  );
  expect(text.length).toBe(3);
});

test("the plan cache shared by every statement above saw no collision", () => {
  expect(compiler.stats().collisions).toBe(0);
  expect(compiler.stats().misses).toBeGreaterThan(100);
});
