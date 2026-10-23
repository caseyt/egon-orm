# Step 21, part 21-api (§1 whole-system audit), status

Branch `step/21-api-audit`, 2026-10-22, from `main` at `97def5c` (#61). Spec: §1 of
`docs/plan/21-release.md`. Measurements were taken on the owner's laptop (macOS, Apple
silicon), Node 22.23.1, TypeScript 6.0.3, against the shared Compose Postgres 16 and MySQL 8.4.

## Summary

| Item | State |
|---|---|
| API review | Done. Four types exported (a user had to name them and could not); TSDoc fixed. Nine renames, removals or additions are listed for the owner below, none made. |
| API report | `api-report/*.api.md` for all nine entry points, written by API Extractor 7.59.4; `pnpm api:check` in CI's build job fails on any difference. |
| Type health | Measured and recorded below. **Two budgets are not met:** (1) the first query a program checks takes 54 to 63 ms, a one-time cost; every other statement is at most 29 ms. (2) **The 200 ms completions gate is not met once about 150 to 200 schemas are connected through associations.** Completion time after an edit follows the number of schemas the edited query's schema reaches through associations, at about 1.1 to 1.2 ms each, whatever the shape: 242 to 314 ms (median) with 200 reachable (chain, binary tree or hub), and 47 ms when only ten are reachable. The per-schema work is identified (section 3): for every reachable schema the checker infers the type of each static member, the user's `changeset` methods included. Which library type triggers that is likely, but not confirmed. |
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

**Synthetic 200-schema project.** 200 schema classes, ten to a file. Each has eleven
fields, associations to other schemas, and a `static changeset` function. Each schema also
has a joined, filtered, selected query, a query with a named parameter, a preload and an
insert (about 8,300 lines). `--topology` sets how the associations link the schemas:

- `chain`: each schema to the one before and after it. All 200 are connected, depth 200.
- `tree`: a binary tree. All 200 are connected, depth about 8.
- `hub`: every schema belongs to `S000`, which has many of each. All 200 are connected, depth 2.
- `clusters`: the chain, cut at each file. Ten schemas are connected per file.

The editor check works in `S001`'s `where` callback. The column "reachable" is the number of
schemas `S001` reaches through associations, itself included.

| Topology | Reachable | Types | Instantiations | Check time | Slowest statement | Next slowest | Completions after an edit (median / max of 20) | Without an edit |
|---|---|---|---|---|---|---|---|---|
| chain | 200 | 61,843 | 413,957 | 4.23 s | 62.0 ms (max 68.2) | 26.4 ms | **246 / 452 ms** | 0 ms |
| tree | 200 | 59,175 | 401,512 | 3.33 s | 63.4 ms (max 102.2) | 29.4 ms | **314 / 449 ms** | 0 ms |
| hub | 200 | 56,695 | 389,037 | 2.30 s | 54.2 ms (max 54.7) | 22.9 ms | **242 / 397 ms** | 0 ms |
| clusters | 10 | 59,753 | 401,968 | 1.08 s | 58.7 ms (max 66.3) | 22.1 ms | 47 / 97 ms | 0 ms |

Completions after an edit, median of 20, from a separate sweep run with
`--completions-only`. The same machine was busier during the table runs above: the tree's
314 ms there was 244 ms here.

| Reachable schemas | chain | tree | hub | clusters |
|---|---|---|---|---|
| 10 | | | | 55 (of 200), 46 (of 400) |
| 50 | 141 | 89 | 86 | |
| 100 | 219 | 149 | 137 | |
| 200 | 244 | 244 | 255 | |
| 400 | | 473 | | |

What this shows:

- **50 ms per query expression: met, except for the first statement a program checks.** The
  slowest statement is always the first query checked (`queries-00.ts:4`), whichever query
  that is. When the `where`-callback file was checked first, the same 55 to 60 ms moved to it,
  and its own time dropped out of the top ten once it was checked last. That is the
  one-time cost of resolving the library's types. Every other statement is at most 29 ms.
  By the letter of the budget, one statement per program is over.
- **Completions under 200 ms: not met once about 150 to 200 schemas are connected.**
  - Completion time after an edit follows the number of **reachable** schemas, not the depth
    of the graph. The tree (depth about 8) and the hub (depth 2) cost what the chain (depth 200)
    costs: about 40 ms plus about 1.1 to 1.2 ms per reachable schema. At that rate the 200 ms
    budget is crossed at about 140 to 170 reachable schemas on this machine; a 2-vCPU CI
    runner or an older laptop would cross it sooner.
  - With no edit, a request takes 0 to 1 ms. The program update after an edit takes 2 ms
    (tsserver log). The time goes into the new checker, which re-resolves the reachable schemas
    for the first request after each edit. A hover after an edit costs the same.
  - A real domain model is usually one connected graph (users, posts, comments, tags, orgs,
    and so on). An application with 150 or more interlinked schemas would miss this budget.
- **The cause, found with a tsserver trace and two variants of the project.** In the trace
  of one completion (`--traceDirectory`), almost all the time sits under the `checkExpression`
  of the binding `s`. Inside it are hundreds of nested `checkExpression` events in the schema
  files, at the bodies of the `static changeset(…)` methods (`cast(…).validateRequired(…)…`)
  and at the association initialisers, about 1 ms per schema. So **for every reachable schema
  the checker infers the type of each static member**: the inferred return type of the
  user's `changeset` method and the inferred type of each `hasMany(…)` / `belongsTo(…)`.
  Completions after an edit, tree with 200 schemas:

  | Variant | Median | Max |
  |---|---|---|
  | As generated | 249 ms | 394 ms |
  | Associations given explicit `Assoc<…>` types (`--annotate-assocs`) | 208 ms | 369 ms |
  | No `changeset` methods (`--no-changeset`) | 105 ms | 240 ms |
  | Both | 66 ms | 152 ms |

  So, of the roughly 200 ms above the baseline, about 145 ms is inferring the reachable
  schemas' `changeset` methods and about 40 ms is inferring their associations. What reads
  every static member is a type that maps over `keyof S`. `AssocKeys<S> = { [K in keyof S]:
  S[K] extends Assoc ? K : never }[keyof S]` does, so it needs the type of every static member
  of `S`. A type that recurses through the association targets would apply it to every
  reachable schema; `PreloadSpec<S>` is one: `{ [K in AssocKeys<S>]?: true |
  PreloadSpec<Target<S, K>> }`. **The second step is a likely explanation, not a
  confirmed one.** I have not found which use of the query's type expands that recursion
  for a plain `where` callback. Finding it, and stopping the expansion (for example by
  recursing on demand, or by reading association keys from a declared list instead of
  `keyof S`), would change public types, so it needs the owner's decision. Until then, a user
  can lower the cost by declaring the return type of `changeset` methods.
- **Check time is superlinear only for long chains.** For the whole chained project: 0.55 s
  with 50 schemas, 1.19 s with 100, 4.4 s with 200 and 26 s with 400, while instantiations grow
  only linearly (414k, then 806k). With the same 200 schemas the tree takes 3.3 s, the hub
  2.3 s and the clusters 1.1 s. Depth drives the superlinear check time; the reachable count
  drives the editor time.
- The owner keeps these type-health checks as a gate for `0.1.0` (owner decision,
  2026-10-22). **The completions budget is not met for about 150 to 200 connected schemas.**

To reproduce: `pnpm build && node scripts/type-health/measure.mjs [--topology
chain|tree|hub|clusters] [--schemas N] [--runs 5] [--completions-only] [--annotate-assocs]
[--no-changeset] [--tsserver-log file]`.

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
- **Exemption, stated plainly.** In the minimum job only, an error is accepted (and
  printed) when its **location**, the file before `(line,col)`, lies inside
  `node_modules/.pnpm/pg-protocol@<version>/node_modules/pg-protocol/`
  (`check-types.mjs --allow-lib-errors pg-protocol`, filter in
  `scripts/allowed-lib-errors.mjs`, with node tests). These still fail:
  - an error with no location, such as TS2688 for a bad `types` entry (review round 1 found
    that the first version let one through);
  - an error elsewhere whose text merely mentions pg-protocol;
  - an error in a package whose name only starts with `pg-protocol`;
  - any error in Egon's own declarations. The existing smoke check (workspace TypeScript, no
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
- The synthetic project's default topology is the chain, which is the worst case for check
  time. For editor time all connected shapes cost about the same. All four topologies
  are recorded.
- Per-statement times are medians of 5 traced runs.

## Requests

- **To the owners of the schema and association types (steps 04 and 14), and the owner:** the
  editor cost in section 3. After each edit, a completion in a `where` callback costs about
  1.1 to 1.2 ms per schema reachable through associations, because the checker infers every
  static member (the user's `changeset` methods, the association initialisers) of every
  reachable schema. That is 242 to 314 ms with 200 connected schemas, whatever the graph's
  shape. Find the type that expands the association graph for a plain query (the likely
  candidate is `AssocKeys<S>`, a mapped type over `keyof S`, applied through the recursive
  `PreloadSpec<S>`), and keep it lazy, so that only the schemas a query names are resolved.
  Separately, check time grows superlinearly with the depth of a chain (26 s for 400 chained
  schemas). To reproduce: `node scripts/type-health/measure.mjs --topology tree
  --completions-only`, then again with `--no-changeset` and with `--annotate-assocs`.
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
  the evidence for §1. **The 200 ms completions gate is not met for about 150 to 200
  connected schemas** (242 to 314 ms median at 200 reachable schemas, in chain, tree and hub
  shapes; met at 47 ms when ten are reachable). It is a `0.1.0` gate (owner decision,
  2026-10-22), so the readiness report should list it as not met until the request above
  is resolved. Also not met by the letter: the first query a program checks takes 54 to
  63 ms, a one-time cost.

## Acceptance (this part)

- [x] The API report is committed (`api-report/`, nine entry points) and enforced in CI
  (`pnpm api:check` in the build job). I verified that it fails on a changed report.
- [x] Type-health results are recorded, with instantiation counts (section 3). **Two
  budgets are not met**: the first query a program checks is over 50 ms, and completions
  are over 200 ms once about 150 to 200 schemas are connected (any shape). Both are listed
  under Requests, for the owner and for 21-audit.
- [x] The error review is done (section 4).
- [x] The seam tests pass (section 5), locally against the Compose Postgres.

## Review round 1 (PR #69)

1. **The pg-protocol allowance let location-less errors through** (a bad `types` entry gave
   only a TS2688, and the check passed). Fixed: every `error TS` line is an error, and one is
   allowed only by its location. The filter moved to `scripts/allowed-lib-errors.mjs`, with
   node tests for both holes (a location-less error, and an error elsewhere that mentions
   the package) and for a look-alike package name.
2. **The type-health conclusion was wrong.** Completion time follows the number of reachable
   schemas, not the depth. I added the `tree` and `hub` topologies, swept the sizes, and
   rewrote section 3, the Request to steps 04/14 and the Request to 21-audit around that.
   I found the per-schema work: each reachable schema's static members, the `changeset`
   methods above all, are inferred. Measured with the new diagnostic variants
   `--no-changeset` and `--annotate-assocs`.
3. **`latest` meant "most recently published".** It is now the `latest` dist-tag when that
   is old enough, and otherwise the highest stable version, by version. A test covers a later
   patch to an older line.
4. **The API report's entry list was kept by hand.** A test now compares it with every
   published package's `exports`.
5. **The 50-task test now proves the tasks overlapped.** It samples `repo.poolStats()` on
   every event-loop turn: more than one connection checked out at once, and callers waiting.
   It also expects more than one session for the database in `pg_stat_activity`.
6. **The stream test's comment** now gives the measured times: about 3 s on a laptop and
   about 10 s on a CI runner.
7. **FAQ:** the update twin of the insert entry is TS2345 under plain `strict`, and TS2379
   only with `exactOptionalPropertyTypes`. I checked both by compiling.
8. **FAQ:** `hasMany` and `hasOne` take `{ foreignKey }` or `{ through }`.

## Verification (local)

- `pnpm check`: passed (lint, typecheck, 6,134 unit tests with the coverage thresholds, 607
  type tests, build). `pnpm api:check`: up to date.
- `EGON_TEST_TIER2=1 pnpm test:integration --maxWorkers=2`: 47 files, 1,781 passed,
  2 expected failures (already in the repo), 55 skipped.
- `node examples/smoke/check-types.mjs --typescript <v>` for the versions in the table in section 3.
- CI on PR #69 (run 39881683958, at `9797377`): every job green. The API report built on
  Linux matched the committed one ("API report up to date for 9 entry points"). The 5.5.4
  job passed with only pg-protocol's errors allowed, and 7.0.2 passed. The informational
  `next` job failed with exactly the TS5115 (zod) and TS5088 (`consumer.ts:173`) errors
  recorded above.

## Not verified

- The tsserver timings are from one machine. The CI runners (2 vCPU) would be slower. The
  numbers are a one-off audit measurement, not a gate.
