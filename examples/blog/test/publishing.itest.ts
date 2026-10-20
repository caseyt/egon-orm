// #region header
// test/publishing.itest.ts
import { Batch, change } from "egon-orm";
import { createSandbox } from "egon-orm/testing";
import { afterEach, beforeEach, expect, test } from "vitest";
import { repo } from "../src/db.js";
import { publish, publishBatch } from "../src/publishing.js";
import { Notification, Post, Subscription, User } from "../src/schemas.js";

// Every test file sets up its own sandbox.
const sandbox = await createSandbox(repo);
beforeEach(() => sandbox.begin());
afterEach(() => sandbox.rollback());

// An author, two readers who follow her, and a draft of hers.
async function setUp() {
  const user = (name: string) =>
    repo.insertOrThrow(change(User, { email: `${name.toLowerCase()}@example.com`, name, passwordHash: "x" }));
  const ada = await user("Ada");
  const bo = await user("Bo");
  const cy = await user("Cy");
  await repo.insertAll(Subscription, [
    { readerId: bo.id, authorId: ada.id },
    { readerId: cy.id, authorId: ada.id },
  ]);
  const draft = await repo.insertOrThrow(change(Post, { authorId: ada.id, title: "Hello", body: "Hi." }));
  return { ada, bo, cy, draft };
}
// #endregion header

test("publishing sets publishedAt and notifies every reader of the author", async () => {
  const { bo, cy, draft } = await setUp();

  const result = await publish(draft.id);

  expect(result).toMatchObject({ notified: 2 });
  expect((await repo.getOrThrow(Post, draft.id)).publishedAt).toBeInstanceOf(Date);
  const notified = (await repo.all(Notification)).map((n) => n.userId).sort();
  expect(notified).toEqual([bo.id, cy.id].sort());
});

test("publishing twice fails at the guard and writes nothing more", async () => {
  const { draft } = await setUp();
  await publish(draft.id);

  // `draft` still says "not published": the batch reads the post again, so it is not fooled.
  expect(await publish(draft.id)).toEqual({ failedAt: "unpublished", error: "already published" });
  expect(await repo.count(Notification)).toBe(2);
});

// #region batch-test
test("the batch is a value: its steps can be checked without running it", async () => {
  const { draft } = await setUp();

  const steps = Batch.toList(publishBatch(draft.id)).map((s) => `${s.name}:${s.operation}`);

  expect(steps).toEqual([
    "post:one",
    "unpublished:run",
    "published:update",
    "readers:all",
    "notifications:insertAll",
  ]);
});
// #endregion batch-test
