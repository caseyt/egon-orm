# Egon ORM — notes for coding agents

**Read `docs/plan/README.md` first**, in full, then your step file `docs/plan/NN-*.md`.
The README holds the settled decisions (§2), the target API (§4), the standards (§6–§8)
and the worker protocol including the PR and review loop (§9). `CONTRIBUTING.md` explains
the tooling in more detail.

Egon ORM is a TypeScript ORM: schemas, changesets, a composable query builder and a repo.
It emits its own SQL and wraps the database drivers directly (ADR 0003). Ecto is the design reference for behaviour, but it is
not how the library is presented: users come from Drizzle, Sequelize and Prisma (plan
README §8, §11).

## Commands

```sh
pnpm i
pnpm db:up               # Postgres 16 on localhost:54329 (db:up:tier2 adds MySQL on 33069)
pnpm check               # lint + typecheck + unit + type tests + build; must pass before a PR
pnpm test:integration    # *.itest.ts against the databases
pnpm lint                # Biome (pnpm format to fix)
pnpm typecheck           # tsc -b, plus the docs/plan/spikes checks
pnpm test:unit           # *.test.ts with coverage thresholds (95% lines/branches in core, postgres)
pnpm test:types          # *.test-d.ts
pnpm build               # tsup: ESM + .d.ts per package (ESM-only, no CommonJS build)
pnpm lint:packages       # publint + attw on built packages
pnpm smoke               # ESM consumer, plus a CommonJS consumer that require()s the ES modules
pnpm bench [filter]      # benchmarks/micro/*.bench.ts -> benchmarks/results/<git-sha>.json
pnpm docs:dev            # VitePress site (docs:build to build)
pnpm db:down             # stop databases, discard data (db:reset = down + up)

pnpm vitest run --project core:unit path/to/file.test.ts     # one project / one file
```

## Layout

```
packages/core/src        "egon-orm": contracts/ types/ schema/ changeset/ query/ compiler/
                         adapter/ repo/ batch/ errors.ts index.ts (the only public entry point)
packages/core/test/support   test helpers: import from "@egon-orm/test-support"
packages/postgres        "@egon-orm/postgres"
packages/zod             "@egon-orm/zod"
packages/sqlite          "@egon-orm/sqlite"
packages/mysql           "@egon-orm/mysql"
packages/cli             "@egon-orm/cli": the egon command
benchmarks/micro         <area>.bench.ts, one per feature area; harness in benchmarks/src
docs/plan                plan and step specs. Do not edit, except to add status/NN.md
docs/adr                 architecture decision records
docs/site                VitePress; guide pages in guide/, checked example sources in examples/
examples/smoke           ESM consumer + CommonJS consumer that require()s the ES modules
```

## Rules

- Work on `step/NN-short-name` and touch only the paths your step owns; other changes go
  under "Requests" in your status note. Finish with `docs/plan/status/NN.md` and a PR.
- Test file kinds: `*.test.ts` (unit, no database), `*.test-d.ts` (types), `*.itest.ts`
  (integration; take a database with `withDatabase`, never share one between files).
- No default exports, no `any`, no non-null assertions outside tests, no `console` in
  `packages/`, no `@ts-ignore`; `@ts-expect-error` only in type tests.
- Relative imports use the `.js` extension; type-only imports use `import type`.
- Every exported symbol has TSDoc with an `@example`. No Ecto positioning: TSDoc, code
  comments and guide pages never mention Ecto (plan README §8).
- Every literal in generated SQL is a bound parameter. No user value ever reaches SQL text.
- Never add `minimumReleaseAgeExclude` to `pnpm-workspace.yaml` or turn off
  `minimumReleaseAgeStrict`; pnpm adds exclusions by itself when strict mode is off. If a
  release is too new, pin the newest one that passes. `pnpm lint` checks this. More
  generally: never disable, exempt or work around a check without saying so in your status note.
- Stage files by name and read the diff before committing; tools edit config files too.
- Report failures, skipped items and unverified claims plainly.

## Hot-path rules (plan README §7)

Performance is a feature with tests. On anything that runs per query or per row:

- No `Proxy`, no `Object.defineProperty` per row, no `delete`, no spread of row objects.
- Keep object shapes monomorphic: assign every field in the same order, always.
- No per-call closures or arrays where a precomputed table on schema metadata will do.
- Identity `fromDb`/`toDb` functions are skipped by reference check, not called.
- Anything derivable from a schema or a query shape is computed once and cached on it.
- Do not optimise speculatively; write clear code that follows these rules.

**Benchmarks are deferred to step 19** (owner decision, 2026-10-14): feature steps do not
write or run benchmarks or tune against the budgets; a step's benchmark or budget item is
marked "deferred to step 19" and left unticked. Plan README §7.

Budgets step 19 will measure: build a 3-clause query < 1.5 µs; compile with plan-cache hit
< 0.3 µs, cold < 40 µs; hydrate a 10-column row < 150 ns; `cast` + 5 validations on 10
fields < 3 µs; `repo.all` of 1,000 rows < 15% over the raw driver; `repo.insert` < 20% over
the raw driver.

## Toolchain constraints

Node >= 22.12 (decision D14) and pnpm 12; use the versions pinned in `.nvmrc` and
`"packageManager"`. TypeScript is held at 6 because tsup's declaration bundler does not
work with TypeScript 7. See "Dependency versions" in `CONTRIBUTING.md` before bumping it.
`packages/core` has no runtime dependency; do not add one (ADR 0003).
