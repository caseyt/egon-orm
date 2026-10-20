// The checked sources of the code blocks in guide/nested-changesets.md. Each `#region` is
// included in the page by name; everything outside a region is the scaffolding that makes
// the regions compile.
import {
  belongsTo,
  buildAssoc,
  type Changeset,
  cast,
  change,
  createBatch,
  from,
  hasMany,
  isLoaded,
  manyToMany,
  type Repo,
  Schema,
  success,
  t,
} from "egon-orm";
import { z } from "zod";

declare const repo: Repo;
declare const params: unknown;

class User extends Schema("users", { id: t.integer().primaryKey().dbGenerated(), email: t.string() }) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });
}

class Tag extends Schema("tags", { id: t.integer().primaryKey().dbGenerated(), name: t.string() }) {}

// #region define
class Comment extends Schema("comments", {
  id: t.integer().primaryKey().dbGenerated(),
  postId: t.integer(),
  body: t.string(),
}) {
  static post = belongsTo(() => Post, { foreignKey: "postId" });

  static changeset(comment: Comment | typeof Comment, params: unknown) {
    return cast(comment, params, ["body"]).validateRequired(["body"]);
  }
}

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
}) {
  // Comments left out of a submitted form are deleted.
  static comments = hasMany(() => Comment, { foreignKey: "postId", onReplace: "delete" });
  // Removing a tag deletes its join row; the tag itself stays.
  static tags = manyToMany(() => Tag, {
    joinThrough: "posts_tags",
    joinKeys: { owner: "post_id", target: "tag_id" },
    onReplace: "delete",
  });

  static changeset(post: Post | typeof Post, params: unknown) {
    return cast(post, params, ["title"]).validateRequired(["title"]);
  }
}
// #endregion define

export async function intro(post: Post, tagA: Tag, tagB: Tag, comment: Comment) {
  // #region intro
  // From untrusted input
  cast(post, params, ["title"]).castAssoc("comments", { with: Comment.changeset });

  // From trusted data
  change(post).putAssoc("tags", [tagA, tagB]);
  change(comment).putAssoc("post", post);
  // #endregion intro
}

export async function form(postId: number, body: unknown) {
  // #region form
  // body: { title: "…", comments: [{ id: 3, body: "edited" }, { body: "new" }] }
  const post = await repo.oneOrThrow(from(Post, "p").where({ id: postId }).preload("comments"));
  const result = await repo.update(Post.changeset(post, body).castAssoc("comments"));
  if (!result.success) return result.error.errorMessages(); // { comments: [{}, { body: ["can't be blank"] }] }
  // Comment 3 is updated, a new one inserted, and every other comment of the post deleted.
  // #endregion form
  return result.data;
}

export function withFn(post: Post) {
  // #region with
  Post.changeset(post, params).castAssoc("comments", {
    with: (comment, item, index) =>
      Comment.changeset(comment, item).validateLength("body", { max: 500 - index }),
    required: true,
  });
  // #endregion with
}

export async function put(post: Post) {
  // #region put
  const tags = await repo.all(from(Tag, "t").where(({ t }) => t.name.in(["news", "howto"])));
  const loaded = await repo.preload(Post, post, "tags");
  await repo.updateOrThrow(change(loaded).putAssoc("tags", [...tags, { name: "fresh" }]));
  // #endregion put
}

export async function build(user: User) {
  // #region build
  const cs = buildAssoc(User, user, "posts", { title: "Hello" }); // Changeset<typeof Post, true>, authorId = user.id
  await repo.insert(cs);
  // #endregion build
}

export function errors(post: Post) {
  // #region errors
  const cs = Post.changeset(post, params).castAssoc("comments");
  cs.changes.comments; // readonly Changeset<typeof Comment, boolean>[] | undefined
  cs.errorMessages(); // { comments: [{}, { body: ["can't be blank"] }] }
  // #endregion errors
  return cs;
}

export function nestedSchema(post: Post) {
  // #region zod
  const PostInput = z.object({
    title: z.string().min(3),
    comments: z.array(z.object({ body: z.string().max(500) })),
  });
  const cs = cast(post, params, ["title"]).castAssoc("comments").validate(PostInput);
  // An issue at ["comments", 1, "body"] lands on the second comment's changeset.
  // #endregion zod
  return cs;
}

export async function saving(input: unknown) {
  // #region save
  const result = await repo.insert(Post.changeset(Post, input).castAssoc("comments"));
  if (result.success && isLoaded(Post, result.data, "comments")) {
    result.data.comments; // Comment[], with their ids and postId
  }
  // #endregion save
}

export async function tagPicker(postId: number, picked: readonly string[]) {
  // #region tag-picker
  const save = createBatch()
    .run("tags", async (tx) => {
      const found = await tx.all(from(Tag, "t").where(({ t }) => t.name.in(picked)));
      const missing = picked.filter((name) => !found.some((tag) => tag.name === name));
      const made =
        missing.length === 0
          ? []
          : (
              await tx.insertAll(
                Tag,
                missing.map((name) => ({ name })),
                { returning: true },
              )
            ).rows;
      return success([...found, ...(made ?? [])]);
    })
    .run("post", async (tx) =>
      success(await tx.oneOrThrow(from(Post, "p").where({ id: postId }).preload("tags"))),
    )
    .update("saved", ({ post, tags }) => change(post).putAssoc("tags", tags));
  const result = await repo.transaction(save);
  // #endregion tag-picker
  return result;
}

export type Children = Changeset<typeof Comment, boolean>;
