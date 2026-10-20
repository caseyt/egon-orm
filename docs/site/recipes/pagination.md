# Pagination

Two ways to read a large list a page at a time: by page number (offset), or after the last
row seen (keyset).

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

<<< @/examples/recipes/pagination.ts#keyset-use

- The cursor holds the values of the order columns of the last row. `tuple(a, b).lt(...)`
  compares them as a row: `(created_at, id) < ($1, $2)`.
- Order by a unique combination: `createdAt` alone may repeat, so `id` breaks ties.
- The `where` and the `orderBy` use the same columns in the same direction. An index on
  `(created_at desc, id desc)` serves both.
- To send the cursor to a client, encode it (for example as base64 JSON) and decode it into
  a `Date` and a number again on the next request.

::: tip Good to know
- `limit` and `offset` count rows, not parents: on a query that join-preloads a to-many
  association they are refused. Preload with a separate query instead.
:::

## See also

- [Limit and offset](/guide/queries#limit-and-offset)
- [Tuple comparison](/guide/queries-advanced#other-tools)
- [Top N per parent](/recipes/top-n-per-parent)
