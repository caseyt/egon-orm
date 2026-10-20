import { defineConfig } from "tsup";

// Build config is identical across packages on purpose; keep them in sync. The
// differences here are the entries, `splitting` and `dts.entry` (below):
//
// - `dist/migration.js` and `dist/testing.js` are the public subpaths `egon-orm/migration`
//   (step 18) and `egon-orm/testing` (step 16).
// - `dist/internal.js` is NOT part of the package's `exports` (nothing can import it by
//   name) and is excluded from the published files (`"!dist/internal.*"` in
//   package.json). It exists so that benchmarks, which run inside the workspace, can
//   measure the built internal utilities (benchmarks/micro/internal.bench.ts) instead of
//   the sources.
// - `splitting: true`, because there is more than one entry: the code they share goes into
//   shared chunks (`dist/chunk-*.js`, and `dist/*-<hash>.d.ts` for the declarations), so
//   that the entries use one copy of every class and registry between them (the errors,
//   `Expr`; the sandbox of `egon-orm/testing` recognises a repo made by `egon-orm`).
export default defineConfig({
  entry: {
    index: "src/index.ts",
    migration: "src/migration/index.ts",
    testing: "src/testing.ts",
    internal: "src/internal/index.ts",
  },
  // ESM only (decision D14): no CommonJS build. A CommonJS project loads the package with
  // `require()` of an ES module, which Node supports from 22.12.
  format: ["esm"],
  target: "node22",
  platform: "node",
  tsconfig: "tsconfig.build.json",
  // tsup 8 injects the deprecated `baseUrl` option into its declaration build, which
  // TypeScript 6 reports as TS5101 unless deprecations are silenced. Build-only; the
  // type-check configs do not carry this.
  //
  // Declarations are built for the public entries only. `dist/internal.js` needs none (the
  // benchmarks take its types from the sources), and its `export * as expr` made the
  // declaration bundler write namespace aliases such as `type expr_Expr<out T, in P> =
  // Expr<T, P>` into the shared chunk: variance annotations on an alias of a class, which
  // tsc rejects with TS2637 in a consumer that checks libraries (`skipLibCheck: false`).
  // examples/smoke/check-types.mjs runs that check.
  dts: {
    entry: { index: "src/index.ts", migration: "src/migration/index.ts", testing: "src/testing.ts" },
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  sourcemap: true,
  clean: true,
  splitting: true, // see above
  treeshake: true,
});
