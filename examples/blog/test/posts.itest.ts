import { change } from "egon-orm";
import { createSandbox, expectQueries } from "egon-orm/testing";
import { afterEach, beforeEach, expect, test } from "vitest";
import { addComment, moderate } from "../src/comments.js";
import { repo } from "../src/db.js";
import { authorStats, createPost, feed, postPage, render } from "../src/posts.js";
import { Comment, Post, User } from "../src/schemas.js";

const sandbox = await createSandbox(repo);
beforeEach(() => sandbox.begin());
afterEach(() => sandbox.rollback());

// #region factory
// test data: insertOrThrow makes a broken fixture fail loudly
function insertUser(name: string) {
  return repo.insertOrThrow(
    change(User, { email: `${name.toLowerCase()}@example.com`, name, passwordHash: "x" }),
  );
}

async function insertPost(author: User, title: string, publishedAt: Date | null = new Date()) {
  return repo.insertOrThrow(change(Post, { authorId: author.id, title, body: `${title}.`, publishedAt }));
}
// #endregion factory

test("creates a post for its author and validates the title", async () => {
  const ada = await insertUser("Ada");

  const created = await createPost(ada, { title: "Hello", body: "First post." });
  expect(created.success && created.data.authorId).toBe(ada.id);

  const invalid = await createPost(ada, { title: "", body: "No title." });
  expect(!invalid.success && invalid.error.errorMessages()).toEqual({ title: ["can't be blank"] });
});

// #region feed-test
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
// #endregion feed-test

test("the post page preloads the author and the comments, oldest first", async () => {
  const ada = await insertUser("Ada");
  const post = await insertPost(ada, "Hello");
  await addComment(post, { authorName: "Bo", body: "First!" });
  await addComment(post, { authorName: "Cy", body: "Second." });

  const page = await postPage(post.id);
  expect(page && render(page)).toBe("Hello, by Ada\n  Bo: First!\n  Cy: Second.");
  expect(await postPage((await insertPost(ada, "Draft", null)).id)).toBeNull();
});

test("author statistics count published posts per author", async () => {
  const ada = await insertUser("Ada");
  const bo = await insertUser("Bo");
  await insertPost(ada, "One");
  await insertPost(ada, "Two");
  await insertPost(bo, "Three");
  await insertPost(bo, "Draft", null);

  expect(await authorStats()).toEqual([
    { author: "Ada", posts: 2 },
    { author: "Bo", posts: 1 },
  ]);
});

// #region moderate-test
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
// #endregion moderate-test

test("an invalid comment keeps the whole form from saving", async () => {
  const ada = await insertUser("Ada");
  const post = await insertPost(ada, "Hello");

  const result = await moderate(post.id, { comments: [{ authorName: "Bo", body: "" }] });

  expect(!result.success && result.error.errorMessages()).toEqual({
    comments: [{ body: ["can't be blank"] }],
  });
  expect(await repo.count(Comment)).toBe(0);
});
