# Find or create

Return the row with a given unique value, creating it if it does not exist, safely when two
requests ask at once.

::: details The schemas and tables this recipe uses
Run the recipe in an empty database of its own: each recipe creates its own tables, and
some have the same names (`posts`) with other columns.

<<< @/examples/recipes/find-or-create.ts#setup

The examples start from these rows, after creating the tables:

<<< @/examples/recipes/find-or-create.ts#seed
:::

## The function

<<< @/examples/recipes/find-or-create.ts#find-or-create

<<< @/examples/recipes/find-or-create.ts#use

- The insert goes first. With `onConflict: "nothing"`, a conflict is not an error: the
  result is `null`, and the row that won is read by its unique value.
- Reading first and inserting when nothing was found has a race: two requests both find
  nothing, and one insert fails. Inserting first lets the unique index decide.
- The changeset normalises the name (trim, lower case), and the lookup uses the
  normalised value from `changeset.getField("name")`.
- The function takes the repo as an argument, so it works with `tx` inside a transaction.

::: tip Good to know
- `onConflict: "nothing"` needs a unique index or constraint on the column.
- On Postgres, a conflicting insert still uses a value of the `serial` sequence: ids get
  gaps. That is harmless.
- An invalid changeset (an empty name) throws here, since the function uses
  `insertOrThrow`; return the result instead to show the errors on a form.
:::

## See also

- [Upserts](/recipes/upserts)
- [Constraints](/guide/constraints)
