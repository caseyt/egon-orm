# Errors

Every error the library throws extends `EgonError`. Each has a stable `code`, a message
that says what happened and how to fix it, and, where a driver error was involved, that
error as `cause`.

<<< @/examples/errors.ts#handle

`isEgonError(value, code?)` checks by code. It works across two copies of the package,
where `instanceof` would not:

<<< @/examples/errors.ts#by-code

## Classes

| Error | `code` | Thrown when | Extra fields | How to fix |
|---|---|---|---|---|
| `InvalidChangesetError` | `"invalidChangeset"` | An `OrThrow` write is given an invalid changeset, or a declared constraint is violated. | `changeset`, `action` | Show `error.changeset.errorMessages()`, or use the method without `OrThrow` and check the result. |
| `ConstraintError` | `"constraint"` | The database rejects a write and the changeset did not declare that constraint; also every violation in a bulk write. | `type`, `constraint`, `table`, `column`, `detail`, `sql` | Declare it on the changeset (the message says how). See [Constraints](/guide/constraints). |
| `StaleEntryError` | `"staleEntry"` | An update or delete matched no row: the row was deleted, or an optimistic lock failed. | `action`, `schema` | Reload and retry, or pass `staleError` / `allowStale`. See [Update](/guide/repo#update). |
| `NoResultsError` | `"noResults"` | `oneOrThrow`, `getOrThrow`, `getByOrThrow` or `reloadOrThrow` found nothing. | `query` (rendered, without values) | Use the method without `OrThrow` where a missing row is expected. |
| `MultipleResultsError` | `"multipleResults"` | `one`, `getBy` or their twins matched more than one row. | `count`, `query` | Make the query unique, or use `first` for "any one". |
| `QueryError` | `"query"` | A query, changeset, batch or transaction is built or used wrongly, or needs a feature the database lacks. | | The message names the clause or call and the fix. See [Dialect support](/reference/dialect-support) for features. |
| `CastError` | `"cast"` | `cast` is given params that are not an object, or a stored value does not fit its field's type. | | Pass a plain object; check the column holds what the field declares. |
| `NotLoadedError` | `"notLoaded"` | `castAssoc` or `putAssoc` is used on an association of a loaded row that was not preloaded as whole rows. | `schema`, `association` | Preload the association before building the changeset. |
| `SchemaDefinitionError` | `"schemaDefinition"` | A schema, type or association is defined incorrectly, or a schema's constructor is called. | | The message names the schema, the field and the fix. |
| `RollbackError` | `"rollback"` | `transactionOrThrow` ended in a rollback: `tx.rollback(reason)`, a batch step that failed (`reason` is `{ step, error, completed }`), or a statement that failed and was not handled. | `reason` | Use `transaction` to get the rollback as a result. |
| `DatabaseError` | see below | The connection or the database failed. | `retryable`, `sql` | Depends on the code. |
| `MigrationError` | `"migration"` | A [migration](/guide/migrations) cannot be rolled back, uses a feature the database lacks, failed, is missing its file, or the migration lock could not be taken. Imported from `egon-orm/migration`. | `version`, `migration`, `sql` | The message says which migration and why. |

## `DatabaseError` codes

| Code | Meaning | `retryable` |
|---|---|---|
| `"database"` | A driver error with no more specific code. | no |
| `"connection"` | Could not connect, the connection was lost, or the repo was closed. | no |
| `"serializationFailure"` | The transaction conflicted with another. | yes |
| `"deadlock"` | The database broke a deadlock by cancelling this transaction. | yes |
| `"aborted"` | The query was cancelled by the caller's `AbortSignal`. | no |
| `"timeout"` | The statement, or the whole call, ran longer than its `timeoutMs`. | no |

[`retries`](/guide/transactions#options) on a transaction runs it again for the retryable
codes.

## What is not thrown

Invalid input and declared constraint violations are **returned**, not thrown, by the
methods without `OrThrow`:

<<< @/examples/errors.ts#result

See [Writing](/guide/repo#writing).

## What errors contain

- The SQL that failed (`sql`), where there was one.
- The driver's error as `cause`.
- Never the parameter values, unless the repo was created with `log: { params: true }`.
- Never the value of a [redacted](/guide/schemas#fields) field. A database message that may quote a value is left out of the message and kept on
  `cause`.

## See also

- [FAQ and troubleshooting](/guide/faq): the messages people meet first, and their fixes.
- [Adapters: errors](/guide/adapters#errors): how driver errors are converted.
