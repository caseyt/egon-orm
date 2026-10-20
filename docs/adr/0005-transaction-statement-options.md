# 0005 — Execution options for the transaction statements of `Connection`

- **Status:** accepted (option 2, by the owner on 2026-10-20); implemented in PR #PR_NUMBER
  (branch `adr/0005-transaction-statement-options`; see "Implementation" below)
- **Date:** 2026-10-20
- **Step:** 16 (raised in the review of PR #36, finding 7; not implemented)
- **Affects:** the frozen `Connection` contract (`packages/core/src/contracts/adapter.ts`:
  `begin`, `commit`, `rollback`, `savepoint`, `rollbackTo`, `releaseSavepoint`); the shared
  adapter (`packages/core/src/adapter/adapter.ts`, `SharedConnection`); the transactions of
  step 16 (`packages/core/src/repo/transaction.ts`); decision 9 and the Known gaps of
  `docs/plan/status/16.md`; the guide page `transactions.md` ("Things to know")

## Context

Step 16 runs a transaction's own statements (`BEGIN`, `SAVEPOINT`, `RELEASE SAVEPOINT`,
`ROLLBACK TO SAVEPOINT`, `COMMIT`, `ROLLBACK`) through the `Connection` methods, because they
write each dialect's syntax: Postgres's `begin isolation level …, read only`, and later
MySQL's `SET TRANSACTION …` plus `START TRANSACTION` (step 11's request to step 17). Those
methods take no arguments besides the begin options and the savepoint name:

```ts
interface Connection extends Executor {
  begin(options?: BeginOptions): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  savepoint(name: string): Promise<void>;
  rollbackTo(name: string): Promise<void>;
  releaseSavepoint(name: string): Promise<void>;
  // …
}
```

`execute` takes `ExecuteOptions` (`signal`, `timeoutMs`, `slots`, `context`); these do not.
That leaves two owner rules unmet for these statements:

1. **`timeoutMs` is one budget for the whole call.** A transaction's `timeoutMs` cancels the
   statements its callback runs, but not its own `BEGIN` or `COMMIT`. A `COMMIT` that waits
   (on synchronous replication, on a lock held at commit time, on a slow disk) runs past
   the budget, and nothing can stop it short of closing the connection.
2. **Telemetry as in steps 11 and 12.** The repo reports a statement as a `query` event when
   the adapter's event for it carries the repo's `Call` as `context`. Without a `context`
   argument, the transaction statements reach the adapter's own `query` listeners but not
   the repo's: `log: true` and `expectQueries` do not show them.

The repo could send the statements itself with `execute`, but then it would write SQL that
belongs to the dialect (ADR 0003, rule 5: no dialect conditional outside `compiler/`,
`adapter/` and the dialect packages), and step 17 would have to repeat MySQL's `BEGIN` in
the repo.

## Options

1. **Keep the contract (today).** The transaction statements are not cancelled by
   `timeoutMs` and are not repo events. Documented as a known gap. Costs nothing now; the
   budget is not a hard bound for a transaction.
2. **An optional `ExecuteOptions` argument on each transaction method**, last:
   `begin(options?: BeginOptions, execute?: ExecuteOptions)`, `commit(execute?)`,
   `rollback(execute?)`, `savepoint(name, execute?)`, `rollbackTo(name, execute?)`,
   `releaseSavepoint(name, execute?)`. The shared adapter passes them to the `execute` it
   already uses for these statements, so they get cancellation, the timeout and the
   telemetry context like any statement. Additive: existing callers compile and behave as
   before. Step 16 would then give each transaction statement what is left of the budget
   and a `Call` (operation `"transaction"`, a new `RepoOperation`), and decide whether
   `expectQueries` counts them.
3. **A method that returns the SQL of each transaction statement** (`transactionSql(kind,
   …)`) so the repo can `execute` it with options. Exposes dialect SQL through the
   contract and splits one responsibility over two places; no better than option 2.

## Decision

Proposed: **option 2**. It is additive, keeps the SQL in the adapter, and makes both owner
rules hold for every statement of a transaction. Changing a frozen contract waited for the
owner's acceptance (plan README §9.4), given on 2026-10-20; the implementation followed
(below).

Open points for the owner, should option 2 be accepted:

- Whether a `ROLLBACK` sent because the budget ran out gets a budget of its own (it must not
  be cut short by the budget that triggered it; a fixed short timeout, or none).
- Whether the transaction statements become repo `query` events (operation
  `"transaction"`), and whether `expectQueries` counts them or filters them out.

## Implementation

Option 2 as written: the six methods take `execute?: ExecuteOptions` last, and the shared
adapter passes them on to the `execute` it already used (MySQL's two-statement `BEGIN`
shares one budget). The open points are built as follows and wait for the owner's
sign-off. The options and the reasons are in `docs/plan/status/16.md`, "Follow-up: ADR
0005".

- The `ROLLBACK` (and `ROLLBACK TO`) gets no budget. `BEGIN`, `SAVEPOINT`, `RELEASE` and
  `COMMIT` get what is left of it, including their wait for the connection.
- The transaction statements are repo `query` events with operation `"transaction"`, a new
  `RepoOperation`. `expectQueries` returns them; the sandbox's own statements are not
  events.

## Consequences

- With option 2: `contracts/adapter.ts` gains the optional arguments and their TSDoc; the
  shared adapter forwards them (a few lines); step 16's `transaction.ts` passes them; the
  contract's type tests and the adapter conformance suite get cases for a cancelled `COMMIT`
  and for the context reaching the listener; step 17's dialect hook for `BEGIN` takes the
  same options. `status/16.md` decision 9 and the guide's "Things to know" change.
- With option 1: nothing changes; the gap stays documented in `status/16.md` and in
  `transactions.md`.
- Revisit if a dialect needs a transaction statement that cannot be expressed as one
  `execute` (then option 2's forwarding is not enough).
