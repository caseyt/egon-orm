# Configuration

Every option the library takes, in one place, with a link to where it is explained. An
unknown option, or a value of the wrong type, throws `TypeError` when the object is
created; an option given as `undefined` counts as left out.

## `createRepo(options)`

| Option | Default | Effect |
|---|---|---|
| `adapter` | required | The database connection. |
| `schema` | none | The default database schema. |
| `log` | `false` | `true`, a function receiving each query event, or `{ params: true }`. |
| `codegen` | `true` | Whether row decoders are generated with `new Function`. |
| `warnOnRootUseInTransaction` | `false` | Development only: warn when the outer repo is used inside its transaction callback. |

Details: [Creating a repo](/guide/repo#creating-a-repo).

## Adapters

| Adapter | Options | Details |
|---|---|---|
| `postgres(options?)` | `connectionString` or `host`/`port`/`user`/`password`/`database`/`ssl`, `pool` (`max`, `idleTimeoutMs`, `connectionTimeoutMs`, or a `pg.Pool`), `planCacheSize`, `statementTimeoutMs`, `applicationName` | [Postgres](/guide/adapters#postgres) |
| `sqlite(options)` | `filename` (required), `pragmas`, `attach`, `readonly`, `planCacheSize` | [SQLite](/guide/adapters#sqlite) |
| `mysql(options?)` | `connectionString` or `host`/`port`/`user`/`password`/`database`/`ssl`, `pool` (`max`, `idleTimeoutMs`, `connectionTimeoutMs`), `planCacheSize` | [MySQL](/guide/adapters#mysql) |

## Per call

| Option | On | Effect | Details |
|---|---|---|---|
| `schema` | reads and writes | The database schema for this call. | [Parameters and options](/guide/repo#parameters-and-options) |
| `timeoutMs` | reads, writes, transactions | One time budget for the whole call. | same |
| `signal` | reads, writes | An `AbortSignal` that cancels the call. | same |
| `context` | reads, writes | Passed through to the query events. | same |
| `maxConcurrency` | reads | Preload statements that may run at once. Default 1. | same |
| `batchSize` | `stream` | Rows per fetch. Default 500. | [Streaming](/guide/repo#streaming) |
| `returning` | `insert`, `insertAll` | Read back more fields, or rows. | [Insert](/guide/repo#insert) |
| `onConflict` | `insert`, `insertAll` | Upsert. | [Upserts](/guide/repo#upserts) |
| `force` | `update` | Update even with no changes. | [Update](/guide/repo#update) |
| `staleError`, `allowStale` | `update`, `delete` | What a stale row does. | same |
| `isolation`, `readOnly`, `retries` | `transaction` | Transaction settings. | [Transactions](/guide/transactions#options) |

## Schemas and fields

| Where | Options | Details |
|---|---|---|
| `Schema(table, fields, options?)` | `schema`, `naming`, `primaryKey: false`, `codegen` | [Schema options](/guide/schemas#schema-options) |
| Field modifiers | `.nullable()`, `.default()`, `.primaryKey()`, `.autogenerate()`, `.dbGenerated()`, `.virtual()`, `.column()`, `.redact()`, `.writable()` | [Fields](/guide/schemas#fields) |
| Associations | `foreignKey`, `references`, `where`, `orderBy`, `onReplace`, `through`, `joinThrough`, `joinKeys`, `joinWhere`, `unique` | [Options](/guide/associations#options) |

## Migrations

| Where | Options | Details |
|---|---|---|
| `createMigrator(options)` | `adapter`, `directory` or `migrations`, `table`, `schema`, `timestampColumn`, `lockTimeoutMs`, `timeoutMs`, `log` | [Running migrations](/guide/migrations#running-migrations) |
| `egon.config.ts` | `adapter`, `migrations`, `database` | [CLI configuration](/reference/cli#configuration) |

`egon-orm/migration` also exports the helpers the CLI is built on:
`createDatabase(admin, name)` and `dropDatabase(admin, name, { ifExists })` run
`CREATE DATABASE` and `DROP DATABASE` through an adapter connected to another database of
the server, and `parseMigrationFileName(file)` reads the version and name from a file name
such as `20261012093000_create_users.ts` (`undefined` when it is not one).

## Versions

Every package exports its version as `VERSION` (`import { VERSION } from "egon-orm"`).
