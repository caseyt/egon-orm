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
| `codegen` | `true` | `false` avoids `new Function`, for environments with a strict content security policy. The rows are the same; reading them is slower. |
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
| `preload(rows, spec)` | loaded rows | See [Preloading](/guide/associations#after-the-fact). |

`R` is what the query selects: rows of the schema class (instances of it, with its getters
and methods) unless the query has a `select`.

<<< @/examples/repo.ts#reading

- **`one` is strict.** It adds no `LIMIT`. A second row means the query is wrong, and you
  are told: the error carries the query, without its values. Use `first` when "any one" is
  what you want.
- **`first` replaces the query's own limit** with 1 and keeps its offset. Give the query
  an `orderBy`: without one, which row comes first is up to the database.
- **`get` with `null` or `undefined` throws** `QueryError`, before anything is sent. That is
  almost always a missing id. For a composite key the id is an object of every key field.
- **`exists`** runs `SELECT 1 … LIMIT 1` without the select, the order and the preloads.
  A query with a limit of its own, or a set operation, is checked as a subquery, so its
  limit still counts.
- **`aggregate`** over a field of the query's root: `count` returns a `number`; `sum` and
  `avg` a number (`bigint` for a `t.bigint()` column, a string for a decimal) or `null`;
  `min` and `max` the field's type or `null`. Over no rows `count` is 0 and the others are
  `null`. A query with a limit, an offset, `distinct`, a `groupBy`, a `having` or a set
  operation is aggregated as a subquery, so the aggregate sees exactly its rows
  (`count(from(Post, "p").limit(2))` is at most 2).
- **`reload`** reads a row again from the table and database schema it was read from. Rows
  of one schema are read with one query; an array comes back in the same order, with
  `null` for a row that is gone. Preloaded associations are not read again.

### Parameters and options

A query with [named parameters](/guide/queries#named-parameters) takes them as the second
argument; options come last. A query without named parameters takes options second.

<<< @/examples/repo.ts#params

| Option | Effect |
|---|---|
| `schema` | The database schema for this call. A query's own `.schema()`, and a schema class that declares one, win over it; it wins over the repo's default. |
| `timeoutMs` | Cancels the query after this long. The wait for a connection counts. |
| `signal` | An `AbortSignal` that cancels the query. |
| `context` | Any plain object. It is passed through to the query event, for request ids and the like. |

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

```ts
const result = await repo.insert(User.changeset(User, input));

if (!result.success) {
  return result.error.errorMessages();    // result.error is the changeset
}
const user = result.data;                 // User
```

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

A result is returned for the failures you should expect: invalid input and declared
[constraints](/guide/constraints). Everything else throws: a lost connection, an
undeclared constraint, a stale row.

### Insert

- An invalid changeset is returned as a failure **without touching the database**.
- A required field with no value is reported as `can't be blank`.
- Values written: the changes, then field defaults, then generated values (`createdAt`,
  `updatedAt`, UUID keys). A field with no value is left out of the statement, so a
  database default applies.
- The returned row includes what the database generated. `{ returning: true }`, or a list
  of fields, also reads back columns that a trigger or default changed.

### Update

- Needs a changeset of a loaded row.
- Writes only the columns that changed. **With no changes it runs no query** and returns
  the row; pass `{ force: true }` to update anyway.
- If no row matched, because it was deleted or because an
  [optimistic lock](/guide/changesets#hooks-for-the-repo) failed, it throws
  `StaleEntryError`. `{ allowStale: true }` ignores that, and
  `{ staleError: { field: "lockVersion" } }` reports it on the changeset instead.

### Delete

Deletes by primary key and returns the row. Pass a changeset when you want to declare a
constraint, such as `noAssocConstraint`.

### Insert or update

`insertOrUpdate` chooses from the changeset: one built from a class is inserted, one built
from a loaded row is updated. It is **not** an upsert; the database is not asked whether
the row exists.

### Upserts

`onConflict` tells the database what to do when the insert collides with an existing row.
Without it, a conflict is an error.

```ts
repo.insert(cs, { onConflict: "nothing" });
repo.insert(cs, { onConflict: { target: ["email"], update: "all" } });
repo.insert(cs, { onConflict: { target: ["email"], update: ["name"] } });
repo.insert(cs, { onConflict: { target: { constraint: "users_email_key" }, update: { except: ["createdAt"] } } });
```

- `target` is the conflicting columns, a constraint name, or a `fragment`. MySQL cannot
  take one, so leave it out there.
- `update` is `"all"`, a list of fields, or `{ except: [...] }`.
- With `"nothing"`, a conflict means no row was inserted: the result is
  `{ success: true, data: null }`.

### Bulk writes

Bulk writes skip changesets and validation.

```ts
const { count, rows } = await repo.insertAll(User, [{ email: "a@b.c" }, { email: "d@e.f" }], { returning: true });

await repo.updateAll(from(Post, "p").where({ authorId: 1 }).set({ published: true }));

await repo.deleteAll(from(Post, "p").where({ published: false }));
```

- **`insertAll(Schema, rows, opts?)`** applies field defaults, timestamps and generated
  values to every row, and splits large inserts under the database's parameter limit
  inside one transaction. It accepts `onConflict` and `returning` (`true` or a list of
  fields), and a query in place of `rows` for `INSERT ... SELECT`. A field's value may be
  an expression or a subquery, and the `placeholders` option binds a value once and reuses
  it across rows.
- **`updateAll(query)`** needs a query with [`.set(...)`](/guide/queries-advanced#bulk-updates-and-deletes).
- **`deleteAll(queryable)`** deletes every row the query matches. `repo.deleteAll(User)`
  deletes every user; there is no guard.
- All three return `{ count, rows }`. `rows` is `null` unless the write asked for rows
  back, with `returning` or `.returning(...)`.

## Logging and events

<<< @/examples/repo.ts#logging

- Events: `query`, `connect`, `disconnect`, `poolExhausted`. `repo.on` returns the
  function that unsubscribes.
- A `query` event is one statement the repo ran: the adapter's report (`sql`,
  `paramCount`, `durationMs`, `queueMs`, `rowCount`, `error`) plus `operation` (the method:
  `"all"`, `"one"`, `"first"`, `"get"`, `"getBy"`, `"exists"`, `"aggregate"` for `count` too,
  `"stream"`, `"reload"`, `"explain"`, `"raw"`; a throwing twin reports its base method),
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
