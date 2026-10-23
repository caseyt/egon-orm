// Scenarios that cross features built in different steps, against Postgres: a nested insert
// in a Batch in a savepoint that fails on its deepest child, a has-through preload in a
// transaction right after bulk inserts, one prepared query with a named parameter run by 50
// tasks at once, and a stream of a million rows in constant memory. Each test has a
// database of its own.

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Comment, Post, Tag, type TestDatabase, User, withDatabase } from "@egon-orm/test-support";
import {
  type Changeset,
  ConstraintError,
  cast,
  change,
  createBatch,
  createRepo,
  from,
  param,
  prepare,
  type Repo,
  Schema,
  t,
} from "egon-orm";
import { expect, test } from "vitest";
import { postgres } from "../src/index.js";

async function withRepo(db: TestDatabase, max: number, fn: (repo: Repo) => Promise<void>): Promise<void> {
  const repo = createRepo({ adapter: postgres({ connectionString: db.url, pool: { max } }) });
  try {
    await fn(repo);
  } finally {
    await repo.close();
  }
}

// --- A nested insert in a Batch in a savepoint --------------------------------------------

/** A user with posts with comments, from form input; a comment's author must exist. */
function signUpWithPosts(params: unknown) {
  return cast(User, params, ["email"])
    .validateRequired(["email"])
    .castAssoc("posts", {
      with: (post, postParams) =>
        cast(post, postParams, ["title"])
          .validateRequired(["title"])
          .castAssoc("comments", {
            with: (comment, commentParams) =>
              cast(comment, commentParams, ["body", "authorId"])
                .validateRequired(["body"])
                .foreignKeyConstraint("authorId"),
          }),
    });
}

const formWithBadDeepComment = (existingUserId: number) => ({
  email: "new@example.com",
  posts: [
    { title: "first", comments: [{ body: "fine", authorId: existingUserId }] },
    {
      title: "second",
      comments: [
        { body: "also fine", authorId: existingUserId },
        { body: "by nobody", authorId: 999_999 },
      ],
    },
  ],
});

async function counts(db: TestDatabase): Promise<Record<string, number>> {
  const [row] = await db.query<{ users: string; posts: string; comments: string; tags: string }>(
    `select (select count(*) from users) as users, (select count(*) from posts) as posts,
            (select count(*) from comments) as comments, (select count(*) from tags) as tags`,
  );
  return {
    users: Number(row?.users),
    posts: Number(row?.posts),
    comments: Number(row?.comments),
    tags: Number(row?.tags),
  };
}

test("a deep child's foreign-key violation in a nested insert fails the batch in its savepoint, and the outer transaction commits", () =>
  withDatabase("postgres", { label: "seambatch", fixtures: ["blog"] }, async (db) => {
    const [existing] = await db.query<{ id: string }>(
      "insert into users (email) values ('existing@example.com') returning id",
    );
    await withRepo(db, 2, async (repo) => {
      const outcome = await repo.transactionOrThrow(async (tx) => {
        await tx.insertOrThrow(change(Tag, { name: "before" }));
        // A transaction inside a transaction is a savepoint.
        const result = await tx.transaction(
          createBatch()
            .insert("user", signUpWithPosts(formWithBadDeepComment(Number(existing?.id))))
            .insert("tag", () => change(Tag, { name: "never" })),
        );
        await tx.insertOrThrow(change(Tag, { name: "after" }));
        return result;
      });

      expect(outcome.success).toBe(false);
      if (outcome.success) return;
      expect(outcome.error.step).toBe("user");
      expect(Object.keys(outcome.error.completed)).toEqual([]);
      const changeset = outcome.error.error as Changeset<typeof User, true>;
      expect(changeset.valid).toBe(false);
      // The error sits on the second comment of the second post, nowhere else.
      expect(changeset.errorMessages()).toEqual({
        posts: [{}, { comments: [{}, { authorId: ["does not exist"] }] }],
      });
      // The savepoint undid the user, both posts and the comments inserted before the
      // failing one; the outer transaction kept its own two rows.
      expect(await counts(db)).toEqual({ users: 1, posts: 0, comments: 0, tags: 2 });
    });
  }));

test("without a declared constraint the deep violation throws a ConstraintError out of the savepoint, and the outer transaction still commits", () =>
  withDatabase("postgres", { label: "seambatchthrow", fixtures: ["blog"] }, async (db) => {
    const [existing] = await db.query<{ id: string }>(
      "insert into users (email) values ('existing@example.com') returning id",
    );
    const undeclared = (params: unknown) =>
      cast(User, params, ["email"]).castAssoc("posts", {
        with: (post, postParams) =>
          cast(post, postParams, ["title"]).castAssoc("comments", {
            with: (comment, commentParams) => cast(comment, commentParams, ["body", "authorId"]),
          }),
      });
    await withRepo(db, 2, async (repo) => {
      let thrown: unknown;
      await repo.transactionOrThrow(async (tx) => {
        try {
          await tx.transactionOrThrow(
            createBatch().insert("user", undeclared(formWithBadDeepComment(Number(existing?.id)))),
          );
        } catch (error) {
          thrown = error;
        }
        await tx.insertOrThrow(change(Tag, { name: "after" }));
      });
      expect(thrown).toBeInstanceOf(ConstraintError);
      const error = thrown as ConstraintError;
      // A violation no changeset declared: the error names the constraint and links its entry.
      expect(error.id).toBe("constraint.undeclared");
      expect(error.constraint).toBe("comments_author_id_fkey");
      expect(error.message).toContain("comments_author_id_fkey");
      expect(error.message).toContain("reference/errors/constraint#constraint-undeclared");
      expect(await counts(db)).toEqual({ users: 1, posts: 0, comments: 0, tags: 1 });
    });
  }));

// --- A has-through preload in a transaction after bulk inserts ----------------------------

test("a has-through preload inside a transaction sees the rows that transaction just bulk-inserted", () =>
  withDatabase("postgres", { label: "seampreload", fixtures: ["blog"] }, async (db) => {
    await withRepo(db, 2, async (repo) => {
      await repo.transactionOrThrow(async (tx) => {
        const users = await tx.insertAll(User, [{ email: "a@example.com" }, { email: "b@example.com" }], {
          returning: true,
        });
        const [a, b] = users.rows;
        if (a === undefined || b === undefined) throw new Error("two users were inserted");
        const posts = await tx.insertAll(
          Post,
          [
            { authorId: a.id, title: "a1" },
            { authorId: a.id, title: "a2" },
            { authorId: b.id, title: "b1" },
          ],
          { returning: true },
        );
        const [a1, a2, b1] = posts.rows;
        if (a1 === undefined || a2 === undefined || b1 === undefined) throw new Error("three posts");
        await tx.insertAll(Comment, [
          { postId: a1.id, body: "on a1" },
          { postId: a2.id, body: "on a2" },
          { postId: a2.id, body: "also on a2" },
          { postId: b1.id, body: "on b1" },
        ]);

        // Through `posts`, then `comments`: two queries, both on the transaction's connection.
        const loaded = await tx.preload(User, users.rows, "comments");
        expect(loaded.map((user) => user.comments.map((c) => c.body).sort())).toEqual([
          ["also on a2", "on a1", "on a2"],
          ["on b1"],
        ]);
        const viaQuery = await tx.all(
          from(User, "u")
            .orderBy(({ u }) => u.id)
            .preload("comments"),
        );
        expect(viaQuery.map((user) => user.comments.length)).toEqual([3, 1]);
      });
      // Outside the transaction, after its commit, the same preload agrees.
      const after = await repo.all(
        from(User, "u")
          .orderBy(({ u }) => u.id)
          .preload("comments"),
      );
      expect(after.map((user) => user.comments.length)).toEqual([3, 1]);
    });
  }));

// --- One prepared query, 50 concurrent tasks ----------------------------------------------

test("one prepared query with a named parameter gives each of 50 concurrent tasks its own rows", () =>
  withDatabase("postgres", { label: "seamprepared", fixtures: ["blog"] }, async (db) => {
    await db.exec(`
      insert into users (email, age)
      select 'user' || g || '@example.com', g from generate_series(1, 50) as g;
    `);
    const byEmail = prepare(
      from(User, "u")
        .where(({ u }) => u.email.eq(param("email", t.string())))
        .select(({ u }) => ({ email: u.email, age: u.age })),
    );
    const olderThan = prepare(
      from(User, "u")
        .where(({ u }) => u.age.gt(param("age", t.integer())))
        .orderBy(({ u }) => u.age),
    );
    // A pool smaller than the number of tasks, so that tasks wait for connections.
    await withRepo(db, 5, async (repo) => {
      const before = repo.planCacheStats();
      // Evidence that the tasks overlapped: the most connections checked out at once and the
      // most callers waiting for one, sampled on every turn of the event loop while they run.
      let busiest = 0;
      let mostWaiting = 0;
      let running = true;
      const sample = (): void => {
        const stats = repo.poolStats();
        busiest = Math.max(busiest, stats.size - stats.idle);
        mostWaiting = Math.max(mostWaiting, stats.waiting);
        if (running) setImmediate(sample);
      };
      setImmediate(sample);
      const tasks = Array.from({ length: 50 }, async (_, i) => {
        const n = i + 1;
        const [rows, older] = await Promise.all([
          repo.all(byEmail, { email: `user${n}@example.com` }),
          repo.count(olderThan, { age: n }),
        ]);
        return { n, rows, older };
      });
      const results = await Promise.all(tasks).finally(() => {
        running = false;
      });
      expect(busiest).toBeGreaterThan(1);
      expect(mostWaiting).toBeGreaterThan(0);
      // And on the server: the pool opened more than one session for this database.
      const [sessions] = await db.query<{ count: string }>(
        "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()",
      );
      expect(Number(sessions?.count)).toBeGreaterThan(1);
      for (const { n, rows, older } of results) {
        expect(rows).toEqual([{ email: `user${n}@example.com`, age: n }]);
        expect(older).toBe(50 - n);
      }
      // Two plans compiled (one per prepared query), every other run a cache hit. The cache
      // is shared by the adapters of one configuration, so the counters are compared with
      // their values before the tasks.
      const after = repo.planCacheStats();
      expect(after.misses - before.misses).toBe(2);
      expect(after.hits - before.hits).toBe(98);
    });
  }));

// --- A million rows, streamed in constant memory ------------------------------------------

/**
 * The number of rows. A million by default: about 3 s on a laptop and about 10 s on a CI
 * runner, the generation of the rows included;
 * `EGON_TEST_STREAM_ROWS` sets another number, for a slow machine or a longer soak.
 */
const STREAM_ROWS = Number(process.env.EGON_TEST_STREAM_ROWS ?? 1_000_000);

class Reading extends Schema("readings", {
  id: t.integer().primaryKey(),
  sensor: t.string(),
  value: t.float(),
  takenAt: t.timestamp(),
}) {}

/** A full garbage collection, so that `heapUsed` counts only what is still referenced. */
function collectGarbage(): () => void {
  setFlagsFromString("--expose-gc");
  return runInNewContext("gc") as () => void;
}

test(`a stream of ${STREAM_ROWS} rows keeps memory flat`, { timeout: 300_000 }, () =>
  withDatabase("postgres", { label: "seamstream" }, async (db) => {
    await db.exec(`
        create table readings (id integer primary key, sensor text not null, value double precision not null,
                               taken_at timestamptz not null);
        insert into readings
        select g, 'sensor-' || (g % 100), g * 0.5, timestamptz '2026-01-01' + g * interval '1 second'
        from generate_series(1, ${STREAM_ROWS}) as g;
      `);
    const gc = collectGarbage();
    await withRepo(db, 1, async (repo) => {
      const checkpoints: number[] = [];
      const every = Math.max(1, Math.floor(STREAM_ROWS / 10));
      let count = 0;
      let lastId = 0;
      let sum = 0;
      gc();
      const baseline = process.memoryUsage().heapUsed;
      for await (const reading of repo.stream(
        from(Reading, "r").orderBy(({ r }) => r.id),
        { batchSize: 1_000 },
      )) {
        count += 1;
        lastId = reading.id;
        sum += reading.value;
        if (count % every === 0) {
          gc();
          checkpoints.push(process.memoryUsage().heapUsed - baseline);
        }
      }
      expect(count).toBe(STREAM_ROWS);
      expect(lastId).toBe(STREAM_ROWS);
      expect(sum).toBe((STREAM_ROWS * (STREAM_ROWS + 1)) / 4);
      // Kept rows would cost well over 100 bytes each (four fields, a Date, a string); after
      // a full collection the heap may hold a batch or two and the plan, never the rows read.
      const limit = 16 * 1024 * 1024;
      expect(checkpoints.length).toBeGreaterThanOrEqual(10);
      for (const used of checkpoints) expect(used).toBeLessThan(limit);
      // And it does not grow from the first tenth to the end.
      const first = checkpoints[0] ?? 0;
      const last = checkpoints[checkpoints.length - 1] ?? 0;
      expect(last - first).toBeLessThan(4 * 1024 * 1024);
    });
  }),
);
