// Fails when a link in the documentation points at a heading that does not exist. VitePress
// fails the build on a link to a missing page, but not on a missing `#anchor`; this runs
// after the build (`pnpm docs:build`), over the written pages and the built HTML.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./check-docs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "docs/site");
const DIST = join(SITE, ".vitepress/dist");

/** The site-relative links with an anchor in a Markdown text: `[label](/guide/repo#upserts)`. */
export function anchoredLinks(markdown) {
  return [...markdown.matchAll(/\]\((\/[^)#\s]*)#([^)\s]+)\)/g)].map((m) => ({ path: m[1], anchor: m[2] }));
}

function main() {
  if (!existsSync(DIST)) {
    process.stderr.write("check-anchors: build the site first (pnpm docs:build)\n");
    process.exitCode = 1;
    return;
  }
  const problems = [];
  const pages = walk(SITE, (name) => name.endsWith(".md")).filter(
    (f) => !relative(SITE, f).startsWith("api/"),
  );
  for (const page of pages) {
    for (const { path, anchor } of anchoredLinks(readFileSync(page, "utf8"))) {
      const html = path.endsWith("/") ? join(DIST, path, "index.html") : join(DIST, `${path}.html`);
      if (!existsSync(html)) problems.push(`${relative(ROOT, page)}: ${path} is not a page`);
      else if (!readFileSync(html, "utf8").includes(`id="${anchor}"`)) {
        problems.push(`${relative(ROOT, page)}: ${path} has no heading #${anchor}`);
      }
    }
  }
  if (problems.length > 0) {
    process.stderr.write(
      `check-anchors: ${problems.length} broken link(s)\n${problems.map((p) => `  ${p}`).join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
