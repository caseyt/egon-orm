# Repo: setup, reads, writes

The repo is the only thing that talks to the database. It runs [queries](/guide/queries)
and persists [changesets](/guide/changesets).

## Creating a repo

<<< @/examples/repo.ts#create

A repo is an ordinary value: export it and import it where it is needed. A second database
or a read replica is a second repo. Nothing connects until the first query.

| Option | Default | Effect |
|---|---|---|
| `adapter` | required | The database connection. See [Adapters](/guide/adapters). |
| `schema` | none | The default database schema (a Postgres schema, a MySQL database). |
| `log` | `false` | `true`, a function receiving each query event, or `{ params: true }` to include parameter values. See [Logging and events](#logging-and-events). |
| `codegen` | `true` | Whether the repo's row decoders are generated with `new Function`. `false` builds them without generating code; the rows are the same, reading them is slower. With `true`, a runtime that refuses `new Function` is detected on the first query and the repo falls back silently. (Other parts of the library still try `new Function` once when they load; they too fall back on their own.) |
| `warnOnRootUseInTransaction` | `false` | Development only. See [Transactions](/guide/transactions#the-explicit-rule). |

An unknown option, or an option of the wrong type, throws `TypeError`. An option set to
`undefined` counts as left out.

<<< @/examples/repo.ts#health

`planCacheStats()` reports the adapter's [plan cache](/internals/compiler#cache-statistics).

## Reading

A **queryable** is a schema class or a query. `repo.all(User)` returns every user.

| Method | Returns | Notes |
|---|---|---|
| `all(queryable)` | `R[]` | A fresh array of fresh rows. |
| `one(queryable)` | `R \| null` | Throws `MultipleResultsError` if more than one row matches. |
| `oneOrThrow(queryable)` | `R` | Also throws `NoResultsError` if none matches. |
| `first(queryable)` | `R \| null` | Adds `LIMIT 1`. Never throws for extra rows. |
| `get(Schema, id)` | `Row \| null` | By primary key. |
| `getOrThrow(Schema, id)` | `Row` | |
| `getBy(queryable, clauses)` | `R \| null` | `clauses` is the [object form](/guide/queries#object-form) of `where`. Strict, like `one`. |
| `getByOrThrow(queryable, clauses)` | `R` | |
| `exists(queryable)` | `boolean` | |
| `count(queryable)` | `number` | |
| `aggregate(queryable, fn, field?)` | see below | `fn` is `"count"`, `"sum"`, `"avg"`, `"min"` or `"max"`. |
| `stream(queryable)` | `AsyncIterable<R>` | See [Streaming](#streaming). |
| `reload(row)` | `Row \| null` | A fresh copy; `null` if it was deleted. Also takes an array. |
| `reloadOrThrow(row)` | `Row` | |
| `preload(Schema, rows, spec)` | loaded rows | New rows; see [Preloading](/guide/associations#after-the-fact). |

`R` is what the query selects: rows of the schema class (instances of it, with its getters
and methods) unless the query has a `select`.

<<< @/examples/repo.ts#reading

- **`one` is strict.** It adds no `LIMIT`. A second row means the query is wrong, and you
  are told: the error carries the query, without its values. Use `first` when "any one" is
  what you want.
- **`first` returns at most one row, and never more than the query's own limit**:
  `first(q.limit(0))` is `null`. The offset is kept. Give the query an `orderBy`: without
  one, which row comes first is up to the database.
- **`get` with `null` or `undefined` throws** `QueryError`, before anything is sent. That is
  almost always a missing id. For a composite key the id is an object of every key field.
- **`exists`** runs `SELECT 1 … LIMIT 1` without the select, the order, `distinct` and
  the preloads. Where dropping them could change the answer, the query is checked as a
  subquery instead: a limit of its own, a set operation, `distinct` together with an
  offset, and a select that aggregates without a `groupBy` (it has a row even over no
  rows).
- **`aggregate`** over a field of the query's root: `count` returns a `number`; `sum` and
  `avg` a number (`bigint` for a `t.bigint()` column, a string for a decimal) or `null`;
  `min` and `max` the field's type or `null`. Over no rows `count` is 0 and the others are
  `null`. A query with a limit, an offset, `distinct`, a `groupBy`, a `having`, a set
  operation, a row lock, or a select that aggregates by itself is aggregated as a
  subquery, so the aggregate sees exactly its rows (`count(from(Post, "p").limit(2))` is
  at most 2). A [fragment](/guide/query-expressions#fragments) in the select counts as
  possibly aggregating, since its SQL cannot be checked. A query read through a subquery
  must select the field's column: whole rows of its root, or an object whose key of that
  name is that column; anything else is a `QueryError`, and the error says why. Compute
  the aggregate in the query's own select and read it with `one` instead.
- **`reload`** reads a row again from the table and database schema it was read from. Rows
  of one schema are read together: on Postgres in one statement whatever their number
  (each key field's values go as one array); elsewhere, and for a key column that holds
  arrays or JSON, in statements of at most 1,000 rows. The database matches the keys with
  its own equality (a decimal whose scale changed is still the same key). An array comes
  back in the same order, with `null` for a row that is gone. What the row was preloaded
  with is loaded again, callbacks included (see
  [Associations](/guide/associations#after-the-fact)).
- **A key the row cannot hold exactly is not found again**: a JavaScript `Date` holds
  milliseconds, so a row whose timestamp key has microseconds reloads as `null` (and
  `get` with that `Date` finds nothing). Avoid such keys, or reload by another column.
- **`reload` sends the keys typed by their fields' declared types.** A key column whose
  database type differs, such as a `t.enum` field over a native Postgres enum column,
  fails with "operator does not exist" (a `where` or `get` on it works). Declare such a
  field with [`defineType`](/guide/types) and the column's SQL type
  (`db: { kind: "custom", sql: "mood" }`); `reload` then casts the keys to it.
- **`get` with an array** throws `QueryError` (unless the key column itself holds arrays
  or JSON):
  to read several rows by key, use `where(({ u }) => u.id.in(ids))`.

### Parameters and options

A query with [named parameters](/guide/queries#named-parameters) takes them as the second
argument; options come last. A query without named parameters takes options second.

<<< @/examples/repo.ts#params

| Option | Effect |
|---|---|
| `schema` | The database schema for this call. A query's own `.schema()`, and a schema class that declares one, win over it; it wins over the repo's default. |
| `timeoutMs` | Cancels the query after this long. The wait for a connection counts, and so does every statement of the call: its preloads, the chunks of a `reload`. |
| `signal` | An `AbortSignal` that cancels the query. |
| `context` | Any plain object. It is passed through to the query event, for request ids and the like. |
| `maxConcurrency` | How many preload statements of the call may run at once. Default 1; inside a transaction always 1. |

A query that exceeds `timeoutMs` rejects with `DatabaseError` and the code `"timeout"`;
one cancelled through `signal` rejects with the code `"aborted"`. An unknown option throws
`TypeError`, and so does passing named parameters to a query that has none.

### Streaming

<<< @/examples/repo.ts#stream

Rows are fetched in batches (`batchSize`, default 500) with a server-side cursor and turned
into rows one at a time. Leaving the loop early (`break`, `return`, an exception) closes the
cursor and returns the connection. Streams do not support preloads: a stream with one
throws `QueryError` and suggests reading in batches instead.

On Postgres a stream needs no transaction. It holds one connection until the loop ends;
inside `repo.transaction`, stream on `tx`.

### Reloading

<<< @/examples/repo.ts#reload

### Raw SQL

<<< @/examples/repo.ts#raw

- `toSql` returns the SQL and the parameters exactly as they would be sent, redacted values
  included: it is a debugging tool, not a log.
- `explain` returns the plan as text, or with `format: "json"` the database's structured
  plan. With `analyze: true` the query really runs.
- `repo.raw` takes a [`fragment`](/guide/query-expressions#fragments) only, whose
  interpolations are bound parameters. Passing a string is a compile error and throws. The
  rows come back as the driver returns them, not converted to field types.

::: tip Good to know
- Reads never cache rows: every call queries the database. What is cached is the plan of
  the SQL, per query shape.
- There is no lazy loading. A row has the associations you preloaded and nothing else.
:::

## Writing

Writes take a changeset and return a **result**:

<<< @/examples/repo-write.ts#result

```ts
type Result<T, E> = { success: true; data: T } | { success: false; error: E };
```

| Method | Returns | Throwing twin |
|---|---|---|
| `insert(changeset, opts?)` | `Result<Row, Changeset>` | `insertOrThrow` |
| `update(changeset, opts?)` | `Result<Row, Changeset>` | `updateOrThrow` |
| `delete(rowOrChangeset, opts?)` | `Result<Row, Changeset>` | `deleteOrThrow` |
| `insertOrUpdate(changeset, opts?)` | `Result<Row, Changeset>` | `insertOrUpdateOrThrow` |

The `OrThrow` methods return the row and throw `InvalidChangesetError`, which carries the
changeset.

A result is returned for the failures you should expect: invalid input, a required field
without a value, a declared [constraint](/guide/constraints), and (when you ask for it) a
stale row. Everything else throws: a lost connection, an undeclared constraint, a stale
row by default, a changeset of the wrong kind.

Every write takes the read options (`schema`, `timeoutMs`, `signal`, `context`). For a
write, the per-call `schema` is the strongest place a database schema can come from: an
insert goes to it, else to the schema class's own, else to the repo's default; an update
or delete goes where the row was read from. `timeoutMs` is one budget for the whole call,
however many statements it runs.

### Insert

<<< @/examples/repo-write.ts#insert

- Takes a changeset of a new record (`cast(User, …)`, `change(User, …)`). A changeset of a
  loaded row is refused (use `update`, or `insertOrUpdate`); the types refuse it too.
- An invalid changeset is returned as a failure **without touching the database**.
- The [`prepareChanges`](/guide/changesets#hooks-for-the-repo) functions run next, in
  order, on the changeset with `repo` and `action` set.
- Values written: the changes, then field defaults (a function default is called), then
  generated values (`createdAt` and `updatedAt` share one instant; UUID keys). A field with
  no value is left out of the statement, so a database default applies; `null` is written
  as `NULL`. A field declared `writable("never")` is never written.
- A non-nullable field that is left without a value (or set to `null`), and that the
  database does not generate, is reported as `can't be blank` before any SQL is sent.
- The returned row has the values written and what the database returned: the primary
  key, `dbGenerated()` fields and `writable("never")` fields. A database default on a
  column whose field declares no default is not read back: pass `{ returning: ["field"] }`,
  or `{ returning: true }` for every field. Virtual fields keep their changes.

### Update

<<< @/examples/repo-write.ts#update

- Needs a changeset of a loaded row.
- Writes only the columns that changed, plus `updatedAt`. **With no changes it runs no
  query** and returns the row; pass `{ force: true }` to update anyway (only `updatedAt`
  then). A field declared `writable("insert")` or `writable("never")` is not updated.
- If no row matched, because it was deleted or because an
  [optimistic lock](/guide/changesets#hooks-for-the-repo) failed, it throws
  `StaleEntryError`. `{ allowStale: true }` treats the row as updated, and
  `{ staleError: { field, message? } }` reports it on the changeset instead (default
  message `is stale`).
- The returned row keeps the row's preloaded associations.

### Delete

<<< @/examples/repo-write.ts#delete

Deletes by primary key (and the optimistic-lock value, if the changeset declares one) and
returns the row in the `deleted` state. Pass a changeset when you want to declare a
constraint, such as `noAssocConstraint`. It takes `staleError` and `allowStale` as update
does.

### Insert or update

<<< @/examples/repo-write.ts#insert-or-update

`insertOrUpdate` chooses from the changeset: one built from a class is inserted, one built
from a loaded row is updated. It is **not** an upsert; the database is not asked whether
the row exists.

### Upserts

`onConflict` tells the database what to do when the insert collides with an existing row.
Without it, a conflict is an error.

<<< @/examples/repo-write.ts#upsert

- `target` is the conflicting fields, `{ constraint: name }`, or a `fragment` (an index
  expression, written with its parentheses). Postgres needs a target for an update: there
  is no guessing from the primary key. MySQL cannot take one, so leave it out there.
- `update` is `"all"` (every inserted column), a list of fields, or `{ except: [...] }`.
- With `"nothing"`, a conflict means no row was inserted: the result is
  `{ success: true, data: null }` (and `insertOrThrow` returns `null`). The type of `data`
  includes `null` only when the call passes `onConflict: "nothing"`.
- An upsert that updates reads the whole row back, since the row it updated may hold other
  values than the ones you sent.

### Bulk writes

Bulk writes skip changesets and validation.

<<< @/examples/repo-write.ts#bulk

- **`insertAll(Schema, rows, opts?)`** applies field defaults, timestamps (one instant for
  the whole call) and generated values (a UUID per row) to every row. Every row is written
  with the same column list; a field a row leaves out is written as `DEFAULT`, so the
  database default applies. Large inserts are split under the database's parameter limit
  (65,535 on Postgres) **inside one transaction** (a savepoint, when the call is made on a
  transaction's `tx`): a failure in any chunk inserts nothing.
  It accepts `onConflict` (with `"nothing"`, `count` leaves out the skipped rows) and
  `returning`: `true` returns rows of the schema, a list of fields returns plain objects of
  those fields.
- A field's value may be an expression of the field's type, a subquery written
  `scalar(query)`, or a named parameter `param(name, type)` whose value the `placeholders`
  option gives once for every row. A scalar subquery is typed `T | null`, so for a field
  that is not nullable say it cannot be null, `scalar(query).as<number>()`, or give a
  fallback, `coalesce(scalar(query), 0)`. A query in place of `rows` is
  `INSERT ... SELECT`: its select's keys are the fields to fill.
- The target column gives a value its type, as in `set`: a plain value and `val(x)` are
  bound with the field's type, and a `caseWhen` or `coalesce` made only of values and
  `null` is cast to it, in the rows and in the select of `INSERT ... SELECT`.

<<< @/examples/repo-write.ts#bulk-values

- **`updateAll(query, params?, opts?)`** needs a query with
  [`.set(...)`](/guide/queries-advanced#bulk-updates-and-deletes); there is no options
  shorthand. **`deleteAll(queryable, params?, opts?)`** deletes every row the query
  matches. Joins become `UPDATE ... FROM` and `DELETE ... USING`.
- All three return `{ count, rows }`. `rows` is `null` unless the write asked for rows
  back, with `returning` or `.returning(...)`.

<<< @/examples/repo-write.ts#bulk-update

::: warning Good to know
- `repo.deleteAll(User)` deletes every user, and an `updateAll` without `where` updates
  every row. There is no guard: check the query before you run it.
- A write never validates by itself: validation is what the changeset did before. The repo
  checks only that required fields have a value.
- One constraint error is reported per attempt: the database stops at the first violation.
- Nested changes (associations given to `cast`) are not written yet; a changeset that holds
  them is refused with a `QueryError`.
:::

## Logging and events

<<< @/examples/repo.ts#logging

- Events: `query`, `connect`, `disconnect`, `poolExhausted`. `repo.on` returns the
  function that unsubscribes.
- A `query` event is one statement the repo ran: the adapter's report (`sql`,
  `paramCount`, `durationMs`, `queueMs`, `rowCount`, `error`) plus `operation` (the method:
  `"all"`, `"one"`, `"first"`, `"get"`, `"getBy"`, `"exists"`, `"aggregate"` for `count` too,
  `"stream"`, `"reload"`, `"preload"` (each statement that loads associations, of any
  read, of `repo.preload` and of `reload`), `"explain"`, `"raw"`, `"insert"`, `"update"`, `"delete"`,
  `"insertAll"` (one event per chunk), `"updateAll"`, `"deleteAll"`; a throwing twin
  reports its base method, and `insertOrUpdate` the write it made),
  `source` (the table the query reads from), `decodeMs` (the time spent turning result rows
  into rows; for a stream, the total) and `context`. A stream reports one event, when it
  ends.
- `log: true` writes one line per statement to standard error:
  `egon all users 1.25 ms (queue 0.02 ms, decode 0.10 ms) 3 rows: select …`.
  `log: (event) => …` receives each event instead.
- Parameter values are included only with `log: { params: true }`, in the log lines and in
  every `query` event of the repo.
- Values of [redacted](/guide/schemas#fields) fields are never logged: they appear as
  `**redacted**`.
- `context` is whatever the call passed as its `context` option.
- Statements another repo runs on the same adapter are not reported to this one.
- When nobody listens, nothing is measured.
- A listener that throws does not fail the statement, but its error is rethrown as an
  uncaught exception, which ends the process unless you handle `uncaughtException`: catch
  errors inside your listener.
