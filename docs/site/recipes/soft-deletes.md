# Soft deletes

Keep deleted rows, marked with the time they were deleted, and leave them out of every
listing.

## Setup

The code of this recipe depends on these declarations: the imports, the schema classes, the
repo, and the migration that creates the tables. Run the recipe in an empty database of its
own: each recipe creates its own tables, and some have the same names (`posts`) with other
columns.

<<< @/examples/recipes/soft-deletes.ts#setup

## The field

<<< @/examples/recipes/soft-deletes.ts#schema

The table's unique index on `title` is partial (`where deleted_at is null`, in the
migration above) and named `posts_title_key`, the name `uniqueConstraint("title")` looks
for: a title is unique among the live posts only.

## Leaving deleted rows out

A scope is a function from query to query, applied with `.pipe(…)`. `QueryWith<{ p: typeof Post }>`
is the type of any query that has a binding `p` of `Post`, so the scope works on every such
query and returns the same query type ([Reusable pieces](/guide/queries#reusable-pieces)).
Every listing starts from a base query that applies it:

<<< @/examples/recipes/soft-deletes.ts#scope

There is no default scope that applies by itself: `repo.all(Post)` and `repo.get(Post, id)`
still see deleted rows. That is deliberate (what a query does is written in the query), and
it is what an admin page or a restore needs. Start listings from `posts`, or from
`from(Post, "p").pipe(live)`.

## Deleting, restoring, purging

<<< @/examples/recipes/soft-deletes.ts#delete

A soft delete is an update, so it goes through a changeset, sets `updatedAt` if the schema
has timestamps, and can carry an [optimistic lock](/recipes/optimistic-locking).

The example below starts from these rows, after creating the tables:

<<< @/examples/recipes/soft-deletes.ts#seed

It deletes a post, which leaves the listing but stays in the table. Both the changeset and
`restore` declare the unique index, so a clash is a field error: a deleted post's title is
free for a new post, and restoring the old one then meets the index.

<<< @/examples/recipes/soft-deletes.ts#use

::: tip Good to know
- **Unique values.** A unique index would count deleted rows too: make it partial, as the
  migration does. With another name than `posts_title_key`, pass it:
  `uniqueConstraint("title", { name })`.
- **Associations.** A preload of `posts` loads deleted posts too. Filter in the callback form:
  `preload("posts", (q) => q.where(({ posts }) => posts.deletedAt.isNull()))`,
  or give the association a `where`.
- **Foreign keys** still point at a soft-deleted row; `ON DELETE` does nothing until it is
  purged.
:::

## See also

- [Reusable pieces](/guide/queries#reusable-pieces)
- [Association options](/guide/associations#options): `where`
- [Migrations](/guide/migrations#index-and-constraint-names)
