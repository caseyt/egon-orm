# Step 21a — Edge readiness

**Depends on:** 17, 18 and 20 (merged). Runs before 21; does not wait for 19.
**Owns:** `packages/core/src/errors.ts` and the error sites of every package (message text
only), a new `egon-orm/messages` entry, the plan cache (`packages/core/src/compiler/`,
`adapter/`), code generation (`schema/`, `changeset/validators/`, the query decoders),
`packages/postgres/src/cancel.ts`, the tsup configs, a new `examples/edge-worker/`,
`docs/site/guide/edge.md`, `docs/site/reference/errors.md`, `docs/plan/status/21a.md`.

> **Owner decision, 2026-10-20:** edge deployments are important. Add this step before the
> release, and switch thrown errors to codes as part of it. The research behind it is
> summarised under Background; the full report was given to the owner the same day.

## Goal

Egon runs on edge runtimes (Cloudflare Workers first) with no change to the public API
other than error messages, its published build tree-shakes, and thrown errors carry an
identifier, a short message and a docs link by default, with the full text as an explicit
opt-in.

## Background (research, 2026-10-20, `main` at `acbfdcc`)

- **Workers fail on the first request today.** `schema/schema.ts` and
  `changeset/validators/validate.ts` check once, when the module loads, whether
  `new Function` is allowed. Workers allow it during startup but not while handling a
  request, so code generation then throws `EvalError` (measured in local workerd).
  `codegen: false` on schemas and the repo works around it, but `changeset.validate()` has
  no opt-out.
- **A repo cannot be reused across Workers requests** (requests after the first hang;
  Workers forbid I/O across requests). The repo, and with it the per-adapter plan cache, is
  created per request, so every query is a cold compile there.
- **The published dist does not tree-shake.** tsup bundles core into five chunks, and
  top-level calls (91 `Object.freeze` tables and others) keep them alive. Importing only
  `EgonError` costs 187.5 KB minified from the dist and 0.1 KB from source; a schemas-only
  import drops from 60.6 to 16.9 KB gzip unbundled.
- **Error text is 15% of the minified bundle** (60 KB over 609 sites). Codes instead of the
  long text save about 46 KB minified, 14 KB gzip (simulated).
- **Sizes of the reference app** (one table, an insert, a select with where/orderBy/limit;
  esbuild, minified, `pg` external): today 394.7 / 124.6 KB min / gzip; with this step's
  build changes about 385 / 122 measured, and with error codes about 339 / 108 simulated.
  As a Worker with `pg`, 164 KiB gzip; Cloudflare's limit is 64 MiB uncompressed.
- `@egon-orm/postgres` works on Workers with `nodejs_compat`, but `cancel.ts` imports `net`
  and `tls` at load time, and tsup rewrites `node:net` / `node:tls` to bare specifiers.
- A prototype of parts 1 and 3 is on the local branch `research/bundle-size` (commits
  `de774bd`, `3165b78`, `cd006f0`). Use it as a reference; its tests were not brought up to date.

## Work

### 1. Code generation that survives request-time refusal

- Check whether code can be generated at the moment it is generated, and remember only a
  refusal; fall back to the existing loop implementations. Covers schema row factories,
  validator tables and query decoders.
- Where a schema is defined at startup (the usual case), build its row factory and
  validator tables eagerly in `Schema()`, while generation is allowed. Measure nothing
  (benchmarks wait for step 19); reason about the cost in the status note.
- Tests: a fake runtime whose `Function` constructor succeeds during "startup" and throws
  afterwards; every generated path falls back and returns the same results. Update the two
  tests that pin today's probe-once behaviour.
- Hot-path rules (README §7) apply: nothing new per row or on a plan-cache hit.

### 2. A plan cache shared across adapters

- Compiled plans are shared by every adapter instance with the same dialect, capabilities
  and codecs (a module-level, bounded cache keyed by those), so a repo created per request
  reuses plans compiled by earlier requests.
- Decide and document what `planCacheSize` means afterwards (README §11 names the option);
  propose the change in the status note under "Needs the owner's decision" before building
  it if it changes the option's contract.
- Tests: two adapters with the same configuration share plans; different codecs or
  capabilities do not; the bound holds under many distinct queries.

### 3. A build that tree-shakes and keeps `node:` imports

- Publish an unbundled dist (one file per source module) for every package, keeping the
  public entry points (`egon-orm`, `egon-orm/migration`, `egon-orm/testing`, the internal
  entry the adapters use) and `sideEffects: false`.
- `/* @__PURE__ */` on top-level calls that build tables, with a lint check that keeps it so.
  Object spread inside such a call is not pure to bundlers; build those tables without it.
- `removeNodeProtocol: false` (or the equivalent), so `node:` specifiers survive the build.
- `pnpm lint:packages`, `pnpm smoke` and the CommonJS `require()` consumer keep passing.
- A size report script over the packed tarballs: the reference app and the subset imports
  (schemas only, `cast`, query only, `EgonError` only), min and gzip. It reports; it does not
  gate (budgets are step 19's).

### 4. Error codes by default, full text by opt-in

Applies to **thrown** errors (`EgonError` and its subclasses, in every package). Changeset
validation messages (`can't be blank`, `has already been taken`, …) are data for end users
and are unchanged.

- The class codes (`error.code`: `"query"`, `"cast"`, `"constraint"`, …) stay as they are;
  each covers many messages (`QueryError` alone is thrown from hundreds of sites). So every
  distinct message also gets a stable identifier of its own (its name and format are part of
  the ADR below), exposed on the error so callers and tests can match it.
- The default message is that identifier, one short sentence that still names what failed
  (the schema, field, parameter or SQL state), and a link to its entry on the docs site.
  Values interpolated today stay in the short sentence; nothing redacted becomes visible.
- The full text, including what to do about it, ships in a separate entry,
  `egon-orm/messages`, and is used only when the application opts in explicitly (owner
  preference: explicit opt-in over inference). Write an ADR that compares the mechanisms
  (an explicit call such as `useFullErrorMessages(messages)`, an option on `createRepo`, the
  `development` export condition) and recommends one; the owner approves the ADR before
  the mechanism is built. Whatever is chosen must work on Workers and Vercel Edge (no
  `process` required) and must not grow the default bundle.
- The docs list every identifier with its full text and how to fix it (on
  `reference/errors.md` or pages under it); a check in `pnpm docs:check` fails when an
  identifier has no entry or an entry names no identifier.
- Structured fields (`code`, `cause`, sub-codes such as `DatabaseError`'s) are unchanged;
  tests that match message text are updated to match identifiers or the opt-in text.
- The guide pages that quote error messages are updated (a change to other steps' pages:
  list them in the status note for the owner, plan README §8).

### 5. `@egon-orm/postgres` on the edge

- Load the cancellation code (`net`, `tls`) only when a cancel is first needed; where those
  modules are unavailable, the adapter reports cancellation as unsupported instead of
  failing to load.
- Document the per-request pattern for Workers: create the repo in the handler and close it
  with `ctx.waitUntil(repo.close())`.

### 6. A Workers check in CI

- `examples/edge-worker/`: the reference app as a Worker (`nodejs_compat`), with
  `wrangler deploy --dry-run` to build it and a Miniflare run against the CI Postgres that
  makes three requests (insert, select, a second request reusing schemas and the plan cache).
- Telemetry off (`send_metrics = false` and `WRANGLER_SEND_METRICS=false`); no login, no deploy.
- Runs in CI as its own job; the bundle size is printed in the job summary.

### 7. Docs

- `guide/edge.md` (Edge runtimes): Workers with `nodejs_compat`, the per-request repo,
  Hyperdrive, what is not supported yet (Vercel Edge, D1, Neon's HTTP driver), and the size
  of a typical bundle.
- `reference/errors.md` as in part 4; the error pages of the guide link to it.

## Acceptance

- [ ] The reference app runs in workerd (Miniflare) against Postgres for three requests,
  in CI, with code generation refused at request time.
- [ ] Every generated path has a tested fallback; no path still checks only at module load.
- [ ] A per-request repo reuses plans compiled by an earlier request (test).
- [ ] Importing `EgonError` alone from the packed tarball bundles to under 1 KB; the size
  report for the reference app and the subset imports is in the status note (min and gzip).
- [ ] No bare `net`, `tls` or other built-in specifier without `node:` in any dist.
- [ ] Every thrown message has a stable identifier and a docs entry (checked); default
  messages contain no "how to fix" text; the opt-in restores it (tested on Node and in the Worker).
- [ ] The error-code ADR is accepted by the owner before part 4's mechanism is built.
- [ ] `pnpm check`, `pnpm test:integration` (both tiers), `pnpm lint:packages`,
  `pnpm smoke` and `pnpm docs:build` pass; no check weakened.
- [ ] Benchmark and budget items: deferred to step 19 (owner decision, 2026-10-14).

## Out of scope

- Moving each database's SQL tables into its adapter package (needs an ADR; later, when a
  fourth database is planned).
- Reshaping the public API for size: feature entry points, a `lite` repo.
- New drivers: Neon, `postgres.js`, D1, libSQL (after step 21).
- Vercel Edge, Netlify, Deno and Bun runs (record what is known in the guide; step 21's
  runtime matrix may add them).
