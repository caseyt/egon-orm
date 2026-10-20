import { defineConfig } from "tsup";

// Build config is identical across packages on purpose; keep them in sync. The one
// difference here is the second entry: `dist/internal.js` is NOT part of the package's
// `exports` (nothing can import it by name) and is excluded from the published files
// (`"!dist/internal.*"` in package.json). It exists so that benchmarks, which run inside
// the workspace, can measure the built internal utilities
// (benchmarks/micro/internal.bench.ts) instead of the sources.
//
// The third entry is the public subpath `egon-orm/migration` (step 18). The entries share
// their modules through chunks (`splitting: true`), so that `egon-orm` and
// `egon-orm/migration` have one copy of every class (the errors, `Expr`) between them.
export default defineConfig({
  entry: { index: "src/index.ts", migration: "src/migration/index.ts", internal: "src/internal/index.ts" },
  // ESM only (decision D14): no CommonJS build. A CommonJS project loads the package with
  // `require()` of an ES module, which Node supports from 22.12.
  format: ["esm"],
  target: "node22",
  platform: "node",
  tsconfig: "tsconfig.build.json",
  // tsup 8 injects the deprecated `baseUrl` option into its declaration build, which
  // TypeScript 6 reports as TS5101 unless deprecations are silenced. Build-only; the
  // type-check configs do not carry this.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
});
