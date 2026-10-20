// The checked sources of the code blocks in guide/associations.md. Each `#region` is
// included in the page by name; everything outside a region is the scaffolding that makes
// the regions compile.
import {
  assoc,
  belongsTo,
  from,
  hasMany,
  hasOne,
  isLoaded,
  type Loaded,
  manyToMany,
  type QueryWith,
  type Repo,
  type RepoQueryEvent,
  Schema,
  t,
  timestamps,
} from "egon-orm";

declare const repo: Repo;

class Profile extends Schema("profiles", {
  id: t.integer().primaryKey().dbGenerated(),
  userId: t.integer(),
  bio: t.string().nullable(),
}) {}

class Tag extends Schema("tags", { id: t.integer().primaryKey().dbGenerated(), name: t.string() }) {}

class Comment extends Schema("comments", {
  id: t.integer().primaryKey().dbGenerated(),
  postId: t.integer(),
  authorId: t.integer().nullable(),
  body: t.string(),
  ...timestamps({ updatedAt: false }),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
}

// #region define
export class User extends Schema("users", { id: t.integer().primaryKey().dbGenerated(), email: t.string() }) {
  static profile = hasOne(() => Profile, { foreignKey: "userId" });
  static posts = hasMany(() => Post, { foreignKey: "authorId", orderBy: ["createdAt"] });
  static comments = hasMany(() => Comment, { through: ["posts", "comments"] });
  static tags = manyToMany(() => Tag, {
    joinThrough: "users_tags",
    joinKeys: { owner: "user_id", target: "tag_id" },
  });
}

export class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
  published: t.boolean().default(false),
  ...timestamps(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
  static comments = hasMany(() => Comment, { foreignKey: "postId" });
  static tags = manyToMany(() => Tag, {
    joinThrough: "posts_tags",
    joinKeys: { owner: "post_id", target: "tag_id" },
  });
}
// #endregion define

export function joins() {
  // #region join
  from(User, "u").joinAssoc("u", "posts", "p");
  from(User, "u").join(Post, "p", ({ u, p }) => p.authorId.eq(u.id));
  // #endregion join
}

export async function shortForms() {
  // #region short
  await repo.all(from(User, "u").preload("posts")); // one association
  await repo.all(from(User, "u").preload(["posts", "profile"])); // several
  await repo.all(from(User, "u").preload({ posts: "comments" })); // posts, then their comments
  await repo.all(from(User, "u").preload({ posts: ["comments", "tags"] }));
  await repo.all(from(User, "u").preload({ posts: { comments: "author" } }));
  // #endregion short
}

export async function callbacks() {
  // #region callback
  const users = await repo.all(
    from(User, "u")
      .preload("profile")
      .preload("posts", (q) =>
        q
          .where(({ posts }) => posts.published)
          .orderBy(({ posts }) => posts.createdAt.desc())
          .limit(3) // the three newest published posts of each user
          .preload("comments", (q) =>
            q
              .orderBy(({ comments }) => comments.createdAt)
              .limit(5)
              .preload("author"),
          ),
      ),
  );
  users[0]?.posts[0]?.comments[0]?.author; // User | null
  // #endregion callback
}

// #region scope
const onlyPublished = <Q extends QueryWith<{ posts: typeof Post }>>(q: Q) =>
  q.where(({ posts }) => posts.published);

export const withPublished = from(User, "u").preload("posts", onlyPublished);
// #endregion scope

export async function selecting() {
  // #region select
  const users = await repo.all(
    from(User, "u").preload("posts", (q) =>
      q.select(({ posts }) => ({ authorId: posts.authorId, title: posts.title })),
    ),
  );
  users[0]?.posts; // { authorId: number; title: string }[]
  // #endregion select
}

export async function fromAJoin() {
  // #region join-preload
  await repo.all(
    from(User, "u")
      .joinAssoc("u", "posts", "p")
      .where(({ p }) => p.published)
      .preload({ posts: "p" }),
  );
  // #endregion join-preload
  // #region join-nested
  await repo.all(
    from(User, "u")
      .leftJoinAssoc("u", "posts", "p")
      .leftJoinAssoc("p", "comments", "c")
      .preload({ posts: { $from: "p", comments: "c" } }),
  );
  // #endregion join-nested
}

export async function afterTheFact(users: User[], user: User) {
  // #region after
  const loaded = await repo.preload(User, users, "posts"); // new rows, with posts
  const top3 = await repo.preload(User, users, "posts", (q) =>
    q.orderBy(({ posts }) => posts.createdAt.desc()).limit(3),
  );
  await repo.preload(User, user, { posts: "comments" }, { force: true });
  // #endregion after
  return { loaded, top3 };
}

// #region loaded
function render(user: Loaded<typeof User, "posts">) {
  return user.posts.map((p) => p.title);
}

type Deep = Loaded<typeof User, { posts: { comments: "author" } }>;

function titles(user: User) {
  if (isLoaded(User, user, "posts")) return user.posts.map((p) => p.title); // narrowed
  return [];
}
// #endregion loaded

export const used: [typeof render, Deep | undefined, typeof titles] = [render, undefined, titles];

export async function querying(user: User, posts: Post[]) {
  // #region assoc
  const drafts = await repo.all(assoc(User, user, "posts").where(({ posts }) => posts.published.eq(false)));
  const comments = await repo.count(assoc(Post, posts, "comments")); // the comments of every post
  // #endregion assoc
  return { drafts, comments };
}

export async function counting() {
  // #region count
  const statements: RepoQueryEvent[] = [];
  const stop = repo.on("query", (event) => statements.push(event));
  await repo.all(from(User, "u").preload({ posts: { comments: "author" } }));
  stop();
  // One for the users, one per association level, whatever the number of rows.
  statements.map((event) => event.operation); // ["all", "preload", "preload", "preload"]
  // #endregion count
}
