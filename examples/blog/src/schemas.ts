// src/schemas.ts: the blog's tables as schema classes. The tutorial includes each region.
import { belongsTo, cast, hasMany, Schema, t, timestamps } from "egon-orm";

// #region user
export class User extends Schema("users", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(), // bigserial: the database makes it
  email: t.string(),
  name: t.string(),
  password: t.string().virtual().redact(), // in changesets only: never stored, never logged
  passwordHash: t.string().redact(), //       hidden from logs, errors and JSON
  ...timestamps(), //                    createdAt, updatedAt
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });
}
// #endregion user

// #region post
export class Post extends Schema("posts", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  authorId: t.bigint({ mode: "number" }),
  title: t.string(),
  body: t.string(),
  publishedAt: t.timestamp().nullable(),
  ...timestamps(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
  // Comments that a form leaves out are deleted when the post is saved.
  static comments = hasMany(() => Comment, {
    foreignKey: "postId",
    orderBy: ["createdAt"],
    onReplace: "delete",
  });

  static changeset(post: Post | typeof Post, params: unknown) {
    return cast(post, params, ["title", "body"])
      .validateRequired(["title", "body"])
      .validateLength("title", { max: 200 });
  }

  get isPublished(): boolean {
    return this.publishedAt !== null;
  }
}
// #endregion post

// #region comment
export class Comment extends Schema("comments", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  postId: t.bigint({ mode: "number" }),
  authorName: t.string(),
  body: t.string(),
  ...timestamps(),
}) {
  static post = belongsTo(() => Post, { foreignKey: "postId" });

  static changeset(comment: Comment | typeof Comment, params: unknown) {
    return cast(comment, params, ["authorName", "body"])
      .validateRequired(["authorName", "body"])
      .validateLength("body", { max: 2000 });
  }
}
// #endregion comment

// #region follow
export class Subscription extends Schema("subscriptions", {
  readerId: t.bigint({ mode: "number" }).primaryKey(), // a composite key: both are given, not generated
  authorId: t.bigint({ mode: "number" }).primaryKey(),
}) {}

export class Notification extends Schema("notifications", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  userId: t.bigint({ mode: "number" }),
  postId: t.bigint({ mode: "number" }),
  readAt: t.timestamp().nullable(),
  ...timestamps(),
}) {}
// #endregion follow
