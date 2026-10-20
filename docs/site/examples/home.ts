// The checked source of the example on the home page (index.md), the introduction
// (guide/index.md) and the root README.md. scripts/check-docs.mjs checks that the README's
// copy is the same as the `example` region.
// #region example
import { postgres } from "@egon-orm/postgres";
import { belongsTo, cast, count, createRepo, from, hasMany, Schema, t, timestamps } from "egon-orm";

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"]).validateRequired(["email"]).uniqueConstraint("email");
  }
}

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
}

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

const result = await repo.insert(User.changeset(User, { email: "ada@example.com" }));
if (!result.success) console.log(result.error.errorMessages()); // { email: ["has already been taken"] }

const authors = await repo.all(
  from(User, "u")
    .where(({ u }) => u.name.isNotNull())
    .preload("posts"),
);
authors[0]?.posts[0]?.title; // string: the type knows "posts" was preloaded

const stats = await repo.all(
  from(User, "u")
    .leftJoinAssoc("u", "posts", "p")
    .groupBy(({ u }) => u.id)
    .select(({ u, p }) => ({ email: u.email, posts: count(p.id) })),
); // { email: string; posts: number }[]

// #endregion example

export { stats };
