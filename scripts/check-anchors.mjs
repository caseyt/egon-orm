// Fails when a link in the documentation points at a heading that does not exist. VitePress
// fails the build on a link to a missing page, but not on a missing `#anchor`; this runs
// after the build (`pnpm docs:build`), over the written pages and the built HTML. It checks
// site links (`/guide/repo#upserts`), same-page links (`#upserts`) and relative ones
// (`./repo#upserts`, `../guide/repo.md#upserts`).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./check-docs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "docs/site");
const DIST = join(SITE, ".vitepress/dist");

/**
 * The links with an anchor in the Markdown of the page at `page` (its path in the site, such
 * as `guide/repo.md`), each resolved to the site path of the page it points at.
 */
export function anchoredLinks(markdown, page) {
  const base = new URL(`/${page.replace(/\.md$/, "")}`, "https://site.invalid");
  const links = [];
  for (const match of markdown.matchAll(/\]\(([^)\s#]*)#([^)\s]+)\)/g)) {
    const target = match[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // another site
    const path = new URL(target === "" ? base.pathname : target, base).pathname
      .replace(/\.(md|html)$/, "")
      .replace(/\/index$/, "/");
    links.push({ path, anchor: match[2] });
  }
  return links;
}

function main() {
  if (!existsSync(DIST)) {
    process.stderr.write("check-anchors: build the site first (pnpm docs:build)\n");
    process.exitCode = 1;
    return;
  }
  const problems = [];
  const pages = walk(SITE, (name) => name.endsWith(".md")).filter(
    (f) => !relative(SITE, f).startsWith("api/reference/"),
  );
  for (const page of pages) {
    for (const { path, anchor } of anchoredLinks(readFileSync(page, "utf8"), relative(SITE, page))) {
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
