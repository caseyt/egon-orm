# Top N per parent

The three most viewed posts of each author, the latest comment of each post: a limit that
applies to each parent rather than to the whole result.

## Setup

The code of this recipe depends on these declarations: the imports, the schema classes, the
repo, and the migration that creates the tables. Run the recipe in an empty database of its
own: each recipe creates its own tables, and some have the same names (`posts`) with other
columns.

<<< @/examples/recipes/top-n.ts#setup

## With a preload

The examples below start from these rows, after creating the tables:

<<< @/examples/recipes/top-n.ts#seed

When the parents are loaded too, a preload with a `limit` does it:

<<< @/examples/recipes/top-n.ts#preload

The `limit` in a preload callback is per parent. It still runs as one query for all the
authors: the posts are numbered per author with `row_number() over (partition by …)` and
filtered on that number. A per-parent limit needs an order, from the callback or the
association's own `orderBy`.

## With a window function

Without the parents, or to filter or join on the rank, number the rows yourself in a
subquery:

<<< @/examples/recipes/top-n.ts#window

Window functions are computed after `where`, so the rank cannot be filtered in the same
query: the subquery computes it, and the outer query filters on it.

::: tip Good to know
- A preload's per-parent `limit` is refused on a has-through association along which a row
  can be reached twice, since the row would be counted twice.
- Ties: `rowNumber` gives tied rows different numbers in no particular order; add a column
  to the `orderBy` (such as `id`) to make it stable, or use `rank` to keep ties together.
:::

## See also

- [Callback form](/guide/associations#callback-form)
- [Window functions](/guide/queries-advanced#window-functions)
