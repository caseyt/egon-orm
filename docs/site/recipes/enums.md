# Enums

A field that holds one of a fixed set of values.

## Setup

The code of this recipe depends on these declarations: the imports, the schema classes, the
repo, and the migration that creates the tables. Run the recipe in an empty database of its
own: each recipe creates its own tables, and some have the same names (`posts`) with other
columns.

<<< @/examples/recipes/enums.ts#setup

## Declaring one

<<< @/examples/recipes/enums.ts#schema

- `t.enum([...])` stores the value as text. The TypeScript type is the union of the
  values.
- `t.enum({ key: value })` stores a number (or another string) and gives your code the
  key: `priority` is `"high"` in TypeScript and `3` in the table.
- Keep the list in a `const` array when other code needs it (a select box, an API
  schema).

## The column

A check constraint keeps other values out of the table, whatever writes to it:

<<< @/examples/recipes/enums.ts#migration

`t.enumText` names the constraint `posts_status_check`. A changeset never sends an unknown
value (casting rejects it first), so the constraint guards against other writers.

## Using it

The examples below start from these rows, after creating the tables:

<<< @/examples/recipes/enums.ts#seed

<<< @/examples/recipes/enums.ts#use

Comparing with a value outside the list (`p.status.eq("archived")`) is a compile error.

::: tip Good to know
- **Adding a value** is a change to the code and a migration that replaces the check
  constraint. Removing one needs the rows that hold it changed first.
- **Native Postgres enums** (`create type mood as enum (…)`) work too: create the type
  in a migration (`m.execute`) and declare the field with `t.enum([...])`. A field that is a
  primary key over a native enum needs a [custom type](/guide/types#a-column-type-the-library-does-not-know)
  that names the SQL type, so that `reload` can cast its keys.
- On MySQL, `t.enum` is stored the same way, as text or a number.
:::

## See also

- [Built-in types](/guide/types#built-in-types)
- [Migrations: columns](/guide/migrations#columns)
