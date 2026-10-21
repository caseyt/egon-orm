# Step 19 — Performance

**Depends on:** 01 for part A (start early); 16 for parts B–D.
**Owns:** `benchmarks/` (harness, comparative suites, CI gating), `docs/site/guide/performance.md`,
`docs/site/reference/benchmarks.md`. May open PRs against any package for optimisations
(each one small, with before/after numbers, reviewed like any other PR).

> **Owner decision, 2026-10-14:** feature steps no longer write micro-benchmarks. This step
> writes `micro/<area>.bench.ts` for every area once everything works (the benchmarks that
> steps 04–07 already committed stay), then measures every README §7 budget. See README §7.

> **Owner decision, 2026-10-21:** no speed test runs on every PR, and nothing in CI gates on
> timings. The benchmarks are run once, the way Drizzle publishes its own (a server per
> library, load from a separate machine with k6), and the results are published in the docs
> with the method, hardware and versions, so that anyone can rerun them. They are rerun by
> hand before a release when the owner asks. This replaces the CI gate (Part A item 5) and
> the gated budgets (item 6); the budgets in README §7 are measured and reported, not
> enforced. Where the runs happen (which machines) is the owner's decision, still open.

## Goal

Measure Egon against the raw driver and the other TypeScript ORMs once, fairly and
reproducibly, publish the results, and use the measurements to meet or beat the budgets in
plan README §7 where they show a problem.

## Part A — Harness (right after step 01, before feature work piles up)

1. **Runner.** `benchmarks/` with `mitata` (or `tinybench`), one process per benchmark file,
   pinned Node flags, warm-up, and enough samples to report median, p75, p99 and the
   relative margin of error. Reject a run whose margin exceeds a threshold (noisy machine).
2. **Layout.** `micro/<area>.bench.ts` (written by this step; see the note above),
   `e2e/*.bench.ts` (against real Postgres with seeded data), `compare/*.bench.ts`
   (other libraries), `memory/*.bench.ts`.
3. **Seeding.** Deterministic dataset generator for the blog schema: small (1k users),
   medium (100k posts), large (1M comments) — created once per run in a dedicated database.
4. **Results.** JSON per run in `benchmarks/results/` with machine fingerprint, Node
   version, git SHA. A `pnpm bench:compare <base> <head>` script prints a table of deltas
   with significance (non-overlapping confidence intervals).
5. **No CI gate** (owner decision, 2026-10-21). CI keeps running `pnpm bench` only to
   keep the harness working; its numbers are not compared or published.
6. **Budgets.** `benchmarks/budgets.json` maps benchmark names to the README §7 budgets; a
   script reports each measured value against its budget on the published run. It does not
   fail a build. If a README number changes, record why in an ADR.

## Part B — Comparative suite (after step 16)

Follow the method of Drizzle's published benchmarks (orm.drizzle.team/benchmarks, also used
by Prisma for its own comparison), so the results are read the same way:

- one small HTTP server per library, each serving the same endpoints over the same dataset
  (the Drizzle suite's e-commerce dataset, or the blog dataset of Part A; record which);
- the server and Postgres on one machine, the load generator ([k6](https://k6.io)) on a
  separate machine on the same network, so they do not compete for CPU;
- a fixed request list, prepared once and replayed for every library;
- reported: requests per second at a given p95 latency, latency percentiles, and CPU and
  memory of the server process.

Alongside that, the per-operation scenarios below, run in-process with the harness.
Same schema, same data, same queries, same pool size, against: raw `pg` with hand-written
mapping (the floor), Kysely, Drizzle, Prisma, TypeORM, MikroORM. Scenarios:

| # | Scenario |
|---|---|
| 1 | Find one by primary key |
| 2 | Select 10 / 1,000 / 10,000 rows, 10 columns |
| 3 | Filter + order + limit with 3 parameters (query rebuilt per call, as in a request handler) |
| 4 | Two joins + aggregate + group by |
| 5 | Users with posts and comments (nested load of 100 × 10 × 5) |
| 6 | Insert one row with validation; insert 1,000 rows in bulk |
| 7 | Update one field by primary key |
| 8 | Transaction with 3 writes |
| 9 | Query construction only (no database): build + compile, cold and warm |
| 10 | Changeset: cast + validate 10 fields (vs Zod alone, vs class-validator) |

Report throughput, latency percentiles, and allocated bytes per operation
(`process.memoryUsage()` deltas over many iterations, with `--expose-gc`). Be fair: each
library used the way its docs recommend, versions pinned and listed, the suite published
so others can reproduce it. Results that make Egon look bad are published too, with an issue filed.

### Edge measurements

Nobody publishes these, and edge deployments matter to the owner (step 21a):

- bundle size (minified, gzip) of the reference app for each library, from the packed
  tarballs, with the same bundler settings;
- cold start in workerd (Miniflare): time to the first response of a Worker, for each library;
- round trips to the database per request for the nested-load and transaction scenarios.

## Part C — Optimisation pass

Work from profiles, not intuition. For each hot path (query build, compile-cache hit,
param binding, hydration, changeset cast, insert, preload stitching):

1. Capture a CPU profile (`--cpu-prof`) and an allocation profile on the relevant benchmark.
2. Check for the usual suspects: megamorphic call sites (`--trace-ic` / deopt logs via
   `--trace-deopt`), hidden-class transitions in row objects, closures allocated per call,
   intermediate arrays, `arguments`/rest in hot functions, `try/catch` or `async` layers
   that add microtask hops, `Map` lookups that could be array indexes, string concatenation in loops.
3. Fix, re-measure, and land as a small PR with before/after numbers. Keep changes that
   win ≥ 3% with significance; revert those that do not (complexity is a cost).
4. Specific investigations to run and write up:
   - Emitter cost on cold compile, and driver-wrapper cost on execution, against the
     spike's floors (ADR 0003: 2.18 µs for the reference query, 122 ns for a stub driver call).
   - Hydration codegen vs interpreter across row widths (5/10/30/100 columns).
   - Whether asking the driver for array-mode rows is worth it.
   - Server-side prepared statements for `prepare`d queries (latency and plan-cache effects).
   - Cost of `Result` object allocation on writes; cost of copy-on-write changesets.
   - Startup cost: time to define 100 schemas and resolve associations; import time of `egon-orm` (target < 30 ms cold).
5. **Memory.** Per-row retained size for a 10-column row (target: within 1.2× of a plain
   object literal); no growth over 1M iterations of each e2e scenario (leak check); plan
   cache bounded under a workload of unique query shapes.
6. **Bundle.** Size of `egon-orm` minified+gzipped with and without tree-shaking a
   changeset-only import, reported with the published run; verify `sideEffects: false` holds.

## Part D — Guidance

`guide/performance.md` for users: define queries at module level; `prepare` for hot paths;
select only what is needed; preload strategy choice; bulk operations; streaming; pool
sizing; reading telemetry; what the plan cache does and its metrics; `codegen: false`
trade-off. `reference/benchmarks.md`: methodology, hardware, versions, full comparative
results, how to reproduce, generated from the latest results JSON.

## Tests

- The harness itself: `bench:compare` on synthetic results (regression detected, noise
  ignored); the budget report; seeding determinism.
- Shape/monomorphism guard tests (V8 natives) for rows and bindings, run in a dedicated CI job.
- Leak tests under `--expose-gc` for each e2e scenario.

## Acceptance

- [ ] Every budget in README §7 has a benchmark, and the published run reports each one
  against its budget (or an ADR adjusts the budget with justification).
- [ ] The comparative suite (server load test and per-operation scenarios) and the edge
  measurements run reproducibly from documented commands on the machines the owner chose;
  results, method, hardware and versions are published in `reference/benchmarks.md`.
- [ ] Each optimisation PR carries before/after numbers; investigations in Part C item 4 written up in `docs/site/internals/performance-notes.md`.
- [ ] Memory, leak and bundle-size targets measured and reported.

## Out of scope

Optimising other libraries' usage beyond their documented best practice. Database tuning.

## Carried over from steps 01 and 02

Requests that the (now removed) status notes of steps 01 and 02 addressed to this step.

- `benchmarks/src/harness.ts` and `run.ts` are this step's to replace; feature steps only need `bench`, `group`, `doNotOptimize` and `runBenchmarks()` to keep working.
- `benchmarks/micro/internal.bench.ts` shows how to benchmark non-public code from `dist/internal.js`.
- The step 02 cost numbers came from one machine, with Postgres behind a VM boundary.
