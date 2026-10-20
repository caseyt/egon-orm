// @run
// The checked source of recipes/top-n-per-parent.md. Each `#region` is included in the page by
// name; the rest makes it compile and run (docs:integration checks the `// =>` comments).
import { postgres } from "@egon-orm/postgres";
import { change, createRepo, from, hasMany, rowNumber, Schema, subquery, t } from "egon-orm";
import { createTables } from "./support.js";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

class Author extends Schema("authors", {
  id: t.integer().primaryKey().dbGenerated(),
  name: t.string(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });
}

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
  views: t.integer(),
}) {}

export async function run(): Promise<void> {
  await createTables(`
    create table authors (id serial primary key, name text not null);
    create table posts (id serial primary key, author_id integer not null references authors (id),
      title text not null, views integer not null);
  `);
  const ada = await repo.insertOrThrow(change(Author, { name: "Ada" }));
  const bo = await repo.insertOrThrow(change(Author, { name: "Bo" }));
  await repo.insertAll(Post, [
    { authorId: ada.id, title: "A1", views: 5 },
    { authorId: ada.id, title: "A2", views: 50 },
    { authorId: ada.id, title: "A3", views: 20 },
    { authorId: ada.id, title: "A4", views: 1 },
    { authorId: bo.id, title: "B1", views: 7 },
  ]);

  // #region preload
  // The three most viewed posts of each author: one query for the authors, one for the posts.
  const authors = await repo.all(
    from(Author, "a")
      .orderBy(({ a }) => a.name)
      .preload("posts", (q) => q.orderBy(({ posts }) => posts.views.desc()).limit(3)),
  );
  // #endregion preload
  authors.map((a) => a.posts.map((p) => p.title)); // => [["A2", "A3", "A1"], ["B1"]]

  // #region window
  // The same rows without the parents: number the posts per author, keep numbers 1 to 3.
  const ranked = from(Post, "p").select(({ p }) => ({
    id: p.id,
    rank: rowNumber().over({ partitionBy: [p.authorId], orderBy: [p.views.desc()] }),
  }));

  const top = await repo.all(
    from(Post, "p")
      .join(subquery(ranked), "r", ({ p, r }) => r.id.eq(p.id))
      .where(({ r }) => r.rank.lte(3))
      .orderBy(({ p, r }) => [p.authorId, r.rank]),
  );
  // #endregion window
  top.map((p) => p.title); // => ["A2", "A3", "A1", "B1"]

  await repo.close();
}
