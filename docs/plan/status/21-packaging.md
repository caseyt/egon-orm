# Step 21 (packaging): packaging and release, status

Branch `step/21-packaging`, 2026-10-22, from `main` at `97def5c` (#61). Spec:
`docs/plan/21-release.md` §4 and "Carried over from steps 01 and 02".

## What shipped

### 1. publint and attw; the consumer matrix

- `pnpm lint:packages` is clean for all six packages, `@egon-orm/cli` included: publint
  `--strict` "All good!" six times; attw `--profile esm-only` green for every entry point
  under `node16 (from ESM)` and `bundler`. attw still prints its static warning for
  `node16 (from CJS)` ("ESM (dynamic import only)"), ignored by the profile: attw does not
  model `require()` of an ES module, which the consumer matrix tests for real instead.
- `examples/smoke/check-types.mjs` became `examples/smoke/consumer.mjs`, the consumer
  matrix. It packs the six packages, installs the tarballs with their peer dependencies in a
  project outside the workspace (strict minimum release age; `better-sqlite3` the only
  package allowed an install script), then:
  - runs `esm.mjs` (ESM consumer) and `require-esm.cjs` (CommonJS `require()` of the ES
    modules) **from the installed packages**, on the running Node and on every
    `--node <path>`. CI passes **Node 22.12.0 exactly** (downloaded, SHA-256 pinned in
    `ci.yml`): the carried-over item.
  - type-checks a consumer (`declaration: true`, `skipLibCheck: false`) under
    `moduleResolution` `nodenext`, **`node16`**, **`bundler`** (`module: preserve`), and a
    new CommonJS file, `types/require.cts`, under `nodenext` (imports compile to
    `require()`); plus `json-return.ts` in its own program, as before.
  - `--peers lower|upper` and `--drivers`: below.
- `pnpm smoke` runs it; CI's `build+publint+attw` job runs `pnpm smoke --node <22.12.0>`.

### 2. Peer dependency bounds

`consumer.mjs --peers lower` installs every peer at the floor of its declared range,
`--peers upper` at the range itself (pnpm resolves the newest release old enough for the
minimum release age). `--drivers` then runs `examples/smoke/drivers.mjs` in the installed
project: per adapter, against its real database, an insert through a changeset, a
unique-constraint violation reported as a changeset error, an ordered read, a rolled-back
transaction, a count and a stream (`pg-cursor` on Postgres); and `toZod`/`castWith`
against the installed Zod. The type checks run against the same peer versions. New CI job
`peer bounds (lower|upper)` (MySQL included, tier-2 compose profile).

Local result (Postgres 16 and MySQL 8.4 from compose, Node 22.23.1), both passing:

| Bound | pg | pg-cursor | @types/pg | better-sqlite3 | mysql2 | zod |
|---|---|---|---|---|---|---|
| lower | 8.23.0 | 2.22.0 | 8.23.0 | 12.4.1 | 3.11.0 | 4.3.0 |
| upper | 8.23.1 | 2.22.1 | 8.23.1 | 13.0.3 | 3.24.6 | 4.6.7 |

**A range was wrong, and is fixed:** `@egon-orm/sqlite` declared
`better-sqlite3: ^12.4.0 || ^13.0.0`, but `better-sqlite3` 12.4.0 was never published
(12.3.0 is followed by 12.4.1), so the advertised lower bound could not be installed or
tested. The range is now `^12.4.1 || ^13.0.0`, which admits exactly the same releases. The
other ranges are right at both ends.

### 3. Package name and scope

- No tracked file outside `docs/plan` mentions the former name (`git grep -i`, clean).
  `scripts/check-release-config.mjs` now enforces it in `pnpm lint`.
- npm: `egon-orm`, `@egon-orm/postgres` and `@egon-orm/cli` are unpublished (404).
  The scope exists: `registry.npmjs.org/-/org/egon-orm/package` answers `{}` (an existing
  scope with no packages), where an unclaimed scope answers `{"error":"Scope not found"}`.
  Whether the owner holds it cannot be seen from here: **owner to confirm** (list below).

### 4. Release workflow (Changesets)

- `.github/workflows/release.yml`, on push to `main`, with Changesets' split actions
  (`changesets/action/select-mode`, `/version`, `/publish`, v2.1.2, pinned by commit SHA):
  - `version`: while changesets are pending, opens or updates "Version packages"
    (`pnpm version-packages`: versions, per-package `CHANGELOG.md`, `VERSION` constants);
  - `publish`: when the manifest versions are not on npm, builds, runs `lint:packages` and
    `smoke`, then `pnpm release` (`changeset publish`) with `NPM_CONFIG_PROVENANCE=true`
    and `id-token: write`, pushes a tag per package and creates a GitHub release per tag;
    in a `npm` environment (for required reviewers);
  - **off until the owner sets the repository variable `RELEASE=on`**: every job is skipped,
    so it publishes nothing now and needs no secret. npm auth: trusted publishing (OIDC), or
    an `NPM_TOKEN` secret, used only when set (the first publish of a new package).
  - `actionlint` (Docker `rhysd/actionlint:latest`) reports nothing on `release.yml` and
    `ci.yml`.
- `.changeset/config.json`: the fixed group already held all six packages, `@egon-orm/cli`
  included (so migrations and the CLI ship in 0.1.0 with the rest). Changed:
  `privatePackages.version` `true` to `false` (the first trial bumped `examples/blog`,
  `examples/react-form` and `examples/edge-worker` to 0.0.1, since they were not in
  `ignore`), and `ignore` emptied (redundant now).
- `.changeset/step-02-core-contracts.md` (a step-02 note about error classes) replaced by
  `first-release.md`: a `minor` for all six packages (0.0.0 to 0.1.0) pointing at the
  human `CHANGELOG.md`.
- **Bug fixed in the release tooling:** `scripts/sync-version.mjs` failed on
  `@egon-orm/cli` (its `VERSION` is in `src/version.ts`, not `src/index.ts`), so
  `pnpm version-packages` exited 1. It now looks in both, and also updates the value the
  TSDoc example prints (`console.log(VERSION); // "0.0.0"`).
- `packages/cli/package.json` gets `publishConfig.access: public` like the others.
- New root scripts: `release` (`changeset publish`) and `release:dry-run`. New root dev
  dependency `verdaccio` 6.10.6 (6.10.7 is from today, too new for the release age; 6.10.6
  passed `minimumReleaseAgeStrict`). The lockfile also re-resolved `vitepress`'s optional
  peer `fuse.js` (now present through verdaccio); nothing else changed.
- `scripts/check-release-config.mjs` (+ `.test.mjs`, 10 tests, in `pnpm lint` /
  `test:unit`): the fixed group equals the set of non-private packages; `access` public;
  private packages never versioned; one version across packages; each published package has
  README.md and LICENSE, `publishConfig.access: public`, `engines.node >=22.12`,
  `type: module`, repository fields pointing at its directory; package README code blocks
  are copies of checked regions; no former name outside `docs/plan`.

### Release dry run (`pnpm release:dry-run`, `scripts/release-dry-run.mjs`)

From a clean clone of `HEAD` into a temporary directory: frozen-lockfile install, build,
`pnpm version-packages`, commit, `pnpm release` against verdaccio (provenance off), then it
checks the registry (version, `latest`, no `workspace:` range, peer `egon-orm` is
`^0.1.0`, the README is the readme), the git tags, writes the release notes, installs the
six packages from verdaccio with npm (`--ignore-scripts`), imports all nine entry points,
`require()`s them, runs `egon --version`; finally a patch changeset for `@egon-orm/zod`
alone must move all six to 0.1.1. New CI job `release dry run`. Output of the run on
`cea8fb2` (Node 22.23.1; spinner control codes and blank lines removed):

```text
== clone HEAD of /Users/caseytickes/Local/TypescriptORM/.claude/worktrees/agent-a174aa95bcd172c06/
ok: clean clone at cea8fb2b385ea9868b8cdc7b2e181dcc9929c279
ok: installed with the frozen lockfile and built
ok: 6 published packages in one fixed group; pending changesets: first-release.md

== version (the version pull request)
🦋 changeset v3.0.3

All files have been updated. Review them and commit at your leisure
packages/cli: VERSION = 0.1.0
packages/core: VERSION = 0.1.0
packages/mysql: VERSION = 0.1.0
packages/postgres: VERSION = 0.1.0
packages/sqlite: VERSION = 0.1.0
packages/zod: VERSION = 0.1.0
ok: every published package is at 0.1.0, with a CHANGELOG entry and VERSION; no private package changed; committed

== publish to verdaccio at http://127.0.0.1:4873/
warn --- you are using Node.js v22.23.1, Verdaccio recommends Node.js v24 or higher, please consider upgrading your Node.js distribution
warn --- http address - http://127.0.0.1:4873/ - verdaccio/6.10.6
🦋 changeset v3.0.3
Package @egon-orm/mysql was not found in the registry.
Package egon-orm was not found in the registry.
Package @egon-orm/postgres was not found in the registry.
Package @egon-orm/cli was not found in the registry.
Package @egon-orm/sqlite was not found in the registry.
Package @egon-orm/zod was not found in the registry.
These packages will be published as they were not found in the registry:
@egon-orm/cli@0.1.0
egon-orm@0.1.0
@egon-orm/mysql@0.1.0
@egon-orm/postgres@0.1.0
@egon-orm/sqlite@0.1.0
@egon-orm/zod@0.1.0
0 packages are already published.
◇  Successfully published:
@egon-orm/cli@0.1.0
@egon-orm/mysql@0.1.0
@egon-orm/postgres@0.1.0
@egon-orm/sqlite@0.1.0
@egon-orm/zod@0.1.0
egon-orm@0.1.0
◇  Created git tags.
ok: 6 packages at 0.1.0 in the registry, no workspace: ranges, READMEs shown, git tags @egon-orm/cli@0.1.0 @egon-orm/mysql@0.1.0 @egon-orm/postgres@0.1.0 @egon-orm/sqlite@0.1.0 @egon-orm/zod@0.1.0 egon-orm@0.1.0

== GitHub release notes (one release per tag, from its CHANGELOG section)
egon-orm@0.1.0:
  ### Minor Changes

  - 46b4e58: The first release of Egon ORM: schemas, changesets, composable queries and a repo, typed
    end to end, with adapters for Postgres, SQLite and MySQL, Zod support, and migrations with
    the `egon` command. ES modules only; Node.js 22.12 or later. What is in it:
    https://github.com/egon-orm/egon-orm/blob/main/CHANGELOG.md
ok: 6 release notes written

== install from the registry (npm), import, require, run egon
esm: 9 entry points, VERSION 0.1.0
cjs: require() of 9 entry points on Node v22.23.1
ok: npm installed 9 entry points from the registry; egon --version is 0.1.0

== the next release: a patch changeset for one package versions every package
ok: a patch to @egon-orm/zod alone moves all 6 packages to 0.1.1 (not published)

release dry run: passed (cea8fb2, 0.1.0)
```

The first CI run of the job failed: `changeset version` needs the commit that added each
changeset (for the changelog line) and fails with a bare `Error` in a shallow checkout.
The job now checks out with `fetch-depth: 0` (as `release.yml`'s jobs already did), and
the script refuses a shallow repository with a clear message. The second CI run then
found a real release bug: `changeset publish` makes annotated tags, which need a committer
identity; on a runner without one git refuses, and changesets still prints "Created git
tags" (it ignores the exit code). The dry run's tag check caught it. `release.yml`'s
publish job now sets the `github-actions[bot]` identity before publishing, and the dry run
sets one in its clone.

A separate trial (scratch clone, not committed) confirmed that a later `minor` changeset
for `egon-orm` alone gives 0.2.0 for all six, with no major cascade through the
`workspace:^` peer ranges (Changesets 3.0.3).

### 5. Versioning and support policy

`docs/site/reference/upgrading.md` ("Versioning", "What counts as breaking", "Deprecations",
"Supported versions"):

- semver, one version for all packages; before 1.0 a breaking change is a minor, everything
  else a patch (so `^0.1.0` gets features and fixes, never 0.2);
- breaking at run time and in the types listed separately (removing/renaming exported
  types or members, narrowing parameters, widening returns, new members of unions users
  switch on or of interfaces they implement, a different inferred row/select/preload type),
  and what is not breaking (new optional things, more precise types that reject no correct
  program, message wording, SQL formatting);
- supported: Node.js >= 22.12 (D14); **TypeScript >= 5.5** (D14; see the Request to 21-api
  and the measurement below); ESM and CommonJS `require()`; `nodenext`, `node16`, `bundler`;
  Postgres >= 14, SQLite >= 3.39, MySQL >= 8.0.31 (as the adapters guide already states); the
  peer ranges with what CI tests at each end.

TypeScript measurement (the consumer project, `skipLibCheck: false`, pinned peers):
5.7.3, 5.8.3, 5.9.3, 6.0.3 and 7.0.2 compile cleanly. 5.5.4 and 5.6.3 fail **only** in
`pg-protocol`'s own `.d.ts` (`TS2315: Type 'Buffer' is not generic`, with `@types/node`
22.20.5); with `skipLibCheck: true` 5.5.4 compiles the consumer with no error, so Egon's
own declarations work on 5.5.

### 6. upgrading.md and CHANGELOG.md

- `docs/site/reference/upgrading.md`: the policies above and a "0.1.0" section with step
  21a's note: error constructors take the identifier first (`(id, message, details?)` for
  `DatabaseError`, `QueryError`, `CastError`, `SchemaDefinitionError`, `MigrationError`;
  `ConstraintError`/`RollbackError` take optional `id`/`message`/`params`), with a checked
  example (`docs/site/examples/upgrading.ts`) and the advice to use one of our identifiers;
  short messages by default and `useFullErrorMessages(messages)`.
- `CHANGELOG.md` (root, new): 0.1.0 "(unreleased)" written for people, by area, with the
  requirements, the upgrade pointer and what is not in the release (no published
  benchmark). `docs/site/reference/changelog.md` now includes it
  (`<!--@include: ../../../CHANGELOG.md-->`), so there is one text; links in it are absolute
  so they work on GitHub and npm too.
- `cspell.json` also checks `CHANGELOG.md` and `packages/*/README.md`.

### 7. Package READMEs (carried over)

`packages/{core,postgres,sqlite,mysql,zod,cli}/README.md`: what it is, install (with the
peer ranges), a minimal example, links to https://egon-orm.github.io/egon-orm/. The examples
are copies of regions of checked files (`docs/site/examples/readme/*.ts`, type-checked with
the site; the CLI's is `egon.config.ts#config`), marked `<!-- example: path#region -->`;
`check-release-config.mjs` fails when a copy drifts (tested by mutation: a changed comment
in the Zod README fails it). The dry run confirms npm shows each README.

### 8. Carried over: TypeScript 7 and branch protection

Both are under "Needs the owner's decision" / "Owner actions" below.

## Decisions

- The policy lives in `reference/upgrading.md` rather than a new page: a new page needs a
  sidebar entry in `.vitepress/config.ts`, which is not this part's.
- Pre-1.0 features are `patch`, breaking changes `minor` (written in the policy,
  `.changeset/README.md` and CONTRIBUTING).
- The release workflow is gated by a repository variable rather than being
  `workflow_dispatch`-only, so that once on it runs on every push like the plan describes,
  and until then it is visibly skipped.
- The dry-run consumer installs with npm (what most users run) and `--ignore-scripts`: a
  pnpm consumer would refuse the packages verdaccio just received, under pnpm's minimum
  release age, unless the policy were relaxed for them, which I did not want to do.
- `consumer.mjs --node` must be the same major as the Node running it (`better-sqlite3`'s
  native module is installed for that Node); a Node 24 binary fails with
  `NODE_MODULE_VERSION`, which is expected, not a package problem.

## Changes outside the owned paths (all small, all release plumbing)

- `.github/workflows/ci.yml`: Node 22.12.0 download in `build+publint+attw` and
  `pnpm smoke --node …`; new jobs `peer bounds (lower|upper)` and `release dry run`, both
  in the `ci` gate's `needs`.
- `examples/smoke/*` (the consumer matrix, per the task), `scripts/sync-version.mjs` (bug
  fix), new `scripts/check-release-config.mjs`, root `package.json` (`lint`, `release`,
  `release:dry-run`, `verdaccio`), `pnpm-lock.yaml`, `cspell.json`, `CONTRIBUTING.md`
  (smoke row, `release:dry-run` row, CI job list, "Releases"),
  `packages/{cli,sqlite}/package.json`, a comment in `packages/core/tsup.config.ts` (the
  renamed script), new `docs/site/examples/readme/*.ts` and `docs/site/examples/upgrading.ts`.

## Checks run

- `pnpm check`: passes (lint incl. the new check; typecheck; 6,134 unit tests, 607 type
  tests; node --test scripts; build).
- `pnpm lint:packages`: clean (above).
- `pnpm smoke --node ~/.nvm/versions/node/v22.12.0/bin/node`: every check passed (runtime
  on 22.23.1 and 22.12.0; types nodenext, node16, bundler, commonjs, json-return).
- `consumer.mjs --peers lower|upper --drivers` with `EGON_TEST_TIER2=1`: both pass.
- `pnpm docs:build`: passes; the changelog include renders, anchors exist (`#_0-1-0`).
- `pnpm release:dry-run`: passes (output above).
- `pnpm test:integration` was not run: nothing this part changes is in an integration
  project (the new example files are not `// @run`).

## Not verified

- **Provenance and trusted publishing were not exercised**: they need a real GitHub Actions
  OIDC token and npm. Whether `pnpm publish` (which `changeset publish` calls, with
  `--no-git-checks`) honours `NPM_CONFIG_PROVENANCE` and npm's OIDC exchange under pnpm 12
  is taken from the tools' documentation, not tested. If it does not, the fallback is the
  `NPM_TOKEN` path plus `--provenance`.
- The `version` and `publish` jobs themselves have not run on GitHub (they are off); the
  dry run runs the same two scripts. The new CI jobs run on this PR.
- Postgres 14/15/17, MySQL 8.0 and SQLite older than the bundled one are not tested; the
  minimums come from the adapters guide.
- Bun and Deno consumers: not tried (step 21 §3 robustness has the runtime matrix).

## Needs the owner's decision

1. **TypeScript 7.** Recommendation: **do not move the build for 0.1.0; support TS 7 for
   users.** Evidence: a consumer compiles against the packed packages on 7.0.2 with
   `skipLibCheck: false` (above), so users on 7 are fine today. Moving the repository is
   blocked by tools that call the TypeScript JS API, which 7.0 does not have: tsup's
   declaration bundler (rollup-plugin-dts), TypeDoc (the API reference), and the API report
   tool step 21-api is adding (`@microsoft/api-extractor`). Path when they are ready: emit
   declarations unbundled with `tsgo --emitDeclarationOnly` (the JS is already one file per
   module) or switch to a bundler whose dts step supports tsgo (tsdown), keep TypeDoc and
   API Extractor on a TS 6 side install until they support 7. Ask 21-api to add 7.x to its
   TypeScript CI matrix (min, latest, `next`).
2. **Support window wording.** `upgrading.md` says a Node.js, database or driver version
   stays supported "until its own end of life at least". Confirm, or set a different
   promise (Postgres 14 reaches end of life in November 2026).
3. **TypeScript minimum**: D14's 5.5 is used; 21-api's matrix should confirm it (Request).
   If the owner prefers a minimum that also passes `skipLibCheck: false` with today's
   `@types/node`, that is 5.7.

## Owner actions (cannot be done from a PR)

- **npm scope**: confirm the `@egon-orm` scope (it exists on npm, with no packages) is yours,
  or claim it, and the unscoped `egon-orm` name.
- **Turn releases on**: set repository variable `RELEASE=on`; create the `npm` environment
  (required reviewers recommended); enable "Allow GitHub Actions to create and approve pull
  requests" (Settings > Actions > General), needed by the version job.
- **npm auth**: for the first publish, an `NPM_TOKEN` secret (an automation or granular
  token with publish rights on the scope) in the `npm` environment; after it, configure
  each of the six packages' trusted publisher (repository `egon-orm/egon-orm`, workflow
  `release.yml`, environment `npm`) and delete the token.
- **CI on the version PR**: pull requests opened with the default `GITHUB_TOKEN` do not
  start other workflows, so the "Version packages" PR gets no `ci` run. Either pass a
  GitHub App or fine-grained token to the version step (`github-token`), or close and
  reopen that PR to start CI.
- **Branch protection on `main`** (carried over): one approval, the `ci` check (it now also
  needs `peer bounds` and `release dry run`), squash merges only, as in CONTRIBUTING.
- At release: change "0.1.0 (unreleased)" in `CHANGELOG.md` to the date in the version PR.

## Requests

- **21-api**: report the TypeScript minimum your CI matrix confirms; `upgrading.md` and
  `CHANGELOG.md` say 5.5 (D14) until then. Please include 7.x. Note the 5.5/5.6 result
  above: `pg-protocol`'s `.d.ts` fails under `skipLibCheck: false` with current
  `@types/node`, so a minimum-version job should use `skipLibCheck: true` or an older
  `@types/node` for that check.
- **21-audit / owner, at release**: the site and README still say "under construction,
  nothing is published" (`README.md` badge and status box, `guide/index.md`,
  `reference/roadmap.md` "Before the first release", `reference/cli.md` install note is
  fine). They are not this part's files.
- **21-robustness**: the runtime matrix can reuse `examples/smoke/consumer.mjs` (`--node`
  for other Node binaries of the same major; for Node 24 run the script itself on 24).
