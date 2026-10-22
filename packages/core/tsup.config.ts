import { defineConfig } from "tsup";

// Build config is shared in spirit across packages; keep them in sync. The differences
// here are the entries and `dts.entry` (below).
//
// The JavaScript is **unbundled**: one output file per source module (`bundle: false`),
// so that an application's bundler keeps only the modules it uses. A bundled dist had to
// keep whole chunks alive for one import (`EgonError` alone cost 187 KB minified). Every
// entry imports the same module files, so the entries share one copy of every class and
// registry (the errors, `Expr`; the sandbox of `egon-orm/testing` recognises a repo made by
// `egon-orm`).
//
// - `dist/index.js`, `dist/migration/index.js`, `dist/testing.js` and
//   `dist/messages/index.js` are the public entries `egon-orm`, `egon-orm/migration`
//   (step 18), `egon-orm/testing` (step 16) and `egon-orm/messages` (step 21a).
// - `dist/internal/index.js` is NOT part of the package's `exports` and is excluded from
//   the published files (package.json). It exists so that benchmarks, which run inside the
//   workspace, can measure the built internal utilities (benchmarks/micro/internal.bench.ts)
//   instead of the sources. The other files of `dist/internal/` are modules the public
//   entries import, and are published.
// - Test-only modules under `src/` (fixtures, SQL cases, test helpers) are not built.
export default defineConfig({
  entry: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/**/*.test-d.ts",
    "!src/**/*.itest.ts",
    "!src/**/test-helpers.ts",
    "!src/**/*-fixtures.ts",
    "!src/**/sql-cases*.ts",
    "!src/compiler/advanced/advanced-cases.ts",
    "!src/compiler/advanced/advanced-queries.ts",
  ],
  bundle: false,
  // ESM only (decision D14): no CommonJS build. A CommonJS project loads the package with
  // `require()` of an ES module, which Node supports from 22.12.
  format: ["esm"],
  target: "node22",
  platform: "node",
  // Keep `node:` specifiers as written: edge runtimes (Workers with `nodejs_compat`)
  // resolve `node:net`, not `net`.
  removeNodeProtocol: false,
  tsconfig: "tsconfig.build.json",
  // tsup 8 injects the deprecated `baseUrl` option into its declaration build, which
  // TypeScript 6 reports as TS5101 unless deprecations are silenced. Build-only; the
  // type-check configs do not carry this.
  //
  // Declarations are bundled per public entry (`dist/index.d.ts`, `dist/migration.d.ts`,
  // `dist/testing.d.ts`, `dist/messages.d.ts`, with shared `dist/*-<hash>.d.ts`).
  // `dist/internal/index.js` needs none (the benchmarks take its types from the sources),
  // and its `export * as expr` made the declaration bundler write namespace aliases such
  // as `type expr_Expr<out T, in P> = Expr<T, P>`: variance annotations on an alias of a
  // class, which tsc rejects with TS2637 in a consumer that checks libraries
  // (`skipLibCheck: false`). examples/smoke/check-types.mjs runs that check.
  dts: {
    entry: {
      index: "src/index.ts",
      migration: "src/migration/index.ts",
      testing: "src/testing.ts",
      messages: "src/messages/index.ts",
    },
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: false,
});
