# Step 21 (robustness): soak, fault injection, runtime matrix, mutation testing, status

Branch `step/21-robustness`, 2026-10-22, from `main` at `e6ea502`, with `main` merged at
`37853d9` (#68, security), `baecd60` (#65, packaging) and `2eff98a` (#69, audit; #71,
TypeScript 5.8 minimum). Spec: `docs/plan/21-release.md` §3. The owner decided on 2026-10-22 that all four items stay gates for `0.1.0`.

## Summary

| Item | Result |
|---|---|
| Soak test, 30 min, pool of 5, random `pg_terminate_backend` | **Pass** on the final code: 166,467 operations, 1,007 kills, 0 unexpected failures, 0 unhandled rejections, 0 connections left checked out, 0 backends after `close()`, heap +0.49 MB. Two earlier runs **found a hang** (bug 1 below), now fixed. |
| Fault injection, every await point | **Pass**: 22 scenarios, 105 await points, 210 faulted runs, no connection left checked out, the injected error surfaces every time. |
| Runtime matrix | **Pass** on Node 22.12.0, 22.23.1 and 24.14.1 (ESM, `require()`, esbuild ESM and CJS bundles, Next.js 16.4.2 build), Postgres and SQLite. Bun 1.4.2 (best effort): Postgres passes in all four forms; SQLite fails because Bun cannot load `better-sqlite3`. Found bug 3 (SQLite in a CommonJS bundle). |
| Mutation testing, ≥ 80% per area | **Pass** (Stryker's own scores, `ignoreStatic: false`): compiler 93.04%, query 83.46%, changeset 83.14%. Not fully triaged: sampled real-gap rates are compiler 13%, query 13%, changeset about 20% (about 33-50% in its two largest files); the changeset survivors are a `0.1.0` gate (owner decision 4) and are triaged one by one in `step/21-changeset-gaps`. |

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
   unhandled `error` and Node exited. Seen as a crash of the runtime matrix (1 run in 3).
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
  (`continue-on-error`, best effort), which runs `check:bun` (Postgres only).

Results (local, macOS arm64):

| Runtime | ESM | require() | esbuild ESM | esbuild CJS | Next.js build |
|---|---|---|---|---|---|
| Node 22.12.0 | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ (ExperimentalWarning) | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | not run |
| Node 22.23.1 | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | ✓ |
| Node 24.14.1 | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | pg ✓ sqlite ✓ | not run locally (CI) |
| Bun 1.4.2 | pg ✓ sqlite ✗ | pg ✓ sqlite ✗ | pg ✓ sqlite ✗ | pg ✓ sqlite ✗ | — |

Node 24.14.1 also passed `consumer.mjs --no-types` (ESM and `require()` from the packed,
installed packages). Bun's SQLite failure is Bun's: "'better-sqlite3' is not yet supported
in Bun" (oven-sh/bun#4290). Before bug 3 was fixed, the esbuild CJS bundle failed on SQLite
on every Node; before bug 2, one run in three of the Node 24 bundles crashed after `close()`.

## 4. Mutation testing

`pnpm test:mutation [area]` (`scripts/mutation.mjs`) runs Stryker 10 with the Vitest runner
over the `core:unit` tests (`vitest.mutation.config.ts`), one run per area, concurrency 2,
`ignoreStatic: false` (see Decisions for why). Local runs on macOS arm64, Node 22.23.1, on
the branch as of `6f16bc4` (the compiler and changeset runs include this step's new tests;
the query run started before the query tests of `7bda82b`).

| Area | Files | Mutants | Killed | Timeout | Survived | No coverage | Score | Time |
|---|---|---|---|---|---|---|---|---|
| compiler | 11 | 5,317 | 4,748 | 199 | 365 | 5 | **93.04%** | 3 h 32 min |
| query | 21 | 5,969 | 4,962 | 20 | 982 | 5 | **83.46%** | 4 h 30 min |
| changeset | 15 | 4,077 | 3,358 | 29 | 662 | 25 | **83.14%** | 32 min |

Score = (killed + timeout) / (killed + timeout + survived + no coverage), as Stryker reports
it. These are the scores Stryker measured. They count every survivor as a survivor,
including the classes below that are not test gaps. No adjusted score is given.

Earlier runs, kept for the record and not used above: compiler 80.59% (with
`ignoreStatic: true`, before this step's compiler tests), query 82.68% (`ignoreStatic:
true`), changeset 80.71% (`ignoreStatic: false`, before this step's changeset tests).

### Survivors by class

| Area | Error id (`""`) | Error message text | Logic | Total |
|---|---|---|---|---|
| compiler | 92 | 14 | 264 | 370 |
| query | 147 | 42 | 798 | 987 |
| changeset | 82 | 67 | 538 | 687 |

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
| compiler | 264 | 4 | 17 | 9 | 0 | 13% (5-30%) | about 35 (13-80) |
| query | 798 | 4 | 14 | 10 | 2 | 13% (5-30%) | about 105 (40-240) |
| changeset, all files | 625 (first run) | 6 | 11 | 11 | 0 | 20% (8-39%) | about 125 (50-245) |
| changeset.ts + nested/change.ts | 305 (first run) | 10 (+5 closed earlier the same day) | 2 | 13 | 0 | 33% (19-51%), 50% counting the 5 | about 100-150 |

  The intervals are Wilson intervals on 30 draws; the estimates scale the rate to the pool.
  The compiler and query samples were drawn from the runs above; the changeset samples from
  its first run (80.71%), so some of the gaps they found are closed in the 83.14% run.
  **The changeset area is not fully triaged**: by the estimate, roughly a hundred untested
  behaviours remain, most in `changeset.ts` and `nested/change.ts`. They are a `0.1.0`
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
   area's untested behaviour at about 20% of its logic survivors, and 33-50% in
   `changeset.ts` and `nested/change.ts`, more than the other areas (13%). Their triage, one
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
- The Next.js check ran locally on Node 22.23.1 only; Node 24 runs it in CI.
- Bun's results are from a local run; the CI Bun job is best effort and not required.
- The `runtime` job, the Bun workflow and the robustness workflow have not run on GitHub
  before this PR.
- Mutation testing: the logic survivors were sampled (30 per area), not all triaged; the
  estimates above are estimates. The changeset ones are triaged in full in
  `step/21-changeset-gaps` (owner decision 4). The query run predates the query tests of
  `7bda82b`, so its score does not include them.

## Requests

- **21-audit:** the three bugs above are fixed here; please re-verify them in the readiness
  report (bug 1 is a release blocker class: a hung pool after a database restart).
- **21-packaging (overlap):** none in their files; `runtime.yml` reuses
  `examples/smoke/consumer.mjs --no-types` as it is.
