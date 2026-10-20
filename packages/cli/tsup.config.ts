import { defineConfig } from "tsup";

// Build config is identical across packages on purpose; keep them in sync. The one
// difference here is the second entry, `dist/bin.js`: the `egon` executable.
export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
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
  splitting: false,
  treeshake: true,
});
