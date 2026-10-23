// Rewrites `export const VERSION` in each package's sources to match its package.json: in
// src/index.ts, or in src/version.ts for a package that keeps it there (@egon-orm/cli, whose
// bin and library entry both read it). Run by `pnpm version-packages` after
// `changeset version`; the unit test beside each index.ts fails if the two ever disagree.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDir = fileURLToPath(new URL("../packages", import.meta.url));
const pattern = /^export const VERSION: string = "[^"]*";$/m;
// The value the TSDoc example above the constant prints.
const example = /^( \* console\.log\(VERSION\); \/\/ )"[^"]*"$/m;

const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

for (const name of packages) {
  const { version } = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8"));
  const candidates = ["index.ts", "version.ts"].map((file) => join(packagesDir, name, "src", file));
  const indexPath = candidates.find((path) => existsSync(path) && pattern.test(readFileSync(path, "utf8")));
  if (indexPath === undefined) {
    console.error(
      `packages/${name}: no \`export const VERSION: string = "…";\` line to update in src/index.ts or src/version.ts`,
    );
    process.exitCode = 1;
    continue;
  }
  const source = readFileSync(indexPath, "utf8");
  const updated = source
    .replace(pattern, `export const VERSION: string = "${version}";`)
    .replace(example, `$1"${version}"`);
  if (updated !== source) {
    writeFileSync(indexPath, updated);
    console.log(`packages/${name}: VERSION = ${version}`);
  }
}
