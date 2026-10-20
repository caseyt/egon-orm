# Transactions

<<< @/examples/transactions.ts#basics

`repo.transaction(fn, opts?)` takes one connection, begins a transaction, and calls `fn`
with `tx`, a repo bound to that connection. `tx` has every repo method.

| What happens in `fn` | Outcome | `repo.transaction` returns |
|---|---|---|
| It returns a value | `COMMIT` | `{ success: true, data: value }` |
| It calls `tx.rollback(reason)` | `ROLLBACK` | `{ success: false, error: reason }` |
| It returns, but a statement in it failed (an error it caught, a write result it did not check) | `ROLLBACK` | `{ success: false, error }`, the statement's error |
| It throws | `ROLLBACK` | the error is rethrown |

`tx.rollback(reason)` stops the callback; nothing after it runs. A rollback the callback
catches still rolls back, with the first reason given.

`repo.transactionOrThrow(fn, opts?)` returns the value directly, and a rollback throws
`RollbackError`, whose `reason` is what `repo.transaction` would have returned as `error`:

<<< @/examples/transactions.ts#or-throw

::: tip Good to know
Transactions are explicit. Nothing is put in a transaction behind your back: no global or
per-request transaction, and the outer repo never joins one. Only what you run on `tx` is
inside.
:::

## The explicit rule

**Only calls on `tx` are inside the transaction.** The outer `repo` uses a different
connection:

<<< @/examples/transactions.ts#explicit-rule

Pass `tx` to the functions you call, in place of the repo. Because `tx` is a repo, code
that takes a repo argument works either way:

<<< @/examples/transactions.ts#pass-tx

In development, `warnOnRootUseInTransaction: true` makes the outer repo warn when it is
used inside one of its transaction callbacks: once per transaction, as a Node warning
(`process.emitWarning`, code `EGON_ROOT_IN_TRANSACTION`). It has no effect when
`NODE_ENV` is `production`, where it is never installed.

<<< @/examples/transactions.ts#warning

## Use the throwing methods

Inside a transaction, prefer `insertOrThrow` and its siblings: a throw rolls back by
itself, and it says where it happened.

When a write the database refuses is not a throw (a [result](/guide/repo#writing)
with a constraint error), the transaction cannot commit anyway: on Postgres, a failed
statement aborts the whole transaction, and Egon treats every database the same way. The
transaction refuses every later statement with a `QueryError` that names the cause, and
ends in a rollback. To handle the failure yourself, roll back explicitly:

<<< @/examples/transactions.ts#handle-failure

Write `return tx.rollback(…)`: TypeScript narrows `created` after a `return`. A bare
`tx.rollback(…)` statement narrows it only when `tx` is annotated (`async (tx: Repo) =>`),
because TypeScript follows a call that never returns only through an annotated name.

To try a write that may fail and carry on when it does, run it in a
[nested transaction](#nesting): its failure undoes only its own work.

## Options

<<< @/examples/transactions.ts#options

| Option | Effect |
|---|---|
| `isolation` | `"read committed"`, `"repeatable read"` or `"serializable"`. A level the database does not have is a `QueryError`. |
| `readOnly` | Begins a read-only transaction: a write in it fails. |
| `retries` | Runs `fn` again, up to this many times, after a serialisation failure or a deadlock (`DatabaseError.retryable`), with a randomised pause between attempts that doubles from about 10 ms, up to about 1 s. Each attempt has a new connection; no attempt is begun that would wait past `timeoutMs`. Only those two failures are retried. `fn` must be safe to run again. Default 0. |
| `timeoutMs` | One budget for the whole call: the wait for a connection, every statement and every retry. When it runs out, the running statement is cancelled, the transaction is rolled back and the call rejects with `DatabaseError`, code `"timeout"`. A statement's own `timeoutMs` counts too, whichever is shorter. |

Unknown options and wrong values are a `TypeError`.

## Nesting

`tx.transaction(fn)` inside a transaction uses a savepoint (`egon_1`, `egon_2`, … by
depth). If the inner callback rolls back, throws, or a statement in it fails, only its
work is undone and the outer transaction continues.

<<< @/examples/transactions.ts#nesting

- `isolation`, `readOnly` and `retries` cannot be set on a nested transaction (a
  `QueryError`); `timeoutMs` can, and the inner one keeps the outer one's budget when that
  is shorter.
- While a nested transaction is open, statements on the outer `tx` are refused with a
  `QueryError`: use the repo the inner callback was given.
- Nested transactions started together on one `tx` run one after the other.
- `tx.rollback(reason)` on the outer `tx`, called inside the inner callback, rolls back
  both.

## Things to know

- **One statement at a time.** A connection cannot run two queries at once. Queries issued
  together on `tx`, for example with `Promise.all`, are queued and run in the order they
  were issued. The wait counts against each one's `timeoutMs`: a query that runs out of
  time while it waits is not sent, and does not harm the transaction.
- **`tx` ends with its callback.** Using it afterwards throws `QueryError` ("transaction
  already completed"). This catches promises that escaped the callback. Queries the
  callback issued and did not await still run before the `COMMIT`.
- **Await nested transactions and streams.** A nested transaction still running, or a
  stream still open, when the callback returns rolls the transaction back.
- **`tx.inTransaction`** is `true`; on the outer repo it is `false`.
- **Writes that span several statements** (a large `insertAll`, nested changesets) open a
  transaction of their own, or, inside one, a savepoint: their failure undoes only their
  own work.
- **The transaction statements** (`BEGIN`, `SAVEPOINT`, `COMMIT`, `ROLLBACK`, …) are the
  adapter's: they are not cancelled by `timeoutMs`, and they are not the repo's `query`
  events (the adapter's own `query` events include them).
- **`tx.close()`** is refused: it would close the whole pool.

## A connection without a transaction

`repo.checkout(fn)` gives `fn` a repo bound to one connection, with no transaction. Use it
for session settings or advisory locks that must run on the same connection as the
queries that follow.

<<< @/examples/transactions.ts#checkout

Statements in a checkout commit one by one. `r.transaction(fn)` inside it begins a
transaction on that connection (and takes every option); `r.inTransaction` is `false`.
Session settings stay on the connection when it goes back to the pool: undo them before
the callback ends. On a transaction's repo, `tx.checkout(fn)` calls `fn` with `tx`.

## See also

- [Batch](/guide/batch) builds a transaction as a list of named steps.
- [Testing](/guide/testing) runs each test in a transaction that is rolled back.
