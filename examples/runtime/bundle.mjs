// The runtime matrix, bundled: esm.mjs and cjs.cjs bundled with esbuild (packages, pg and
// all, into one file each, as an application would ship), then run. better-sqlite3 stays
// external: it is a native module. Run `pnpm build` first.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = fileURLToPath(new URL("./dist/", import.meta.url));
rmSync(out, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  // pg-native is an optional dependency of pg that is never installed here.
  external: ["better-sqlite3", "pg-native"],
  logLevel: "warning",
  absWorkingDir: here,
  // Not the workspace's tsconfig, whose `paths` point the packages at their sources: the
  // bundles are made from the built packages, as an application's are.
  tsconfigRaw: {},
  metafile: true,
};

/** Every input of a bundle that comes from a package of this repository must be its dist/. */
function checkInputs(result, label) {
  const sources = Object.keys(result.metafile.inputs).filter((input) => /packages\/[^/]+\/src\//.test(input));
  if (sources.length > 0) throw new Error(`${label} bundled package sources: ${sources.join(", ")}`);
}

const esm = await build({
  ...common,
  entryPoints: ["esm.mjs"],
  format: "esm",
  outfile: "dist/esm.bundle.mjs",
  // pg is CommonJS: inside an ES module bundle its require() calls need a require function.
  banner: {
    js: 'import { createRequire as __egonRequire } from "node:module"; const require = __egonRequire(import.meta.url);',
  },
});
checkInputs(esm, "the ESM bundle");
const cjs = await build({
  ...common,
  entryPoints: ["cjs.cjs"],
  format: "cjs",
  outfile: "dist/cjs.bundle.cjs",
});
checkInputs(cjs, "the CommonJS bundle");

let failed = false;
for (const [file, label] of [
  ["dist/esm.bundle.mjs", "esbuild esm bundle"],
  ["dist/cjs.bundle.cjs", "esbuild cjs bundle"],
]) {
  try {
    execFileSync(process.execPath, [file], {
      cwd: here,
      stdio: "inherit",
      env: { ...process.env, RUNTIME_LABEL: label },
    });
  } catch {
    failed = true;
  }
}
if (failed) process.exitCode = 1;
