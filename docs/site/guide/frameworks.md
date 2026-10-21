# Framework integration

How a repo fits into a web server: where to create it, what to do per request, how to map
errors to responses, and how to shut down. The examples are type-checked against Express
5, Fastify 5, Hono 4 and React 19 types.

## One repo per process

<<< @/examples/frameworks.ts#repo

- Create the repo once, at module scope, and import it where it is needed. It holds the
  connection pool; creating one per request would open a pool per request.
- Nothing connects until the first query, so importing the module never fails because the
  database is down. Call `repo.ping()` at start-up, or in a health check, to find out.
- There is no per-request object to create. A request that needs a transaction opens one
  with `repo.transaction` and passes `tx` on.

## The request lifecycle

### Express

<<< @/examples/frameworks.ts#express

- A write returns a result: invalid input becomes a 422 with the field errors, without a
  `try`.
- The errors the library throws have classes and stable `code`s (see
  [Errors](/reference/errors)), so one error handler can map them.
- `context` is passed through to the `query` events of the call: put the request id there
  to find a request's statements in the logs.

### Fastify

<<< @/examples/frameworks.ts#fastify

`repo.on("query", …)` sees every statement, with the call's `context`. Here it logs the slow
ones through Fastify's logger; `log: true` on the repo writes every statement to standard
error instead. `repo.on` returns the function that removes the listener, so an app built
twice (in tests, say) does not leave the first app's listener behind.

### Hono

<<< @/examples/frameworks.ts#hono

- `signal` cancels the query on the server when it aborts. Passing the request's signal
  stops the work of a request whose client went away, where the runtime aborts that signal.
- A transaction is opened by the handler that needs it, and only the calls on `tx` are in
  it. There is no transaction per request behind your back.

## Next.js

### Reusing the repo in development

In development, Next.js evaluates modules again when files change, and a module-scope repo
would open a new pool each time. Keep it on `globalThis` outside production:

<<< @/examples/frameworks.ts#nextjs-repo

### Server actions that return changeset errors

<<< @/examples/frameworks.ts#nextjs-action

`errorMessages()` is plain, serialisable data, so a server action can return it to the
client as it is. The [form errors recipe](/recipes/form-errors) shows the React side, with
`useActionState`.

Use the repo in server code only (server components, route handlers, server actions): it
needs Node.js, not a browser or the Edge runtime.

## Graceful shutdown

<<< @/examples/frameworks.ts#shutdown

`repo.close()` waits for the queries that are running and for checked-out connections
(a transaction in progress, an open stream), then ends the pool. Calls made after it reject
with a `DatabaseError` whose code is `"connection"`. So close the HTTP server first, and wait
for its callback: `server.close()` returns at once, while requests that are still running
may have queries left to run. A server with long-lived connections (keep-alive, streaming
responses) may need a time limit on that wait.

## Serverless functions

<<< @/examples/frameworks.ts#serverless

- **Create the repo outside the handler**, so that warm invocations reuse its connection.
- **Keep the pool small.** Each running instance has its own pool: a hundred instances
  with `max: 10` can ask for a thousand connections. Put a connection pooler such as
  PgBouncer in front of Postgres when instances scale out.
- **With a pooler in transaction mode,** session state does not survive between
  transactions: `SET` statements and advisory locks taken through `repo.checkout` are lost.
  Statements are sent without named server-side prepared statements, and cancellation
  requests pass through PgBouncer (see [Adapters](/guide/adapters#cancellation-and-timeouts)).
- **Set timeouts.** A frozen or recycled instance can leave a request waiting; `timeoutMs`
  per call, and `connectionTimeoutMs` on the pool, bound it.
- **Edge runtimes** without Node.js's `net` module cannot run the `pg`, `mysql2` or
  `better-sqlite3` drivers, and so cannot run the adapters.

::: tip Good to know
- **No ambient state.** The library keeps nothing per request: no current transaction, no
  identity map. Two requests share the pool and nothing else.
- **`warnOnRootUseInTransaction: true`** in development warns when code inside a
  transaction callback uses the outer repo by mistake. See
  [Transactions](/guide/transactions#the-explicit-rule).
- **Testing a server**: import the same repo in your tests and wrap each test in the
  [sandbox](/guide/testing), which routes the repo through a transaction that is rolled
  back.
:::

## See also

- [Repo: setup, reads, writes](/guide/repo)
- [Adapters](/guide/adapters): pool options and events
- [Errors](/reference/errors)
