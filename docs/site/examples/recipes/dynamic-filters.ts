// @run
// The checked source of recipes/dynamic-filters.md. Each `#region` is included in the page by
// name; the rest makes it compile and run (docs:integration checks the `// =>` comments).
// #region setup
import { postgres } from "@egon-orm/postgres";
import { applyAction, cast, createRepo, from, Schema, t } from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  status: t.enum(["draft", "published"]),
  views: t.integer(),
  createdAt: t.timestamp(),
}) {}

// The tables, created by a migration.
const tables = defineMigration({
  up(m) {
    m.createTable("posts", (table) => {
      table.id("id", { type: "integer" });
      table.text("title").notNull();
      table.text("status").notNull();
      table.integer("views").notNull();
      table.timestamptz("created_at").notNull();
    });
  },
  down(m) {
    m.dropTable("posts");
  },
});

/** Creates the tables, in the database that DATABASE_URL names. */
export async function createTables(): Promise<void> {
  const admin = postgres({ connectionString: process.env.DATABASE_URL });
  await createMigrator({
    adapter: admin,
    migrations: [{ version: 1, name: "tables", migration: tables }],
  }).up();
  await admin.close();
}
// #endregion setup

// #region parse
// ?q=launch&status=published&minViews=10&sort=popular&page=2
const filterTypes = {
  q: t.string(),
  status: t.enum(["draft", "published"]),
  minViews: t.integer(),
  sort: t.enum(["newest", "popular"]).default("newest"),
  page: t.integer().default(1),
};

export function parseFilters(search: URLSearchParams) {
  const params = Object.fromEntries(search); // every value is a string; cast converts them
  const changeset = cast({ data: {}, types: filterTypes }, params, [
    "q",
    "status",
    "minViews",
    "sort",
    "page",
  ])
    .validateLength("q", { max: 100 })
    .validateNumber("page", { greaterThan: 0, lessThanOrEqualTo: 1000 });
  return applyAction(changeset, "insert"); // { success: true, data } or the changeset with its errors
}
// #endregion parse

// #region query
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listPosts(search: URLSearchParams, perPage = 20) {
  const parsed = parseFilters(search);
  if (!parsed.success) return { errors: parsed.error.errorMessages() };
  const { q, status, minViews, sort, page } = parsed.data;

  const posts = from(Post, "p")
    .pipe((query) => (q === undefined ? query : query.where(({ p }) => p.title.ilike(`%${escapeLike(q)}%`))))
    .pipe((query) => (status === undefined ? query : query.where({ status })))
    .pipe((query) => (minViews === undefined ? query : query.where(({ p }) => p.views.gte(minViews))))
    .orderBy(({ p }) =>
      sort === "popular" ? [p.views.desc(), p.id.desc()] : [p.createdAt.desc(), p.id.desc()],
    )
    .limit(perPage)
    .offset((page - 1) * perPage);

  return { posts: await repo.all(posts) };
}
// #endregion query

export async function run(): Promise<void> {
  await createTables();
  await repo.insertAll(Post, [
    { title: "Launch day", status: "published", views: 40, createdAt: new Date("2026-10-01T00:00:00Z") },
    { title: "Launch plan", status: "draft", views: 2, createdAt: new Date("2026-10-02T00:00:00Z") },
    { title: "100% done", status: "published", views: 12, createdAt: new Date("2026-10-03T00:00:00Z") },
  ]);

  // #region use
  const found = await listPosts(new URLSearchParams("q=launch&status=published"));
  const invalid = await listPosts(new URLSearchParams("page=0&minViews=lots"));
  // #endregion use
  found.posts?.map((p) => p.title); // => ["Launch day"]
  invalid.errors; // => { minViews: ["is invalid"], page: ["must be greater than 0"] }

  const percent = await listPosts(new URLSearchParams("q=100%"));
  percent.posts?.map((p) => p.title); // => ["100% done"]
  const popular = await listPosts(new URLSearchParams("sort=popular&minViews=10"));
  popular.posts?.map((p) => p.title); // => ["Launch day", "100% done"]

  await repo.close();
}
