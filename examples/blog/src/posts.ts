// src/posts.ts: writing, reading and moderating posts. The tutorial includes each region.
import { count, from, type Loaded } from "egon-orm";
import { repo } from "./db.js";
import { Post, type User } from "./schemas.js";

// #region write
export function createPost(author: User, params: unknown) {
  // The author comes from the session, never from the form: it is set, not cast.
  return repo.insert(Post.changeset(Post, params).putChange("authorId", author.id));
}

export function updatePost(post: Post, params: unknown) {
  return repo.update(Post.changeset(post, params));
}
// #endregion write

// #region feed
// A query is a value: build it once, reuse it, extend it.
export const published = from(Post, "p").where(({ p }) => p.publishedAt.isNotNull());

export function feed(page: number, perPage = 10) {
  return repo.all(
    published
      .orderBy(({ p }) => p.publishedAt.desc())
      .limit(perPage)
      .offset((page - 1) * perPage)
      .preload("author"), // one more query for every author on the page, not one per post
  );
}
// #endregion feed

// #region post-page
export async function postPage(id: number) {
  const post = await repo.one(published.where({ id }).preload(["author", "comments"]));
  return post; // Loaded<typeof Post, "author" | "comments"> | null
}

export function render(post: Loaded<typeof Post, "author" | "comments">): string {
  return [
    `${post.title}, by ${post.author.name}`,
    ...post.comments.map((c) => `  ${c.authorName}: ${c.body}`),
  ].join("\n");
}
// #endregion post-page

// #region stats
export function authorStats() {
  return repo.all(
    from(Post, "p")
      .joinAssoc("p", "author", "u")
      .where(({ p }) => p.publishedAt.isNotNull())
      .groupBy(({ u }) => [u.id, u.name])
      .orderBy(({ p }) => count(p.id).desc())
      .select(({ u, p }) => ({ author: u.name, posts: count(p.id) })),
  ); // { author: string; posts: number }[]
}
// #endregion stats
