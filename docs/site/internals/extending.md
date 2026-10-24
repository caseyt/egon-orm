# Extending Egon

Where a new type, operator or database goes, and what has to come with it. Read
[Architecture](/internals/) first.

## A type

**In an application**, a new type does not need a change to the library: `defineType`
and `parameterized` are public. See [Custom types](/guide/types#custom-types) and the
[money recipe](/recipes/money).

**A built-in type** (one reached through `t`):

1. Implement it in `packages/core/src/types/` (`scalars.ts`, `temporal.ts`, `composite.ts`)
   as a `FieldType`: `cast` never throws and returns `{ success, data }` or
   `{ success: false, message }`; `fromDb` and `toDb` are the shared identity function when
   no conversion is needed, so the decoder can skip them.
2. Add the builder to `t` in `schema/field.ts`.
3. Give its logical column type (`DbType`) a SQL type in each dialect table
   (`compiler/dialect.ts`) and in the migration column builders
   (`migration/builder.ts`), and a driver codec in each dialect package (`values.ts`) where
   the driver's value differs.
4. Map it in `@egon-orm/zod` (`packages/zod/src/to-zod.ts`).
5. Tests: property tests for `cast`/`toDb`/`fromDb` round trips, type tests for the
   TypeScript type, and a row in the write and read conformance suites so every database
   stores and reads it.

## An operator or function

1. The method on expressions goes in `query/expr.ts` (or a free function in
   `query/functions.ts`), typed so that it exists only on expressions of a fitting type and
   rejects `null` where SQL would.
2. Its node: an existing kind with a new operator name (`BinaryOp` in
   `contracts/query.ts`), or a new node kind. A new name in the contracts is an addition;
   a change to an existing node is a contract change and needs an ADR.
3. Its SQL in each dialect table (`operators`, `functions`, …). A database without it
   leaves it out of its table, so that the compiler refuses it with `QueryError`, and gets
   a capability if the refusal should be explained ([Dialect support](/reference/dialect-support)).
4. Tests: a case per dialect in `compiler/sql-cases*.ts` (run against Postgres by
   `sql.itest.ts`), precedence where it is written between operands, and a type test with
   positive and negative cases.

## A dialect

A dialect is a package like `packages/sqlite`, plus tables in core:

1. **Contracts.** `Dialect` in `contracts/adapter.ts` lists the databases; a new value is a
   contract change and needs an ADR, as do new capabilities (ADR 0006 records those of the
   tier 2 dialects).
2. **Compiler table** in `compiler/dialect.ts`: quoting, placeholder style, operators,
   functions, types, lock clauses. The emitter has no branch on a dialect's name; a
   difference is a table entry or a capability (`scripts/check-dialect-conditionals.mjs`
   enforces this).
3. **Migration table** in `migration/dialect.ts`: DDL features, column types, literals,
   the runner's lock.
4. **The package**: options, a driver wrapper (`driver.ts`), value codecs (`values.ts`),
   error normalisation into `DatabaseError` and `ConstraintError` (`errors.ts`; the
   function is internal to the package and passed to `createAdapter` as `normalizeError`),
   the capabilities (`dialect.ts`), and `index.ts`, which calls `createAdapter`.
   `createAdapter` is internal to the Egon packages: its driver contract is not exported,
   so a dialect is written inside this repository, not as a third-party package.
5. **Conformance.** Each suite in `packages/core/test/conformance/` (adapter, read,
   write, preload, nested, transaction, compiler, migration) runs against the package through a
   profile file in its `test/` directory. A case that needs a missing capability is skipped
   by name.
6. **Docs.** Add the dialect to `scripts/dialect-support.ts` and run `pnpm docs:dialects`;
   `pnpm lint` fails when the page is stale.

## See also

- [How a query becomes SQL](/internals/compiler)
- [Dialect support](/reference/dialect-support)
