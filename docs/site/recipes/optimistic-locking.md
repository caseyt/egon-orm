# Optimistic locking

Stop a user from overwriting an edit made by someone else since they loaded the page,
without holding a lock while they type.

::: details The schemas and tables this recipe uses
<<< @/examples/recipes/optimistic-locking.ts#setup
:::

## A version field

<<< @/examples/recipes/optimistic-locking.ts#schema

`optimisticLock("lockVersion")` adds `where lock_version = <the value read>` to the update
and increments the field. If someone else updated the row in between, no row matches.

## What happens on a conflict

<<< @/examples/recipes/optimistic-locking.ts#conflict

By default the update throws `StaleEntryError`. To show the conflict on the form instead,
report it as an error on a field:

<<< @/examples/recipes/optimistic-locking.ts#save

`result.error.errorMessages()` is then `{ body: ["was changed by someone else; reload and try again"] }`.

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
