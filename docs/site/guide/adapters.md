# Adapters

An adapter connects a [repo](/guide/repo) to a database. Postgres supports every feature;
SQLite and MySQL support most, and the gaps are listed in
[Dialect support](/reference/dialect-support).

## Postgres

```sh
pnpm add @egon-orm/postgres pg
pnpm add pg-cursor   # optional: only needed for repo.stream
```

<<< @/examples/adapters.ts#connect

| Option | Default | Effect |
|---|---|---|
| `connectionString` | none | A `postgres://` URL. Or `host`, `port`, `user`, `password`, `database`, `ssl`; with both, the separate settings win. With neither, `pg` reads the `PG*` environment variables. |
| `pool` | `{ max: 10 }` | Pool settings (`max`, `idleTimeoutMs`, `connectionTimeoutMs`), or an existing `pg.Pool` to use as it is. |
| `planCacheSize` | `1000` | How many compiled query shapes to keep. |
| `statementTimeoutMs` | none | A server-side limit for every statement (Postgres `statement_timeout`). |
| `applicationName` | none | Shown in `pg_stat_activity`. |

An option given as `undefined` counts as left out, so `process.env.DATABASE_URL` can be
passed as it is. An unknown option, or a value of the wrong type, throws a `TypeError`
when `postgres()` is called. There is no option for type parsing: the field in the
schema decides what a column becomes (see [How values are stored](#how-values-are-stored)).

<<< @/examples/adapters.ts#settings

The adapter connects on first use. Postgres 14 and later are supported.

### Bringing your own pool

<<< @/examples/adapters.ts#own-pool

A pool you pass in stays yours. The adapter does not change its settings or its type
parsers, so the connection options above (`connectionString`, `host`, ...,
`statementTimeoutMs`, `applicationName`) cannot be combined with it: set them on the pool.
`close()` waits for the adapter's own connections to come back and leaves the pool open.

The adapter adds no `error` listener to a pool you bring. `pg` emits `error` on the pool
when an idle connection fails (the server restarts, or ends the session), and an `error`
event without a listener ends the Node.js process, so add one yourself:
`pool.on("error", (error) => logger.warn(error))`. A pool the adapter creates has one.

### Health

<<< @/examples/adapters.ts#health

`repo.ping()` and `repo.poolStats()` pass through to these.

## SQLite

```sh
pnpm add @egon-orm/sqlite better-sqlite3
```

<<< @/examples/adapters.ts#sqlite

| Option | Default | Effect |
|---|---|---|
| `filename` | required | The database file, or `":memory:"` for a database that lives as long as the adapter. |
| `pragmas` | `{}` | Pragmas run in order when the file is opened (`{ journal_mode: "WAL", busy_timeout: 5000 }`). Names and values must be plain words, numbers or booleans. |
| `attach` | `{}` | Databases attached when the file is opened, by schema name (`{ audit: "audit.db" }`). |
| `readonly` | `false` | Opens the file read-only. |
| `planCacheSize` | `1000` | How many compiled query shapes to keep. |

`better-sqlite3` 12 and 13 are supported; version 13 needs Node.js 22.14 or later, and the
adapter says so instead of crashing on an older one. SQLite 3.39 or later (the version
`better-sqlite3` bundles) is assumed.

- Foreign keys are **on**, whatever the SQLite build's own default is; set
  `pragmas: { foreign_keys: false }` to turn them off. A pragma given as `undefined` counts
  as left out.
- `:memory:` is the fastest way to run a test suite: no file, no server.
- **One handle, one caller at a time.** The adapter opens one database handle and hands it
  to one caller at a time, in order: a transaction holds it until it ends, and everything
  else waits. Two transactions never interleave, and there are no isolation levels to
  choose (asking for one throws `QueryError`).
- A transaction starts with a plain (deferred) `begin`: it takes SQLite's write lock at its
  first write. Another process writing the same file at that moment makes the write fail
  with a retryable `DatabaseError` (`SQLITE_BUSY`) once `busy_timeout` runs out.
- Row locks (`lock("update")`) are accepted and not written: with one writer they are
  already satisfied.
- A statement runs synchronously to its end and cannot be stopped. `timeoutMs` is still one
  budget for the whole call: a statement whose budget is spent before it starts is refused
  with the code `"timeout"`, but one statement that runs past the budget finishes.
- The `schema` option names an attached database:

  <<< @/examples/adapters.ts#sqlite-attach

- A unique violation is reported by its columns; see
  [Constraint names](/reference/dialect-support#constraint-names).

## MySQL

```sh
pnpm add @egon-orm/mysql mysql2
```

<<< @/examples/adapters.ts#mysql

| Option | Default | Effect |
|---|---|---|
| `connectionString` | none | A `mysql://` URL. Or `host`, `port`, `user`, `password`, `database`, `ssl`; with both, the separate settings win. |
| `pool` | `{ max: 10 }` | `max`, `idleTimeoutMs`, and `connectionTimeoutMs` (how long to wait for a connection; `0` waits for ever). |
| `planCacheSize` | `1000` | How many compiled query shapes to keep. |

MySQL 8.0.31 or later and `mysql2` 3.11 or later are supported. There is no time zone
option: every session is UTC, so a timestamp means the same instant whatever the server's
or the process's time zone. A connection whose session cannot be set up is closed instead
of used.

- **No rows from writes.** `insert` reads the row back by its key: the generated
  auto-increment id, or the key you gave (a client-generated uuid, a composite key).
  `.returning(...)` on bulk writes throws `QueryError`.
- **Upserts take no target.** `ON DUPLICATE KEY UPDATE` fires on any unique key, so
  `onConflict.target` throws `QueryError`; leave it out. An upsert and the read-back of its
  row run as one unit. When it meets a row by the key it was given, it returns that row.
  When it meets a row through another unique column, the row cannot be found by the given
  key: the upsert is undone and throws `QueryError`, and nothing is written.
- **Comparisons ignore case and accents.** Every connection uses the collation
  `utf8mb4_0900_ai_ci`. Under it `like`, `eq` and unique keys treat `"CAFE"`, `"cafe"`
  and `"café"` as equal (on Postgres `eq` and `like` are exact). Declare a column with a
  binary or `_as_cs` collation in your DDL where you need exact comparisons.
- **DDL commits.** Each DDL statement ends the transaction it runs in, so a migration that
  fails midway is left half-applied; see [Migrations](/guide/migrations).
- **Custom types and `CAST`.** MySQL's `CAST` takes only a few type names (`signed`,
  `double`, `decimal(p, s)`, `char`, …). Beside a column in arithmetic, a value of a type
  made with `defineType` is bound as it is, as on every database (see
  [Expressions](/guide/query-expressions#explicit-values-and-types)). Elsewhere (two values
  with nothing else to type them, a value in a `select`, a value beside an expression) such
  a value is still cast to its type's name, which MySQL refuses unless it is one of those
  names; give the value a built-in type there.
- **`/` of two integers gives a decimal** (`7 / 2` is `3.5000`), where Postgres divides as
  integers (`3`).
- A write conflict between serializable transactions is reported as a deadlock
  (`code: "deadlock"`, retryable), not a serialization failure.
- `timeoutMs` and `signal` stop a statement with `KILL QUERY`, sent on a connection of
  its own.
- A migration's `text` column is a `varchar(255)` on MySQL, because a MySQL `TEXT` column
  can be neither indexed nor given a default. Declare a long text column with
  `m.custom("body", "text")`.
- A unique index created without a name is named after its first column (`email`), not
  `users_email_key`. `uniqueConstraint("email")` matches a violation of it only when the
  index has the conventional name, as the migrations of this library give it; for one
  created otherwise, pass its name: `uniqueConstraint("email", { name: "email" })`.

## How values are stored

The TypeScript type of a field is the same on every database. The adapter converts where
the driver differs:

| Type | Postgres | SQLite | MySQL |
|---|---|---|---|
| `boolean` | `boolean` | `0` / `1` | `tinyint(1)` |
| `bigint` | `bigint` | integer | `bigint` |
| `decimal` | `numeric` | text | `decimal` |
| `uuid` | `uuid` | text, lowercase | `char(36)`, lowercase |
| `date`, `time` | native | ISO-8601 text | native |
| `timestamp` | native | ISO-8601 text in UTC, with milliseconds | `datetime(6)`, UTC |
| `json` | `jsonb` | text | `json` |
| `binary` | `bytea` | blob | `longblob` |
| array | native | JSON text of the elements | `json` (an array of the elements) |

On SQLite and MySQL an array field is stored as a JSON array and read back as an array;
the array operators (`has`, `contains`, `in(arrayExpression)`) are refused with
`QueryError`. A uuid is written in lowercase, as Postgres stores one, so its two spellings
are one key. On SQLite, integers are read exactly: a `t.bigint()` beyond
`Number.MAX_SAFE_INTEGER` keeps every digit. A decimal is text there, so `orderBy` and
range comparisons on a decimal column compare text (`"10.5" < "9.1"`); store money as an
integer number of cents if you sort or compare it. A value with no type
(`val(new Date())`, `val(true)`) is bound as SQLite stores one: timestamp text, `1` / `0`.

On Postgres:

- **`bigint`** columns arrive as text and become a `bigint` for `t.bigint()`, or a
  `number` for `t.bigint({ mode: "number" })`, which throws `CastError` for a value
  beyond `Number.MAX_SAFE_INTEGER` rather than return a neighbouring number. The same
  holds for `count(...)` and `sum(...)`, which Postgres returns as `bigint` and `numeric`.
- **`decimal`** (`numeric`) stays a string, so no digit is lost to floating point.
- **`date`** is read as the `"YYYY-MM-DD"` string Postgres sends. `pg` would otherwise
  build a `Date` at local midnight, which is the day before in time zones west of UTC.
- **`timestamp`** values are written as UTC text and read exactly, whatever the time zone
  of your process or of the database session. A `localTimestamp` (`timestamp without
  time zone`) is read and written by its UTC fields: `getUTCHours()` is the hour stored.
- **`binary`** (`bytea`) arrives as a plain `Uint8Array` over the bytes `pg` read.
- **`json`** is serialised by the adapter, so an array or a string is stored as JSON and
  not as a Postgres array or as text.

These settings apply to this adapter's statements only. The process-wide `pg.types`
registry is never changed, so other code in your process that uses `pg` sees its usual
values.

## Errors

Driver errors are converted to the library's [error classes](/reference/errors), with the
original error kept as `cause`:

- a constraint violation becomes a changeset error when it was
  [declared](/guide/constraints), otherwise a `ConstraintError` with the `type`
  (`unique`, `foreignKey`, `check`, `exclusion`, `notNull`), and the `constraint`,
  `table` and `column` the database reports;
- a serialisation failure or deadlock becomes a `DatabaseError` with `retryable: true`
  and the code `"serializationFailure"` or `"deadlock"`;
- a statement stopped by `statementTimeoutMs` becomes a `DatabaseError` with the code
  `"timeout"`;
- a connection failure (refused, lost, terminated by the server, wrong credentials, no
  free connection within `connectionTimeoutMs`) becomes a `DatabaseError` with the code
  `"connection"`;
- any other database error becomes a `DatabaseError` with the code `"database"`.

<<< @/examples/adapters.ts#errors

The SQL is attached to the error as `sql`. Parameter values are never attached, and a
database message that may quote a value (a data error such as `invalid input syntax`) is
left out of the error's own message; it is still on `cause`.

## Cancellation and timeouts

`timeoutMs` and `signal` (see [Parameters and options](/guide/repo#parameters-and-options))
cancel a statement **on the server**. The adapter sends Postgres's own cancel request: a
short message on a new socket, which needs no login and no free connection slot, and which
PgBouncer passes on to the right server process. It goes to the address the connection is
actually connected to, not to the host name resolved again, so DNS round-robin or a load
balancer cannot send it to another server. When the connection uses TLS (`ssl`, or
`sslmode` in the connection string), the cancel request does too, with the same TLS
options and certificate checks; if TLS cannot be set up, the request is not sent at all,
never in plain text. The call rejects with a `DatabaseError` whose code is `"timeout"` or
`"aborted"` once the statement has stopped, and the connection goes back to the pool
ready for the next statement.

`timeoutMs` is one budget for the whole call: the wait for a free connection counts, and
a call that waits longer than `timeoutMs` rejects with `"timeout"` without running. An
abort while waiting stops the wait the same way. (For a stream, `timeoutMs` bounds the
wait and then each fetch of a batch.)

A statement that had already finished when the cancel arrived is not undone; the call
still rejects. Postgres does not say whether a cancel request stopped anything. A request
that fails (the server unreachable within `connectionTimeoutMs`, 10 seconds without one,
or TLS refused) lets the statement run to its end before the call rejects, and because the
request might still reach the server late and cancel whatever runs next, that connection
is never reused: a pooled one is closed, and a dedicated one (a transaction's) refuses
further statements with the code `"connection"` and is closed when released.
Inside a transaction, a cancelled statement aborts the transaction, as any failed
statement does.

`statementTimeoutMs` is the same limit set once for every statement, enforced by
Postgres itself.

## Logging and events

The adapter reports every statement, and the pool's `connect`, `disconnect` and
`poolExhausted` events, to the repo, which exposes them through `repo.on(...)` and its
`log` option (see [Logging and events](/guide/repo#logging-and-events)). A `query`
event carries the SQL, the number of parameters, the time spent waiting for a connection
(`queueMs`) and running (`durationMs`), the row count and the error, if any. Parameter
values are included only with `log: { params: true }`, and the value of a redacted field
is always replaced by `**redacted**`.

When nobody listens, the adapter does not measure anything. A listener that throws does
not fail the statement, but its error is rethrown as an uncaught exception, which ends the
process unless you handle `uncaughtException`: catch errors inside your listener.

## Pool behaviour

- A query waits for a free connection when the pool is busy. `connectionTimeoutMs` bounds
  the wait, and the `poolExhausted` event fires when a query has to queue.
- A connection that fails at the protocol level (lost, or terminated by the server) is
  discarded, not reused. So is a connection that is returned while still inside a
  transaction.
- An idle connection that the server closes is dropped from the pool without an error;
  the next query opens a new one. A checked-out connection that the server closes fails
  its next statement with the code `"connection"` and is discarded when it is released.
- While a stream is open on a connection, another statement on that connection throws
  `QueryError`: finish the stream, or leave its loop, first. Releasing the connection
  while its stream is open ends the stream: its next fetch rejects with the code
  `"connection"`.
- `repo.close()` waits for running queries and checked-out connections, and can be called
  more than once. Calls made after it reject with a `DatabaseError` (code `"connection"`).

::: tip Good to know
- Nothing connects until the first query, so creating an adapter never fails because the
  database is down. Use `repo.ping()` at start-up to check.
- `pg-cursor` is only loaded the first time you stream. Without it, `repo.stream` throws a
  `QueryError` telling you to install it.
- A statement list without parameters (`"select 1; select 2"`) runs in one round trip and
  returns the last statement's rows.
:::

## Capabilities

Each adapter states what its database can do. A query that needs something missing throws
`QueryError` naming the feature and the database when it is compiled, never a syntax
error from the database:

```
QueryError: FULL JOIN is not supported by mysql
```

## See also

- [Repo](/guide/repo): the options of every call.
- [Dialect support](/reference/dialect-support)
- [Configuration](/reference/configuration)
- [Framework integration](/guide/frameworks): pools in servers and serverless functions.
