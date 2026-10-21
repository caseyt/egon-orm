// test/pages.itest.ts: more tests of the blog, beyond the ones the tutorial shows.
import { createSandbox } from "egon-orm/testing";
import { afterEach, beforeEach, expect, test } from "vitest";
import { addComment, moderate } from "../src/comments.js";
import { repo } from "../src/db.js";
import { authorStats, createPost, postPage, render } from "../src/posts.js";
import { Comment } from "../src/schemas.js";
import { insertPost, insertUser } from "./factories.js";

const sandbox = await createSandbox(repo);
beforeEach(() => sandbox.begin());
afterEach(() => sandbox.rollback());

test("creates a post for its author and validates the title", async () => {
  const ada = await insertUser("Ada");

  const created = await createPost(ada, { title: "Hello", body: "First post." });
  expect(created.success && created.data.authorId).toBe(ada.id);

  const invalid = await createPost(ada, { title: "", body: "No title." });
  expect(!invalid.success && invalid.error.errorMessages()).toEqual({ title: ["can't be blank"] });
});

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

test("an invalid comment keeps the whole form from saving", async () => {
  const ada = await insertUser("Ada");
  const post = await insertPost(ada, "Hello");

  const result = await moderate(post.id, { comments: [{ authorName: "Bo", body: "" }] });

  expect(!result.success && result.error.errorMessages()).toEqual({
    comments: [{ body: ["can't be blank"] }],
  });
  expect(await repo.count(Comment)).toBe(0);
});
