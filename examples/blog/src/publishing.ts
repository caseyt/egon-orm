// #region imports
// src/publishing.ts: publishing a post and notifying the author's readers, as one batch.
import { change, createBatch, failure, from, success } from "egon-orm";
import { repo } from "./db.js";
import { Notification, Post, Subscription } from "./schemas.js";
// #endregion imports

// #region publish
export function publishBatch(postId: number, now: Date = new Date()) {
  return createBatch()
    .one("post", from(Post, "p").where({ id: postId }).lock("update")) // read again, locked
    .run("unpublished", async (_tx, { post }) =>
      post === null
        ? failure("no such post")
        : post.isPublished
          ? failure("already published")
          : success(post),
    )
    .update("published", ({ unpublished }) => change(unpublished, { publishedAt: now }))
    .all("readers", ({ unpublished }) => from(Subscription, "s").where({ authorId: unpublished.authorId }))
    .insertAll("notifications", Notification, ({ unpublished, readers }) =>
      readers.map((s) => ({ userId: s.readerId, postId: unpublished.id })),
    );
}

export async function publish(postId: number) {
  const result = await repo.transaction(publishBatch(postId));
  if (!result.success) {
    // type: "unpublished" | "published", the steps that can fail
    const failedAt = result.error.step;
    return { published: false, failedAt, error: result.error.error } as const;
  }
  return { published: true, post: result.data.published, notified: result.data.notifications.count } as const;
}
// #endregion publish
