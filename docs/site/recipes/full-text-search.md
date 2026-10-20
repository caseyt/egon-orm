# Full-text search

Search articles by words, ranked by relevance, with Postgres's full-text search. The
operators have no builder methods, so the query writes them with `fragment`, whose
interpolations are bound parameters.

## The index

A generated `tsvector` column keeps the searchable text up to date by itself, and a GIN
index makes it fast:

<<< @/examples/recipes/full-text-search.ts#index

The column is not a field of the schema class: the database computes it, and the
application never reads it.

## Searching

<<< @/examples/recipes/full-text-search.ts#search

- `websearch_to_tsquery` reads what users type: words, `"quoted phrases"`, `or`, and `-`
  to exclude. The search terms are a bound parameter.
- `.as<boolean>()` gives the fragment a type, so `where` accepts it; `.as<number>()` lets
  `orderBy` sort by it.
- Identifiers in a fragment (`search` here) are written as they are. For a name that comes
  from elsewhere, use `fragment.ident(name)`, which checks and quotes it.

## Showing where it matched

<<< @/examples/recipes/full-text-search.ts#headline

`ts_headline` marks the matching words with `<b>` tags: escape the rest of the text
before you render it as HTML.

::: tip Good to know
- This is Postgres only. SQLite has FTS5 virtual tables and MySQL `FULLTEXT` indexes with
  `MATCH … AGAINST`; both can be written with `fragment` the same way.
- For a simple "contains" filter, `ilike` with an escaped pattern is enough; see
  [Filters from a query string](/recipes/dynamic-filters).
:::

## See also

- [Fragments](/guide/query-expressions#fragments)
- [Up and down migrations](/guide/migrations#reversible-migrations-and-up-down)
