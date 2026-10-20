# Soft deletes

Keep deleted rows, marked with the time they were deleted, and leave them out of every
listing.

::: details The schemas and tables this recipe uses
<<< @/examples/recipes/soft-deletes.ts#setup
:::

## The field

<<< @/examples/recipes/soft-deletes.ts#schema

## Leaving deleted rows out

A scope is a function from query to query. Every listing starts from a base query that
applies it:

<<< @/examples/recipes/soft-deletes.ts#scope

There is no default scope that applies by itself: `repo.all(Post)` and `repo.get(Post, id)`
still see deleted rows. That is deliberate (what a query does is written in the query), and
it is what an admin page or a restore needs. Start listings from `posts`, or from
`from(Post, "p").pipe(live)`.

## Deleting, restoring, purging

<<< @/examples/recipes/soft-deletes.ts#delete

A soft delete is an update, so it goes through a changeset, sets `updatedAt` if the schema
has timestamps, and can carry an [optimistic lock](/recipes/optimistic-locking).

::: tip Good to know
- **Unique values.** A unique index would count deleted rows too. Make it partial in a
  migration: ``m.createIndex("posts", ["title"], { unique: true, where: fragment`deleted_at is null` })``,
  and give the changeset its name with `uniqueConstraint("title", { name })`.
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
