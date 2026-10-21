# Testing

The test helpers are a separate entry point:

<<< @/examples/testing.ts#import

## The sandbox

The sandbox runs each test inside a transaction that is rolled back afterwards. Tests see
their own writes, nothing is committed, and there is no cleanup to write.

<<< @/examples/testing.ts#sandbox-imports

<<< @/examples/testing.ts#sandbox

- **`createSandbox(repo)`** takes the repo `createRepo` made, the one your application
  imports.
- **`sandbox.begin()`** takes one connection, opens a transaction, and routes every
  operation of `repo` through it, including code that imports the repo itself. It returns
  a repo bound to that transaction, like `tx` in a transaction callback.
- **`sandbox.rollback()`** undoes everything and gives the repo its pool back. It does
  nothing when the sandbox has not begun, so it is safe in `afterEach` after a failed
  `beforeEach`. `begin()` twice without a rollback is a `QueryError`.
- **`repo.transaction` inside a test** becomes a savepoint, so code that uses
  transactions works unchanged. Its `isolation`, `readOnly` and `retries` are left out:
  only a real transaction can have them. Two of them started together take turns, and a
  statement made on the repo meanwhile (by a concurrent request, not from inside the
  callback) waits for the open one to end, so that its rollback cannot undo the statement.
- **A write the database refuses** undoes only itself, as it would outside the sandbox:
  each statement made on the repo itself runs in a savepoint of its own (two more
  statements per query, in tests only). Inside `repo.transaction` the usual rules apply.

<<< @/examples/testing.ts#expected-failure

### Parallelism

Vitest runs each test file in its own worker. Each file therefore has its own
sandbox and connection: files run in parallel over one database without seeing each
other's data, and the tests within one file run one after another. Two files that write
the same unique value at the same time both succeed: the second one waits until the
first one's test rolls back.

### Limits

- Code that opens its own connection or pool (another repo, another adapter) is outside
  the sandbox.
- A test cannot observe a real commit. Behaviour that depends on one, such as two
  connections seeing each other's work, needs a test without the sandbox (and its own
  cleanup).
- The repo used inside one of its own `repo.transaction` callbacks (a statement, another
  `repo.transaction`, a bulk insert, a stream) is a `QueryError` in the sandbox. In
  production such a call runs on another connection, outside the transaction (usually a
  mistake: pass `tx`); the sandbox has one connection, where the call could only run
  inside the transaction or wait for it forever. Code that commits on purpose outside a
  transaction it is in needs a test without the sandbox.
- Locks are held until the rollback: a statement on another connection that needs a row
  or a table the test wrote (`DROP`, `ALTER`, `TRUNCATE`) waits for the test to end.
- `repo.inTransaction` stays `false` and `repo.rollback()` stays an error, as in
  production.

## Counting queries

`expectQueries(repo, fn)` runs `fn` and returns the query events it caused, those of its
transactions included. Use it to pin down the number of queries, so an N+1 cannot creep
in:

<<< @/examples/testing.ts#count-queries

Each event has `sql`, `operation`, `source` and `durationMs`. The statements that begin and
end a transaction are counted too, with `operation: "transaction"` (in the sandbox they
are `SAVEPOINT` and `RELEASE`); the sandbox's own statements are not. To count only the
queries, filter them out:
`queries.filter((q) => q.operation !== "transaction")`.

## A database for tests

- **SQLite in memory** needs no service and is the fastest:
  `sqlite({ filename: ":memory:" })`. Check
  [Dialect support](/reference/dialect-support) for features your queries use.
- **The same database as production**, in Docker, is the most faithful. Start it once,
  for example with Docker Compose and `docker compose up -d --wait`, point
  `DATABASE_URL` at it, and create the tables once before the run (a Vitest
  `globalSetup` that runs your migrations). The sandbox keeps them empty between tests.

## Test data

There is no factory helper. A plain function is enough, and `insertOrThrow` makes a bad
fixture fail loudly:

<<< @/examples/testing-app.ts#factory

::: tip Good to know
- **Nothing is committed.** Each test runs in a transaction that is rolled back; there is
  no cleanup to write.
- **Your application's repo is the one under test.** The sandbox routes it through the
  test's transaction, so code that imports the repo itself works unchanged.
- **Code that opens its own connection** is outside the sandbox.
:::

## See also

- [Transactions](/guide/transactions)
- The [tutorial](/guide/tutorial#_10-test-it)'s tests.
