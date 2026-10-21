# Optimistic locking

Stop a user from overwriting an edit made by someone else since they loaded the page,
without holding a lock while they type.

## Setup

The code of this recipe depends on these declarations: the imports, the schema classes, the
repo, and the migration that creates the tables. Run the recipe in an empty database of its
own: each recipe creates its own tables, and some have the same names (`posts`) with other
columns.

<<< @/examples/recipes/optimistic-locking.ts#setup

## A version field

<<< @/examples/recipes/optimistic-locking.ts#schema

`optimisticLock("lockVersion")` adds `where lock_version = <the value read>` to the update
and increments the field. If someone else updated the row in between, no row matches.

## What happens on a conflict

The examples below start from these rows, after creating the tables:

<<< @/examples/recipes/optimistic-locking.ts#seed

<<< @/examples/recipes/optimistic-locking.ts#conflict

By default the update throws `StaleEntryError`. To show the conflict on the form instead,
report it as an error on a field:

<<< @/examples/recipes/optimistic-locking.ts#save

`result.error.errorMessages()` is then `{ body: ["was changed by someone else; reload and try again"] }`.

## An unchanged save

A form submitted without edits changes nothing, so the update runs no query: the version
is not incremented, and the copies other users have open stay current.

<<< @/examples/recipes/optimistic-locking.ts#unchanged

The increment alone does not count as a change. Any other change does, including one a
`prepareChanges` function makes and a change to an association: a parent saved with only
`castAssoc` or `putAssoc` changes is incremented and checked like any other update.

Because no query runs, an unchanged save of a copy that is already stale is not checked:
it succeeds, and nothing is written. Pass `{ force: true }` to run the update anyway: it
then increments the version and checks it, and a stale copy fails.

::: tip Good to know
- The version must travel with the form: send the version the user saw as a hidden field,
  and check it against the row you load when the form comes back (or keep the loaded row
  in the session). A row loaded again just before the update has the latest version, and
  so defeats the check.
- A delete with the same changeset checks the version too.
- For a lock held during a transaction instead, use `lock("update")` on the query that
  reads the row: see [Locks](/guide/queries#locks).
:::

## See also

- [Hooks for the repo](/guide/changesets#hooks-for-the-repo)
- [Update](/guide/repo#update): `staleError` and `allowStale`
