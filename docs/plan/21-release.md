# Step 21 — Release hardening

**Depends on:** all other steps, including 21a (edge readiness).
**Owns:** release configuration, `SECURITY.md`, `CHANGELOG.md`, `docs/site/guide/upgrading.md`,
`docs/plan/status/21-audit.md`. Fixes found here go to the owning area as normal PRs.

## Goal

Decide, on evidence, that the library is ready for a public `0.1.0` (and what remains
before `1.0`), and make publishing a one-command, repeatable act.

## Work

### 1. Whole-system audit

- **API review.** Read `index.ts` of every package top to bottom as a user would. Check
  naming consistency (`OrThrow` twins everywhere, option names, parameter order), remove
  accidental exports, confirm every type a user must name is exported. Generate an API
  report (`@microsoft/api-extractor`) and commit it; from now on CI fails on unreviewed API changes.
- **Type health.** Type-check time of `examples/blog` and of a synthetic 200-schema project
  (`tsc --extendedDiagnostics`); budget: no single query expression over 50 ms of check
  time, instantiation counts recorded. Editor responsiveness check (tsserver completions in
  a `where` callback under 200 ms on the 200-schema project). Test against the minimum
  supported TypeScript version and the latest, plus `next`, in CI.
- **Error-message review.** Trigger every error class deliberately; each message must say
  what happened, the offending name, and the fix (the fix in the full text that step 21a
  makes opt-in; the default short message must still name what failed and link its entry). Do the same for the ten most likely
  **type** errors and make sure the docs' troubleshooting page covers them.
- **Cross-step seams.** Scenario tests that cross features: nested changeset insert inside
  a Batch inside a savepoint with a constraint violation on the deepest child; preload of a
  has-through inside a transaction after a bulk insert; prepared query with named params
  used concurrently from 50 tasks; streaming 1M rows with constant memory.

### 2. Security review

- Injection: rerun the step 10 property test at 100k runs across all dialects; manual
  review of every place SQL text is assembled (fragments, identifiers, lock clauses, DDL,
  database schema names, savepoint names, `explain` options).
- Prototype pollution and mass assignment: `cast` with `__proto__`, `constructor`,
  getters, symbol keys, deeply nested and huge params (size/time bounded).
- ReDoS: every built-in regex (uuid, integer, decimal, ISO date parsing, identifier checks)
  tested with adversarial input; no catastrophic backtracking.
- Secrets: redacted fields never appear in logs, errors, inspect output, telemetry, or
  thrown changeset errors; connection strings never logged.
- `new Function` use: documented, opt-out works, generated code contains no user-derived
  strings other than validated identifiers (review the generators).
- Dependencies: audit, licence check, lockfile integrity; minimal dependency set confirmed.
- `SECURITY.md` with reporting instructions and the threat model in one page.

### 3. Robustness

- Soak test: mixed workload for 30 minutes against Postgres with random connection kills
  (`pg_terminate_backend`) and a pool of 5 — no leaked connections, no unhandled
  rejections, stable memory.
- Fault injection through a fake adapter: failure at every await point of insert/update/
  delete/transaction/Batch/nested/preload leaves no checked-out connection and surfaces the original error.
- Runtime matrix: Node 22 and 24 (required), Bun (best effort, results recorded);
  ESM consumers, and CommonJS consumers through `require()` of the ES module; bundled with esbuild and with a framework build (Next.js) in `examples/`.
- Mutation testing (Stryker) on `changeset/`, `query/`, `compiler/`: mutation score ≥ 80%;
  surviving mutants triaged (killed with new tests or justified).

### 4. Packaging and release

- `publint` and `attw` clean for every package; `exports` verified from real consumer
  projects (ESM, CommonJS via `require()` of the ES module on Node >= 22.12, TS `moduleResolution` `node16` and `bundler`).
- Peer dependency ranges tested at their lower and upper bounds (`pg`, Zod, `better-sqlite3`, `mysql2`).
- The package name is decided: `egon-orm` / `@egon-orm/*` (plan README §11). Confirm the
  npm scope is claimed and verify nothing still references `ectype`.
- Changesets-based release workflow: version PR, changelog generation, npm publish with
  provenance from CI, git tags, GitHub release notes. Dry-run it end to end against a local registry (verdaccio).
- Versioning policy and support policy written down (semver; what counts as breaking for
  types; supported Node/TS/database versions).
- `upgrading.md` scaffold; `CHANGELOG.md` for 0.1.0 written for humans.

### 5. Readiness report

`docs/plan/status/21-audit.md`: for each area a verdict (ready / ready with caveats /
not ready) with evidence links; every acceptance box from steps 01–20 re-verified
(not copied from the status notes); open issues ranked; an explicit recommendation —
publish `0.1.0` now, or fix a named list first — and the proposed gate for `1.0`.

## Acceptance

- [ ] Audit report written with evidence for each verdict; no "not ready" item without an owner and issue.
- [ ] Security review complete; all findings fixed or documented with severity.
- [ ] Soak, fault-injection and runtime-matrix results recorded; zero connection leaks.
- [ ] Mutation score target met for the three core areas.
- [ ] Release dry run succeeds end to end from a clean clone.
- [ ] API report committed and enforced in CI.

## Out of scope

Actually publishing to npm and announcing — that is the project owner's call after reading the readiness report.

## Carried over from steps 01 and 02

Requests that the (now removed) status notes of steps 01 and 02 addressed to this step.

- Run the CommonJS `require()` consumer on Node 22.12 exactly, not only on the latest 22.x.
- Public packages have no `README.md` yet.
- Decide whether to move to TypeScript 7 (it needs a different declaration bundler than tsup's).
- Owner: enable branch protection on `main` (one approval and the `ci` check; squash merges only).
