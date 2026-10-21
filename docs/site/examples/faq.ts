// The checked sources of the fixes in guide/faq.md. Each `#region` is included in the page by
// name; everything outside a region is the scaffolding that makes the regions compile.
import { postgres } from "@egon-orm/postgres";
import { belongsTo, cast, createRepo, from, hasMany, isLoaded, type Loaded, Schema, t } from "egon-orm";

// #region circular
// user.ts
//   import { Post } from "./post.js";      a value import, not `import type`
class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" }); // a function, called later

  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"]).uniqueConstraint("email");
  }
}

// post.ts
//   import { User } from "./user.js";
class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
}
// #endregion circular

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });
declare const params: unknown;
declare const name: string | undefined;

export async function preloaded() {
  // #region preload
  const user = await repo.one(from(User, "u").where({ id: 1 }).preload("posts"));
  user?.posts; // Post[]

  // A function that needs the posts says so in its parameter type:
  function titles(author: Loaded<typeof User, "posts">) {
    return author.posts.map((p) => p.title);
  }

  // A row you got from elsewhere: check at run time, which narrows the type.
  const other = await repo.getOrThrow(User, 2);
  if (isLoaded(User, other, "posts")) titles(other);
  else titles(await repo.preload(User, other, "posts"));
  // #endregion preload
}

export function nulls() {
  // #region null
  from(User, "u").where(({ u }) => u.name.isNull());
  from(User, "u").where({ name: null }); // the object form: IS NULL
  from(User, "u").where(({ u }) => u.name.isDistinctFrom(name ?? null)); // null as a value
  // #endregion null
}

export function optional() {
  // #region undefined
  const query = from(User, "u").pipe((q) => (name === undefined ? q : q.where({ name })));
  // #endregion undefined
  return query;
}

export async function update(user: User) {
  // #region update
  await repo.update(User.changeset(user, params)); // a loaded row: update
  await repo.insert(User.changeset(User, params)); // the class: insert
  // #endregion update
}
