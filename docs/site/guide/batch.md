# Batch

A batch is a list of named steps that run in one transaction. It is a value: you can
build it in one place, add to it in another, inspect it in a test, and run it later.

<<< @/examples/batch.ts#sign-up

## Steps

Each step has a unique name. A step is given either a value, or a function that receives
the results of the earlier steps by name, fully typed.

| Step | Result under its name |
|---|---|
| `insert(name, changeset, opts?)`, `update`, `delete`, `insertOrUpdate` | the row (`delete` also takes a row) |
| `insertAll(name, schema, rows, opts?)`, `updateAll(name, query)`, `deleteAll(name, queryable)` | `{ count, rows }` |
| `one(name, queryable)`, `all`, `exists` | the query's result (`one`: the row or `null`) |
| `run(name, fn)` | whatever `fn` returns inside `success(...)` |
| `put(name, value)` | the value |
| `inspect(name?, fn)` | nothing; calls `fn` with the results so far |

Each step takes the same options as the repo method of its name; a query with named
parameters takes them after the query, as `repo.all` does.

`run(name, async (tx, results) => ...)` is for anything else. It must return
`success(data)` or `failure(error)`; anything else is a `TypeError`. Use the `tx` it is
given for database work.

<<< @/examples/batch.ts#steps

A step's function receives a copy of the results so far: changing it changes nothing.

## Composing

| Method | Effect |
|---|---|
| `merge((results) => batch)` | Builds more steps from the results so far, at that point in the sequence. It runs when the batch reaches it, inside the transaction. |
| `append(batch)`, `prepend(batch)` | Joins two batches. |
| `Batch.toList(batch)` | The steps as data, for tests: `{ name, operation, input, schema, args }` each. |

A batch is immutable: every method returns a new one. A duplicate step name does not
compile where the types can see it, and throws `QueryError` when the batch is built (or,
for a name a `merge` adds, when the batch runs).

<<< @/examples/batch.ts#compose

<<< @/examples/batch.ts#to-list

## Running

`repo.transaction(batch)` runs the steps in order.

- **Checked first.** Write steps given a ready-made changeset (not a function) are checked
  before the transaction opens. If one is invalid, the batch fails at once with that step,
  its changeset and `completed: {}`, and no query is sent.
- **The first failure stops it.** A write step whose result is a failure, or a `run` step
  that returns `failure(error)`, rolls everything back, and the result names the step,
  its error, and what had completed.
- **A throw is a throw.** If a step throws, the transaction is rolled back and the error
  propagates.
- **Inside a transaction** (`tx.transaction(batch)`) the batch runs in a savepoint.
- **`repo.transactionOrThrow(batch)`** returns the results, and a failure throws
  `RollbackError` whose `reason` is `{ step, error, completed }`:

<<< @/examples/batch.ts#or-throw

`repo.transaction(batch, opts)` takes the [transaction options](/guide/transactions#options).

## Handling a failure

`step` is typed as the union of the names of the steps that can fail (the write steps and
`run`), so a `switch` narrows `error`, and `completed` to the results of the steps before
that one:

<<< @/examples/batch.ts#handle

## Batch or transaction callback?

- Use a **transaction callback** for a one-off sequence with ordinary control flow.
- Use a **batch** when the steps are assembled from parts, reused, or when you want to
  know exactly which step failed without `try`/`catch` around each one.
