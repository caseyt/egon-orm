# Step 21 (decisions): the owner decisions of 2026-10-22, status

Branch `step/21-decisions`, 2026-10-22, from `main` at `9cf9e3b` (#69). Inputs: the owner's
decisions of 2026-10-22, `status/21-api.md` §1 (API items 1 to 9) and `status/21-security.md`
(F5). These are approved public API changes; they are built here.

## Summary

| Item | State |
|---|---|
| 1. `normalizePgError`, `normalizeMysqlError`, `normalizeSqliteError` not exported | Done |
| 2. `createAdapter` documented as internal | Done |
| 3. The adapter contract's internal types stay unexported | Done (unchanged, checked) |
| 4. `stripInternal` for the published declarations | Done, in all six packages |
| 5. `egon-orm/migration`'s `ConstraintOptions` renamed (approved as `AddConstraintOptions`, then `CreateConstraintOptions`) | Done, no alias |
| 6. `applyActionOrThrow` | Done |
| 7. `repo.firstOrThrow` | Done |
| 8. `SqlOptions` stays unexported | Done (unchanged, checked) |
| 9. Forgotten-export helper types stay in the API reports | Done (unchanged, checked) |
| F5: schemaless changesets never generate code | Done, with a test |
| Support policy: no longer provisional | Done (`reference/upgrading.md`, `SECURITY.md`) |
| FAQ: slow editor completions in large models | Done |
| Upgrade notes for 0.1.0 | Done (`CHANGELOG.md`, `reference/upgrading.md`) |
| API reports | Regenerated; every change reviewed (below) |

## What was built

### API items 1 to 9

1. **The `normalize…Error` functions** are no longer re-exported from `@egon-orm/postgres`,
   `@egon-orm/sqlite` and `@egon-orm/mysql`. The adapters still pass them to `createAdapter`.
   The packages' export tests (`postgres/src/index.test.ts`) list what is left.
   `internals/extending.md` no longer says they are exported.
2. **`createAdapter`** and **`AdapterDefinition`**: their TSDoc says they are internal to the
   Egon packages, exported only for the dialect packages, not a supported way to write a
   third-party dialect, and subject to change in any release. The comment in `index.ts` and
   `internals/extending.md` say the same. They are *not* tagged `@internal`: the dialect packages
   import them from `egon-orm`, and TypeDoc (`excludeInternal`) would drop their pages.
3. **Adapter contract types** (`CompiledQuery`, `OutputPlan`, `ExplainOptions`,
   `InsertPlanOptions`, `QueryAst`): still unexported. Nothing to change.
4. **`stripInternal: true`** in the `dts.compilerOptions` of every package's `tsup.config.ts`.
   tsup's declaration build works with it (TypeScript 6). What it strips:
   - `ColumnAdder.context` and `added` and `MigrationBuilder.operations` (already tagged);
   - `PreparedQuery.plan`, `named` and `query` (newly tagged, as `status/21-api.md` listed).
   - **Not stripped: constructors** (review round 1). The bundled declarations export every
     class as a value (`export { … as Query }`), whatever `export type` said in the sources,
     so a stripped constructor left a default one that takes no arguments: `new Query()` and
     `new MigrationBuilder()` compiled in a consumer and failed at run time. In round 0 I
     wrote that the type-only exports made this safe; that was wrong. The migration builders'
     constructors, tagged `@internal` before this PR, now have prose TSDoc ("Internal: …")
     instead, like the query classes' constructors. The smoke consumer's type check
     (`examples/smoke/types/consumer.ts`, `internalConstructors`) has `@ts-expect-error` on
     `new Query()` and `new MigrationBuilder()`. Checked: with the `Query` constructor tagged
     again, the three `consumer.ts` programs fail with TS2578 (unused directive).
   - **Not stripped:** `PreparedQuery.ast` and `Query.ast`. `QueryLike` requires `ast`, so
     without it a `PreparedQuery` would no longer be a queryable in a consumer's types. Its
     TSDoc now says so.
   - Verified on the built `dist/`: no `@internal` left in any published `.d.ts`; the
     members above are gone, and the types only they used (`PlanSource`, the migration
     `Operation` types) drop out of the reports. `pnpm lint:packages` (publint, attw): no new finding (only the
     CommonJS modes the esm-only profile ignores, as before). `pnpm smoke`: the packed
     packages pass every consumer program with `skipLibCheck: false`, on TypeScript 6.0.3 and
     on 5.8.3, the minimum (`consumer.mjs --no-runtime --typescript 5.8.3`).
   - Enforcement: a stripped member that comes back changes the API report, so `pnpm
     api:check` fails.
5. **`CreateConstraintOptions`**: `ConstraintOptions` of `egon-orm/migration` renamed, no
   deprecated alias. `ConstraintOptions` of `egon-orm` (a changeset's constraint options) is
   unchanged. See "Needs the owner's decision".
6. **`applyActionOrThrow(changeset, action)`** in `egon-orm`: returns the applied data
   (`AppliedData<S>`); an invalid changeset throws `InvalidChangesetError` with the changeset,
   its `action` set, and `error.action`. The other throws are those of `applyAction`
   (`QueryError` for an unknown action or a new record; a new record is also a compile error,
   as for `applyAction`). It reuses the existing identifier `invalidChangeset`, like every
   `OrThrow` write: no new catalog entry, and `reference/errors/general.md` is unchanged
   (`pnpm docs:errors --check` passes). Its message lists errors without values, which the
   unit test checks with a recognisable input.
7. **`repo.firstOrThrow(queryable, params?, options?)`**: the query of `first` (`LIMIT 1`,
   the query's own smaller limit and offset kept), returning `R`; no row throws
   `NoResultsError` (identifier `noResults`, existing) with the rendered query, without
   values, as `oneOrThrow` does. It counts the rows rather than testing the row, so a
   selected `null` is returned, not refused (unit test). It reports the operation `"first"`,
   as every twin reports the method it is the twin of (`RepoOperation`'s TSDoc). Hot path:
   `first` and `firstOrThrow` share one helper (`firstRows`) that makes the same derived,
   cached query; no closure, no extra allocation.
8. **`SqlOptions`**: still unexported.
9. **Forgotten exports**: `includeForgottenExports` unchanged.

### F5

`specOfTypes` (`changeset/spec.ts`) marks the field table of every changeset without a schema
class with `refuseGeneration`, so `validate()` uses the loop builders and never calls `new
Function`. `generated.ts`'s TSDoc is updated. The test in `test/security/codegen.test.ts`
counts calls of the `Function` constructor (construct and apply, through a stubbed global) and
expects **zero** for a schemaless changeset's `validate()`, checking the values the validator
saw. It fails without the fix (checked by removing the `refuseGeneration` call). A second test
checks that the same validate() of a schema class does generate, so the count means
something. `SECURITY.md`'s code-generation row says so (owner decision, 2026-10-22).

The F5 line of `status/21-security.md`, as it now reads (I did not edit that note; this is
its replacement for the readiness report):

> | F5 | Low | A changeset without a schema class has no `codegen` opt-out: its `validate()` tried `new Function` | **Fixed** (owner decision, 2026-10-22, in step/21-decisions): it never generates code |

### The docs

- **Support policy** (`reference/upgrading.md` "Security fixes" and "Supported versions",
  `SECURITY.md` "Supported versions"): no backports before 1.0; from 1.0, the previous major
  gets security fixes for six months after the next major; a database version is supported
  until at least its own end of life. Each is marked an owner decision of 2026-10-22, and the
  word "provisional" is gone from both files.
- **FAQ** (`guide/faq.md`, "Why are editor completions slow in a large model?"): the measured
  cost from the roadmap row (about 40 ms plus 1.1 to 1.2 ms per reachable schema, past 200 ms
  at about 140 to 170 connected schemas; about 114 ms at 200 with declared return types), and
  the workaround, `Changeset<typeof User, boolean, "passwordConfirmation">`, with why `boolean`
  and not `true`. The example is the `completions` region of the new checked file
  `docs/site/examples/faq-completions.ts` (it has its own `User` with a `password` field, so
  `faq.ts`'s scaffolding is unchanged), which also checks that `errorMessages()` keeps
  `passwordConfirmation`.
- **New functions:** rows in `guide/repo.md` (`firstOrThrow`) and `guide/changesets.md`
  (`applyActionOrThrow`), lines in the checked examples `repo.ts` (`reading`),
  `changesets.ts` (`apply`) and the runnable `coming-from.ts` (`find-first`, which runs
  `firstOrThrow` against Postgres in `docs:integration`), `findFirstOrThrow` named on the
  Prisma page, and `reference/errors.md`'s rows for `InvalidChangesetError` and
  `NoResultsError`. `reference/exports.md` is regenerated.
- **Upgrade notes:** the removed `normalize…Error` functions were listed in the exports
  reference, so `CHANGELOG.md`'s 0.1.0 entry names the removals and the rename, and
  `reference/upgrading.md`'s 0.1.0 section has a new "Removed and renamed exports" table (the
  changelog links to it). The changelog's repo and changeset paragraphs mention the new twins.
  No new changeset file: `.changeset/first-release.md` already versions every package for
  0.1.0.

### API report diff, reviewed

Every change is intended:

- `egon-orm`: `+ applyActionOrThrow`, `+ Repo.firstOrThrow`; the stripped `PreparedQuery`
  members, and `PlanSource`, which only `plan()` used.
- `egon-orm/testing`: the same, through the types it repeats.
- `egon-orm/migration`: `ConstraintOptions` → `CreateConstraintOptions` (and in
  `createConstraint`); the stripped builder members, and the internal types only they used
  (`Operation` and its parts). The constructors stay.
- The three dialect reports: the `normalize…Error` function removed.
- One change that is not an API change: `functions.ts`'s private `NullOf` helper had no
  TSDoc, and API Extractor had been attributing to it the `@module` comment that preceded it in
  the bundled chunk. The new function moved it, and the report showed `(undocumented)`. It now
  has its own one-line TSDoc, and the report is as before for it.

## Decisions

- `createAdapter` and `AdapterDefinition` are documented as internal in prose, not with the
  `@internal` tag, which would strip them from the declarations the dialect packages build
  against and drop them from TypeDoc.
- No constructor is stripped (review round 1, above): it would make `new` compile.
- `PreparedQuery.ast` stays (required by `QueryLike`).
- `firstOrThrow`'s `NoResultsError.query` renders the query the caller gave, as `oneOrThrow`'s
  does, not the derived `LIMIT 1` query.

## Needs the owner's decision

- None open. **Answered (owner, 2026-10-23):** `AddConstraintOptions` is renamed
  `CreateConstraintOptions`, with no alias. The first approval rested on `status/21-api.md`
  calling the method `addConstraint`; the method is `m.createConstraint(table, name,
  options)`, and its neighbours are `CreateTableOptions` and `DropConstraintOptions`.

## Requests

- **21-audit:** use the F5 line above in the readiness report (F5 fixed). The support policy
  is no longer provisional.
- **21-security** (finished): the F5 row of `status/21-security.md` is superseded by the line
  above; I did not edit another part's status note.

## Files outside this part's own paths

The owner asked for these changes in this PR: `SECURITY.md`, `CHANGELOG.md` and
`reference/upgrading.md` (21-security and 21-packaging, both finished), `guide/faq.md`, the
guide and reference pages above, and the packages' sources, tests and `tsup.config.ts`.

## Verification (local)

- `pnpm lint`: passed (Biome, the policy checks, `docs:check` with `docs:exports --check`,
  `docs:errors --check`, page order and cspell).
- `pnpm typecheck`: passed.
- Unit tests with coverage, `--maxWorkers=2`: 142 files, 6,198 tests passed; coverage
  98.94% statements, 97.74% branches; thresholds met. The benchmark harness tests and
  `node --test scripts/*.test.mjs` (77) passed.
- Type tests: 35 files, 608 passed.
- `pnpm build`, `pnpm api:report` (then `pnpm api:check`: up to date), `pnpm lint:packages`,
  `pnpm smoke` (TypeScript 6.0.3), `consumer.mjs --no-runtime --typescript 5.8.3`,
  `pnpm docs:build`: passed.
- `EGON_TEST_TIER2=1`, integration, `--maxWorkers=2`: 49 files; 1,798 passed, 1 failed, 2
  expected failures (already in the repo), 55 skipped. The failure was a `// =>` check I had
  written wrong in `coming-from.ts` (the oldest post is "Hello", not "Draft"); after the fix,
  `docs:integration`'s `examples.itest.ts` passed (16 tests). The new conformance test
  `firstOrThrow` passed on Postgres, SQLite and MySQL.

## Not verified

- CI ran on PR #72: every job of the `ci` check passed on `cdd7d26` and on `7e49be1`; the
  informational `types (typescript next)` job fails with the known TS5088 and TS5115 errors
  (`status/21-api.md`). For the head after the rename, see the PR.
- No benchmarks (deferred to step 19).

## Review round 1 (PR #72)

1. **Stripped constructors made `new Query()` compile.** Fixed: no constructor is tagged
   `@internal` (the eight I tagged are untagged; the four migration builder constructors get
   prose TSDoc). `consumer.ts` checks `new Query()` and `new MigrationBuilder()` with
   `@ts-expect-error`, verified to fail when a constructor is stripped. API reports
   regenerated: the constructors and the types they name (`Scope`, `TOKEN`, `PreparedFrom`,
   `TableContext`, …) are back as on `main`.
2. **`first` / `firstOrThrow` TSDoc** said a limit of the query's own is replaced. It is not:
   `firstAst` (`repo/read.ts`) reads at most one row, `LIMIT 1` or the query's own limit
   when smaller (`limit(0)` reads none), and keeps the offset. Both comments now say so.
3. **FAQ:** the cause of slow completions is "likely", as on the roadmap.
4. **CHANGELOG.md:** the 0.1.0 paragraph lists the type members left out of the
   declarations; `upgrading.md`'s table no longer lists constructors.

## The rename to `CreateConstraintOptions` (owner, 2026-10-23)

A commit of its own, after round 1: `AddConstraintOptions` → `CreateConstraintOptions` in
`migration/builder.ts` (the interface, its TSDoc example, `createConstraint`'s parameter),
`migration/index.ts`, `CHANGELOG.md`, `reference/upgrading.md`, the regenerated
`reference/exports.md` and `api-report/egon-orm-migration.api.md`. No alias; no type test
named it. `status/21-api.md` (another part's note) still says `AddConstraintOptions`, as a
record of the first approval. Checked: lint, typecheck, type tests, build, `api:check`,
smoke. No migration runtime code changed, so integration was not re-run.

## Review round 2 (PR #72)

Approved at `7e49be1`, with three minor points, fixed in the rename commit:

1. `guide/repo.md`: the `first` row said "Adds `LIMIT 1`"; it now says it reads at most one
   row, `LIMIT 1` or the query's own smaller limit, with the offset kept. The `firstOrThrow`
   row ("Like `first`; throws `NoResultsError` if no row matches") reads correctly after it.
2. `repo/read.ts`: the internal TSDoc of `first` and `firstOrThrow` says the same.
3. "Not verified" no longer says CI has not run.

