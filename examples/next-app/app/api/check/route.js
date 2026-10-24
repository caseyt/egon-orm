// A route handler that runs a round trip through the ORM: a nested insert in a transaction,
// a Batch, a query with a preload, a count and a stream. `check.mjs` builds the app with
// `next build`, serves it with `next start` and compares the answer.
import { postgres } from "@egon-orm/postgres";
import { change, createBatch, createRepo, fragment, from, hasMany, Schema, success, t } from "egon-orm";

class Author extends Schema("next_authors", {
  id: t.integer().primaryKey().dbGenerated(),
  name: t.string(),
}) {
  static books = hasMany(() => Book, { foreignKey: "authorId", orderBy: ["id"] });
}

class Book extends Schema("next_books", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
}) {}

// Rendered on every request: the answer comes from the database, not from the build.
export const dynamic = "force-dynamic";

export async function GET() {
  const repo = createRepo({
    adapter: postgres({ connectionString: process.env.DATABASE_URL, pool: { max: 2 } }),
  });
  try {
    await repo.raw(
      fragment`create table if not exists next_authors (id serial primary key, name text not null)`,
    );
    await repo.raw(
      fragment`create table if not exists next_books (id serial primary key, author_id integer not null, title text not null)`,
    );
    await repo.raw(fragment`truncate next_books, next_authors restart identity`);
    await repo.transactionOrThrow((tx) =>
      tx.insertOrThrow(
        change(Author, { name: "Ann" }).putAssoc("books", [{ title: "One" }, { title: "Two" }]),
      ),
    );
    const batch = await repo.transactionOrThrow(
      createBatch()
        .insert("author", change(Author, { name: "Bo" }))
        .insert("book", ({ author }) => change(Book, { authorId: author.id, title: "Three" }))
        .run("count", async (tx) => success(await tx.count(from(Book, "b")))),
    );
    const authors = await repo.all(
      from(Author, "a")
        .orderBy(({ a }) => a.id)
        .preload("books"),
    );
    const streamed = [];
    for await (const book of repo.stream(from(Book, "b").orderBy(({ b }) => b.id))) streamed.push(book.title);
    return Response.json({
      count: batch.count,
      authors: authors.map(
        (author) => `${author.name}: ${author.books.map((book) => book.title).join(", ")}`,
      ),
      streamed,
    });
  } finally {
    await repo.close();
  }
}
