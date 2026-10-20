import { readFileSync } from "node:fs";
import { type DefaultTheme, defineConfig } from "vitepress";

const siteRoot = new URL("../", import.meta.url);

// The slugify VitePress uses for heading anchors (minus control characters, which a
// heading line cannot hold), so the links below match.
const slugify = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "_$1")
    .toLowerCase();

// The text VitePress slugs: inline code keeps its content, links keep their label.
const headingText = (raw: string): string =>
  raw
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/g, "$2")
    .trim();

/** The `##` headings of a page, outside code fences, as sidebar links to their anchors. */
function headingItems(link: string): DefaultTheme.SidebarItem[] {
  const file = link.endsWith("/") ? `${link.slice(1)}index.md` : `${link.slice(1)}.md`;
  const source = readFileSync(new URL(file, siteRoot), "utf8");
  const items: DefaultTheme.SidebarItem[] = [];
  const seen = new Map<string, number>();
  let fence: string | undefined;
  for (const line of source.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch?.[1] !== undefined) {
      const marker = fenceMatch[1];
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    const heading = fence === undefined ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading?.[1] === undefined) continue;
    const custom = /\s*\{#([^}]+)\}$/.exec(heading[1]);
    const text = headingText(custom ? heading[1].slice(0, custom.index) : heading[1]);
    let slug = custom?.[1] ?? slugify(text);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    if (count > 0) slug = `${slug}-${count}`;
    items.push({ text, link: `${link}#${slug}` });
  }
  return items;
}

/** A sidebar entry for a page that expands to its headings while the page is open. */
function page(text: string, link: string): DefaultTheme.SidebarItem {
  const items = headingItems(link);
  return items.length === 0 ? { text, link } : { text, link, collapsed: true, items };
}

const base = process.env.DOCS_BASE ?? "/";

// Step 20 owns the theme and the tooling of this site; the guide pages live under guide/.
export default defineConfig({
  title: "Egon ORM",
  description: "A TypeScript ORM with schemas, changesets, composable queries and a repo, typed end to end.",
  // Set DOCS_BASE (e.g. "/ectype-orm/") when the site is served from a sub-path.
  base,
  cleanUrls: true,
  lastUpdated: true,
  // Checked example sources live beside the pages but are not pages themselves.
  srcExclude: ["examples/**"],
  // VitePress does not prefix `head` links with the base, so it is added here.
  head: [
    ["link", { rel: "icon", href: `${base}favicon.ico`, sizes: "48x48" }],
    [
      "link",
      { rel: "icon", type: "image/png", href: `${base}favicon.png`, media: "(prefers-color-scheme: light)" },
    ],
    [
      "link",
      {
        rel: "icon",
        type: "image/png",
        href: `${base}favicon-dark.png`,
        media: "(prefers-color-scheme: dark)",
      },
    ],
    ["link", { rel: "apple-touch-icon", href: `${base}apple-touch-icon.png` }],
  ],
  themeConfig: {
    logo: { light: "/logo.png", dark: "/logo-dark.png", alt: "Egon ORM" },
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Reference", link: "/reference/errors" },
      { text: "API", link: "/api/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Start here",
          items: [page("Introduction", "/guide/"), page("Getting started", "/guide/getting-started")],
        },
        {
          text: "Modelling data",
          items: [
            page("Schemas", "/guide/schemas"),
            page("Types", "/guide/types"),
            page("Associations and preloading", "/guide/associations"),
            page("Embeds", "/guide/embeds"),
          ],
        },
        {
          text: "Changing data",
          items: [
            page("Changesets", "/guide/changesets"),
            page("Validation", "/guide/validation"),
            page("Constraints", "/guide/constraints"),
            page("Nested changesets", "/guide/nested-changesets"),
          ],
        },
        {
          text: "Querying data",
          items: [
            page("Queries", "/guide/queries"),
            page("Expressions", "/guide/query-expressions"),
            page("Advanced queries", "/guide/queries-advanced"),
          ],
        },
        {
          text: "The repo",
          items: [
            page("Repo: setup, reads, writes", "/guide/repo"),
            page("Transactions", "/guide/transactions"),
            page("Batch", "/guide/batch"),
            page("Adapters", "/guide/adapters"),
            page("Testing", "/guide/testing"),
          ],
        },
        {
          text: "Changing the database",
          items: [page("Migrations", "/guide/migrations")],
        },
        {
          text: "Examples",
          items: [page("Overview", "/guide/examples")],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            page("Errors", "/reference/errors"),
            page("CLI", "/reference/cli"),
            page("Dialect support", "/reference/dialect-support"),
            page("Roadmap", "/reference/roadmap"),
          ],
        },
      ],
      "/api/": [{ text: "API reference", items: [page("Overview", "/api/")] }],
    },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/caseyt/ectype-orm" }],
  },
});
