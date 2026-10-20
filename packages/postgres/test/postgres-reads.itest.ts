// Postgres-only read behaviour the shared conformance suite cannot assert on every database:
// explain with format and analyze in one call (MySQL refuses the pair), and where Postgres
// puts NULLs by default in an ascending order (last; SQLite and MySQL put them first).
import { Comment, createTestDatabase, Post, type TestDatabaseHandle, User } from "@egon-orm/test-support";
import { createRepo, from, type Repo } from "egon-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { postgres } from "../src/index.js";

let handle: TestDatabaseHandle;
let repo: Repo;

beforeAll(async () => {
  handle = await createTestDatabase("postgres", { label: "pgreads", fixtures: ["blog"] });
  repo = createRepo({ adapter: postgres({ connectionString: handle.db.url, pool: { max: 2 } }) });
  await handle.db.exec(`
    insert into users (id, email) values (1, 'a@example.com'), (2, 'b@example.com');
    insert into posts (id, author_id, title) values (10, 1, 'ten'), (11, 1, 'eleven'), (12, 2, 'twelve');
    insert into comments (id, post_id, author_id, body) values
      (100, 10, 2, 'x'), (101, 11, 1, 'y'), (102, 12, 1, 'z');
  `);
});

afterAll(async () => {
  await repo?.close();
  await handle?.drop();
});

test("explain takes format and analyze together and returns the structured plan", async () => {
  const json = await repo.explain(from(User, "u").where({ id: 1 }), { format: "json", analyze: true });
  expect(typeof json).toBe("object");
  expect(JSON.stringify(json)).toContain("Actual");
});

test("a full join ordered by a nullable key puts the NULLs last, in the database's own order", async () => {
  const rows = await repo.all(
    from(Post, "p")
      .fullJoin(Comment, "c", ({ p, c }) => c.postId.eq(p.id).and(c.authorId.eq(2)))
      .orderBy(({ p, c }) => [p.id, c.id])
      .select(({ p, c }) => ({ post: p.id, comment: c })),
  );
  expect(rows.map((row) => [row.post, row.comment?.id ?? null])).toEqual([
    [10, 100],
    [11, null],
    [12, null],
    [null, 101],
    [null, 102],
  ]);
});
