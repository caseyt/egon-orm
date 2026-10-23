import { defineConfig } from "tsup";

// Build config is identical across the dialect and zod packages on purpose; keep them in
// sync (packages/core/tsup.config.ts explains the choices).
export default defineConfig({
  // Unbundled: one output file per source module, so that an application's bundler keeps
  // only what it uses.
  entry: ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/*.test-d.ts", "!src/**/*.itest.ts"],
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
  dts: {
    entry: { index: "src/index.ts" },
    compilerOptions: { ignoreDeprecations: "6.0", stripInternal: true },
  },
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: false,
});
