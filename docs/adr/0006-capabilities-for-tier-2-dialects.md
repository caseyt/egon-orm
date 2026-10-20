# 0006 — Sixteen capabilities for the tier-2 dialects

- **Status:** proposed
- **Date:** 2026-10-20
- **Step:** 17 (raised in the review of PR #38, finding 11; implemented as described below,
  pending the owner's decision)
- **Affects:** the frozen `Capabilities` contract of step 02
  (`packages/core/src/contracts/adapter.ts`), which third-party adapters implement; the
  capability tables of `@egon-orm/postgres`, `@egon-orm/mysql` and `@egon-orm/sqlite`, and
  their reference copies in `packages/core/src/compiler/dialect.ts`; the compiler, the repo
  and the conformance suites that read them; `reference/dialect-support.md`, which is
  generated from them

## Context

Step 02 froze `Capabilities` with the flags Postgres needed to say "yes" to: `returning`,
`onConflict`, `conflictTarget`, `ilike`, `lateralJoin`, `fullJoin`, `distinctOn`, `arrays`,
`arrayParams`, `jsonb`, `nullsOrder`, `updateJoin`, `cteMaterialized`, `insertDefaultValues`,
the lock modes, isolation levels, savepoints, DDL transactions, streams and the parameter
limit.

SQLite and MySQL lack features those flags do not name. The owner's rules decide how each
gap is handled:

- An unsupported feature is a clear `QueryError` when the statement is compiled, never
  silent emulation and never a database syntax error.
- A conformance case is skipped only through a declared capability, never by dialect name.

Each gap below therefore needs a flag. Without one, either the compiler has to branch on
the dialect's name (which the dialect-conditional check forbids), or the test has to be
skipped ad hoc.

## Decision

Add sixteen boolean fields to `Capabilities`, all required. Postgres sets every one to `true`.

| Field | What it says | SQLite | MySQL |
|---|---|---|---|
| `writingCtes` | `updateAll` / `deleteAll` inside a `WITH` | false | false |
| `intersectExceptAll` | `INTERSECT ALL`, `EXCEPT ALL` | false | true |
| `defaultInValues` | `DEFAULT` cells in a multi-row `VALUES` (ragged `insertAll`) | false | true |
| `aggregateFilter` | `FILTER (WHERE …)` on an aggregate | true | false |
| `explainOptions` | `explain` takes `analyze` / `format` | false | true |
| `limitExpressions` | `LIMIT` / `OFFSET` take an expression | true | false |
| `conflictConstraint` | `onConflict.target: { constraint }` | false | false |
| `readOnlyTransactions` | `begin({ readOnly: true })` | false | true |
| `deferrableTransactions` | `begin({ deferrable: true })` | false | false |
| `cancel` | a running statement can be stopped (`timeoutMs`, `signal`) | false | true |
| `multipleConnections` | more than one connection at a time | false | true |
| `serializationFailures` | serializable conflicts fail as serialization failures | false | false |
| `nonFiniteFloats` | `NaN` and infinities in float columns | false | false |
| `exactDecimals` | a decimal reads back as written and compares by value | false | false |
| `foreignKeyNames` | a foreign-key violation names its constraint and table | false | true |
| `longIdentifiers` | identifiers longer than 64 bytes can be used | true | false |

The first nine refuse what needs them with a `QueryError` naming the feature and the
dialect, before anything is sent. Seven are checked when a statement is compiled. Two,
`readOnlyTransactions` and `deferrableTransactions`, are checked by `begin()`
(`beginStatements`). `compiler/capabilities.test.ts` checks all nine on all three dialects.

The last seven describe how the database behaves rather than what SQL it takes. Each is
honoured by the adapter or the repo, and the conformance cases that depend on one skip with
its name.

## Alternatives considered

1. **Optional fields with safe defaults.** A third-party adapter written against step 02
   would keep compiling.
   - The defaults that keep its old behaviour are all `true`. A missing flag would then
     silently promise features the database may lack, and the first sign would be a
     syntax error from the database. That is what the explicit-opt-in rule exists to
     prevent.
   - A default of `false` would instead refuse features the adapter supported before, also
     silently.
   - Defaults would also need resolving once in `createAdapter`, with every reader moved
     to a resolved type.

   Not chosen. A compile error in the third-party adapter is the explicit way to ask the
   question. The library is pre-1.0, and there are no published third-party adapters.
2. **One field holding a list of unsupported features** (`unsupported: readonly string[]`).
   It is open-ended, but a typo in a feature name is silent, and the generated support page
   needs a description per feature anyway. Not chosen.
3. **Keep the behaviour flags out of `Capabilities`**: `exactDecimals`, `nonFiniteFloats`,
   `foreignKeyNames`, `longIdentifiers`, `multipleConnections`, `serializationFailures` and
   `cancel` in a separate `Behaviours` object of the adapter definition.
   - It separates "what SQL is accepted" from "how the database behaves", and the
     compiler's reference copies would hold only the former.
   - But the conformance suites and the repo read both through `adapter.capabilities`,
     and a second object is a second frozen contract.

   Not chosen. Worth revisiting if the list of behaviour flags keeps growing.

## Consequences

- An adapter outside this repository must add the sixteen fields: a compile error tells it
  which ones.
- Every flag is listed, with its value per dialect, on the generated
  `reference/dialect-support.md`.
- A new feature gap later is a new flag and a new ADR row, not a dialect-name check.

## Also changed in step 17: `Connection.inTransaction()`

The frozen `Connection` contract gains `inTransaction(): boolean`: whether a transaction is
open on the connection, as the driver reports it. That includes one a raw `begin` started.

The migration runner needs it to roll back a `transaction: false` migration that left its
own transaction open, before it takes its SQLite lock back (review round 4 of PR #38).

Only the shared adapter's `SharedConnection` implements `Connection`, and it reads the
answer from the driver connection, which already tracks it. Code that only uses
`Connection` is unaffected.
