// Postgres-only read behaviour the shared conformance suite cannot assert on every database:
// explain with format and analyze in one call (MySQL refuses the pair), where Postgres
// puts NULLs by default in an ascending order (last; SQLite and MySQL put them first), and
// that pg reads a bigint or numeric column as text, which a t.integer() or t.float() field
// refuses.
import { Comment, createTestDatabase, Post, type TestDatabaseHandle, User } from "@egon-orm/test-support";
import { CastError, change, createRepo, from, type Repo, Schema, t } from "egon-orm";
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

// The blog keys are bigserial (int8), which pg sends as text; posts.views is an integer.
class LooseUser extends Schema("users", { id: t.integer().primaryKey().dbGenerated(), email: t.string() }) {}
class LoosePost extends Schema("posts", {
  id: t.bigint({ mode: "number" }).primaryKey(),
  views: t.integer(),
}) {}

test("a t.integer() field over a bigint column throws a CastError instead of holding a string", async () => {
  const read = repo.all(from(LooseUser, "u").orderBy(({ u }) => u.id));
  await expect(read).rejects.toThrow(CastError);
  await expect(repo.all(from(LooseUser, "u"))).rejects.toThrow(
    "LooseUser.id is declared t.integer(), but the database returned a string for it, not a number: the column or expression is not of an integer type (Postgres reads bigint, bigserial and numeric columns as text; MySQL's / returns a decimal). Declare the field t.bigint({ mode: \"number\" }) for a 64-bit integer column, or t.decimal() for a decimal, or change the column's type.",
  );
  // A selected column is checked too, named by its key.
  await expect(repo.all(from(LooseUser, "u").select(({ u }) => ({ key: u.id })))).rejects.toThrow(
    '"key" is declared t.integer(), but the database returned a string',
  );
  // An integer column read into t.integer() or t.float() is a number.
  expect(
    await repo.all(
      from(LooseUser, "u")
        .select(({ u }) => u.email)
        .orderBy(({ u }) => u.email),
    ),
  ).toEqual(["a@example.com", "b@example.com"]);
  expect((await repo.all(from(LoosePost, "p").orderBy(({ p }) => p.id))).map((post) => post.views)).toEqual([
    0, 0, 0,
  ]);
});

test("a t.float() field over a numeric column throws a CastError; t.decimal() or a cast reads it", async () => {
  await handle.db.exec(`
    create table measures (id integer primary key, amount numeric(10, 2) not null, ratio double precision not null);
    insert into measures values (1, 1.50, 0.5);
  `);
  class Measure extends Schema("measures", {
    id: t.integer().primaryKey(),
    amount: t.float(),
    ratio: t.float(),
  }) {}
  class ExactMeasure extends Schema("measures", { id: t.integer().primaryKey(), amount: t.decimal() }) {}
  await expect(repo.all(from(Measure, "m"))).rejects.toThrow(
    "Measure.amount is declared t.float(), but the database returned a string for it, not a number: the column or expression is not of a floating-point type (Postgres reads numeric columns as text). Declare the field t.decimal() for a decimal column, or change the column's type.",
  );
  expect((await repo.all(from(ExactMeasure, "m"))).map((m) => m.amount)).toEqual(["1.50"]);
  const asFloat = from(ExactMeasure, "m").select(({ m }) => ({ amount: m.amount.cast(t.float()) }));
  expect(await repo.all(asFloat)).toEqual([{ amount: 1.5 }]);
});

test("a write whose returned key fails to decode throws after the row is written, naming the schema", async () => {
  // The documented consequence of the check (status 03, owner row 2): outside a transaction
  // the insert stays; the error says so.
  // The seed rows took ids 1 and 2 explicitly: move the sequence past them.
  await handle.db.exec("select setval('users_id_seq', 100)");
  const insert = repo.insert(change(LooseUser, { email: "written@example.com" }));
  await expect(insert).rejects.toThrow(
    /^LooseUser\.id is declared t\.integer\(\).* The write itself was applied: outside a transaction it stays/,
  );
  await expect(
    repo.insertAll(LooseUser, [{ email: "bulk@example.com" }], { returning: true }),
  ).rejects.toThrow(/^LooseUser\.id is declared t\.integer\(\)/);
  const emails = await repo.all(
    from(User, "u")
      .where(({ u }) => u.email.in(["written@example.com", "bulk@example.com"]))
      .select(({ u }) => u.email)
      .orderBy(({ u }) => u.email),
  );
  expect(emails).toEqual(["bulk@example.com", "written@example.com"]);
  // Inside a transaction the error rolls the write back.
  await expect(
    repo.transaction(async (tx) => tx.insert(change(LooseUser, { email: "rolled@example.com" }))),
  ).rejects.toThrow(CastError);
  expect(await repo.count(from(User, "u").where({ email: "rolled@example.com" }))).toBe(0);
});
