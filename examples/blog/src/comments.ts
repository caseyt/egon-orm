// src/comments.ts: adding comments, and the moderation form that edits a post together
// with its comments. The tutorial includes each region.
import { from } from "egon-orm";
import { repo } from "./db.js";
import { Comment, Post } from "./schemas.js";

// #region add
export function addComment(post: Post, params: unknown) {
  return repo.insert(Comment.changeset(Comment, params).putChange("postId", post.id));
}
// #endregion add

// #region moderate
// params: { title, body, comments: [{ id, authorName, body }, …] }
export async function moderate(postId: number, params: unknown) {
  const post = await repo.oneOrThrow(from(Post, "p").where({ id: postId }).preload("comments"));

  const changeset = Post.changeset(post, params).castAssoc("comments"); // uses Comment.changeset
  return repo.update(changeset); // the post and its comments, in one transaction
}
// #endregion moderate
