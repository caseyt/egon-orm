# Errors

Every error the library throws extends `EgonError`. Each has a stable `code`, a message
that says what happened and how to fix it, and, where a driver error was involved, that
error as `cause`.

```ts
import { EgonError, InvalidChangesetError, ConstraintError } from "egon-orm";

try {
  await repo.insertOrThrow(cs);
} catch (e) {
  if (e instanceof InvalidChangesetError) return e.changeset.errorMessages();
  if (e instanceof ConstraintError) return { [e.column ?? "base"]: [e.constraint] };
  throw e;
}
```

## Classes

| Error | Thrown when | Extra fields |
|---|---|---|
| `InvalidChangesetError` | An `OrThrow` write is given an invalid changeset, or a declared constraint is violated. | `changeset` |
| `ConstraintError` | The database rejects a write and the changeset did not declare that constraint. | `type`, `constraint`, `table`, `column`, `detail` |
| `StaleEntryError` | An update or delete matched no row, or an optimistic lock failed. | |
| `NoResultsError` | `oneOrThrow`, `getOrThrow`, `getByOrThrow` or `reloadOrThrow` found nothing. | the query, rendered |
| `MultipleResultsError` | `one`, `getBy` or their twins matched more than one row. | the query, rendered |
| `QueryError` | A query is built or used wrongly, or needs a feature the database lacks. | |
| `CastError` | `cast` is given something that is not an object, or a stored value does not fit its type. | |
| `NotLoadedError` | `castAssoc` is used on an association that was not preloaded as whole rows. | |
| `SchemaDefinitionError` | A schema or association is defined incorrectly. | |
| `RollbackError` | `transactionOrThrow` ended in a rollback: `tx.rollback(reason)`, a batch step that failed (`reason` is `{ step, error, completed }`), or a statement that failed and was not handled. | `reason` |
| `DatabaseError` | The connection or the database failed. | `code`, `retryable` |
| `MigrationError` | A [migration](/guide/migrations) cannot be rolled back, uses a feature the database lacks, failed, is missing its file, or the migration lock could not be taken. Imported from `egon-orm/migration`. | `version`, `migration`, `sql` |

## `DatabaseError` codes

| Code | Meaning | `retryable` |
|---|---|---|
| `"database"` | A driver error with no more specific code. | no |
| `"connection"` | Could not connect, or the connection was lost. | no |
| `"serializationFailure"` | The transaction conflicted with another. | yes |
| `"deadlock"` | The database broke a deadlock by cancelling this transaction. | yes |
| `"aborted"` | The query was cancelled by the caller's `AbortSignal`. | no |
| `"timeout"` | The statement ran longer than its `timeoutMs`. | no |

[`retries`](/guide/transactions#options) on a transaction reruns it for the retryable
codes.

## What is not thrown

Invalid input and declared constraint violations are **returned**, not thrown, by the
methods without `OrThrow`:

```ts
const result = await repo.insert(cs);
if (!result.success) result.error.errorMessages();
```

See [Writing](/guide/repo#writing).

## What errors contain

- The SQL that failed.
- Never the parameter values, unless the repo was created with `log: { params: true }`.
- Never the value of a [redacted](/guide/schemas#fields) field.
