// src/publishing.ts: publishing a post and notifying the author's readers, as one batch.
// The tutorial includes each region.
import { change, createBatch, failure, from, success } from "egon-orm";
import { repo } from "./db.js";
import { Notification, type Post, Subscription } from "./schemas.js";

// #region publish
export function publishBatch(post: Post, now: Date = new Date()) {
  return createBatch()
    .run("unpublished", async () => (post.isPublished ? failure("already published") : success(post)))
    .update("post", change(post, { publishedAt: now }))
    .all("readers", from(Subscription, "s").where({ authorId: post.authorId }))
    .insertAll("notifications", Notification, ({ readers }) =>
      readers.map((s) => ({ userId: s.readerId, postId: post.id })),
    );
}

export async function publish(post: Post) {
  const result = await repo.transaction(publishBatch(post));
  if (!result.success) return { failedAt: result.error.step, error: result.error.error };
  return { post: result.data.post, notified: result.data.notifications.count };
}
// #endregion publish
