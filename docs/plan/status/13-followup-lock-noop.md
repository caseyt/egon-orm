# Step 13 follow-up: an unchanged save with an optimistic lock, status

Branch `fix/optimistic-lock-noop`.

## Bug

The repo guide (Update) says an update with no changes runs no query and returns the row.
With `optimisticLock("lockVersion")` it still ran: the lock registers a prepare function
that `forceChange`s the lock field, and the prepare functions run before `updateRow`
checks for an empty change set. Saving an unchanged form therefore incremented the
version (and moved `updatedAt`), which made every other open copy of the row stale.

## Decision

Owner, 2026-10-21: the code follows the docs. When nothing but the lock's increment would
be written, the update runs no query, does not increment, and returns the row unchanged.
`{ force: true }` still runs the update, increments the version and checks it.

## Fix

`packages/core/src/repo/write.ts`: after the prepare functions have run, `update()` passes
the changeset through `withoutLoneLockBump` (unless `force` is set). The lock fields are
the keys of `changeset.filters` (only `optimisticLock` sets them). If every other change is
to a virtual field or a field that may not be updated, the lock fields are taken out of the
changes, and `updateRow` then does what it does without a lock: no change returns the row
itself, virtual-only changes return the row with them, both without a query.

Why here and not in the lock's prepare function: the check runs after every prepare
function, so a change a user `prepareChanges` function makes counts whichever order it was
registered in (a check inside the bump would miss a function registered after the lock),
and `force` is a repo option the changeset cannot see.

Nested writes are unchanged: a parent with association changes goes through
`writeNested`, which calls `updateRow` directly, so its own update still carries the
increment and the `where lock_version = …` guard. A child update with a lock goes through
`update()` and gets the fix.

A consequence worth knowing: an unchanged save of a copy that is already stale now
succeeds (there is no query to find out). Nothing was written, so nothing is lost.

## Tests

- Unit (`write.test.ts`): no change with a lock (also a `cast` to the same value): no
  statement, no event, the row itself; virtual-only changes with a lock: no statement, the
  version kept; changes only to a `writable("insert")` field with a lock: no statement;
  `force` with a lock and no change: the update with the increment and the guard, and stale
  when no row matched; a `prepareChanges` change registered before or after the lock: the
  update with the increment; a custom incrementer: no change sends nothing, `force`
  writes its value. The first three fail without the fix.
- Conformance (`test/conformance/write`, run by Postgres, SQLite and MySQL): an unchanged
  save sends nothing, keeps `lockVersion` and `updatedAt` in the database, and another open
  copy can still save; `force` with no change increments and makes the other copy stale; a
  prepare function's change is written and increments; a parent with only association
  changes (a new post through `castAssoc`) is updated with the increment and a stale copy
  of it fails.
- `pnpm check` and `pnpm test:integration` with `EGON_TEST_TIER2=1` pass locally.

## Docs

- `recipes/optimistic-locking.md`: a section "An unchanged save", with a new `#unchanged`
  region in `examples/recipes/optimistic-locking.ts` (a `// @run` file, so its `// =>`
  comments, including the version read back from the database, are checked). It says
  that association changes count as a change, and that an unchanged save of a stale copy
  is not checked (`force` checks it).
- `guide/repo.md` (Update) and `guide/changesets.md` (Hooks for the repo): one sentence
  each; the repo guide's `force` note now says a lock's version is written and checked
  too. The TSDoc of `optimisticLock` says the same.

## Requests

None.
