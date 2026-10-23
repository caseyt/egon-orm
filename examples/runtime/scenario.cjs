// The runtime matrix's workload (step 21, robustness): the same round trip on every runtime,
// module system and bundle. It imports nothing: each entry (esm.mjs, cjs.cjs, and their
// esbuild bundles) loads the packages its own way and passes them in, so this file tests
// whatever loaded them.
//
// Against one adapter: create two tables, insert through a validated changeset, a nested
// insert, a transaction, a Batch, a rolled-back transaction, a query with a preload, a
// count, a stream, an update and a delete; then drop the tables and close.
"use strict";

/**
 * @param {typeof import("egon-orm")} egon
 * @param {import("egon-orm").DatabaseAdapter} adapter
 * @param {"postgres" | "sqlite"} dialect which DDL to create the tables with
 * @returns {Promise<Record<string, unknown>>} what was read back
 */
async function run(egon, adapter, dialect) {
  const { Schema, t, hasMany, belongsTo, cast, change, from, createRepo, createBatch, fragment, success } =
    egon;

  class Author extends Schema("rt_authors", {
    id: t.integer().primaryKey().dbGenerated(),
    name: t.string(),
  }) {
    static books = hasMany(() => Book, { foreignKey: "authorId", orderBy: ["id"] });
  }
  class Book extends Schema("rt_books", {
    id: t.integer().primaryKey().dbGenerated(),
    authorId: t.integer(),
    title: t.string(),
  }) {
    static author = belongsTo(() => Author);
  }

  const repo = createRepo({ adapter });
  // SQL text comes only from template literals (a fragment refuses anything else).
  if (dialect === "postgres") {
    await repo.raw(fragment`create table rt_authors (id serial primary key, name text not null)`);
    await repo.raw(
      fragment`create table rt_books (id serial primary key, author_id integer not null, title text not null)`,
    );
  } else {
    await repo.raw(
      fragment`create table rt_authors (id integer primary key autoincrement, name text not null)`,
    );
    await repo.raw(
      fragment`create table rt_books (id integer primary key autoincrement, author_id integer not null, title text not null)`,
    );
  }
  try {
    const invalid = await repo.insert(
      cast(Author, { name: "" }, ["name"]).validateLength("name", { min: 1 }),
    );
    const ann = await repo.insertOrThrow(cast(Author, { name: "Ann" }, ["name"]).validateRequired(["name"]));
    const bo = await repo.insertOrThrow(
      change(Author, { name: "Bo" }).putAssoc("books", [{ title: "One" }, { title: "Two" }]),
    );
    await repo.transactionOrThrow(async (tx) => {
      await tx.insertOrThrow(change(Book, { authorId: ann.id, title: "Three" }));
    });
    const batch = await repo.transaction(
      createBatch()
        .insert("author", change(Author, { name: "Cy" }))
        .insert("book", ({ author }) => change(Book, { authorId: author.id, title: "Four" }))
        .run("count", async (tx) => success(await tx.count(from(Book, "b")))),
    );
    const rolledBack = await repo.transaction(async (tx) => {
      await tx.insertOrThrow(change(Author, { name: "Gone" }));
      tx.rollback("on purpose");
    });
    const loaded = await repo.all(
      from(Author, "a")
        .orderBy(({ a }) => a.id)
        .preload("books"),
    );
    const streamed = [];
    for await (const book of repo.stream(
      from(Book, "b").orderBy(({ b }) => b.id),
      { batchSize: 2 },
    )) {
      streamed.push(book.title);
    }
    const renamed = await repo.updateOrThrow(change(ann, { name: "Ann B." }));
    await repo.deleteOrThrow(bo.books[0]);
    return {
      invalid: invalid.success ? null : invalid.error.errorMessages(),
      batch: batch.success ? batch.data.count : "failed",
      rolledBack: rolledBack.success ? "committed" : rolledBack.error,
      authors: loaded.map((author) => `${author.name}: ${author.books.map((book) => book.title).join(", ")}`),
      streamed,
      renamed: renamed.name,
      remaining: await repo.count(from(Book, "b")),
    };
  } finally {
    await repo.raw(fragment`drop table rt_books`);
    await repo.raw(fragment`drop table rt_authors`);
    await repo.close();
  }
}

/** What {@link run} must return, on every runtime and adapter. */
const EXPECTED = {
  invalid: { name: ["can't be blank"] },
  batch: 4,
  rolledBack: "on purpose",
  authors: ["Ann: Three", "Bo: One, Two", "Cy: Four"],
  streamed: ["One", "Two", "Three", "Four"],
  renamed: "Ann B.",
  remaining: 3,
};

module.exports = { run, EXPECTED };
