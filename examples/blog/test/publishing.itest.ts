import { Batch, change } from "egon-orm";
import { createSandbox } from "egon-orm/testing";
import { afterEach, beforeEach, expect, test } from "vitest";
import { repo } from "../src/db.js";
import { publish, publishBatch } from "../src/publishing.js";
import { Notification, Post, Subscription, User } from "../src/schemas.js";

const sandbox = await createSandbox(repo);
beforeEach(() => sandbox.begin());
afterEach(() => sandbox.rollback());

async function setUp() {
  const [ada, bo, cy] = await Promise.all(
    ["Ada", "Bo", "Cy"].map((name) =>
      repo.insertOrThrow(
        change(User, { email: `${name.toLowerCase()}@example.com`, name, passwordHash: "x" }),
      ),
    ),
  );
  if (ada === undefined || bo === undefined || cy === undefined) throw new Error("users not created");
  await repo.insertAll(Subscription, [
    { readerId: bo.id, authorId: ada.id },
    { readerId: cy.id, authorId: ada.id },
  ]);
  const draft = await repo.insertOrThrow(change(Post, { authorId: ada.id, title: "Hello", body: "Hi." }));
  return { ada, bo, cy, draft };
}

test("publishing sets publishedAt and notifies every reader of the author", async () => {
  const { bo, cy, draft } = await setUp();

  const result = await publish(draft);

  expect(result).toMatchObject({ notified: 2 });
  expect((await repo.getOrThrow(Post, draft.id)).publishedAt).toBeInstanceOf(Date);
  const notified = (await repo.all(Notification)).map((n) => n.userId).sort();
  expect(notified).toEqual([bo.id, cy.id].sort());
});

test("publishing twice fails at the first step and writes nothing", async () => {
  const { draft } = await setUp();
  const first = await publish(draft);
  if (!("post" in first) || first.post === undefined) throw new Error("not published");

  expect(await publish(first.post)).toEqual({ failedAt: "unpublished", error: "already published" });
  expect(await repo.count(Notification)).toBe(2);
});

// #region batch-test
test("the batch is a value: its steps can be checked without a database", async () => {
  const { draft } = await setUp();

  const steps = Batch.toList(publishBatch(draft)).map((s) => `${s.name}:${s.operation}`);

  expect(steps).toEqual(["unpublished:run", "post:update", "readers:all", "notifications:insertAll"]);
});
// #endregion batch-test
