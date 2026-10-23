// A CommonJS TypeScript file (`.cts`) of a consumer project, compiled by consumer.mjs with
// `module: nodenext`: its imports compile to `require()` of the ES modules, which Node
// supports from 22.12 on. Exported with inferred types, like consumer.ts, so that emitting
// declarations needs every type they mention to be reachable from a public entry point.
import { defineConfig } from "@egon-orm/cli";
import { mysql } from "@egon-orm/mysql";
import { postgres } from "@egon-orm/postgres";
import { sqlite } from "@egon-orm/sqlite";
import { toZod } from "@egon-orm/zod";
import { cast, createRepo, from, hasMany, isEgonError, Schema, t } from "egon-orm";
import { defineMigration } from "egon-orm/migration";
import { createSandbox } from "egon-orm/testing";

export class Author extends Schema("authors", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  static changeset(author: Author | typeof Author, params: unknown) {
    return cast(author, params, ["email", "name"]).validateRequired(["email"]);
  }
}

export class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
}) {}

export const adapter = postgres({ connectionString: "postgres://localhost/unused" });
export const others = [sqlite({ filename: ":memory:" }), mysql({ connectionString: "mysql://localhost/x" })];
export const repo = createRepo({ adapter });
export const config = defineConfig({ adapter, migrations: { directory: "migrations" } });
export const named = from(Author, "a")
  .where(({ a }) => a.name.isNotNull())
  .preload("posts");
export const authors = () => repo.all(named);
export const inserted = () => repo.insert(Author.changeset(Author, { email: "ada@example.com" }));
export const AuthorZ = toZod(Author, { mode: "insert", pick: ["email", "name"] });
export const migration = defineMigration({ up() {}, down() {} });
export const sandbox = () => createSandbox(repo);
export const isQueryError = (error: unknown) => isEgonError(error, "query");
