# Pagination

Two ways to read a large list a page at a time: by page number (offset), or after the last
row seen (keyset).

## Setup

The code of this recipe depends on these declarations: the imports, the schema classes, the
repo, and the migration that creates the tables. Run the recipe in an empty database of its
own: each recipe creates its own tables, and some have the same names (`posts`) with other
columns.

<<< @/examples/recipes/pagination.ts#setup

## By page number

<<< @/examples/recipes/pagination.ts#offset

`limit` and `offset` are bound parameters, so every page shares one query plan.
`repo.count(base)` counts the rows of the same query; the order does not matter to it.

Offset pagination is simple and lets a reader jump to page 7, but the database still reads
and skips the rows before the page, and a row inserted while someone pages through moves
the rest by one.

## After the last row seen

Keyset (or cursor) pagination asks for the rows after the last one of the previous page.
It reads only the page, whatever its depth, and is stable while rows are added.

<<< @/examples/recipes/pagination.ts#keyset

The examples below start from these rows, after creating the tables:

<<< @/examples/recipes/pagination.ts#seed

<<< @/examples/recipes/pagination.ts#keyset-use

- The first page has no cursor, so `after` adds the `where` only when there is one: a query
  is a value, and `query.where(...)` returns a new one with the condition added.
- The cursor holds the values of the order columns of the last row. `tuple(a, b).lt(...)`
  compares them as a row: `(created_at, id) < ($1, $2)`.
- A page shorter than `perPage` is the last one, so `after` returns no cursor and the loop
  stops: 45 rows take three queries (20, 20, 5). When the total is an exact multiple of
  `perPage`, the last full page still returns a cursor, and one more query comes back empty.
  To avoid it, ask for `perPage + 1` rows and return a cursor only when the extra row came
  back.
- Order by a unique combination: `createdAt` alone may repeat, so `id` breaks ties.
- The `where` and the `orderBy` use the same columns in the same direction. An index on
  `(created_at, id)` serves both: Postgres reads it backwards for a descending order.
- To send the cursor to a client, encode it (for example as base64 JSON) and decode it into
  a `Date` and a number again on the next request.

::: tip Good to know
- `limit` and `offset` count rows, not parents. A query that fills a to-many association
  from one of its own joins (`preload({ posts: "p" })`, see
  [From a join](/guide/associations#from-a-join)) repeats each parent once per child, so
  `limit` and `offset` are refused there. Preload the association with a separate query
  (`preload("posts")`) instead.
:::

## See also

- [Limit and offset](/guide/queries#limit-and-offset)
- [Tuple comparison](/guide/queries-advanced#other-tools)
- [Top N per parent](/recipes/top-n-per-parent)
