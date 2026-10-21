# Upserts

Insert a row, or update the one that is already there, in one statement.

## Setup

The code of this recipe depends on these declarations: the imports, the schema classes, the
repo, and the migration that creates the tables. Run the recipe in an empty database of its
own: each recipe creates its own tables, and some have the same names (`posts`) with other
columns.

<<< @/examples/recipes/upserts.ts#setup

## Insert or update one row

The examples below start from these rows, after creating the tables:

<<< @/examples/recipes/upserts.ts#seed

<<< @/examples/recipes/upserts.ts#one

- `target` is the unique key that may conflict: fields, `{ constraint: "name" }`, or a
  `fragment` for an index on an expression. MySQL takes no target: any unique key
  conflicts there.
- `update` is `"all"` (every inserted column), a list of fields, or `{ except: [...] }`.
  List `updatedAt` when the update should touch it.
- The returned row is the one in the table after the statement, whichever happened.

## Insert unless it exists

<<< @/examples/recipes/upserts.ts#nothing

With `onConflict: "nothing"`, `data` is `null` when the row existed; its type includes
`null` only with this option.

## Many rows at once

<<< @/examples/recipes/upserts.ts#bulk

`insertAll` skips changesets: use it for data you trust, such as imports.

`update` writes the values of the row being inserted; it does not compute from the row that
is there. To increment a counter, insert the row if it is missing, and otherwise update it
with an expression:

<<< @/examples/recipes/upserts.ts#counter

`DailyView.day` is a `t.date()` field: a calendar date with no time, which reads and writes
as a `"YYYY-MM-DD"` string ([Types](/guide/types)), so `countView` takes the day as one.
Counting the same page and day twice:

<<< @/examples/recipes/upserts.ts#counter-use

Inserting first is safe when two requests count at once: one inserts, the other finds the
row there and increments it.

::: tip Good to know
- An upsert is not `insertOrUpdate`. `insertOrUpdate` chooses insert or update from the
  changeset (new record or loaded row) and never asks the database; `onConflict` lets the
  database decide.
- A changeset with nested association changes cannot be combined with `onConflict`.
- To read a row or create it, see [Find or create](/recipes/find-or-create).
:::

## See also

- [Upserts](/guide/repo#upserts) in the repo guide
- [Bulk writes](/guide/repo#bulk-writes)
