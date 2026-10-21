// #region file
// schemas.ts
import { belongsTo, cast, hasMany, Schema, t, timestamps } from "egon-orm";

export class User extends Schema("users", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"])
      .validateRequired(["email"])
      .validateFormat("email", /^[^@\s]+@[^@\s]+$/)
      .uniqueConstraint("email");
  }
}

export class Post extends Schema("posts", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  authorId: t.bigint({ mode: "number" }),
  title: t.string(),
  published: t.boolean().default(false),
  ...timestamps(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
}
// #endregion file
