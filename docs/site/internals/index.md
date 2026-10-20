# Architecture

This section is for contributors. It explains how the library is put together, so that a
change lands in the right place. You do not need it to use Egon.

## The pipeline

```text
 schema classes ─────────────┐ metadata: fields, types, associations (computed once, cached)
                             ▼
 params ──► changeset ──► repo.insert / update ──► compiler.compileInsert … ──┐
             (cast, validate,     (required fields,      (write plan)           │
              constraints)         prepareChanges)                              ▼
                                                                    adapter ──► driver ──► database
 from(User, "u")… ──► query AST ──► repo.all ──► compiler.compile ──────────┘     │
   (immutable value,   (values kept   (options,     (plan: SQL text, slots,          │
    bindings cached)    apart)          preloads)     output plan; plan cache)       │
                                                                                    ▼
 rows ◄── decoder (hydration: one per plan) ◄── result rows ◄── adapter (codecs, errors, events)
   └──► preloads: one more query per association level, children grouped by key
```

1. **Schemas** (`packages/core/src/schema/`). `Schema(table, fields)` returns a base class
   and attaches its metadata: fields, column names, types, the primary key, and a row
   factory. Associations are `static` members that hold a function returning the target
   class; they are resolved and checked the first time they are used.
2. **Types** (`types/`). A field type knows how to `cast` untrusted input, read the
   driver's value (`fromDb`), write a parameter (`toDb`) and compare two values. A type
   whose conversion is the identity says so, and the conversion is then skipped by a
   reference check.
3. **Changesets** (`changeset/`). Immutable values: each method returns a new changeset.
   Validation runs immediately and never touches the database; constraint declarations
   are recorded for the repo.
4. **Queries** (`query/`). The builder produces an AST (`contracts/query.ts`): a tree of
   plain nodes, with every value of the query kept in one array beside it. Binding objects
   (`u.email`, …) are built once per schema and alias, and cached.
5. **The compiler** (`compiler/`). One emitter for every database, driven by a dialect
   table. It turns an AST into a plan: SQL text with placeholders, a slot per placeholder
   saying where its value comes from, and an output plan saying how to build the result.
   Plans hold no values, so they are cached per query shape. See
   [How a query becomes SQL](/internals/compiler).
6. **The adapter** (`adapter/`, and each dialect package). `createAdapter` builds an
   adapter from a dialect package's driver wrapper, capabilities, value codecs and error
   normaliser: pooling, statements, streams, transactions and savepoints, cancellation,
   telemetry and the plan cache.
7. **The repo** (`repo/`). The public face: reads, writes, preloads, transactions,
   batches and the sandbox, written against the `Adapter` contract only.

## Hydration

Each compiled plan gets one row decoder (`repo/hydrate.ts`), built from its output plan:

- With code generation (the default), the decoder is straight-line JavaScript made with
  `new Function`: one statement per column, no loop and no closure per row. Every name from
  the plan enters that code as a JSON string literal, so nothing from a schema or a query
  can become code.
- Where generating code is forbidden (a Content Security Policy without `unsafe-eval`, or
  `codegen: false`), an interpreted decoder walks a tree prepared once from the plan. Rows
  are the same; it is slower.
- Rows are built by the schema's row factory, which assigns every field in declaration
  order without running a constructor, so every row of a schema has the same shape.
- A `null` from the database is passed through without calling a type's `fromDb`.

## Rules that hold everywhere

- **No value in SQL text.** A value exists only in the AST's value array and becomes a
  bound parameter. SQL text comes from the compiler's tables, the literal parts of a
  `fragment`, and a custom type's plain type name.
- **No back-end type in the contracts.** `packages/core/src/contracts/` defines what the
  parts agree on; changing it needs an ADR.
- **No ambient state.** No current transaction, no identity map, no global registry of
  schemas; a transaction is a value (`tx`) passed explicitly.
- **Hot-path rules.** No `Proxy`, no per-row `defineProperty`, no spread or `delete` of row
  objects, monomorphic shapes, and anything derivable from a schema or a query shape is
  computed once and cached. The full list is in
  [§7 of the plan](https://github.com/caseyt/egon-orm/blob/main/docs/plan/README.md#7-performance-standards)
  and in [`CONTRIBUTING.md`](https://github.com/caseyt/egon-orm/blob/main/CONTRIBUTING.md).

## Decision records

The decisions behind this design are recorded as ADRs in
[`docs/adr/`](https://github.com/caseyt/egon-orm/tree/main/docs/adr):

| ADR | Decision |
|---|---|
| [0001](https://github.com/caseyt/egon-orm/blob/main/docs/adr/0001-schema-classes.md) | Schemas are classes, associations `static` members holding functions. |
| [0002](https://github.com/caseyt/egon-orm/blob/main/docs/adr/0002-kysely-backend.md) | Kysely as a hidden SQL back end (superseded by 0003). |
| [0003](https://github.com/caseyt/egon-orm/blob/main/docs/adr/0003-own-sql-emitter.md) | Egon emits its own SQL and wraps the drivers directly. |
| [0004](https://github.com/caseyt/egon-orm/blob/main/docs/adr/0004-validator-non-list-result-throws.md) | A validator function that returns something other than a list throws. |
| [0005](https://github.com/caseyt/egon-orm/blob/main/docs/adr/0005-transaction-statement-options.md) | Statement options on the `Connection` transaction methods (accepted; implemented in a follow-up). |
| [0006](https://github.com/caseyt/egon-orm/blob/main/docs/adr/0006-capabilities-for-tier-2-dialects.md) | Capabilities for the tier 2 dialects. |

## See also

- [How a query becomes SQL](/internals/compiler): the compiler and its plan cache.
- [Extending Egon](/internals/extending): adding a type, an operator or a dialect.
- [`CONTRIBUTING.md`](https://github.com/caseyt/egon-orm/blob/main/CONTRIBUTING.md): tooling, tests and the review loop.
