# Egon ORM — master plan

A TypeScript ORM modelled on Elixir's Ecto: **schemas**, **changesets**, an Ecto-style
**query builder**, and a **Repo**. Heavily tested, performance-first, fully documented.

> The project is **Egon ORM**: packages `egon-orm` and `@egon-orm/*` (owner decision,
> 2026-10-12). It was called Ectype while steps 01 and 02 were built; the code was renamed
> in PR #4. The GitHub repository, formerly `caseyt/ectype-orm`, is now `egon-orm/egon-orm`.
>
> Ecto is the design reference for behaviour. It is **not** how the library is presented:
> users come from Drizzle, Sequelize and Prisma, so public names, TSDoc and guides do not
> mention Ecto (§8).
>
> **Order of authority for the public API:** the guide pages under `docs/site/guide/`
> first, then §11 (the developer-API review of 2026-10-13), then the step files. The
> guide was written before the code and describes what developers will see; the step
> files say how to build and test it. If you find a disagreement, follow the higher
> source and record it in your status note.

This file is the shared context for every step. **Every worker reads this file in full,
then their own step file.** Step files do not repeat what is here.

---

## 1. Goals and non-goals

**Goals**

1. Ecto's mental model, faithfully: data (schema structs) is separate from change tracking
   (changesets), from query description (immutable query values), from execution (Repo).
2. End-to-end type inference with no codegen: row types, preloaded association types, and
   `select` result types all come from the schema definition.
3. Validation through any [Standard Schema](https://standardschema.dev) validator (Zod is
   the documented default; Valibot, ArkType and recent Yup also implement it) or a plain
   user function.
4. Overhead over the raw driver small enough to measure in microseconds (budgets in §7).
5. Every public API documented with runnable, type-checked examples.

**Non-goals for 1.0**

- Active-record style (`user.save()`), lazy loading, identity map, unit of work.
- Implicit transaction propagation via `AsyncLocalStorage` (transactions are explicit).
- Schema-diffing auto-migrations. Migrations are hand-written (step 18).
- Non-SQL stores.

---

## 2. Decisions already made

These are settled. Changing one requires an ADR (§9), not a unilateral edit.

| # | Decision | Why |
|---|---|---|
| D1 | **Schemas are classes** built with `class User extends Schema("users", {...fields}) {}`; associations are `static` members holding thunks. | Verified by spike. `const User = schema({ posts: hasMany(() => Post) })` and the same thing in a class `extends` clause both fail with TS7022/TS2506 on any circular association. Static initialisers resolve lazily. See `spikes/schema-typing.ts` (compiles under `--strict`) and `spikes/rejected-const-thunks.ts`. |
| D2 | Rows are **instances of the schema class**, created by a generated factory that never runs a constructor. The constructor is **not public API**: a row comes only from the database (a query, or a successful write). New records are described by changesets, `cast(User, params, [...])` and `change(User, values)`. Schema classes may carry getters and methods, never a constructor or field initialisers. | Named row types (`User`), user-defined getters/methods, stable hidden classes. A half-built row whose required fields are `undefined` cannot exist. |
| D3 | Fields are **non-null by default**; `.nullable()` opts in. Confirmed by the owner (2026-10-13). `cast` rejects `null` for a non-nullable field and `repo.insert` reports a missing required field as a changeset error. | Deviates from Ecto (everything nullable) because it is what TS users expect and gives better types. |
| D4 | Field names are camelCase in TS and snake_case in the database by default; `.column("col")` overrides per field, `naming` option per schema. | Convention on both sides. |
| D5 | `belongsTo` does **not** define the foreign-key field; declare it in the fields object. | Fields and associations live in different places because of D1. |
| D6 | Query bindings are **named** and passed to callbacks as one object: `.where(({ u, p }) => ...)`. | Ecto named bindings; positional bindings do not type well. |
| D7 | Operators are methods on expressions (`u.age.gt(18)`), with free functions for n-ary and aggregate forms (`and`, `or`, `not`, `count`, `fragment`). | No operator overloading in TS; methods are discoverable. |
| D8 | Binding objects are **prebuilt per (schema, alias) and cached**. No `Proxy` anywhere on a hot path. | Performance. |
| D9 | Every literal in a query is a **bound parameter**. The only way to emit raw SQL text is the `fragment` tagged template, whose interpolations are also bound. | Injection safety by construction. |
| D10 | Write operations return `Result<T, Changeset<T>>` (`{ success: true, data } \| { success: false, error }`); each has an `...OrThrow` twin. The word `ok` appears nowhere in the API: the helpers are `success(data)` and `failure(error)`. | A validation failure is an expected outcome, typed and impossible to confuse with a fault. Same shape as Zod's `safeParse`. |
| D11 | Changesets are immutable and synchronous. Async validation is a separate, explicit `validateAsync`. | Keeps the common path allocation-light and predictable. |
| D12 | **Egon emits its own SQL and wraps the database drivers directly.** One emitter in core turns our query AST into SQL text, with a dialect table for Postgres, MySQL and SQLite; each dialect package wraps its driver (`pg`, `mysql2`, `better-sqlite3`) behind our `Adapter` interface. Core has no runtime dependency. | ADR 0003, which supersedes ADR 0002 (Kysely as a hidden back end). Kysely would have saved about 1,500 lines of emitter and 500 of drivers, while we wrote a lowering of similar size on top of its undocumented node layer, pinned to one pre-1.0 minor. Owning the emitter keeps the injection rule (D9), byte-identical SQL and the full query feature set in our own code. |
| D13 | Postgres is tier 1 (every feature, every test). SQLite and MySQL are tier 2 (conformance suite, documented capability gaps). | Scope control. |
| D14 | Node >= 22.12, TypeScript >= 5.5, **ESM only: no CommonJS build**. pnpm workspace. Vitest. Biome. | Current baseline. Two builds of one package are two copies of every class and symbol. Node 22.12 is the first release in which a CommonJS project can `require()` an ES module, which is how such projects use the packages. (Kysely being ESM-only was the original reason, ADR 0002; that reason is gone with ADR 0003, and the decision stands until the owner revisits it.) |
| D15 | Validators are consumed through the Standard Schema interface (types vendored, no dependency). Zod is a dev/peer dependency of `@egon-orm/zod` only. | "Zod by default, anything else allowed" with zero coupling in core. |

---

## 3. Packages and layout

```
packages/
  core/            -> "egon-orm"            schema, types, changeset, query, repo, adapter interface, SQL emitter
  postgres/        -> "@egon-orm/postgres"  pg driver wrapper, pg type mapping, error normalisation
  sqlite/          -> "@egon-orm/sqlite"    (step 17)
  mysql/           -> "@egon-orm/mysql"     (step 17)
  zod/             -> "@egon-orm/zod"       derive Zod schemas from Egon schemas (step 06)
  cli/             -> "@egon-orm/cli"       migration runner and generators (step 18)
benchmarks/        comparative and micro benchmarks (step 19)
examples/          blog (reference app used by docs and e2e tests)
docs/
  plan/            this plan; status/ holds completion notes; spikes/ holds proofs
  adr/             architecture decision records
  site/            VitePress documentation site (step 20)
```

`packages/core/src`:

```
contracts/     frozen shared interfaces (step 02)
types/         FieldType implementations (03)
schema/        Schema(), field builder, associations, metadata (04)
changeset/     changeset core (05), validators (06), nested (15)
query/         ast.ts, expr.ts (07); builder.ts (08); advanced/ (09)
compiler/      AST -> SQL text, dialect tables, plan cache (10)
adapter/       shared Adapter implementation over a driver wrapper, telemetry (11)
repo/          read (12), write (13), preload (14), transaction + sandbox (16)
batch/         Batch (16)
errors.ts
index.ts       the public entry point; everything else is internal
```

Public entry points for the first release are exactly two: `egon-orm` and
`egon-orm/testing` (step 16). `egon-orm/migration` arrives with step 18.

Each step file lists the paths it **owns**. Do not edit files outside your owned paths
except to add an export line to `index.ts`. If you need a change elsewhere, write it in
your status note under "Requests".

---

## 4. The API at a glance

This is the target surface. Step files specify each part exactly; this section exists so
that every worker has the same picture.

```ts
import { Schema, t, hasMany, belongsTo, timestamps, cast, from, count, createRepo } from "egon-orm";
import { postgres } from "@egon-orm/postgres";
import { z } from "zod";

// --- Schema ------------------------------------------------------------------
export class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(), // serial: the database generates it
  email: t.string(),                          // non-null by default
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  password: t.string().virtual(),
  passwordHash: t.string().redact(),
  ...timestamps(),                            // createdAt, updatedAt
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  // Changeset functions are ordinary static methods. Pass the class for a new record,
  // a loaded row for an update.
  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name", "age", "password"])
      .validateRequired(["email"])
      .validate(z.object({ email: z.string().email(), age: z.number().int().min(13).nullish() }))
      .validateLength("password", { min: 12 })
      .uniqueConstraint("email");
  }
}

export class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  published: t.boolean().default(false),
  authorId: t.integer(),                      // a plain column; the association points at it
  ...timestamps(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
}

// --- Repo --------------------------------------------------------------------
const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

const result = await repo.insert(User.changeset(User, input));
if (!result.success) return result.error.errorMessages();   // { email: ["has already been taken"] }
const user = result.data;                                   // User

// --- Query -------------------------------------------------------------------
const q = from(User, "u")
  .joinAssoc("u", "posts", "p")
  .where(({ u, p }) => u.age.gte(18).and(p.published))
  .groupBy(({ u }) => u.id)
  .orderBy(({ u }) => u.createdAt.desc())
  .select(({ u, p }) => ({ id: u.id, email: u.email, posts: count(p.id) }));

const rows = await repo.all(q);                     // { id: number; email: string; posts: number }[]

const withPosts = await repo.all(
  from(User, "u").preload("posts", (q) => q.orderBy(({ posts }) => posts.createdAt.desc()).limit(3)),
);
withPosts[0].posts[0].title;                        // typed: Loaded<typeof User, "posts">

await repo.transaction(async (tx) => {
  const u = await tx.getOrThrow(User, 1);
  await tx.updateOrThrow(User.changeset(u, { name: "New" }));
});
```

Naming is camelCase throughout; a throwing twin is `funOrThrow`; a predicate is
`isFun`/`hasFun`. Names are chosen for people arriving from Drizzle, Sequelize and Prisma
(§8, §11).

---

## 5. Steps and dependency graph

| Step | File | Depends on | Can run in parallel with |
|---|---|---|---|
| 01 Foundation | `01-foundation.md` | — | — |
| 02 Core contracts and back-end spike | `02-core-contracts.md` | 01 | — |
| 03 Type system | `03-types.md` | 02 | 07, 11 |
| 04 Schema | `04-schema.md` | 03 | 07, 11 |
| 05 Changeset core | `05-changeset.md` | 04 | 08, 10, 11 |
| 06 Validators (Zod / Standard Schema / custom) | `06-changeset-validators.md` | 05 | 08–12 |
| 07 Query AST and expressions | `07-query-expressions.md` | 02 | 03, 04, 11 |
| 08 Query builder | `08-query-builder.md` | 04, 07 | 05, 10, 11 |
| 09 Advanced queries | `09-query-advanced.md` | 08, 10 | 12, 13 |
| 10 SQL compiler and plan cache | `10-sql-compiler.md` | 07 (08 for integration) | 05, 08, 11 |
| 11 Adapter and Postgres package | `11-adapter.md` | 02 | 03–10 |
| 12 Repo: reads | `12-repo-read.md` | 08, 10, 11 | 05, 06, 09 |
| 13 Repo: writes | `13-repo-write.md` | 05, 12 | 09, 14 |
| 14 Associations and preload | `14-associations-preload.md` | 12 | 13 |
| 15 Nested changesets and embeds | `15-nested-changesets.md` | 13, 14 | 16 |
| 16 Transactions, Batch, sandbox | `16-transactions-batch.md` | 13 | 14, 15 |
| 17 SQLite and MySQL | `17-dialects.md` | 12–16 | 18 |
| 18 Migrations and CLI (brought forward; merged in #34, 2026-10-20) | `18-migrations-cli.md` | 11 | 12–17 |
| 19 Performance | `19-performance.md` | harness after 01; final pass after 16 | — |
| 20 Documentation | `20-documentation.md` | skeleton after 01; final pass after 17 | — |
| 21a Edge readiness (owner decision, 2026-10-20) | `21a-edge-readiness.md` | 17, 18, 20 | 19 |
| 21b JSON responses (owner decision, 2026-10-21) | `21b-json-responses.md` | 20 | 21a, 19 |
| 21 Release hardening | `21-release.md` | all except 19 (owner decision, 2026-10-22) | — |

Suggested waves: **A** 01 → **B** 02 → **C** 03, 07, 11 → **D** 04, 10 → **E** 05, 08 →
**F** 06, 12 → **G** 09, 13, 14 → **H** 15, 16 → **I** 17, 18 → **J** 19, 20, 21.
Step 21a (edge readiness) was added on 2026-10-20 and step 21b (JSON responses) on
2026-10-21; both run before 21, in parallel with each other. Step 19 is postponed until the
owner decides where benchmarks run; it is a one-off published run, not a CI gate
(owner decision, 2026-10-21). Step 21 does not wait for it (owner decision, 2026-10-22).

Steps 01 and 02 are deliberately sequential and small: they freeze the interfaces that let
everything after them proceed independently.

---

## 6. Testing standards

All of these apply to every step. Step files add specifics.

- **Unit tests** (`*.test.ts` beside the source): no database, no network. Target: 100%
  of branches in owned code; CI enforces 95% lines and branches per package.
- **Type tests** (`*.test-d.ts`, Vitest `expectTypeOf` plus `// @ts-expect-error`): every
  public generic has positive and negative cases. A type that silently degrades to `any`
  or `unknown` is a bug; include `expectTypeOf(x).not.toBeAny()` on inferred results.
- **SQL snapshot tests**: query in, `{ sql, params }` out, inline snapshots, one per
  feature per dialect. No database needed.
- **Integration tests** (`*.itest.ts`): real databases from `docker compose`. Each test
  runs inside the sandbox (step 16; before that, a truncate helper from step 01).
- **Property tests** (fast-check) where the input space is large: type cast/toDb/fromDb
  round trips, changeset invariants, and "no user-supplied string ever appears in emitted
  SQL text".
- **Conformance suite** (`packages/core/test/conformance`): dialect-independent
  integration tests that every adapter package runs against itself.
- Tests are named for the behaviour, not the function: `"cast ignores keys that are not permitted"`.
- A bug fix lands with a test that fails without it.

---

## 7. Performance standards

Performance is a feature with tests. Step 19 owns the harness **and, since the owner's
decision of 2026-10-14, the benchmarks themselves**: feature steps no longer write or run
micro-benchmarks or tune against the budgets below. Benchmarks are written once everything
works, in step 19, which then measures every budget. Where a step file asks for a
benchmark, a budget check or benchmark numbers, that item is **deferred to step 19**: mark
its Acceptance box "deferred to step 19 (owner decision, 2026-10-14)" and leave it unticked.
The hot-path coding rules below still apply to every step.

Budgets (Node 22; step 19 measures them once on the machines the owner chooses and
publishes the results. Nothing in CI gates on timings: owner decision, 2026-10-21):

| Operation | Budget |
|---|---|
| Build a 3-clause query (`from`/`where`/`orderBy`/`limit`) | < 1.5 µs |
| Compile, plan-cache hit | < 0.3 µs |
| Compile, cold | < 40 µs |
| Hydrate one 10-column row into a schema instance | < 150 ns |
| `cast` + 5 built-in validations on a 10-field changeset | < 3 µs |
| `repo.all` of 1,000 rows, end to end, over raw driver with manual mapping | < 15% overhead |
| `repo.insert` of one row over raw driver | < 20% overhead |

Rules that follow from the budgets:

- No `Proxy`, no `Object.defineProperty` per row, no `delete`, no spread of row objects on
  hot paths. Keep object shapes monomorphic: assign every field in the same order, always.
- No per-call closures or arrays where a precomputed table on schema metadata will do.
- Identity `fromDb`/`toDb` functions are skipped by reference check, not called.
- Anything derivable from a schema or a query shape is computed once and cached on it.
- Do not optimise speculatively: write clear code that follows these rules. Optimisations
  that need measurement wait for step 19.

---

## 8. Documentation standards

- Every exported symbol has TSDoc: one-sentence summary, `@example`, `@throws` where
  relevant.
- **No Ecto positioning.** TSDoc, code comments and guide pages never say "Ecto
  equivalent", "as in Ecto" or "differences from Ecto", and there is no "Coming from Ecto"
  page or Ecto mapping table. Readers come from Drizzle, Sequelize and Prisma; comparisons
  and migration guides are written for them. (These plan files may still cite Ecto as the
  behavioural reference for workers. Where a step file asks for an "Ecto equivalent"
  column or a "Differences from Ecto" box in *user* documentation, leave it out.)
- **The guide pages already exist** (PR #5) and define the public API. A step does not
  create the page(s) listed in its file: it implements what the page says, then updates
  the page where the implementation taught us something (in the same PR, called out in
  the status note), and adds the plan details the page lacks. A change to the API itself
  is a change to the page first, agreed with the owner.
- Every code block in the docs is type-checked in CI once its feature exists. The pages
  were written before the code, so their blocks are hand-written today. **The step that
  implements a feature converts that page's blocks** to regions of real files under
  `docs/site/examples/`, included by reference. Step 20 builds the extractor and the lint
  that forbids the remaining hand-written blocks.
- Step 20 assembles, edits and cross-links, and applies its page template in the final pass.
- Behaviour that would surprise someone coming from another ORM (no lazy loading,
  explicit transactions, non-null by default, results instead of exceptions) is stated in
  a "Good to know" box on the page.

---

## 9. Worker protocol

1. Read this file, then your step file, then the step files you depend on (their "Public
   API" sections are your inputs) and `packages/core/src/contracts/`.
2. Work on branch `step/NN-short-name`. Touch only your owned paths.
3. Build in this order: types and signatures, type tests, unit tests, implementation,
   integration tests, docs. (Benchmarks are step 19's; §7.)
4. If the spec is wrong, ambiguous, or blocked by another step: do not guess silently.
   Choose the option closest to Ecto's documented behaviour (unless §11 says otherwise), implement it, and record it
   under "Decisions" in your status note. If it changes a frozen contract or a decision in
   §2, write `docs/adr/NNNN-title.md` (context, options, decision, consequences) and stop
   that part of the work until it is accepted.
5. Done means every box in your step's **Acceptance** list is true and `pnpm check`
   (lint, typecheck, unit, type tests, build) passes, plus `pnpm test:integration` for
   steps that have integration tests.
6. Write `docs/plan/status/NN.md`: what shipped, decisions made, deviations from the spec,
   known gaps, requests to other steps. Report failures and skipped items plainly; a status note that hides a gap is worse than the gap.
7. Open a pull request and take it through the review loop below. A step is finished when
   its PR is approved and merged, not when the code is written.

### Pull request and review loop

Remote: `https://github.com/egon-orm/egon-orm.git`, default branch `main`.

**Author (the worker that implemented the step)**

1. Push `step/NN-short-name` and open a PR against `main` with `gh pr create`.
   Title: `Step NN: <name>`. Body: summary, the step's Acceptance list as checkboxes with
   their real state, deviations and decisions, and how to verify locally.
2. Wait for CI. Do not request review on a red PR.
3. Hand the PR to a **different agent** for review (a fresh agent with no memory of the
   implementation; never review your own PR).
4. When the review arrives, address every comment: fix it, or reply with a concrete reason
   it should stay. Push follow-up commits (no force-push during review, so the reviewer
   can see what changed) and reply on each thread saying what was done.
5. Request re-review. Repeat until the reviewer approves with no remaining suggestions.
6. Squash-merge after approval and green CI, then delete the branch.

**Reviewer (a separate agent, started fresh for each round or continued across rounds)**

Reads `docs/plan/README.md`, the step file, and the PR diff — then checks out the branch
and runs it. Reviews against, in order:

1. **Spec conformance:** every Acceptance box is actually true (verify, do not trust the
   checklist); public API matches the step file; nothing outside the owned paths changed.
2. **Correctness:** hunt for bugs, especially edge cases the spec lists, null handling,
   error paths, and anything that could put a user value into SQL text.
3. **Types:** no `any`/`unknown` leaking from public generics; negative type tests exist.
4. **Tests:** they fail when the behaviour is broken (spot-check by mutating the code),
   cover the listed use cases, and are not snapshot-only where behaviour matters.
5. **Performance:** hot-path coding rules in §7 followed. Benchmarks and budgets are not
   reviewed before step 19 (§7).
6. **Docs:** TSDoc and the guide page exist, examples compile.

Posts findings with `gh pr review`: `--request-changes` with specific, located comments
(file, line, what is wrong, a failing input where possible) while anything remains;
`--approve` only when there is nothing left to suggest. Reviewers do not push commits to
the PR. Style preferences the linter does not enforce are not grounds for requesting changes.

If author and reviewer disagree for two rounds on the same point, stop and escalate it to
the project owner in the PR rather than looping.

Definition of done, common to all steps:

- [ ] Acceptance list complete; no `TODO` without an issue reference; no `any` in public types.
- [ ] No `@ts-ignore`; `@ts-expect-error` only in type tests.
- [ ] Unit, type, and (where applicable) integration tests pass; coverage thresholds met.
- [ ] TSDoc on all exports; guide page delivered.
- [ ] `index.ts` exports updated; nothing internal exported.
- [ ] Status note written.

---

## 10. Owner decisions (2026-10-11)

1. **Name:** superseded on 2026-10-12: **Egon ORM**, `egon-orm` / `@egon-orm/*`. The npm scope is still to be claimed (step 21 confirms).
2. **Database tiers:** Postgres first (D13 stands). SQLite and MySQL follow in step 17.
3. **Migrations and CLI:** wanted, but as a **follow-up**. Step 18 is not part of the first
   release; it starts after step 21. Until then tests and examples use plain SQL fixtures.
   Superseded: step 18 was brought forward and merged on 2026-10-20 (#34).
4. **Nullable default (D3):** confirmed 2026-10-13: non-null by default.

---

## 11. Developer-API review (owner decisions, 2026-10-13)

The owner walked through the whole developer API. These decisions are settled (changing
one needs an ADR, as for §2) and the step files have been edited to match. Where a step
file still disagrees with this section, this section wins; record the disagreement in
your status note.

### Repo and adapters (steps 11, 12, 17)

- `planCacheSize` is an **adapter** option (`postgres({ planCacheSize })`), not a repo option.
- No `types` option on an adapter. The schema field decides the runtime type.
- Logging options live on the repo: `log: true | LoggerFn | { params: true }`. There is no
  separate `logParams` or `debug` switch.
- `warnOnRootUseInTransaction` is a development-only warning implemented with
  `AsyncLocalStorage` (never in production; transactions stay explicit).
- `repo.ping()` and `repo.poolStats()` pass through to the adapter. `repo.on(...)` forwards
  the pool events (`connect`, `disconnect`, `poolExhausted`) as well as `query`.
- **`prefix` is renamed `schema` everywhere**: the repo option, the per-call option, the
  third argument of `Schema()`, and `.schema("tenant_1")` on a query. (In prose, "schema
  class" or "model" is the class; "database schema" is this option.)
- The adapter and the repo stay two objects.
- Every adapter takes `connectionString` (MySQL's `uri` is gone) and has no `timezone`
  option: the MySQL session is always UTC. SQLite turns `foreign_keys` on by default and
  ignores row locks silently (single writer). SQLite and MySQL stay in the first release.

### Schemas (steps 03, 04)

- **No `t.id()`** (and no `types.id`). A serial key is `t.integer().primaryKey().dbGenerated()`;
  a foreign key is a plain `t.integer()` (or `t.uuid()`). `.primaryKey()` never implies
  database-generated, whatever the type: a key is a value you supply unless `.dbGenerated()`
  or `.autogenerate()` says otherwise. This holds for every part of a composite key.
- `t.bigint({ mode: "number" })` maps a 64-bit column to a JS `number` and throws
  `CastError` beyond the safe range. Plain `t.bigint()` is a JS `bigint`.
- **No public constructor** (D2). `new User(...)` is not written by developers.
- `timestamps()` gives `createdAt` / `updatedAt`.
- Renames: `utcDatetime` → `timestamp`, `naiveDatetime` → `localTimestamp`,
  `.source()` → `.column()`, `.readAfterWrites()` → `.dbGenerated()`,
  `EctoType` → `FieldType`, `load` / `dump` → `fromDb` / `toDb`. `t.map<T>()` is removed
  (use `t.json<T>()`). `.redact()` stays.
- **One namespace for types.** There is no public `types` object: wherever a type is
  needed (`param`, `expr.cast`, `values`, schemaless changesets) pass a field builder,
  `t.integer()`.
- A custom type's `cast` returns `{ success: true, data } | { success: false, message }`.
- `date` stays a `"YYYY-MM-DD"` string and `decimal` a string by default.
- Class members: getters and methods only.

### Associations (steps 04, 14)

- The word is **association**; the loading verb is **preload**.
- `foreignKey` is **required** on `hasOne` and `hasMany` (a default derived from the class
  name breaks under minification). `belongsTo` keeps its default, `<property name>Id`.
- `manyToMany` with a join table given as a string: `joinKeys` is **required** and holds the
  join table's **column** names, `joinKeys: { owner: "user_id", target: "tag_id" }`. There
  is no default. With a join schema class they are field names.
- No `optional` on `belongsTo` (the foreign key's `.nullable()` decides) and no `onDelete`.
- The association option `preloadOrder` is renamed `orderBy`.

### Queries (steps 07, 08, 09)

- The alias is **required**: `from(User, "u")`. There is no `"root"` default.
- `from` takes a schema class or an explicit source wrapper (`subquery(q)`, `cte(...)`;
  `values(...)` is future work). It does not take a bare `Query`.
- `orWhere` stays (`.where(a).where(b).orWhere(c)` is `(a AND b) OR c`). `neq` stays.
- `.first()` and `.last()` are removed from the builder; `reverseOrder` stays.
- `.lock("update" | "share" | "noKeyUpdate" | "keyShare", { skipLocked?, noWait? })`, or
  `.lock(fragment\`...\`)`. No SQL strings.
- `withCte` is a query method only: `from(cte("tree", Category), "t").withCte("tree", q, { recursive: true })`.
- Bulk updates use **`.set(...)`**, an object or a callback returning one:
  `.set({ published: true })`, `.set(({ p }) => ({ views: p.views.add(1) }))`. There is no
  `inc` / `push` / `pull`; arrays get `append` and `remove` expression methods.
- Update and delete queries declare `RETURNING` with **`.returning(...)`**, not `.select()`.
- `parentAs` is replaced by `outerRef("u", User)`.
- **Future work, not in the first release:** lateral joins, `VALUES` sources,
  table-valued fragments, index hints, data-modifying CTEs, named server-side prepared
  statements, `sortParam` / `dropParam` / index-keyed form params.

### Repo reads (step 12)

- Short names stay: `all`, `one`, `get`, `getBy`. Added: `repo.first(q)` (adds `LIMIT 1`,
  returns `R | null`) and `repo.count(q)`.
- Named parameters and options stay separate arguments: `repo.all(q, opts?)` when the
  query has none, `repo.all(q, params, opts?)` when it has.
- `repo.query` is renamed `repo.raw`. The per-call `telemetry` option is renamed `context`.

### Changesets (steps 05, 06)

- A new-record changeset has `cs.data === null` and `cs.model` (the class); `getField`
  falls back to field defaults. `applyChanges()` exists only for changesets of loaded rows.
- `.validate()` keeps **every** issue by default; `scope: "changed"` is the opt-in.
- `cast` adds `can't be blank` when a non-nullable field is set to `null`, and
  `repo.insert` returns the same error for a required field with no value.
- `unsafeValidateUnique` is renamed `validateUniqueAsync`.
- The default unique-constraint name is `<table>_<cols>_key` (Postgres's own convention),
  and only that. `Constraint.name` is a single string; other names are passed with `{ name }`.
- Placeholders are `{count}`; meta keys are camelCase (`constraintName`).
- The default messages are unchanged (`can't be blank`, `has already been taken`, ...).

### Writes (step 13)

- `insert` takes a changeset only. `insert` returns a `Result`; `insertOrThrow` throws.
  The same for `update`, `delete`, `insertOrUpdate` (name kept).
- `insertAll` applies defaults, timestamps and autogenerated values (it still skips
  validation).
- `updateAll` has no options shorthand; the query carries `.set(...)`.
- Unfiltered `updateAll` / `deleteAll` are allowed; there is no guard.
- One upsert option: `onConflict: "nothing" | { target?, update: "all" | Field[] | { except: Field[] } }`,
  where `target` is `Field[] | { constraint: string } | Fragment`. Throwing is the default
  and has no spelling. `target` is optional because MySQL cannot take one.
- With `onConflict: "nothing"` and a conflict, the result is `{ success: true, data: null }`
  (typed nullable only for that option).

### Preloads (steps 08, 14)

- Forms: the short forms (`"posts"`, arrays, nested objects), the **callback form**
  `preload("posts", (q) => q.where(({ posts }) => ...).orderBy(...).limit(3))`, and the
  join form `{ posts: "p" }`. There is no custom-query form and no `preloadQuery`.
- In a callback the binding is named after the association. `limit` and `offset` are
  **per parent** and require an order (the callback's, or the association's `orderBy`).
- A callback may `select`. The result is then plain objects of that shape, and the select
  **must include the association's key** under its field name, or the query throws
  `QueryError` when built (nothing is added or stripped automatically; many-to-many is
  the exception, since its key is in the join table). Nested preloads and nested writes
  need whole rows.
- Join-form tie-break: a string is a binding alias only when the query has a binding of
  that name joined through that association; otherwise it is a nested association.
- Sibling associations load one at a time by default (`maxConcurrency: 1`).
- `assocLoaded` is renamed `isLoaded`. `repo.preload(rows, "posts", (q) => ...)` takes
  the same callback.

### Nested writes (step 15)

- `putAssoc` / `putEmbed` take plain objects, changesets or loaded rows; `buildAssoc`
  returns a changeset.
- `onReplace`: `"error"` (default) | `"invalid"` | `"setNull"` | `"update"` | `"delete"` | `"deleteIfExists"`.
- To-many params are arrays only.

### Transactions, Batch, sandbox (step 16)

- `Multi` is renamed **`Batch`**: `createBatch()`, run with `repo.transaction(batch)`
  (`repo.transaction` takes a callback or a batch; there is no `repo.transact`).
- A batch failure is `{ step, error, completed }`.
- The sandbox has no `mode: "shared"`.

### Errors and logging (steps 02, 11, 12)

- `EctypeError` → `EgonError`; `AdapterError` → `DatabaseError`; its sub-codes are
  camelCase (`serializationFailure`). `MigrationError` is not exported until step 18.

### Changes to merged code

Done in PR #4: steps 01 and 02 were brought into line with this section (the Egon rename,
`schema`, `Result` as `{ success, data }`, `FieldType`, `fromDb` / `toDb`, `dbGenerated`,
`DatabaseError`, `orderBy`, the dropped association options, `{count}` placeholders,
`created_at` in the fixtures). The step 01 and 02 status notes were removed in the same
PR; the requests they addressed to later steps are now in those step files, under
"Carried over from steps 01 and 02".
