# Step 21 (robustness): soak, fault injection, runtime matrix, mutation testing, status

Branch `step/21-robustness`, 2026-10-22, from `main` at `e6ea502`, with `main` merged at
`37853d9` (#68, security), `baecd60` (#65, packaging), `2eff98a` (#69, audit; #71,
TypeScript 5.8 minimum) and `8b1aeea` (#72, owner decisions). After the last merge:
`pnpm check`, `pnpm api:check` and `pnpm test:integration --maxWorkers=2` with
`EGON_TEST_TIER2=1` (51 files, 1,801 tests) pass. Spec: `docs/plan/21-release.md` §3. The owner decided on 2026-10-22 that all four items stay gates for `0.1.0`.

## Summary

| Item | Result |
|---|---|
| Soak test, 30 min, pool of 5, random `pg_terminate_backend` | **Pass** on the final code: 166,467 operations, 1,007 kills, 0 unexpected failures, 0 unhandled rejections, 0 connections left checked out, 0 backends after `close()`, heap +0.49 MB. Two earlier runs **found a hang** (bug 1 below), now fixed. |
| Fault injection, every await point | **Pass**: 22 scenarios, 105 await points, 210 faulted runs, no connection left checked out, the injected error surfaces every time. |
| Runtime matrix | **Pass** on Node 22.12.0, 22.23.1 and 24.14.1 (ESM, `require()`, esbuild ESM and CJS bundles, Next.js 16.4.2 build), Postgres and SQLite. Bun 1.4.2 (best effort): Postgres passes in all four forms; SQLite fails because Bun cannot load `better-sqlite3`. Found bug 3 (SQLite in a CommonJS bundle). |
| Mutation testing, ≥ 80% per area | **Pass** (Stryker's own scores, `ignoreStatic: false`): compiler 93.04%, query 83.46%, changeset 83.14%. Not fully triaged: sampled real-gap rates are compiler 13%, query 13%, changeset about 37% (50% in its two largest files; corrected on 2026-10-24, see §4); the changeset survivors are a `0.1.0` gate (owner decision 4) and are triaged one by one in `step/21-changeset-gaps`. |

Bugs found and fixed here, each with a test that fails without the fix:

1. **High: a Postgres stream whose session ended held its pooled connection forever.**
   pg-cursor's `close()` resolves on the connection's next `readyForQuery`, which an ended
   connection never sends. When the server terminated a session mid-stream, the read
   failed, the adapter closed the cursor in `finally`, and that close never settled: the
   stream never finished and its connection never went back. In the soak test the whole
   pool (5 connections) ended up held this way after about 9 minutes, and every other
   operation waited for a connection forever (the first two soak runs). Fix
   (`packages/postgres/src/driver.ts`): each checkout listens for the client's `end`; a
   cursor close that is waiting is failed when the connection ends, and one asked for
   after it fails at once. The adapter already treats a failed close as a broken
   connection and destroys it. Tests: `test/stream-kill.itest.ts` (times out without the
   fix), three unit tests in `src/driver.test.ts`.
2. **Medium: a session the server terminated right after `close()` crashed the process.**
   pg-pool's `end()` resolves once it has asked its idle clients to end, before their
   sockets have closed. The Postgres adapter removed the pool's `error` listener as soon as
   `end()` resolved, so a session terminated in that window (a restart,
   `pg_terminate_backend`, `DROP DATABASE … WITH (FORCE)`) made the pool emit an
   unhandled `error` and Node exited. Seen as a crash of the runtime matrix (1 run in 3),
   and again on `main` at `8b1aeea` (which does not have the fix): CI's tier-2 integration
   job failed with one unhandled error, a FATAL `57P01` ("terminating connection due to
   administrator command") from a client already ending (`_ending: true`), on a database
   of `error-review.itest.ts` dropped with `DROP DATABASE … WITH (FORCE)`.
   Fix: the owned pool keeps its error listener after `end()`. Tests:
   `test/close-race.itest.ts` (fails without the fix), a unit test in `src/driver.test.ts`.
3. **Medium: `@egon-orm/sqlite` failed when bundled to CommonJS.** `SQLITE_RUNTIME.open`
   called `createRequire(import.meta.url)`; esbuild with `format: "cjs"` leaves
   `import.meta` empty, so every first query threw `ERR_INVALID_ARG_VALUE`. Fix
   (`packages/sqlite/src/driver.ts`, `requireFor`): use the module URL when there is one,
   else the CommonJS `require`, else skip the version check (it only improves an error
   message). Tests: three unit tests; the esbuild CJS bundle of `examples/runtime` (failed
   before). esbuild still prints its `empty-import-meta` warning for that line, which is
   harmless now.

## 1. Soak test

- `packages/postgres/test/soak/workload.ts` (the workload) and `soak.soak.ts` (the test), in
  a Vitest project of their own, `postgres:soak` (`vitest.config.ts`). No other project
  matches `*.soak.ts`, so neither `pnpm test:integration` nor CI on pull requests runs it.
  `pnpm test:soak` runs it: 2 minutes by default, `EGON_SOAK_MINUTES=30` for the gate,
  `EGON_SOAK_PAUSE_MS="min,max"` for the pause after each operation (default 20–100 ms, a
  moderate load: about 90 operations a second here), `EGON_SOAK_REPORT` for the JSON report.
- `.github/workflows/robustness.yml` runs it by hand (`workflow_dispatch`, length as an
  input) and every Monday; no secrets; the report is kept as an artifact. It does not run on
  pull requests.
- Workload: six workers, a pool of 5 (`postgres({ pool: { max: 5 } })`), mixing validated
  inserts, duplicate inserts that must come back as changeset failures, updates, deletes,
  reads with a per-parent preload limit, counts, transfers between accounts in a
  transaction with `lock("update")`, a transaction rolled back with `tx.rollback`, a
  savepoint rolled back inside a committed transaction, a Batch, nested inserts, streams
  (left early or read to the end), `insertAll`, `deleteAll` trimming, and a statement that
  outlives its `timeoutMs` (cancel path). Tables are trimmed so that the load stays the same.
- Kills: a separate session terminates one backend every 0.5–3 s, chosen from
  `pg_stat_activity` **filtered by the workload's own `application_name` and database**, and
  terminated with the same filter, so other workers' backends are never touched.
- Checks: every failure must be a `DatabaseError` with code `connection` (a killed session)
  or the deliberate `timeout`; no `unhandledRejection` or `uncaughtException`; the transfers
  keep the accounts' total (atomicity under kills); no worker still busy a minute after the
  deadline (reported as "stuck" instead of hanging the test); after the workers stop, no
  connection checked out and none waiting; `close()` resolves within 10 s; no backend of
  the workload left on the server; heap growth after warm-up (median of the last samples
  minus the first, after a forced GC) under 16 MB.
- **Result of the final run** (Node 22.23.1, local Compose Postgres 16, 30 min 1.8 s):
  166,467 operations (read 28,969, insert 21,851, transfer 21,733, update 17,783, Batch
  14,535, nested 14,447, insertAll 7,425, savepoint 7,269, stream 7,203, delete 7,186,
  rollback 7,128, timeout 3,690, trim 3,656, duplicate 3,592); 1,007 kills; 180 operations
  failed with `DatabaseError` `connection` (the others hit idle connections, which the pool
  replaced: 1,010 connects, 1,007 disconnects); 0 unexpected; 0 unhandled rejections; 0
  uncaught exceptions; at most 5 backends; final pool 3 open, 3 idle, 0 waiting; `close()`
  clean; 0 backends after close; accounts total 10,000 (unchanged); 61 heap samples, heap
  32.7–36.4 MB, growth +0.49 MB; RSS 112.5 → 114.8 MB.
- **Earlier runs:** run 1 (1 minute, heavier load, before the watchdog existed) hung; run 2
  (30 minutes) stopped making progress after about 9 minutes with all 5 connections checked
  out and none of the workload's backends on the server: bug 1. After the fix, the 30-minute
  run above passed. Bug 2 was fixed between run 2 and the final run too.

## 2. Fault injection

`packages/core/test/fault/fault-injection.test.ts` (unit project, no database): a fake
`DriverWrapper` under the real adapter, compiler and repo counts every asynchronous driver
call (acquire, query, cursor, cursor read, cursor close, release, cancel) and fails the Nth.
Each scenario runs once without a fault to enumerate its await points, then once per point
in two modes: **once** (only the Nth call fails) and **outage** (the Nth and every later call
fail, so the rollback and the release fail too). After every run it checks that:

- every acquired connection was released exactly once, and the adapter closes (it waits for
  checked-out connections, so a leak would time out);
- no connection went back to the pool (instead of being destroyed) while inside a
  transaction, or after a cursor on it failed to close;
- the operation failed with the injected error (itself, in its `cause` chain, or in the
  Result or Batch failure), and in outage mode with the **first** one, not a later cleanup
  error. A fault in a release or in a cursor close is absorbed by design (the statement's
  outcome is what the caller needs, the connection is destroyed); the test checks that the
  operation then still succeeds.

Scenarios (22; await points in brackets): insert [3], insert with `timeoutMs` [3], read with
an `AbortSignal` [6], insertOrThrow [3], update [3], delete [3], insertOrUpdate [3],
insertAll [3], updateAll [3], deleteAll [3], transaction [6], nested transaction with a
savepoint [8], transaction rolled back on purpose [5], Batch with insert, dependent insert,
run and update [8], nested insert [7], nested update replacing children [7], preload by
query [6], `repo.preload` of rows [3], preload inside a transaction [6], stream read to the
end [7], stream left early [5], `checkout` [4]. That is 105 points and 210 faulted runs. All
pass; no bug found here. Checked that the test catches a leak: with the adapter's check-in
on the error path disabled, 10 of the scenarios fail.

## 3. Runtime matrix

- `examples/runtime` (new): `scenario.cjs`, one round trip (validated insert, a changeset
  failure, nested insert, transaction, Batch, rolled-back transaction, preload, stream,
  update, delete, count) that takes the packages from its caller; `esm.mjs` loads them with
  `import`, `cjs.cjs` with `require()`; `bundle.mjs` bundles both with esbuild 0.28.2 (ESM
  and CJS output; `better-sqlite3` external) and runs the bundles. It checks that no
  package source went into a bundle (the workspace's `paths` would otherwise be picked up),
  and has a `tsconfig.json` of its own for the same reason (Bun reads `paths`). Targets:
  Postgres (a database of its own) and SQLite (a temporary file).
- `examples/next-app` (new): Next.js 16.4.2 (React 19.3.1), a route handler doing a round
  trip through `egon-orm` and `@egon-orm/postgres`; `check.mjs` runs `next build`, `next
  start` on 127.0.0.1 against a database of its own, and compares the JSON. Telemetry off.
- The consumer matrix of `examples/smoke/consumer.mjs` (#65) is reused for the installed
  packages: the `runtime` job runs `node examples/smoke/consumer.mjs --no-types` on Node 22
  and 24 (the build job already runs it on 22 and 22.12.0).
- `.github/workflows/ci.yml`, new job `runtime` (Node 22 and 24), part of the `ci` job's
  `needs`, so required: each Node runs the consumer matrix, `examples/runtime` and
  `examples/next-app` (owner decision 1 below).
- `.github/workflows/runtime.yml` (new, on pull requests and `main`): only the Bun job
  (`continue-on-error`, best effort). It installs Bun 1.4.2 with `oven-sh/setup-bun`
  (pinned by SHA, v2.2.0), prints `bun --version`, and runs `check:bun` (Postgres only): the
  ES module, `require()`, and both esbuild bundles, each run on Bun.

Results (local, macOS arm64):

| Runtime | ESM | require() | esbuild ESM | esbuild CJS | Next.js build |
|---|---|---|---|---|---|
| Node 22.12.0 | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ (ExperimentalWarning) | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | not run |
| Node 22.23.1 | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | ✓ |
| Node 24.14.1 | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | not run locally (CI) |
| Bun 1.4.2 | pg ✓ sqlite ✗ | pg ✓ sqlite ✗ | pg ✓ sqlite ✗ | pg ✓ sqlite ✗ | — |

The Bun bundle columns were run on 2026-10-24, with Bun 1.4.2 and `bundle.mjs` started by
Bun, which runs each bundle with `process.execPath`; until review round 1, `check:bun` ran
only the ES module and `require()`, so CI did not check the bundles.

Node 24.14.1 also passed `consumer.mjs --no-types` (ESM and `require()` from the packed,
installed packages). Bun's SQLite failure is Bun's: "'better-sqlite3' is not yet supported
in Bun" (oven-sh/bun#4290). Before bug 3 was fixed, the esbuild CJS bundle failed on SQLite
on every Node; before bug 2, one run in three of the Node 24 bundles crashed after `close()`.

## 4. Mutation testing

`pnpm test:mutation [area]` (`scripts/mutation.mjs`) runs Stryker 10 with the Vitest runner
over the `core:unit` tests (`vitest.mutation.config.ts`), one run per area, concurrency 2,
`ignoreStatic: false` (see Decisions for why). Local runs on macOS arm64, Node 22.23.1. Each
run tests the working tree as it was when it started (the time its configuration file in
`reports/mutation/` was written), matched against the commit times:

- query, 14:28:11: `5ea82e8` plus the uncommitted changeset tests that were committed as
  `4bf2837` at 14:30:30 (`measure.test.ts`). Those tests are outside the query area, so the
  query score is the score of `5ea82e8`; it has none of the query tests of `7bda82b`.
- compiler, 18:59:13: `b2beef5` (committed 14:41:33; the next commit, `7bda82b`, came at
  19:11:01), so without the compiler tests of `6f16bc4`.
- changeset, 22:32:07: `7bda82b` (committed 19:11:01; `6f16bc4` came at 22:38:01, and its
  compiler test edits may already have been in the working tree; they are outside the
  changeset area), so with every changeset test of this step.
- the first changeset run (80.71%, the source of the changeset samples), 13:59:21:
  `5ea82e8` (committed 13:08:48; the next commit came at 14:30:30).

| Area | Files with mutants | Mutants | Killed | Timeout | Survived | No coverage | Runtime error | Score | Time |
|---|---|---|---|---|---|---|---|---|---|
| compiler | 10 | 5,317 | 4,748 | 199 | 365 | 5 | 0 | **93.04%** | 3 h 32 min |
| query | 19 | 5,969 | 4,962 | 20 | 982 | 5 | 0 | **83.46%** | 4 h 30 min |
| changeset | 10 | 4,077 | 3,358 | 29 | 662 | 25 | 3 | **83.14%** | 32 min |

Score = (killed + timeout) / (killed + timeout + survived + no coverage), as Stryker reports
it; runtime errors (mutants whose test run crashed outside a test) are left out of it. These are the scores Stryker measured. They count every survivor as a survivor,
including the classes below that are not test gaps. No adjusted score is given.

Earlier runs, kept for the record and not used above: compiler 80.59% (with
`ignoreStatic: true`, before this step's compiler tests), query 82.68% (`ignoreStatic:
true`), changeset 80.71% (`ignoreStatic: false`, before this step's changeset tests).

### Survivors by class

| Area | Error id (`""`) | Error message text | Logic | Total |
|---|---|---|---|---|
| compiler | 92 | 14 | 264 | 370 |
| query | 147 | 42 | 798 | 987 |
| changeset | 81 | 76 | 530 | 687 |

The counts are those of `scripts/mutation-sample.mjs` on the reports behind the scores above
(the compiler with its message pattern, see the appendix). The first changeset run (80.71%)
gives 81 / 80 / 625 for the same classes; its logic pool of 625 is the one the changeset
samples were drawn from.

- **Error id, rejected by tsc (verified by sample).** A `QueryError` id replaced with `""`.
  Ids are typed `IdsOf<"query">`, so such a mutant does not compile; it survives only
  because Stryker runs without a TypeScript checker. Checked by hand on five
  (`write.ts` deleteNoKey, `emit.ts` astJoinKind, `plan.ts` astCteName, `dialect.ts`
  unsupportedFeature, `bind.ts` namedParamMissing): `tsc -p packages/core` rejects each with
  TS2345 (`'""' is not assignable to parameter of type 'IdsOf<"query">'`).
- **Error message text: low value.** The wording of errors for misuse by the developer
  (an argument of the wrong kind); their ids are typed and their throws are tested. Two that
  had logic behind them were tested (the constraint `match` modes and non-object options).
- **Logic: sampled, not all triaged.** A seeded random sample of 30 per area, each mutant
  classified by hand, each real gap closed with a test checked against the hand-applied
  mutant:

| Area | Pool | Real gap (now tested) | Equivalent | Low value | Tool artifact | Gap rate (95% interval) | Estimated untested in pool |
|---|---|---|---|---|---|---|---|
| compiler | 264 | 4 | 17 | 9 | 0 | 13.3% (5.3-29.7%) | about 35 (14-78) |
| query | 798 | 4 | 14 | 10 | 2 | 13.3% (5.3-29.7%) | about 106 (42-237) |
| changeset, all files | 625 (first run) | 11 | 6 | 13 | 0 | 36.7% (21.9-54.5%) | about 229 (137-341) |
| changeset.ts + nested/change.ts | 305 (first run) | 15 | 2 | 13 | 0 | 50.0% (33.2-66.8%) | about 153 (101-204) |

  Each interval is the Wilson score interval at 95% (z = 1.96) for k real gaps in 30
  draws; the estimate is the rate, and its interval, times the pool. The compiler and query
  samples were drawn from the runs above; the changeset samples from its first run (80.71%,
  `5ea82e8`), so the gaps they found are closed in the 83.14% run. In the first changeset
  sample, 2 of the 8 gaps (and in the second, 5 of the 15) had been closed by tests written
  after that run but before the sample was classified; an earlier version of this note
  counted them apart, which made the first row add up to 28. The appendix lists every
  sampled mutant. Corrected on 2026-10-24 (review of `step/21-changeset-gaps`, #74): five
  rows of the first changeset sample were classed wrong. Rows 11, 26 and 27 are real gaps
  (a has-many to a keyless schema; a symbol in an issue path), and rows 24 and 25 are low
  value (they change only an error message or whether an empty path is frozen), so that
  sample has 11 real gaps, not 8, and the row above is recomputed.
  **The changeset area is not fully triaged**: by the estimate, between
  about 140 and 340 untested behaviours remained in its first run, most in `changeset.ts` and
  `nested/change.ts`. They are a `0.1.0`
  gate (owner decision 4) and are triaged one by one in `step/21-changeset-gaps`.
  "Equivalent" means the mutant cannot change behaviour (a check that another check already
  makes, a cache shortcut to the same result, a separator that keeps keys unique without
  it); "low value" means only a message, its advice parameters, or a malformed AST that the
  types forbid.

### Before the samples: the compiler survivors of the first run

Most of the tests this step added came from working through the compiler's first-run
survivors file by file (`dialect.ts`, `registry.ts`, `compiler.ts`, `cache.ts`, `bind.ts`,
`same-shape.ts`, `plan.ts`, `write.ts`, `emit.ts`), with each test checked against
hand-applied mutants. Real gaps closed there, among others: `capabilities.test.ts` took
its expectations from the table it checks, so a wrong capability flag passed it
(`dialect.test.ts` now pins every table); write-plan cache keys ran field positions
together (`[1, 0]` and `[10]` would share a plan) and ignored list lengths of insert cells
on MySQL and SQLite (only the tests were missing: the keys are right); `PlanCache.clear()`
dropping write plans, MySQL's `delete … from` with joins, INTERSECT grouping after UNION,
placeholder spacing in fragments, and redaction of named parameters had no test. **No
production bug was found by mutation testing**; every gap was a missing test.

### Known limitations of the tooling

- **A mutant that breaks a test file at load time is reported as survived.** The Vitest
  runner builds a mutant's result from the test tasks of each file
  (`collectTestsFromSuite` in `@stryker-mutator/vitest-runner`); a file whose top-level
  code throws has no test tasks and the error does not reach `errorsSet`, so nothing fails.
  This affects static mutants in code that test files run while they are collected (for
  example `dynamic()` called at a `describe`'s top level). Two in the query sample were of
  this kind and failed `advanced/small.test.ts` at load when applied by hand. It only
  understates the scores; it is not patched (owner, 2026-10-23), and static survivors in
  the samples were checked by hand.
- No TypeScript checker (owner decision), so mutants that would not compile count as
  survived (the error-id class above).
- Timeouts count as detected, as Stryker counts them. The compiler run had 199 (`emit.ts` 114, `plan.ts`
  37, `cache.ts` 23), mutants that make a loop or a lookup run past the time limit.

### Disk

The coordinator asked for disk use to be logged every 5 minutes during the runs (an earlier
attempt had filled the disk; what filled it was not found). Over all runs:
`.stryker-tmp` stayed at 18-19 MB, `reports/` grew to 39 MB (an HTML and a JSON report of
8-16 MB per area), `node_modules/.vite` 24 KB, no `node_modules/.vitest`. Nothing else in
the worktree grew.

## Decisions

- The soak test lives in `packages/postgres` (it needs the Postgres adapter, and core's tests
  do not depend on dialect packages) and in a project of its own rather than behind an
  environment variable in an `*.itest.ts`, so that an integration run cannot pick it up.
- Fault injection works at the driver interface (`DriverWrapper`), below the shared adapter,
  so that the adapter's own transaction, savepoint, cursor and check-in code is under test.
  It does not wrap a real adapter (which #68 made impossible with private fields anyway).
- Mutation testing: one Stryker run per area, so that each area has its own score;
  `coverageAnalysis: perTest` with Vitest's related mode; concurrency 2; no TypeScript
  checker (mutants that would not compile still run, which can only lower the score; the
  owner decided on 2026-10-23 not to add `@stryker-mutator/typescript-checker`).
- **`ignoreStatic: false`** (stricter than the first setting, `true`). Cause: in Stryker 10
  (`@stryker-mutator/core`, `dist/src/mutants/mutant-test-planner.js`), with `ignoreStatic`
  on, a "hybrid" mutant (one in code that runs at module load, such as a dialect table, but
  that some test also covers, here because a few tests import modules afresh while they run)
  is run against its covering tests only, with `mutantActivation: "runtime"`: the runner
  turns the mutant on in a `beforeAll`, after the module has loaded, so the table is never
  changed and the mutant always survives. It reported 456 of the compiler's 976 survivors,
  most of them tested (three applied by hand, `inner join`, `asc` and `union` emptied in
  emit.ts, each failed 28 to 37 compiler tests). Evidence on `registry.ts` alone: with
  `ignoreStatic: true`, 41 of its 46 static mutants survived although `registry.test.ts`
  refuses every built-in kind; with `false`, all 46 were killed (score 100%, 1 min 37 s).
  With `false`, static mutants run against all tests with the module loaded afresh. The
  vitest-runner patch (owner decision 2) is not involved: it only changes the test-name
  filter. Only results with `ignoreStatic: false` are reported in §4.

## Owner decisions (approved 2026-10-23)

1. **The runtime matrix's Node jobs are part of the required `ci` check; Bun stays best
   effort.** Reason: the Node 22 and 24 runs (ESM, `require()`, esbuild bundles, Next.js)
   are supported targets and caught bugs 2 and 3 here, so a regression there must block a
   merge; Bun is not a supported target and fails on SQLite for a reason of its own. Done:
   the Node jobs moved from `runtime.yml` into `ci.yml` as the `runtime` job, which the `ci`
   job needs; `runtime.yml` keeps only the Bun job, with `continue-on-error`.
2. **A pnpm patch of `@stryker-mutator/vitest-runner` 10.0.0**
   (`patches/@stryker-mutator__vitest-runner@10.0.0.patch`, registered in
   `pnpm-workspace.yaml` under `patchedDependencies`). Reason: the runner selects a mutant's
   tests with a name filter that joins suite and test names with a space, while Vitest 5
   matches against names joined with `" > "`. Without the patch no test inside a `describe`
   ever ran against a mutant, so every mutant covered only by such tests "survived" and the
   scores were meaningless. The patch accepts either separator at each space; it is a
   dev-only dependency, used only by `pnpm test:mutation`, and pinned to the exact version
   (pnpm fails the install if the patch stops applying). Drop it when the runner supports
   Vitest 5.
3. **`noDefaultExport` exemption for the three Next.js files** (`biome.json`:
   `examples/next-app/next.config.mjs`, `app/layout.jsx`, `app/page.jsx`). Reason: Next.js
   only loads a config, layout or page from a default export, so the example cannot be
   written otherwise; the exemption is limited to those three paths, as the existing one
   for the edge worker is.
4. **The changeset survivors are a `0.1.0` gate.** Reason: the samples put the changeset
   area's untested behaviour at about 27% of its logic survivors (14-44%; about 37%, 22-54%,
   after the correction of 2026-10-24 in §4), and 50% (33-67%)
   in `changeset.ts` and `nested/change.ts`, more than the other areas (13%). Their triage, one
   survivor at a time with a test for each real gap, follows in `step/21-changeset-gaps`,
   started from this branch.

## Checks I changed, exempted or worked around

- `biome.json`: `noDefaultExport` is off for `examples/next-app/next.config.mjs`,
  `app/layout.jsx` and `app/page.jsx` (owner decision 3).
- The Stryker Vitest runner is patched (owner decision 2). It changes how mutation testing
  selects tests, not what any check accepts.
- No check was weakened: coverage thresholds, `minimumReleaseAgeStrict` and the integration
  tests are as they were. Every new dependency passed the minimum release age
  (`@stryker-mutator/core` and `vitest-runner` 10.0.0, `next` 16.4.2, `react`/`react-dom`
  19.3.1, `esbuild` 0.28.2 already in the lockfile). Bun is installed in CI with
  `npm install --global bun@1.4.2` (pinned; 1.4.4 was a day old).

## Gaps and unverified claims

- Soak: one 30-minute run on the final code, locally, on Node 22; not run in CI yet (the
  workflow is manual or weekly). Postgres only, as the spec asks; MySQL streams were read
  (their cursor ends on a connection error) but not soaked.
- CI on this PR (head `d8e4a13`): every required job passed, among them `runtime (node 22)`
  and `runtime (node 24)` (the consumer matrix, `examples/runtime` and the Next.js build and
  serve on Node 24 too) and both integration jobs. `runtime (bun, best effort)` passed:
  Bun 1.4.2 ran the ES module, `require()` and both esbuild bundles against Postgres. On
  the previous head (`a15c778`) the Bun job had failed with `bun: not found` (fixed in
  review round 1). `types (typescript next, informational)` failed, as it does on `main`;
  it is informational and not part of `ci`.
- The robustness workflow (`workflow_dispatch` and weekly) has not run on GitHub yet; the
  soak result above is local.
- Mutation testing: the logic survivors were sampled (30 per area), not all triaged; the
  estimates above are estimates. The changeset ones are triaged in full in
  `step/21-changeset-gaps` (owner decision 4). The query run predates the query tests of
  `7bda82b`, so its score does not include them.

## Review round 1

Findings of https://github.com/egon-orm/egon-orm/pull/73#issuecomment-6380835977, all
addressed in `d8e4a13` and the commit after it:

1. The Bun job never ran Bun (`bun: not found` after `npm install --global`). It now uses
   `oven-sh/setup-bun` pinned by SHA (v2.2.0, published 2026-03-14), prints
   `bun --version`, and passed on GitHub.
2. The samples could not be reproduced. `scripts/mutation-sample.mjs` draws them; the
   appendix lists every sampled mutant with its class and, for each real gap, the test
   that kills it now, with the seeds, the commits the reports came from and the class rule.
3. The first changeset sample added up to 28: 2 of its real gaps had been counted apart. It
   is 8 of 30; every interval is now the Wilson interval at 95% and every estimate is the
   rate and its interval times the pool.
4. The results table lists the 3 runtime errors (left out of the score), and counts the
   files with mutants (10, 19, 10).
5. Each run names the commit it tested: the compiler run ran on `b2beef5`, before
   `6f16bc4`.
6. `check:bun` now runs the esbuild bundles too, so the Bun table's bundle columns are
   checked in CI.
7. "Gaps and unverified claims" has the CI results; main's tier-2 failure on `8b1aeea` is
   recorded under bug 2.

## Review round 2

Findings of https://github.com/egon-orm/egon-orm/pull/73#issuecomment-6381012937:

1. The changeset row of "Survivors by class" now has the script's counts on the report
   behind the 83.14% score (81 / 76 / 530); the old 82 / 67 / 538 came from an earlier
   classifier and are replaced. The first run's counts (81 / 80 / 625) are given beside it.
2. The query run started at 14:28:11, before `4bf2837` was committed (14:30:30): it tested
   `5ea82e8` plus the uncommitted `measure.test.ts` changes, which are outside the query
   area. Every run is now matched against the commit times in §4.

## Requests

- **21-audit:** the three bugs above are fixed here; please re-verify them in the readiness
  report (bug 1 is a release blocker class: a hung pool after a database restart).
- **21-packaging (overlap):** none in their files; `runtime.yml` reuses
  `examples/smoke/consumer.mjs --no-types` as it is.

## Appendix: the mutation samples

**Method.** `scripts/mutation-sample.mjs` draws each sample from a Stryker JSON report. It
puts every survived or uncovered mutant into one of three classes, and samples the third:

1. **error id**: a StringLiteral mutant whose original text is an id such as
   `"query.deleteNoKey"` (`/^"[a-z]+\.[A-Za-z]+"$/`);
2. **error message**: any other StringLiteral mutant on a line where, counting the three
   lines before it, the message pattern matches (default `` Error\(|`\$\{fn\} ``; the compiler
   sample also matched `unsupported\(`, the compiler's helper for refusals);
3. **logic**: everything else.

The draw is a linear congruential generator, `seed = (seed × 1103515245 + 12345) mod 2^31`,
whose value `seed / 2^31` picks an index into the logic pool in report order, skipping
repeats, until 30 are picked; the pick is listed by file and line. The seeds and commands are
under each table. The reports are not committed (8 to 16 MB each). To reproduce a sample,
check out the commit named in its title, run `pnpm test:mutation <area>`, and run the
command on `reports/mutation/<area>.json`. With the same report, the script gives the same
30 mutants. Every class below was given by hand after reading the code. Every real gap was
closed with a test, and that test was checked against the hand-applied mutant. Each tool
artifact was applied by hand and failed a test file at load. Reasons in short: "equivalent"
means the mutant cannot change behaviour; "low value" means only a message, its advice
parameters, or a path for misuse or a malformed AST.

#### Changeset, all files: seed 21, first changeset run (`5ea82e8`)

`node scripts/mutation-sample.mjs reports/mutation/changeset.json --seed 21`

real gap 11, low value 13, equivalent 6 (corrected on 2026-10-24: rows 11, 24, 25, 26, 27).

| # | Location | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 1 | `changeset/changeset.ts:124` (id 10, static) | StringLiteral: `"replace"` → `""` | real gap | `change.test.ts` "takes each of the five actions" (bab9417) |
| 2 | `changeset/changeset.ts:959` (id 463) | StringLiteral: `"inclusion"` → `""` | low value | function name in an error message |
| 3 | `changeset/changeset.ts:991` (id 493) | StringLiteral: `"validateSubset"` → `""` | low value | function name in an error message |
| 4 | `changeset/changeset.ts:1000` (id 525) | ConditionalExpression: `allowed === element` → `false` | equivalent | identity shortcut; deepEqual gives the same answer |
| 5 | `changeset/changeset.ts:1453` (id 858) | StringLiteral: `"addError"` → `""` | low value | function name in an error message |
| 6 | `changeset/changeset.ts:1678` (id 1018) | ConditionalExpression: `typeof options !== "object"` → `false` | real gap | `constraints.test.ts` "options that are not an object…" (a3be40b) |
| 7 | `changeset/measure.ts:19` (id 1678) | EqualityOperator: `code === 0x0d` → `code !== 0x0d` | equivalent | the fast path and the segmenter count a lone C1 control alike |
| 8 | `changeset/measure.ts:19` (id 1671) | ConditionalExpression: `code >= 0x80 \|\| code === 0x0d` → `true` | equivalent | always segmenting gives the same count |
| 9 | `changeset/measure.ts:24` (id 1682) | ConditionalExpression: `simple` → `false` | equivalent | always segmenting gives the same count |
| 10 | `changeset/measure.ts:53` (id 1730) | EqualityOperator: `code < 0x800` → `code <= 0x800` | real gap | `measure.test.ts` boundary list, U+0800 (4bf2837) |
| 11 | `changeset/nested/change.ts:284` (id 2082) | ConditionalExpression: `relation.kind === "embed"` → `true` | real gap | a has-many to a schema with `primaryKey: false` has an empty key: `nested.test.ts` "a has-many to a schema without a primary key deletes a stored row left out" (`step/21-changeset-gaps`) |
| 12 | `changeset/nested/embed.ts:53` (id 2616, no coverage) | EqualityOperator: `fallback.kind === "value"` → `fallback.kind !== "value"` | real gap | `nested.test.ts` "a new row takes each field's default" (bab9417) |
| 13 | `changeset/nested/embed.ts:83` (id 2659) | ConditionalExpression: `made && value instanceof Date` → `false` | real gap | `nested.test.ts` "the timestamps of one new row are one value" (bab9417) |
| 14 | `changeset/nested/embed.ts:161` (id 2745, no coverage) | ConditionalExpression: `value === null` → `false` | real gap | `nested.test.ts` "a stored row that holds null in a required field" (bab9417) |
| 15 | `changeset/nested/embed.ts:186` (id 2770) | ConditionalExpression: `embedTypeInfo(field.type) === undefined` → `false` | low value | a field that is not an embed cannot hold a nested change |
| 16 | `changeset/nested/relation.ts:58` (id 2777) | ConditionalExpression: `value === null` → `false` | low value | wording of an error message |
| 17 | `changeset/nested/relation.ts:60` (id 2783) | ConditionalExpression: `typeof value === "object"` → `true` | low value | wording of an error message |
| 18 | `changeset/nested/relation.ts:96` (id 2817) | EqualityOperator: `model === null` → `model !== null` | low value | wording of an error message |
| 19 | `changeset/nested/relation.ts:120` (id 2857) | ConditionalExpression: `fn === "castEmbed"` → `true` | low value | advice parameters of an error |
| 20 | `changeset/nested/relation.ts:207` (id 2960) | ObjectLiteral: `{ schema: relation.ownerName, association: name }` → `{}` | low value | details of a NotLoadedError |
| 21 | `changeset/nested/relation.ts:232` (id 2995) | ConditionalExpression: `value === ""` → `false` | real gap | `nested.test.ts` "an empty string is no key" (bab9417) |
| 22 | `changeset/spec.ts:185` (id 3340) | StringLiteral: ``a ${typeof params}`` → ```` | low value | wording of an error message |
| 23 | `changeset/validators/validate.ts:342` (id 3699) | EqualityOperator: `last <= 0xdbff` → `last < 0xdbff` | low value | truncation of a value shown in an error message |
| 24 | `changeset/validators/validate.ts:411` (id 3794) | ConditionalExpression: `typeof raw !== "object"` → `false` | low value | an `undefined` issue is still refused with a TypeError, with another message |
| 25 | `changeset/validators/validate.ts:501` (id 3903) | ConditionalExpression: `path.length === 1` → `false` | low value | an empty path either way; only whether it is frozen differs, and the path is readonly by type |
| 26 | `changeset/validators/validate.ts:527` (id 3929) | LogicalOperator: `typeof at === "string" && /^\\d+$/.test(at)` → `typeof at === "string" \|\| /^\\d+$/.tes` | real gap | a symbol in an issue path throws a TypeError: `validate.test.ts` "a symbol where a position would be sends the issue to the parent" (`step/21-changeset-gaps`) |
| 27 | `changeset/validators/validate.ts:527` (id 3930) | ConditionalExpression: `typeof at === "string"` → `true` | real gap | as row 26 |
| 28 | `changeset/validators/validate.ts:598` (id 4011, no coverage) | BooleanLiteral: `!only.includes(key)` → `only.includes(key)` | real gap | `validate.test.ts` "only keeps a nested change of a listed embed" (bab9417) |
| 29 | `changeset/validators/validate.ts:645` (id 4050) | ConditionalExpression: `typeof output !== "object"` → `false` | equivalent | Object.keys of a primitive output names no field |
| 30 | `changeset/validators/validate.ts:660` (id 4074) | ConditionalExpression: `result.meta === undefined` → `false` | equivalent | spreading undefined meta adds nothing |

#### Changeset, `changeset.ts` and `nested/change.ts`: seed 2026, first changeset run (`5ea82e8`)

`node scripts/mutation-sample.mjs reports/mutation/changeset.json --seed 2026 --files 'changeset/changeset\.ts$|nested/change\.ts$'`

real gap 15, low value 13, equivalent 2.

| # | Location | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 1 | `changeset/changeset.ts:124` (id 10, static) | StringLiteral: `"replace"` → `""` | real gap | `change.test.ts` "takes each of the five actions" (bab9417) |
| 2 | `changeset/changeset.ts:236` (id 97) | ConditionalExpression: `(multi)` → `true` | real gap | `change.test.ts` "keeps both of two errors that differ…" (b2beef5) |
| 3 | `changeset/changeset.ts:549` (id 209) | StringLiteral: `"forceChange"` → `""` | low value | function name in an error message |
| 4 | `changeset/changeset.ts:1030` (id 540) | ConditionalExpression: `typeof options !== "object"` → `false` | low value | options that are not an object are refused anyway, by the no-limit check |
| 5 | `changeset/changeset.ts:1098` (id 670) | ConditionalExpression: `typeof options !== "object"` → `false` | low value | options that are not an object are refused anyway (unknown option or no limit) |
| 6 | `changeset/changeset.ts:1128` (id 747) | StringLiteral: `"message"` → `""` | real gap | `validations.test.ts` "a message option is not a limit" (b2beef5) |
| 7 | `changeset/changeset.ts:1162` (id 757) | StringLiteral: `"validateConfirmation"` → `""` | low value | function name in an error message |
| 8 | `changeset/changeset.ts:1619` (id 964) | ConditionalExpression: `options.name === ""` → `false` | real gap | `constraints.test.ts` "…an empty check name are refused" (a3be40b) |
| 9 | `changeset/changeset.ts:1660` (id 1002) | OptionalChaining: `this.#spec.meta?.assocs` → `this.#spec.meta.assocs` | real gap | `constraints.test.ts` "a changeset without a schema class has no associations" (a3be40b) |
| 10 | `changeset/changeset.ts:1678` (id 1018) | ConditionalExpression: `typeof options !== "object"` → `false` | real gap | `constraints.test.ts` "options that are not an object…" (a3be40b) |
| 11 | `changeset/changeset.ts:1678` (id 1023) | BlockStatement: `(multi)` → `{}` | real gap | `constraints.test.ts` "options that are not an object…" (a3be40b) |
| 12 | `changeset/changeset.ts:1931` (id 1219) | ConditionalExpression: `value > limit` → `false` | real gap | `validations.test.ts` notEqualTo above the limit (b2beef5) |
| 13 | `changeset/changeset.ts:1999` (id 1326) | ConditionalExpression: `at.argumentKey !== undefined` → `true` | real gap | `errors.test.ts` validations() with toStrictEqual (b2beef5) |
| 14 | `changeset/changeset.ts:2070` (id 1395) | ConditionalExpression: `Array.isArray(value) && value.some((item) => item ` → `false` | real gap | `errors.test.ts` "nested changesets, alone or in a list…" (b2beef5) |
| 15 | `changeset/changeset.ts:2089` (id 1409) | ObjectLiteral: `{ ...changes }` → `{}` | real gap | `errors.test.ts` "nested changesets, alone or in a list…" (b2beef5) |
| 16 | `changeset/changeset.ts:2353` (id 1600, static) | StringLiteral: `"change"` → `""` | low value | function name in an error message |
| 17 | `changeset/changeset.ts:2370` (id 1608, static) | ConditionalExpression: `typeof values !== "object"` → `false` | low value | change() values that are not an object are refused anyway, with another error |
| 18 | `changeset/nested/change.ts:119` (id 1947) | EqualityOperator: `child.model === null` → `child.model !== null` | low value | wording of an error message |
| 19 | `changeset/nested/change.ts:208` (id 2012) | ConditionalExpression: `relation.kind === "embed"` → `true` | low value | wording of an error message |
| 20 | `changeset/nested/change.ts:215` (id 2027) | ObjectLiteral: `(multi)` → `{}` | low value | advice parameters of an error |
| 21 | `changeset/nested/change.ts:219` (id 2036) | StringLiteral: `""` → `"Stryker was here!"` | low value | advice parameters of an error |
| 22 | `changeset/nested/change.ts:338` (id 2171) | ConditionalExpression: `value === stored` → `false` | equivalent | identity shortcut; the next comparisons give the same answer |
| 23 | `changeset/nested/change.ts:339` (id 2181) | EqualityOperator: `value === null` → `value !== null` | real gap | `nested.test.ts` "a keyless embedded item equal to the stored one…" (b2beef5) |
| 24 | `changeset/nested/change.ts:353` (id 2204) | ConditionalExpression: `data === current` → `false` | real gap | `nested.test.ts` "a change of the stored keyless embed is that row" (b2beef5) |
| 25 | `changeset/nested/change.ts:354` (id 2214) | ConditionalExpression: `typeof data !== "object"` → `false` | equivalent | a child's data is a row or null, never a primitive |
| 26 | `changeset/nested/change.ts:434` (id 2308) | StringLiteral: `"castEmbed"` → `""` | low value | function name in an error message |
| 27 | `changeset/nested/change.ts:435` (id 2311) | StringLiteral: `"assoc"` → `""` | low value | kind name in an error message |
| 28 | `changeset/nested/change.ts:488` (id 2411) | ConditionalExpression: `indexOfKey([existing], relation.key, key) === 0` → `true` | real gap | `nested.test.ts` "a keyed embedOne cast with another key is a new row" (b2beef5) |
| 29 | `changeset/nested/change.ts:510` (id 2429) | UnaryOperator: `-1` → `+1` | real gap | `nested.test.ts` "a new child changeset put into a list matches no stored row" (b2beef5) |
| 30 | `changeset/nested/change.ts:558` (id 2498) | ObjectLiteral: `{ params: { target: targetMeta.name } }` → `{}` | low value | advice parameters of an error |

#### Query: seed 4242, query run (`5ea82e8` plus the uncommitted `measure.test.ts` changes of `4bf2837`)

`node scripts/mutation-sample.mjs reports/mutation/query.json --seed 4242`

low value 10, tool artifact 2, real gap 4, equivalent 14.

| # | Location | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 1 | `query/advanced/cte.ts:67` (id 169) | ObjectLiteral: `{ params: { name } }` → `{}` | low value | advice parameters of an error |
| 2 | `query/advanced/dynamic.ts:210` (id 249, static) | ConditionalExpression: `args.length === 1` → `false` | tool artifact | verified by hand: breaks `advanced/small.test.ts` at load, which the runner counts as survived |
| 3 | `query/advanced/dynamic.ts:218` (id 269, static) | EqualityOperator: `schemas === null` → `schemas !== null` | tool artifact | verified by hand: breaks `advanced/small.test.ts` at load, which the runner counts as survived |
| 4 | `query/advanced/tuple.ts:283` (id 1076, static) | BooleanLiteral: `false` → `true` | low value | marks a tuple comparison redacted: hides values in logs only |
| 5 | `query/advanced/windows.ts:828` (id 1477, static) | CallExpression: `visit(clause, node.expr, windows);` → `;` | real gap | `windows.test.ts` "a window named inside a JSON path is checked too" (7bda82b) |
| 6 | `query/assoc.ts:159` (id 1641) | LogicalOperator: `column.type?.db.kind ?? ""` → `column.type?.db.kind && ""` | real gap | `builder.test.ts` "…an array value on an array column is equality" (7bda82b) |
| 7 | `query/assoc.ts:237` (id 1740, no coverage) | ConditionalExpression: `field.column === column` → `true` | real gap | `preload.test.ts` "manyToMany through a join schema…" (7bda82b) |
| 8 | `query/ast.ts:286` (id 2104, static) | ConditionalExpression: `typeof value === "number"` → `true` | equivalent | Number.isFinite is false for anything but a number |
| 9 | `query/ast.ts:755` (id 2363, static) | StringLiteral: `"cast"` → `""` | equivalent | a kind seed only has to differ from the others |
| 10 | `query/ast.ts:757` (id 2365, static) | StringLiteral: `"jsonPath"` → `""` | equivalent | a kind seed only has to differ from the others |
| 11 | `query/ast.ts:764` (id 2372, static) | StringLiteral: `"window"` → `""` | equivalent | a kind seed only has to differ from the others |
| 12 | `query/builder.ts:1272` (id 3058, static) | ConditionalExpression: `named.length === 0` → `false` | equivalent | a cache of the canonical named parameters, computed again when absent |
| 13 | `query/builder.ts:1473` (id 3199) | ObjectLiteral: `{ key }` → `{}` | low value | advice parameters of an error |
| 14 | `query/builder.ts:1914` (id 3354, static) | StringLiteral: `"select"` → `""` | low value | label in an error message |
| 15 | `query/builder.ts:2594` (id 3674, static) | ConditionalExpression: `lists.length === 0` → `false` | equivalent | an empty list in place of the shared empty list |
| 16 | `query/builder.ts:2716` (id 3766) | BooleanLiteral: `true` → `false` | equivalent | preloads add no parameters to the main list, so there is nothing to replace |
| 17 | `query/builder.ts:2733` (id 3786) | BooleanLiteral: `true` → `false` | real gap | `set-operations.test.ts` "exclude(setOperations) also drops the values…" (7bda82b) |
| 18 | `query/builder.ts:2809` (id 3829) | ObjectLiteral: `{ params: { alias: root.alias } }` → `{}` | low value | advice parameters of an error |
| 19 | `query/builder.ts:3301` (id 4211) | ConditionalExpression: `value !== null` → `true` | low value | a null preload value (misuse) throws a TypeError instead of a QueryError |
| 20 | `query/builder.ts:3368` (id 4322) | BooleanLiteral: `true` → `false` | equivalent | a re-sorted nested list is a new node, so the result is the new list anyway |
| 21 | `query/builder.ts:3456` (id 4450) | ConditionalExpression: `value.expr.kind === "column"` → `true` | equivalent | a non-column expression has no binding to match |
| 22 | `query/builder.ts:3494` (id 4490, static) | StringLiteral: `""` → `"Stryker was here!"` | low value | text of render(), a debugging aid |
| 23 | `query/builder.ts:3635` (id 4747) | MethodExpression: `ast.ctes.some((node) => node.recursive)` → `ast.ctes.every(node => node.recursive)` | low value | text of render(), a debugging aid |
| 24 | `query/expr.ts:1201` (id 4998, static) | StringLiteral: `"remove"` → `""` | low value | method name in an error message |
| 25 | `query/expr.ts:1201` (id 4999, static) | BooleanLiteral: `false` → `true` | low value | the comparison flag only words an error |
| 26 | `query/expr.ts:1587` (id 5093, static) | ConditionalExpression: `type === undefined` → `false` | equivalent | elementTypeOf(undefined) gives the same undefined (a test was added anyway, 7bda82b) |
| 27 | `query/functions.ts:288` (id 5555, static) | ConditionalExpression: `named.length === 0` → `false` | equivalent | an empty list in place of the shared empty list |
| 28 | `query/functions.ts:849` (id 5801, static) | ConditionalExpression: `typeof query !== "object"` → `false` | equivalent | a function or a primitive has no subquery method and is refused anyway |
| 29 | `query/select.ts:224` (id 6121, static) | ConditionalExpression: `named.length === 0` → `true` | equivalent | applied by hand, every test passes: the named parameters are collected elsewhere |
| 30 | `query/widen.ts:50` (id 6194, static) | ConditionalExpression: `l !== undefined` → `true` | equivalent | with l undefined, r > l is false |

#### Compiler: seed 7777, compiler run (`b2beef5`)

`node scripts/mutation-sample.mjs reports/mutation/compiler.json --seed 7777 --messages 'Error\(|unsupported\(|`\$\{fn\}'`

equivalent 17, low value 9, real gap 4.

| # | Location | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 1 | `compiler/bind.ts:28` (id 10) | CallExpression: `namesOfSlots.set(slots, names);` → `;` | equivalent | a cache of the slot names, computed again when absent |
| 2 | `compiler/cache.ts:153` (id 229) | BlockStatement: `(multi)` → `{}` | equivalent | the identity level is a shortcut to the same plan |
| 3 | `compiler/cache.ts:241` (id 285) | CallExpression: `entries.push(entry);` → `;` | equivalent | the identity level is a shortcut to the same plan |
| 4 | `compiler/compiler.ts:218` (id 463) | LogicalOperator: `typeof node !== "object" \|\| node === null` → `typeof node !== "object" && node === nul` | low value | a null node (malformed AST) throws a TypeError instead of a QueryError |
| 5 | `compiler/compiler.ts:268` (id 511) | ConditionalExpression: `this.#expands && nodes.length > 0` → `true` | equivalent | a list-length key on any dialect only splits the cache |
| 6 | `compiler/compiler.ts:268` (id 514) | ConditionalExpression: `nodes.length > 0` → `true` | equivalent | a list-length key with no lists is a constant |
| 7 | `compiler/compiler.ts:380` (id 578) | LogicalOperator: `typeof update !== "object" \|\| update === null` → `typeof update !== "object" && update ===` | low value | a null update (malformed) throws a TypeError instead of a QueryError |
| 8 | `compiler/compiler.ts:385` (id 584, static) | ArrayDeclaration: `[]` → `["Stryker was here"]` | equivalent | a constant nothing reads |
| 9 | `compiler/compiler.ts:399` (id 600) | StringLiteral: `"-"` → `""` | equivalent | the key part stays distinct from a JSON string |
| 10 | `compiler/compiler.ts:399` (id 598) | ConditionalExpression: `schema === undefined` → `false` | equivalent | the key part stays distinct from a JSON string |
| 11 | `compiler/compiler.ts:417` (id 628) | StringLiteral: `"v"` → `""` | equivalent | the cell key stays distinct from the other cell kinds |
| 12 | `compiler/compiler.ts:426` (id 637) | StringLiteral: ``e${shapeOf(cell.expr)}`` → ```` | equivalent | expression cells are also compared by sameNodes, which catches a collision |
| 13 | `compiler/compiler.ts:441` (id 652) | StringLiteral: `"n"` → `""` | equivalent | the conflict key stays distinct from the other forms |
| 14 | `compiler/dialect.ts:761` (id 1057) | ConditionalExpression: `!dialect.capabilities.arrays` → `false` | real gap | `value-typing.test.ts` "a cast to an array type is refused…" (6f16bc4) |
| 15 | `compiler/emit.ts:327` (id 1273) | ConditionalExpression: `typeof name !== "string"` → `false` | low value | a name that is not a string (malformed AST) |
| 16 | `compiler/emit.ts:417` (id 1375) | ConditionalExpression: `typeof value === "number"` → `true` | equivalent | Number.isFinite is false for anything but a number |
| 17 | `compiler/emit.ts:439` (id 1403) | ObjectLiteral: `{ dialect: ctx.dialect.name }` → `{}` | low value | advice parameters of an error |
| 18 | `compiler/emit.ts:589` (id 1596) | ConditionalExpression: `type.db === null` → `false` | low value | a cast type without db (malformed AST) |
| 19 | `compiler/emit.ts:763` (id 1809) | StringLiteral: `"namedParam"` → `""` | equivalent | a named parameter cannot be an operand of an integer division here |
| 20 | `compiler/emit.ts:898` (id 1966) | ConditionalExpression: `node.name === "coalesce"` → `true` | equivalent | only reached for operands that are all bound values; another function has a SQL type |
| 21 | `compiler/emit.ts:1074` (id 2227) | ConditionalExpression: `node.kind === "param" \|\| node.kind === "namedPar` → `true` | real gap | `value-typing.test.ts` "a cast inside a fragment is written once" (6f16bc4) |
| 22 | `compiler/emit.ts:1124` (id 2305) | ConditionalExpression: `type === undefined` → `false` | real gap | `value-typing.test.ts` "a selected CASE gives an untyped nested compound…" (6f16bc4) |
| 23 | `compiler/emit.ts:1166` (id 2369) | EqualityOperator: `node.args.length > 0` → `node.args.length >= 0` | low value | coalesce() with no arguments (malformed AST) |
| 24 | `compiler/emit.ts:1188` (id 2402) | ConditionalExpression: `typeof node.name !== "string"` → `false` | low value | a name that is not a string (malformed AST) |
| 25 | `compiler/emit.ts:1208` (id 2433, static) | StringLiteral: `"notLike"` → `""` | real gap | `value-typing.test.ts` "notLike of two bound values…" (6f16bc4) |
| 26 | `compiler/plan.ts:387` (id 3764) | BooleanLiteral: `false` → `true` | equivalent | the flag is read only for the root's schema, undefined for these sources |
| 27 | `compiler/plan.ts:738` (id 4146) | ConditionalExpression: `branch.kind !== "row"` → `false` | equivalent | a branch that is not a row has no meta, so main is returned anyway |
| 28 | `compiler/plan.ts:775` (id 4199) | ConditionalExpression: `main.length === 0` → `false` | equivalent | merging two empty lists gives an empty list |
| 29 | `compiler/write.ts:103` (id 4937) | ConditionalExpression: `typeof field !== "object" \|\| field === null` → `false` | low value | a null field (misuse) throws a TypeError instead of a QueryError |
| 30 | `compiler/write.ts:377` (id 5286) | ConditionalExpression: `first === undefined` → `false` | low value | unreachable: a schema always has a column |
