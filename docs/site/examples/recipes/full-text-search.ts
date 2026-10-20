// @run
// The checked source of recipes/full-text-search.md. Each `#region` is included in the page
// by name; the rest makes it compile and run (docs:integration checks the `// =>` comments).
import { postgres } from "@egon-orm/postgres";
import { createRepo, fragment, from, Schema, t } from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";

class Article extends Schema("articles", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  body: t.string(),
}) {}

const adapter = postgres({ connectionString: process.env.DATABASE_URL });
const repo = createRepo({ adapter });

// #region index
// A generated tsvector column, and a GIN index on it.
export const searchable = defineMigration({
  up(m) {
    m.execute(fragment`
      alter table articles add column search tsvector
        generated always as (to_tsvector('english', title || ' ' || body)) stored
    `);
    m.createIndex("articles", ["search"], { using: "gin" }); // articles_search_index
  },
  down(m) {
    m.execute(fragment`alter table articles drop column search`); // drops the index with it
  },
});
// #endregion index

// #region search
export function search(terms: string) {
  return repo.all(
    from(Article, "a")
      .where(() => fragment`search @@ websearch_to_tsquery('english', ${terms})`.as<boolean>())
      .orderBy(() => fragment`ts_rank(search, websearch_to_tsquery('english', ${terms}))`.as<number>().desc())
      .limit(20),
  );
}
// #endregion search

// #region headline
export function searchWithSnippets(terms: string) {
  return repo.all(
    from(Article, "a")
      .where(() => fragment`search @@ websearch_to_tsquery('english', ${terms})`.as<boolean>())
      .select(({ a }) => ({
        id: a.id,
        title: a.title,
        snippet:
          fragment`ts_headline('english', ${a.body}, websearch_to_tsquery('english', ${terms}))`.as<string>(),
      })),
  );
}
// #endregion headline

export async function run(): Promise<void> {
  const tables = defineMigration({
    change(m) {
      m.createTable("articles", (t) => {
        t.id("id", { type: "integer" });
        t.text("title").notNull();
        t.text("body").notNull();
      });
    },
  });
  await createMigrator({
    adapter,
    migrations: [
      { version: 1, name: "articles", migration: tables },
      { version: 2, name: "searchable", migration: searchable },
    ],
  }).up();
  await repo.insertAll(Article, [
    { title: "Indexing tables", body: "A GIN index makes searches fast." },
    { title: "Cooking", body: "Rice, beans and searches for good spices." },
    { title: "Gardening", body: "Tomatoes need sun." },
  ]);

  (await search("search index")).map((a) => a.title); // => ["Indexing tables"]
  (await search("searching")).length; // => 2
  const [hit] = await searchWithSnippets("tomatoes");
  hit?.snippet; // => "<b>Tomatoes</b> need sun."

  await adapter.close();
}
