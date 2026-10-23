# Step 21, part 21-api (§1 whole-system audit), status

Branch `step/21-api-audit`, 2026-10-22, from `main` at `97def5c` (#61). Spec: §1 of
`docs/plan/21-release.md`. Measurements were taken on the owner's laptop (macOS, Apple
silicon), Node 22.23.1, TypeScript 6.0.3, against the shared Compose Postgres 16 and MySQL 8.4.

## Summary

| Item | State |
|---|---|
| API review | Done. Four types exported (a user had to name them and could not); TSDoc fixed. Nine renames, removals or additions are listed for the owner below, none made. |
| API report | `api-report/*.api.md` for all nine entry points, written by API Extractor 7.59.4; `pnpm api:check` in CI's build job fails on any difference. |
| Type health | Measured and recorded below. **Two budgets are not met in every case**: the first query a program checks takes 59 to 62 ms (one-time cost; every other statement is at most 26 ms), and completions in a `where` callback take 246 ms (median) on a 200-schema project whose associations form one long chain, and 47 ms when they form clusters. |
| TypeScript matrix | CI checks the packed packages with TypeScript 5.5.4 (the minimum, decision D14) and the latest release (7.0.2 today). `next` runs as information only, and **fails today** (see below). |
| Error review | Done. Every error class was triggered (12 tests). Twelve messages or advice entries were reworded, with no identifier changed. Four type errors were added to the FAQ, so it now covers the 12 likeliest. |
| Seam tests | 5 tests in `packages/postgres/test/seams.itest.ts`, all passing. The full million-row stream runs by default, in about 3 s. |

## 1. API review

I read every entry point, as a user would. I read the source `index.ts` files and the
generated API reports, which show the whole surface with every signature expanded.

### Fixed here

- `DecimalOptions`, `TimestampOptions`, `TimestampPrecision` and `EnumMapping` are now exported
  from `egon-orm` (type-only). `t.decimal(options)`, `t.timestamp(options)`,
  `t.localTimestamp(options)` and `t.enum(mapping)` take them, and a user who wants to pass
  options around (`const money: DecimalOptions = …`) could not name them. Their TSDoc linked to
  internal functions (`{@link decimalType}`), which TypeDoc would have rejected once they
  were exported; the TSDoc now refers to `t.decimal()` and has real examples.
  `docs/site/reference/exports.md` is regenerated.
- `VERSION` in `egon-orm`: the TSDoc still said "Placeholder export from step 01 … the
  public API arrives in later steps". Removed.

### Checked and consistent

- **`OrThrow` twins.** Every `Result`-returning write has one: `insert`, `update`, `delete` and
  `insertOrUpdate`, plus `transaction`. Each nullable read has one too: `get`, `getBy`, `one` and
  `reload`. The exceptions are listed below.
- **Option names.** Durations end in `Ms` everywhere (`timeoutMs`, `lockTimeoutMs`,
  `statementTimeoutMs`, `idleTimeoutMs`, `connectionTimeoutMs`). Each of `schema`,
  `batchSize` and `planCacheSize` means one thing everywhere. Every adapter takes
  `connectionString`.
- **Parameter order.** Schema first: `repo.preload(User, rows, "posts", fn?, options?)`,
  `assoc(User, rows, "posts")`, `buildAssoc(User, user, "posts", …)`. Named parameters come
  before options: `repo.all(q, params?, options?)`. The plan's §11 writes
  `repo.preload(rows, "posts", …)`. The guide, which takes precedence, writes the schema
  first, and so does the code.

### Needs the owner's decision (not changed)

1. **`normalizePgError`, `normalizeMysqlError`, `normalizeSqliteError`** are exported from
   the dialect packages. No page documents them, and the adapters use them internally. The names
   are also inconsistent (`Pg` and `Postgres`). *Recommendation:* remove them from the public
   exports for 0.1.0. If a use is wanted, keep them and rename the first to `normalizePostgresError`.
2. **`createAdapter` takes a driver that cannot be typed.** Its definition's `driver` is a
   `DriverWrapper` (with `DriverConnection`, `DriverCursor` and `DriverHooks`), which is
   deliberately not exported (comment in `index.ts`). So a third-party dialect cannot name
   what it implements. *Recommendation:* decide whether third-party dialects are supported in
   0.1.0. If they are, export the driver contract types. If not, document `createAdapter` as
   internal to the Egon packages.
3. **The `Adapter` contract mentions types that are not exported**: `CompiledQuery`,
   `OutputPlan`, `ExplainOptions`, `InsertPlanOptions` and `QueryAst`. TypeDoc links them to
   the source on GitHub (`typedoc.json`). Only someone who implements `Adapter` by hand needs
   them. *Recommendation:* leave them unexported. Either answer to item 2 covers them.
4. **Members marked `@internal` are visible in the published declarations**: the
   constructors of `Expr`, `PreparedQuery`, `Query` and the migration builders (they take AST
   nodes and `TableContext`), `PreparedQuery.plan`, `ast`, `named` and `query`,
   `MigrationBuilder.operations`, and `ColumnAdder.context` and `added`. The build does not strip them.
   *Recommendation:* turn on `stripInternal` for the declaration build, or move these members
   behind symbols. Either way it changes the published declarations, so it is the owner's
   decision. The API report would show the effect.
5. **Two different `ConstraintOptions`**: one in `egon-orm` (the options of a changeset's
   constraint) and one in `egon-orm/migration` (the options of a migration's `addConstraint`).
   An application that imports both has to alias one. *Recommendation:* rename the migration
   one to `AddConstraintOptions`.
6. **`applyAction` has no `applyActionOrThrow`.** It returns a `Result`, like the writes
   (decision D10). *Recommendation:* add `applyActionOrThrow`.
7. **`repo.first` has no `firstOrThrow`**, while `one`, `get` and `getBy` have their twins.
   *Recommendation:* add it. It is cheap, and people coming from Prisma look for `findFirstOrThrow`.
8. **`SqlOptions`**, the options of `repo.toSql`, is not exported. It is
   `Pick<ReadOptions, "schema">`. *Recommendation:* leave it. `ReadOptions` names it well enough.
9. **API report scope.** With `includeForgottenExports` on, the reports also spell out the
   about 300 helper types that no entry point exports, but that public signatures use (so a change to
   one counts as an API change). The `egon-orm/testing`, `/migration` and `/messages` reports
   repeat the core types they reach. *Recommendation:* keep it as it is. The alternative is
   smaller reports that miss changes to helper types.

## 2. API report

- `scripts/api-report.mjs` calls API Extractor for each entry point, on the built
  declarations (`dist/*.d.ts`, the tsup layout with its shared hashed chunks). It writes
  `api-report/<entry>.api.md`. Commands: `pnpm api:report` (builds first, then rewrites) and
  `pnpm api:check` (compares). CI runs `pnpm api:check` in the `build+publint+attw` job,
  after `pnpm build`. A difference fails the job and leaves the fresh report in
  `temp/api-report/` for `diff`. `CONTRIBUTING.md` explains the workflow.
- The check does not fail on its own. I replaced a line in the committed postgres report
  (`host` to `hostX`) and `pnpm api:check` failed (`api-report/egon-orm-postgres.api.md differs`).
  It passed again once I restored the line.
- **Works with TypeScript 6 and tsup's `.d.ts`.** API Extractor analyses with its bundled
  TypeScript 5.9.3, which reads the declarations without errors. No workaround was needed,
  and no check is weakened. I made one normalisation: findings that API Extractor cannot
  place next to a declaration are listed at the end with a location such as
  `dist/batch-CjAnxdq6.d.ts:1803:9`. The chunk's content hash and the line number would
  change with every comment edit, so the script drops the location and keeps the finding.
  A unit test covers this (`scripts/api-report.test.mjs`).
- How each kind of message is handled:
  - Compiler errors and API Extractor errors fail the check.
  - `ae-forgotten-export` (a type used by the public API that no entry point exports) is
    written into the report, so a new one is a reviewed change.
  - `ae-missing-release-tag` and `ae-undocumented` are off. Release tags are not used, and
    TypeDoc already enforces a summary and an `@example` on every export.
  - `ae-unresolved-link` and the TSDoc syntax checks are off. TypeDoc validates links
    (`validation.invalidLink`), and API Extractor's TSDoc dialect rejects `@module`, which
    TypeDoc needs.
- **New devDependency** `@microsoft/api-extractor` `7.59.4`, the latest. It was published on
  2026-10-06 and installs under `minimumReleaseAgeStrict: true`. `pnpm-workspace.yaml` is
  unchanged.

## 3. Type health (one-off measurements, not CI gates)

`scripts/type-health/generate.mjs` writes the synthetic project into `temp/`, which is
ignored. `scripts/type-health/measure.mjs` measures it. Both projects resolve `egon-orm` to
the **built declarations**, as an installed package would, not to the sources. Per-statement
times come from `tsc --generateTrace` and are the median of 5 traced runs, so that one GC
pause does not count. The column "max" is the slowest single run.

**examples/blog** (its application code: `src/` and `egon.config.ts`; the tests import the
workspace's private test helpers):

| Files | Types | Instantiations | Check time | Slowest statements (median / max) |
|---|---|---|---|---|
| 282 (8 own) | 14,730 | 48,563 | 0.20 s | `accounts.ts:16` 32.3 / 34.7 ms (a changeset with a Zod `validate`), `comments.ts:11` 21.9 ms, `posts.ts:50` 20.5 ms |

**Synthetic 200-schema project.** 200 schema classes, ten to a file, each with eleven
fields, a `belongsTo` to the schema before it, a `hasMany` to the one after, and a changeset
function. Each schema also has a joined, filtered, selected query, a query with a named
parameter, a preload and an insert (8,340 lines). `--topology chain` (the default) links
every schema to its neighbours, so all 200 are connected. `--topology clusters` links only
the ten schemas of each file.

| Topology | Types | Instantiations | Check time | Slowest statement | Next slowest | Completions in `where`, after an edit (median / max of 20) | Without an edit | First request (loads the project) |
|---|---|---|---|---|---|---|---|---|
| chain | 61,843 | 413,957 | 4.23 s | 62.0 ms (max 68.2) | 26.4 ms | **246 / 452 ms** | 0 ms | 480 ms |
| clusters | 59,753 | 401,968 | 1.08 s | 58.7 ms (max 66.3) | 22.1 ms | 47 / 97 ms | 0 ms | 156 ms |

What this shows:

- **50 ms per query expression: met, except for the first statement a program checks.** The
  slowest statement is always the first query checked (`queries-00.ts:4`), whichever query
  that is. When the `where`-callback file was checked first, the same 55 to 60 ms moved to it,
  and its own time dropped out of the top ten once it was checked last. That is the
  one-time cost of resolving the library's types; every other statement is at most 26 ms.
  By the letter of the budget, one statement per program is over.
- **Completions under 200 ms: met for clusters, not for a chain.** With no edit, a request
  takes 0 to 1 ms. After an edit, tsserver rebuilds its checker, and that rebuild costs as much
  as resolving every schema reachable through associations from the one being edited. The
  program update itself takes 2 ms (tsserver log, `--tsserver-log`). A hover after an edit
  costs the same (239 ms on the chain). It grows with the length of the association chain:
  89 ms (median) with 50 chained schemas, 140 with 100, 246 with 200 and 471 with 400. In the
  clusters topology it stays flat: 47 ms with 200 and 47 with 400.
- **Check time is superlinear in chain length.** For the whole chained project: 0.55 s with 50
  schemas, 1.19 s with 100, 4.4 s with 200 and 26 s with 400, while instantiations grow only
  linearly (414k, then 806k). Clusters stay linear: 1.1 s, then 1.9 s. The cost is the depth
  of the association graph, not the number of types. I have not found which type forces the
  whole chain to resolve. My hypothesis: something reads every static member of an
  association's target (for example a mapped type over its keys), which resolves the
  target's own associations, and so on down the chain. I record this as a Request below
  rather than guess at a fix; a fix would probably change public type signatures.
- A real application's schemas are usually more clustered than a 200-long chain, but a large,
  well-connected domain can reach deep chains. The owner keeps these type-health checks as a
  gate for `0.1.0` (owner decision, 2026-10-22). **The completions budget is not met on the
  chain topology.**

To reproduce: `pnpm build && node scripts/type-health/measure.mjs [--topology clusters]
[--schemas N] [--runs 5] [--tsserver-log file]`.

### Minimum supported TypeScript, and the CI matrix

- **Decision: TypeScript 5.5 or later**, as decision D14 already says. It is checked at 5.5.4.
  The workspace builds with 6.0.3. The getting-started page and `CONTRIBUTING.md` now say so.
- I checked a consumer of the packed packages (`examples/smoke/check-types.mjs --typescript …`:
  `declaration: true`, `skipLibCheck: false`) against these versions:

  | TypeScript | Result |
  |---|---|
  | 5.5.4, 5.6.3 | Egon's declarations compile. pg-protocol 1.16.1 (a dependency of the `pg` peer) fails with `TS2315: Type 'Buffer' is not generic` in its own `.d.ts`, because `@types/node` 22 has a generic `Buffer` only from TypeScript 5.7. With `skipLibCheck: true` the project compiles cleanly. |
  | 5.7.3, 5.8.3, 5.9.3, 7.0.2 | Clean. |
  | 7.1.0-dev.20261021.1 (`next`) | **Fails.** `TS5115` in zod 4.6.5's own declarations (`Instantiations … appear infinitely circular`), and `TS5088` on `export const errors = newUser.errorMessages()` in `consumer.ts:173` ("references a type with a cyclic structure which cannot be trivially serialized"). The second one is ours: `ErrorTreeOf` / `errorMessages()` under the next TypeScript. See Requests. |

- CI: `types (typescript minimum)` and `types (typescript latest)` are matrix entries of a new
  `typescript` job, which the `ci` check now waits for. `scripts/typescript-version.mjs` picks
  the versions: the minimum is pinned, and `latest` and `next` are the newest releases older
  than pnpm's minimum release age, so the strict policy of the consumer install still holds.
  `types (typescript next, informational)` has `continue-on-error: true` and the `ci` check
  does not wait for it. It is a heads-up about the next TypeScript, not a gate.
- **Exemption, stated plainly.** In the minimum job only, errors that lie entirely inside
  `node_modules/.pnpm/pg-protocol@…` are accepted and printed
  (`check-types.mjs --allow-lib-errors pg-protocol`). Any other error still fails, including
  one in Egon's own declarations. The existing smoke check (workspace TypeScript, no
  allowance) is unchanged.

## 4. Error-message review

- **Every error class triggered** the way an application would trigger it, in
  `packages/postgres/test/error-review.itest.ts`: `NoResultsError`, `MultipleResultsError`,
  `InvalidChangesetError`, `StaleEntryError`, `ConstraintError`, `DatabaseError`,
  `RollbackError`, `NotLoadedError`, `QueryError`, `CastError`, `SchemaDefinitionError` and
  `MigrationError`. `EgonError` is the base class and is never thrown by itself. Each test
  turns the full messages off (the test setup turns them on) and checks five things:
  - the short message starts with `<id>: `;
  - it names the offending thing (the schema, field, alias, constraint, file or count);
  - it links `reference/errors/<namespace>#<anchor>`;
  - that anchor exists on the generated page;
  - `explain(error)` adds the catalog's advice and keeps the link.
- **All 651 identifiers** were reviewed through the catalog and their throw sites, using
  `scripts/error-docs.ts`'s `findSites` and a one-off analysis that is not committed. Most
  short messages name the call (`addError()`, `withCte("tree", …)`) or interpolate the name.
  I also checked that every function or method the advice tells the user to call exists in
  the API reports. Fixed, with every identifier unchanged (ADR 0007):
  - Short messages that did not name the offending thing:
    - `query.lockNotNumber` now names the field: `optimisticLock(): "email" is not a number…`
      The check moved from the increment function to `optimisticLock`, where the field name
      is known; it is thrown at the same time as before.
    - `query.fieldValidatorPromise` names the field.
    - `query.updateWithAll` now says that an update was run as a read.
  - Advice that did not say what to do: `query.distinctTwice`, `query.setEmpty`,
    `query.windowsEmpty`, `query.windowTwice`, `query.cteTwice`, `query.overName`,
    `query.subqueryIsUpdate`, `query.updateWithAll`, `query.lockNotNumber`,
    `schema.stateNotRow` and `database.locked`.
  - `query.overArgument` told the user to call `window()`. The method is `windows()`.
  - The docs pages under `reference/errors/` and the four tests that quote these texts are
    updated.
- **Type errors.** I compiled 16 likely mistakes against the built package
  (`tsc --pretty false`) and compared the messages with the FAQ. The FAQ already covered
  eight, with the exact text. I added the four I judge most likely to be missing:
  - `repo.insert(User, values)`, the `create(…)` habit (`typeof User` is not assignable to `Changeset`);
  - a missing named parameter (`Expected 2-3 arguments, but got 1`), with the misspelt-name
    variant;
  - an unknown association in `preload` (reported against `never`), with the `Loaded<…>` variant;
  - `hasMany` without `foreignKey` (`Expected 2 arguments, but got 1`).
  I also added the `update`-of-a-new-record twin of the insert message, and the exact text of
  the `Col<string>`-is-not-a-`Condition` error. That makes 12 type errors with their messages
  and fixes on `guide/faq.md`.
- **Quality notes, for the owner** (not changed: they are type signatures):
  - `preload("postz")` is reported as "not assignable to parameter of type `never`", which
    does not list the valid names.
  - A field typo inside `select` (`p.titel`) also reports `Type 'Col<string>' is not
    assignable to type 'never'` next to the useful `TS2551 … Did you mean 'title'?`.

## 5. Cross-step seam tests

`packages/postgres/test/seams.itest.ts`. Each test takes its own database with
`withDatabase`:

1. **A nested insert in a Batch in a savepoint, with a constraint violation on the deepest
   child.** A user with two posts, the second of which has a comment whose author does not exist
   (a foreign-key violation on `comments`, three levels down), is inserted in a Batch run with
   `tx.transaction(batch)` inside an outer transaction. The batch fails at step `user`, with
   `completed` empty, and the error appears only on that comment
   (`{ posts: [{}, { comments: [{}, { authorId: ["does not exist"] }] }] }`). The savepoint
   rolls back the user, both posts and the comments already written. The outer transaction
   commits the rows it wrote before and after. A second test checks the same scenario with
   no declared constraint: a `ConstraintError` (`constraint.undeclared`, naming
   `comments_author_id_fkey`) comes out of the savepoint, and the outer transaction still commits.
2. **A has-through preload inside a transaction after a bulk insert.** `insertAll` of users,
   posts and comments, then `tx.preload(User, users, "comments")` (through `posts`) and a
   query with `.preload("comments")`, both inside the transaction. Both see the uncommitted
   rows, so the preload runs on the transaction's connection. They give the same result after
   the commit.
3. **A prepared query with named parameters from 50 concurrent tasks.** Two prepared queries
   (`email = :email` with a select; `age > :age` through `repo.count`) run by 50 tasks over a
   pool of 5. Every task gets its own rows. The plan cache compiled exactly two plans and
   answered the other 98 lookups. Its counters are compared before and after, because the
   cache is shared by adapters of the same configuration, as documented.
4. **Streaming 1M rows with constant memory.** Postgres generates 1,000,000 rows. The test
   streams them in batches of 1,000 and checks the count, the last id and the sum. It forces a
   full GC (`--expose-gc` set at run time) at ten checkpoints. The bound: after a GC, the heap
   is at most 16 MB above the baseline at every checkpoint, and it grows less than 4 MB from
   the first checkpoint to the last. The bound does catch retained rows: a version of the test
   that kept the rows failed at the first checkpoint, at 23.8 MB. **Runtime: about 3 s for
   the whole million on the laptop, generation included**, so the full size runs by default.
   `EGON_TEST_STREAM_ROWS` sets another size, for a slower machine or a longer soak.
   Decision: no opt-in flag. If CI shows that this is too slow, lower the default there.

No seam test exposed a bug.

## Decisions

- API reports live in `api-report/` at the root. `reports/` is in `.gitignore`.
- The reports include the forgotten-export helper types (see owner item 9).
- The minimum supported TypeScript stays at 5.5 (D14). CI checks it at 5.5.4, with the
  pg-protocol allowance described in section 3.
- The `next` TypeScript job is informational and not part of the `ci` check.
- The synthetic project's default topology is the chain, the worst case. Both topologies
  are recorded.
- Per-statement times are medians of 5 traced runs.

## Requests

- **To the owners of the schema and association types (steps 04 and 14), and the owner:** the
  chain-depth cost in section 3: completions take 246 ms (median) after an edit, and check time
  grows superlinearly with the length of the association chain. To reproduce:
  `node scripts/type-health/measure.mjs --schemas 400`. Find which type resolves every schema
  reachable through the associations, and whether it can stay lazy.
- **To the owners of the changeset types (steps 05 and 15):** under TypeScript `next`
  (7.1.0-dev.20261021.1), `export const errors = cs.errorMessages()` fails with TS5088
  (cyclic type that cannot be serialised) in a consumer with `declaration: true`. CI's
  informational job will show it. Check again when 7.1 reaches beta.
- **To 21-packaging:** `scripts/sync-version.mjs` rewrites `VERSION` in each package's
  `src/index.ts`, but `@egon-orm/cli` declares it in `src/version.ts`
  (`index.ts` re-exports it), so `pnpm version-packages` reports
  "no `export const VERSION` line" for the CLI. I did not run it.
- **To 21-packaging:** the support policy should state TypeScript 5.5 or later (5.7 or later
  for `skipLibCheck: false` with `@egon-orm/postgres`, because of `pg`'s declarations). That is
  what CI now checks.
- **To 21-audit:** the API report check, the TypeScript jobs and the measurements above are
  the evidence for §1.

## Acceptance (this part)

- [x] The API report is committed (`api-report/`, nine entry points) and enforced in CI
  (`pnpm api:check` in the build job). I verified that it fails on a changed report.
- [x] Type-health results are recorded, with instantiation counts (section 3). **Two
  budgets are not met in every case**: the first query a program checks is over 50 ms, and
  completions are over 200 ms on the chain topology. Both are listed under Requests and for the owner.
- [x] The error review is done (section 4).
- [x] The seam tests pass (section 5), locally against the Compose Postgres.

## Verification (local)

- `pnpm check`: passed (lint, typecheck, 6,134 unit tests with the coverage thresholds, 607
  type tests, build). `pnpm api:check`: up to date.
- `EGON_TEST_TIER2=1 pnpm test:integration --maxWorkers=2`: 47 files, 1,781 passed,
  2 expected failures (already in the repo), 55 skipped.
- `node examples/smoke/check-types.mjs --typescript <v>` for the versions in the table in section 3.

## Not verified

- CI has not run on this branch yet. The new CI jobs (`typescript` and `typescript-next`) and
  the `api:check` step were run locally only.
- I did not check that the API report is byte-identical when built on Linux. The CI run
  will show it.
- The tsserver timings are from one machine. The CI runners (2 vCPU) would be slower. The
  numbers are a one-off audit measurement, not a gate.
