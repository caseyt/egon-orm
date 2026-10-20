# Migrations

Migrations change the database's structure in versioned, ordered steps. Each one is a
TypeScript file in a migrations directory, written by hand with a small set of operations,
and the runner applies the pending ones and records what it applied.

<<< @/examples/migrations.ts#create-users

The file name holds the version and the name: `20261012093000_create_users.ts` is version
`20261012093000` (a UTC timestamp, `YYYYMMDDHHMMSS`) named `create_users`. `egon migrate
create create_users` writes such a file, with an empty `change` for you to fill in
([CLI reference](/reference/cli#egon-migrate-create-name)).

If you come from Prisma Migrate or drizzle-kit: there is no schema diffing. You write the
change you want, as with Sequelize's or Knex's migrations; the schema classes and the
migrations are kept in step by you, not inferred from each other.

## Running migrations

From the command line, with the configuration in [`egon.config.ts`](/reference/cli#configuration):

```sh
egon migrate create add_age  # write migrations/<version>_add_age.ts
egon migrate                 # apply every pending migration
egon migrate --dry-run       # print the SQL, run nothing
egon rollback                # roll back the latest one
egon migrations              # list them: up, down or missing (claimed: see SQLite below)
```

From code, with `createMigrator` from `egon-orm/migration`:

<<< @/examples/migrations.ts#migrator

The migrator takes the **adapter**, the same one you give `createRepo` (or one of its own).

## Reversible migrations and up/down

A migration is either **reversible**, with `change(m)`, or written in **both directions**,
with `up(m)` and `down(m)`.

With `change`, the runner rolls the migration back by running the inverse of each
operation, last first: `createTable` becomes `dropTable`, `rename(a, b)` becomes
`rename(b, a)`, `add` becomes `remove`, and so on. Some operations do not hold what their
inverse needs; they are accepted when the migration is applied and refused with
`MigrationError` **when it is rolled back**, with the fix in the message:

| Operation in `change` | Why it cannot be rolled back | The fix |
|---|---|---|
| `t.remove("age")` | the column's type is unknown | `t.remove("age", "integer")` |
| `t.modify("age", "bigint")` | the previous type is unknown | `t.modify("age", "bigint", { from: "integer" })` (with `notNull` and `default` in `from` when you change them) |
| `m.execute(sql)` | there is no statement that undoes it | `m.execute(up, down)` |
| `m.dropTable("users")` | there is no definition to create it from | `m.dropTable("users", (t) => { … })` |
| `m.dropConstraint(table, name)` | there is no definition | pass `{ check }` or `{ exclude }` |
| anything with `ifNotExists` / `ifExists`, `cascade`, `dropExtension` | the inverse could destroy something the migration did not create, or cannot restore what it dropped | write `up` and `down` |

Use `up`/`down` for data changes and anything the inverses cannot express:

<<< @/examples/migrations.ts#up-down

A migration with `up` and no `down` cannot be rolled back; trying is a `MigrationError`.

## Operations

| Operation | Options |
|---|---|
| `m.createTable(name, (t) => …, options?)` | `schema`, `ifNotExists`, `primaryKey: false` |
| `m.alterTable(name, (t) => …, options?)` | `schema` |
| `m.dropTable(name, define?, options?)` | `schema`, `ifExists`, `cascade` |
| `m.renameTable(from, to, options?)` | `schema` |
| `m.createIndex(table, columns, options?)` / `m.dropIndex(…)` | `unique`, `name`, `where`, `using`, `include`, `concurrently`, `schema`, `ifNotExists` / `ifExists` |
| `m.createConstraint(table, name, options)` / `m.dropConstraint(…)` | `check` or `exclude` (a fragment), `using`, `schema`; `ifExists` on drop |
| `m.execute(up, down?)` | two fragments; their interpolations are bound parameters |
| `m.createSchema(name)` / `m.dropSchema(name)` | `ifNotExists` / `ifExists`, `cascade` (a database schema) |
| `m.createExtension(name)` / `m.dropExtension(name)` | `ifNotExists`, `schema` / `ifExists` |

A table must have a primary key: `t.id()`, or `.primaryKey()` on its key columns (several
make a composite key). Pass `{ primaryKey: false }` for a table that has none on purpose.

Inside `alterTable`, the column methods add columns, and `modify`, `remove` and `rename`
change existing ones:

<<< @/examples/migrations.ts#alter

### Columns

The column methods are named after the column types (`DbType`): `integer`, `bigint`,
`float`, `decimal`, `boolean`, `text` (also `string`), `uuid`, `binary`, `date`, `time`,
`timestamp`, `timestamptz`, `json`, `jsonb`, `array(name, of)` and `custom(name, sql)`.
`t.add(name, type)` takes any type, such as `{ kind: "decimal", precision: 10, scale: 2 }`.

The helpers:

| Helper | Column |
|---|---|
| `t.id()` | `"id" bigserial primary key`; `t.id("id", { type: "integer" })` for `serial` (the first argument is the column name) |
| `t.references(column, table, options?)` | a `bigint` (or `type`) with a foreign key to `table` (`column`, `onDelete`, `onUpdate`, `schema`, `name`) |
| `t.enumText(column, values)` | `text` with a check constraint allowing only `values` |
| `t.timestamps()` | `created_at` and `updated_at`, `timestamptz not null default now()` |

Each returns a column builder: `.notNull()`, `.nullable()`, `.default(value)`,
`.primaryKey()`, `.unique()`.

A column default is a constant (a string, number, bigint, boolean, `null`, or for `json` and
`jsonb` an object or array) or an expression as a fragment, ``.default(fragment`now()`)``.
DDL takes no bound parameters, so a constant is written into the statement as a SQL literal:
strings with their quotes doubled (on Postgres as an `E'…'` string with doubled
backslashes when they hold a backslash), numbers only when finite. Fragments in DDL (a
default, an index predicate, a constraint) may interpolate identifiers with
`fragment.ident()`, but not values.

## Index and constraint names

Migrations name what they create the way the changeset constraint functions expect, so a
database error becomes a changeset error without either side naming anything:

| Created by | Default name | Matched by default by |
|---|---|---|
| `m.createIndex(table, cols, { unique: true })`, `.unique()` | `<table>_<columns>_key` | `uniqueConstraint(fields)` |
| `t.references(column, …)` | `<table>_<column>_fkey` | `foreignKeyConstraint`, `assocConstraint`, `noAssocConstraint` |
| `t.enumText(column, …)` | `<table>_<column>_check` | `checkConstraint(field, { name })` |
| `m.createIndex(table, cols)` | `<table>_<columns>_index` | (not a constraint) |

<<< @/examples/migrations.ts#changeset-pairing

A name longer than the database keeps (63 bytes on Postgres) is shortened the way Postgres
shortens the names it makes itself, and the changeset defaults match the shortened name.
Pass `name` to choose your own; then give the same name to the changeset function.

<<< @/examples/migrations.ts#indexes

<<< @/examples/migrations.ts#constraints

## How the runner works

- **Order.** Pending migrations run oldest version first. A pending migration older than
  the latest applied one (merged from another branch) is applied too, with a warning.
- **Transactions.** Each migration runs in its own transaction where the database has
  transactional DDL (Postgres and SQLite do); if it fails, it is rolled back and the run
  stops. With `transaction: false` it runs without one, and a failure can leave it partly
  applied. **MySQL commits after every DDL statement**, so there a migration that fails
  midway is always left partly applied and is not recorded: fix the database by hand (or
  write migrations of one DDL statement each) before running again.
- **The lock.** The runner holds a lock for the whole run (on Postgres a session-level
  advisory lock keyed by the tracking table, on MySQL `GET_LOCK` with a name derived from
  it), so two deploys that start at once take turns: the second waits, then finds nothing
  left to do. `lockTimeoutMs` makes it give up instead.
- **The lock on SQLite.** SQLite has no lock outside a transaction, so the runner holds a
  write transaction (`begin immediate`) for the whole run, and each migration is a savepoint
  inside it. While it runs, every other writer to the file waits until the run ends: another
  runner, in this process or another, tries again every 25 ms until `lockTimeoutMs`, and
  other writes to the file fail with a retryable `SQLITE_BUSY` once their `busy_timeout`
  runs out. Keep migration runs out of busy periods.
- **`transaction: false` on SQLite.** Some statements cannot run in a transaction at all
  (`vacuum`), and `pragma foreign_keys = off` is ignored inside one, which the table
  rebuild needs (copy, drop, rename: the way to change a column on SQLite). Such a migration
  runs outside the lock:
  1. the runner records a claim (a row with version `-1` in the tracking table) and commits;
  2. it runs the migration with no transaction;
  3. it takes the lock again, removes the claim and records the version.

  Another runner that gets the lock while the claim is there gives it back and waits, so
  two runners never both run it.

  If the process dies in step 2, the claim stays behind:
  - `egon migrations` (`status()`) lists it as `claimed`, version `-1`;
  - a later run warns once (a `warning` event, which `egon migrate` prints), then waits for
    the claim to go;
  - with `lockTimeoutMs`, it gives up instead.

  Check what the migration did, then delete the row with version `-1`; a waiting run then
  carries on.

  After such a migration, whether it succeeded or failed, the runner:
  - rolls back a transaction the migration left open (a `begin` without a `commit` is a
    failure);
  - puts `foreign_keys` back as it was before, since the adapter's one handle is shared
    with the application.

  A failure is reported as "failed inside a transaction of its own, which was rolled
  back" when the migration's own transaction was undone, and otherwise as "ran without a
  transaction": statements before the failing one stay applied.

  A table rebuild follows SQLite's own order:
  1. foreign keys off, outside any transaction;
  2. the rebuild and its check inside `begin … commit`;
  3. foreign keys on.

  A row left without its parent fails the check, and the whole rebuild is rolled back:

  <<< @/examples/migrations.ts#sqlite-rebuild

- **Tracking.** Applied versions are rows of `schema_migrations (version bigint primary key,
  created_at timestamp(0))`, created by the first `up` or `down` that is not a dry run
  (`status` and dry runs never create it), with `created_at` in UTC.
- **Missing files.** A recorded version with no migration file shows as `missing`. Rolling
  back past it is refused until the file is restored.
- **Dry run.** `up({ dryRun: true })` and `down({ dryRun: true })` return the SQL of each
  migration and change nothing, not even the tracking table.

## Zero-downtime changes

- Build indexes on large tables with `concurrently: true`. It cannot run inside a
  transaction, so the migration needs `transaction: false` (the runner refuses otherwise).
  Keep such a migration to that one operation: without a transaction, a failure leaves the
  earlier statements applied.
- Add a column as nullable (or with a default), backfill it in an `up`/`down` migration,
  and add `notNull` in a later one.
- Rename in steps: add the new column, write to both, then drop the old one.

## Running in CI and deploys

Run `egon migrate` before the new code starts. It exits with 0 on success and 1 on a
failure, prints a line per migration with its duration, and with `--json` prints one JSON
object instead. Several instances may run it at once; the lock serialises them.

## Loading migration files

Migration files are loaded with `import()`. TypeScript files need a process that can load
TypeScript: Node 22.18 or later strips types by itself (22.12 to 22.17 with
`--experimental-strip-types`), or run under tsx (`node --import tsx`) or Bun. Without one,
the error says what to install. A file exports its migration as the default export (or as
`migration`).

For bundlers and deployments without a file system, pass the migrations as a list:

<<< @/examples/migrations.ts#in-memory

## Adopting an existing database

To start using migrations on a database that already has its tables, write a first
migration that describes them (`egon migrate create initial` gives you the empty file), and
record it as applied without running it. On a database that has never been migrated the
tracking table does not exist yet, so create it first, as the runner would:

<<< @/examples/migrations.ts#baseline

If the database already has a `schema_migrations` table from another tool, with a
`version bigint` column, the runner reads it as it is. Its versions count as applied; name
its timestamp column if it is not `created_at`:

<<< @/examples/migrations.ts#adopt

::: tip Good to know
- Columns allow `NULL` unless you call `.notNull()`, as in SQL. (Schema fields are the
  other way round: non-null unless `.nullable()`.)
- The column method `timestamp` is a timestamp **without** a time zone and `timestamptz` one
  with it; the schema field `t.timestamp()` is stored as `timestamptz`, and `t.json()` as
  `jsonb`.
- Nothing is inferred from your schema classes when migrations run: a migration describes
  the database, and the schema classes describe your code.
- Rolling back a `change` migration that created a table drops it, with its rows.
:::
