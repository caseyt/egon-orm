// @run
// The checked source of recipes/enums.md. Each `#region` is included in the page by name;
// the rest makes it compile and run (docs:integration checks the `// =>` comments).
import { postgres } from "@egon-orm/postgres";
import { cast, createRepo, from, Schema, t } from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";

const adapter = postgres({ connectionString: process.env.DATABASE_URL });
const repo = createRepo({ adapter });

// #region schema
export const STATUSES = ["draft", "review", "published"] as const;

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  status: t.enum(STATUSES).default("draft"), //          text: "draft" | "review" | "published"
  priority: t.enum({ low: 1, normal: 2, high: 3 }).default("normal"), // integer, read as its key
}) {
  static changeset(post: Post | typeof Post, params: unknown) {
    return cast(post, params, ["status", "priority"]);
  }
}

export type Status = Post["status"]; // "draft" | "review" | "published"
// #endregion schema

// #region migration
export const posts = defineMigration({
  change(m) {
    m.createTable("posts", (t) => {
      t.id("id", { type: "integer" });
      t.enumText("status", STATUSES).notNull().default("draft"); // text with posts_status_check
      t.integer("priority").notNull().default(2);
    });
  },
});
// #endregion migration

export async function run(): Promise<void> {
  await createMigrator({ adapter, migrations: [{ version: 1, name: "posts", migration: posts }] }).up();

  // #region use
  const invalid = Post.changeset(Post, { status: "archived" });
  invalid.errorMessages(); // => { status: ["is invalid"] }

  const urgent = await repo.insertOrThrow(Post.changeset(Post, { status: "review", priority: "high" }));
  urgent.priority; // => "high"

  const waiting = await repo.all(
    from(Post, "p").where(({ p }) => p.status.in(["draft", "review"]).and(p.priority.eq("high"))),
  );
  // #endregion use
  waiting.length; // => 1

  await adapter.close();
}
