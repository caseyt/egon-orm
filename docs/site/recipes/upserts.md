# Upserts

Insert a row, or update the one that is already there, in one statement.

## Insert or update one row

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

`insertAll` skips changesets: use it for data you trust, such as counters and imports.

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
