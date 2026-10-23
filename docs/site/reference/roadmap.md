# Roadmap

Egon ORM is under construction: nothing is published to npm yet.

## Built

| Feature | Pages |
|---|---|
| Schemas, types, associations and embeds | [Schemas](/guide/schemas), [Types](/guide/types), [Associations](/guide/associations), [Embeds](/guide/embeds) |
| Changesets, validation (built-in rules, Zod and any Standard Schema library), constraints, nested changesets | [Changesets](/guide/changesets), [Validation](/guide/validation), [Constraints](/guide/constraints), [Nested changesets](/guide/nested-changesets) |
| The query builder: joins, subqueries, CTEs, set operations, window functions, fragments, named parameters | [Queries](/guide/queries), [Expressions](/guide/query-expressions), [Advanced queries](/guide/queries-advanced) |
| The repo: reads, writes, upserts, bulk writes, preloads, streams, transactions, batches, the test sandbox | [Repo](/guide/repo), [Transactions](/guide/transactions), [Batch](/guide/batch), [Testing](/guide/testing) |
| Postgres, SQLite and MySQL adapters | [Adapters](/guide/adapters), [Dialect support](/reference/dialect-support) |
| Migrations, their runner and the `egon` command | [Migrations](/guide/migrations), [CLI](/reference/cli) |

## Before the first release

| Work | Notes |
|---|---|
| Performance | Benchmarks against the raw drivers. No numbers are published until then. |
| Release hardening | Publishing the packages, `@egon-orm/cli` included, versioning and the changelog. |

## Planned after the first release

| Feature | Notes |
|---|---|
| Lateral joins | `joinLateral`, `leftJoinLateral`. |
| `VALUES` lists as a query source | `from(values(...), "v")`. |
| Table-valued fragments | Such as `generate_series` as a source. |
| Index hints | MySQL. |
| Data-modifying CTEs | `UPDATE` or `DELETE` inside a `WITH`. |
| Named server-side prepared statements | For [`prepare`](/guide/queries-advanced#prepared-queries). |
| Form helpers for nested changesets | Sort and drop parameters, and index-keyed objects in place of arrays. |
| Other databases through a custom dialect | |
| Query observability | Built on the `query` event of [`repo.on`](/guide/repo#logging-and-events), which already reports each statement's SQL and timings: slow-query detection, OpenTelemetry tracing and warnings for N+1 query patterns. |
| A browser entry point | `egon-orm/client`, with `cast` and the validations, so a form can run the same casts and field validations in the browser, without bundling the query builder or the repo. Constraints and checks that ask the database stay on the server. |
| Test factories | Beside the [test sandbox](/guide/testing): build valid rows for a schema, override single fields, create association graphs, and generate deterministic test data. For integration tests in large applications. |

## Not planned

These are deliberate choices, not gaps:

- **Active-record methods** such as `user.save()`. Rows are data.
- **Lazy loading.** Associations are loaded only when asked for.
- **An identity map or unit of work.** Two queries for the same row return two objects.
- **Implicit transactions.** Nothing joins a transaction you did not open: only calls on
  the transaction object are inside it. (A single call that writes several statements, a
  parent with its children or a chunked `insertAll`, is atomic on its own.)
- **Generating migrations from schema differences.** Migrations are written by hand.
- **Non-SQL stores.**
