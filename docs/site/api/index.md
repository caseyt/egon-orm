# API reference

Every exported function, class and type, generated from the TSDoc in the source code by
TypeDoc when the site is built. Each entry has a summary and an example; the build fails
when an export lacks either. For explanations and worked examples, start from the
[Guide](/guide/).

## Packages

| Package | Contents |
|---|---|
| [`egon-orm`](/api/reference/egon-orm/) | Schemas, types, changesets, queries, the repo, batches, errors. |
| [`egon-orm/testing`](/api/reference/egon-orm/testing/) | The test sandbox and the query counter. |
| [`egon-orm/migration`](/api/reference/egon-orm/migration/) | Migrations and their runner. |
| [`@egon-orm/postgres`](/api/reference/@egon-orm/postgres/) | The Postgres adapter. |
| [`@egon-orm/sqlite`](/api/reference/@egon-orm/sqlite/) | The SQLite adapter. |
| [`@egon-orm/mysql`](/api/reference/@egon-orm/mysql/) | The MySQL adapter. |
| [`@egon-orm/zod`](/api/reference/@egon-orm/zod/) | Zod schemas derived from schema classes. |
| [`@egon-orm/cli`](/api/reference/@egon-orm/cli/) | The `egon` command and its configuration helper. |

## By topic

| Topic | Guide | Main exports |
|---|---|---|
| Schemas | [Schemas](/guide/schemas), [Associations](/guide/associations), [Embeds](/guide/embeds) | `Schema`, `t`, `timestamps`, `hasMany`, `belongsTo`, `hasOne`, `manyToMany`, `EmbeddedSchema`, `meta` |
| Types | [Types](/guide/types) | `defineType`, `parameterized`, `FieldType` |
| Changesets | [Changesets](/guide/changesets), [Validation](/guide/validation), [Nested changesets](/guide/nested-changesets) | `cast`, `change`, `Changeset`, `applyAction`, `traverseErrors`, `buildAssoc` |
| Queries | [Queries](/guide/queries), [Expressions](/guide/query-expressions), [Advanced queries](/guide/queries-advanced) | `from`, `fragment`, `param`, `count`, `subquery`, `cte`, `dynamic`, `prepare` |
| Repo | [Repo](/guide/repo), [Transactions](/guide/transactions) | `createRepo`, `Repo`, `Result`, `success`, `failure` |
| Batch | [Batch](/guide/batch) | `createBatch`, `Batch` |
| Adapters | [Adapters](/guide/adapters) | `postgres`, `sqlite`, `mysql`, `createAdapter` |
| Migration | [Migrations](/guide/migrations) | `defineMigration`, `createMigrator` |
| Testing | [Testing](/guide/testing) | `createSandbox`, `expectQueries` |
| Errors | [Errors](/reference/errors) | `EgonError`, `isEgonError` and the error classes |
