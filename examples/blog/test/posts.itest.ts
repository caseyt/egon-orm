// #region file
// test/posts.itest.ts: every test file sets up its own sandbox, as accounts.itest.ts does.
import { change } from "egon-orm";
import { createSandbox, expectQueries } from "egon-orm/testing";
import { afterEach, beforeEach, expect, test } from "vitest";
import { moderate } from "../src/comments.js";
import { repo } from "../src/db.js";
import { feed } from "../src/posts.js";
import { Comment } from "../src/schemas.js";
import { insertPost, insertUser } from "./factories.js";

const sandbox = await createSandbox(repo);
beforeEach(() => sandbox.begin());
afterEach(() => sandbox.rollback());

test("the feed loads a page of posts and their authors in two queries", async () => {
  const ada = await insertUser("Ada");
  const bo = await insertUser("Bo");
  for (const title of ["One", "Two", "Three"]) await insertPost(ada, title);
  await insertPost(bo, "Four");
  await insertPost(bo, "Draft", null); // not published: not in the feed

  const queries = await expectQueries(repo, async () => {
    const page = await feed(1, 3);
    expect(page.map((p) => p.author.name)).toHaveLength(3);
  });
  expect(queries).toHaveLength(2); // the posts, then their authors: never one per post
});

test("moderation edits a comment, deletes one and adds one, in one transaction", async () => {
  const ada = await insertUser("Ada");
  const post = await insertPost(ada, "Hello");
  const keep = await repo.insertOrThrow(
    change(Comment, { postId: post.id, authorName: "Bo", body: "Fisrt!" }),
  );
  await repo.insertOrThrow(change(Comment, { postId: post.id, authorName: "Spam", body: "Buy now" }));

  const result = await moderate(post.id, {
    title: "Hello, world",
    comments: [
      { id: keep.id, authorName: "Bo", body: "First!" }, // matched by id: an update
      { authorName: "Ada", body: "Thanks, Bo." }, //       no id: an insert
    ], //                                                  the spam is left out: deleted (onReplace)
  });

  expect(result.success).toBe(true);
  const comments = await repo.all(Comment);
  expect(comments.map((c) => c.body).sort()).toEqual(["First!", "Thanks, Bo."]);
});
// #endregion file
