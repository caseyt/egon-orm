import { existsSync, readFileSync } from "node:fs";
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

/**
 * The sidebar of the API reference, which TypeDoc writes with the pages (`pnpm docs:api`,
 * run by `docs:build` and `docs:dev`). Empty before the first run.
 */
function apiSidebar(): DefaultTheme.SidebarItem[] {
  const file = new URL("api/reference/typedoc-sidebar.json", siteRoot);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as DefaultTheme.SidebarItem[]) : [];
}

const base = process.env.DOCS_BASE ?? "/";

// Step 20 owns the theme and the tooling of this site; the guide pages live under guide/.
export default defineConfig({
  title: "Egon ORM",
  description: "A TypeScript ORM with schemas, changesets, composable queries and a repo, typed end to end.",
  // Set DOCS_BASE (e.g. "/egon-orm/") when the site is served from a sub-path.
  base,
  cleanUrls: true,
  lastUpdated: true,
  // Generated pages have no source to edit: the API reference (TypeDoc) and the index of
  // exports (scripts/api-index.ts). They get no edit link.
  transformPageData(pageData) {
    if (
      pageData.relativePath.startsWith("api/reference/") ||
      pageData.relativePath === "reference/exports.md"
    ) {
      pageData.frontmatter.editLink = false;
    }
  },
  // Checked example sources live beside the pages but are not pages themselves.
  srcExclude: ["examples/**", "test/**"],
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
      { text: "Tutorial", link: "/guide/tutorial" },
      { text: "Recipes", link: "/recipes/" },
      { text: "Reference", link: "/reference/errors" },
      { text: "API", link: "/api/" },
      { text: "Internals", link: "/internals/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Start here",
          items: [
            page("Introduction", "/guide/"),
            page("Getting started", "/guide/getting-started"),
            page("Tutorial: a blog", "/guide/tutorial"),
          ],
        },
        {
          text: "Coming from",
          items: [
            page("Prisma", "/guide/coming-from-prisma"),
            page("Drizzle", "/guide/coming-from-drizzle"),
            page("Sequelize", "/guide/coming-from-sequelize"),
          ],
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
          text: "In an application",
          items: [
            page("Framework integration", "/guide/frameworks"),
            page("FAQ and troubleshooting", "/guide/faq"),
            { text: "Recipes", link: "/recipes/" },
          ],
        },
      ],
      "/recipes/": [
        { text: "Recipes", items: [{ text: "Overview", link: "/recipes/" }] },
        {
          text: "Reading",
          items: [
            page("Pagination", "/recipes/pagination"),
            page("Top N per parent", "/recipes/top-n-per-parent"),
            page("Filters from a query string", "/recipes/dynamic-filters"),
            page("Full-text search", "/recipes/full-text-search"),
          ],
        },
        {
          text: "Writing",
          items: [
            page("Upserts", "/recipes/upserts"),
            page("Find or create", "/recipes/find-or-create"),
            page("Optimistic locking", "/recipes/optimistic-locking"),
            page("Soft deletes", "/recipes/soft-deletes"),
            page("Auditing", "/recipes/auditing"),
          ],
        },
        {
          text: "Modelling",
          items: [
            page("Enums", "/recipes/enums"),
            page("Money", "/recipes/money"),
            page("Multi-tenancy", "/recipes/multi-tenancy"),
          ],
        },
        {
          text: "Forms and messages",
          items: [
            page("Showing form errors (React)", "/recipes/form-errors"),
            page("Translating error messages", "/recipes/translating-errors"),
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            page("Errors", "/reference/errors"),
            page("Configuration", "/reference/configuration"),
            page("CLI", "/reference/cli"),
            page("Dialect support", "/reference/dialect-support"),
            page("Glossary", "/reference/glossary"),
            page("Index of exports", "/reference/exports"),
          ],
        },
        {
          text: "Project",
          items: [
            page("Roadmap", "/reference/roadmap"),
            page("Changelog", "/reference/changelog"),
            page("Upgrading", "/reference/upgrading"),
          ],
        },
      ],
      "/internals/": [
        {
          text: "Internals",
          items: [
            page("Architecture", "/internals/"),
            page("How a query becomes SQL", "/internals/compiler"),
            page("Extending Egon", "/internals/extending"),
          ],
        },
      ],
      "/api/": [{ text: "API reference", items: [{ text: "Overview", link: "/api/" }, ...apiSidebar()] }],
    },
    search: {
      provider: "local",
      options: {
        // The generated API pages are left out of the index: with them it is several
        // megabytes, downloaded on the first search. The guide and reference pages, which
        // mention every export, are searched.
        _render(src, env, md) {
          const html = md.render(src, env);
          return env.relativePath.startsWith("api/reference/") ? "" : html;
        },
      },
    },
    editLink: {
      pattern: "https://github.com/caseyt/egon-orm/edit/main/docs/site/:path",
      text: "Edit this page on GitHub",
    },
    socialLinks: [{ icon: "github", link: "https://github.com/caseyt/egon-orm" }],
  },
});
