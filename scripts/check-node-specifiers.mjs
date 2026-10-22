// Fails when a built package imports a Node built-in without the `node:` prefix (`net`
// instead of `node:net`). Edge runtimes with Node compatibility (Cloudflare Workers with
// nodejs_compat) resolve only the prefixed names, and a bundler may otherwise try to
// bundle a package of that name. The tsup configs keep the prefix
// (`removeNodeProtocol: false`); this checks the output. Run after `pnpm build` (CI's
// build job).
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith("_")));
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** The specifiers of `code` that name a built-in without `node:`. */
export function bareBuiltins(code) {
  return [...code.matchAll(IMPORT)].map((m) => m[1]).filter((specifier) => BUILTINS.has(specifier));
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith(".js")) yield path;
  }
}

/** Every bare built-in import in the built packages, as `path: specifier`. */
export function findProblems() {
  const problems = [];
  for (const pkg of readdirSync(join(root, "packages"))) {
    let dist;
    try {
      dist = [...files(join(root, "packages", pkg, "dist"))];
    } catch {
      problems.push(`packages/${pkg}/dist is missing: run pnpm build first`);
      continue;
    }
    for (const path of dist) {
      for (const specifier of bareBuiltins(readFileSync(path, "utf8"))) {
        problems.push(`${relative(root, path)}: imports "${specifier}"; write "node:${specifier}"`);
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = findProblems();
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("ok: every Node built-in in the built packages is imported with node:");
}
