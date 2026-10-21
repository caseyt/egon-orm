// Reports the bundle size of the reference app and of subset imports, built with esbuild
// (minified, ESM) from the packed packages, as an application would install them. It
// reports and never fails on a size: budgets are step 19's. Run after `pnpm build`:
//
//   node scripts/size-report.mjs          a Markdown table on stdout
//   node scripts/size-report.mjs <root>   the same for the built packages of another checkout
//
// `pg` is left external (an application bundles its own driver, and a Worker gets it from
// the runtime's Node compatibility layer).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const { build } = require(require.resolve("esbuild", { paths: [require.resolve("tsup")] }));

/** What is measured: a name and the entry module's source. */
export const CASES = [
  {
    name: "reference app (a table, an insert, a select with where/orderBy/limit)",
    source: `
import { change, createRepo, from, Schema, t } from "egon-orm";
import { postgres } from "@egon-orm/postgres";
export class Note extends Schema("notes", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  stars: t.integer().default(0),
}) {}
export async function run(url) {
  const repo = createRepo({ adapter: postgres({ connectionString: url }) });
  await repo.insertOrThrow(change(Note, { title: "a", stars: 3 }));
  const rows = await repo.all(from(Note, "n").where(({ n }) => n.stars.gte(1)).orderBy(({ n }) => n.id.desc()).limit(10));
  await repo.close();
  return rows;
}`,
  },
  {
    name: "schemas only",
    source: `
import { Schema, t } from "egon-orm";
export class Note extends Schema("notes", { id: t.integer().primaryKey(), title: t.string() }) {}`,
  },
  {
    name: "cast",
    source: `
import { cast, Schema, t } from "egon-orm";
class Note extends Schema("notes", { id: t.integer().primaryKey(), title: t.string() }) {}
export const changeset = (params) => cast(Note, params, ["title"]).validateRequired(["title"]);`,
  },
  {
    name: "query only",
    source: `
import { from, Schema, t } from "egon-orm";
class Note extends Schema("notes", { id: t.integer().primaryKey(), stars: t.integer() }) {}
export const query = from(Note, "n").where(({ n }) => n.stars.gte(1)).limit(10);`,
  },
  { name: "EgonError only", source: `export { EgonError } from "egon-orm";` },
  {
    name: "egon-orm/messages (the full text, opt-in)",
    source: `export { explain, messages } from "egon-orm/messages";`,
  },
];

/** Packs a package and unpacks it into `modules/<name>`. */
function install(dir, modules, name) {
  const packs = join(modules, "..", "packs");
  mkdirSync(packs, { recursive: true });
  execFileSync("pnpm", ["pack", "--pack-destination", packs], { cwd: join(root, dir), stdio: "ignore" });
  const tarball = readdirSync(packs).find((file) => file.startsWith(name.replace("@", "").replace("/", "-")));
  if (tarball === undefined) throw new Error(`pnpm pack wrote no tarball for ${name}`);
  const target = join(modules, name);
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", join(packs, tarball), "-C", target, "--strip-components", "1"]);
  rmSync(join(packs, tarball));
}

/** The sizes, in bytes, of each case: minified, and minified then gzipped. */
export async function measure() {
  const work = mkdtempSync(join(tmpdir(), "egon-size-"));
  try {
    const modules = join(work, "node_modules");
    install("packages/core", modules, "egon-orm");
    install("packages/postgres", modules, "@egon-orm/postgres");
    const results = [];
    for (const [i, { name, source }] of CASES.entries()) {
      const entry = join(work, `entry-${i}.mjs`);
      writeFileSync(entry, source);
      // An entry the packages do not have (egon-orm/messages, before 21a) is reported as such.
      const out = await build({
        entryPoints: [entry],
        absWorkingDir: work,
        bundle: true,
        minify: true,
        format: "esm",
        platform: "neutral",
        mainFields: ["module", "main"],
        target: "es2022",
        // "net" and "tls": a build from before 21a wrote them without node:, which this reports on.
        external: ["pg", "pg-cursor", "node:*", "net", "tls"],
        write: false,
        logLevel: "silent",
      }).catch(() => undefined);
      const code = out?.outputFiles[0]?.contents;
      results.push({ name, min: code?.length, gzip: code === undefined ? undefined : gzipSync(code).length });
    }
    return results;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const kb = (bytes) => (bytes === undefined ? "(no such entry)" : `${(bytes / 1024).toFixed(1)} KB`);
  const rows = await measure();
  const lines = [
    "| Bundle (esbuild, minified, `pg` external) | min | gzip |",
    "|---|---:|---:|",
    ...rows.map((row) => `| ${row.name} | ${kb(row.min)} | ${kb(row.gzip)} |`),
  ];
  console.log(lines.join("\n"));
}
