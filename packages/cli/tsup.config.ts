import { defineConfig } from "tsup";

// Build config is identical across packages on purpose; keep them in sync
// (packages/core/tsup.config.ts explains the choices). The difference here: `dist/bin.js`,
// the `egon` executable, is an entry of its own.
export default defineConfig({
  // Unbundled: one output file per source module.
  entry: ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/*.test-d.ts", "!src/**/*.itest.ts"],
  bundle: false,
  // ESM only (decision D14): no CommonJS build. A CommonJS project loads the package with
  // `require()` of an ES module, which Node supports from 22.12.
  format: ["esm"],
  target: "node22",
  platform: "node",
  // Keep `node:` specifiers as written.
  removeNodeProtocol: false,
  tsconfig: "tsconfig.build.json",
  // tsup 8 injects the deprecated `baseUrl` option into its declaration build, which
  // TypeScript 6 reports as TS5101 unless deprecations are silenced. Build-only; the
  // type-check configs do not carry this.
  dts: { entry: { index: "src/index.ts" }, compilerOptions: { ignoreDeprecations: "6.0" } },
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: false,
});
