// The blog schema of fixtures/blog.sql, written as five migrations. The suite applies them,
// rolls them back and applies them again, and the repo's writes run against the result.
import { defineMigration, type MigrationSource } from "egon-orm/migration";

export const BLOG_MIGRATIONS: readonly MigrationSource[] = [
  {
    version: 20260110090000,
    name: "create_users",
    migration: defineMigration({
      up(m) {
        m.createTable("users", (t) => {
          t.id();
          t.text("email").notNull();
          t.text("name");
          t.integer("age");
          t.enumText("role", ["admin", "member"]).notNull().default("member");
          t.text("password_hash");
          t.jsonb("settings");
          t.integer("lock_version").notNull().default(1);
          t.timestamps();
        });
        m.createIndex("users", ["email"], { unique: true });
      },
      down(m) {
        m.dropIndex("users", ["email"], { unique: true });
        m.dropTable("users");
      },
    }),
  },
  {
    version: 20260110090100,
    name: "create_profiles_and_orgs",
    migration: defineMigration({
      up(m) {
        m.createTable("profiles", (t) => {
          t.id();
          t.references("user_id", "users", { onDelete: "cascade" }).notNull().unique();
          t.text("bio");
          t.text("avatar_url");
        });
        m.createTable("orgs", (t) => {
          t.uuid("id").primaryKey();
          t.text("name").notNull();
        });
      },
      down(m) {
        m.dropTable("orgs");
        m.dropTable("profiles");
      },
    }),
  },
  {
    version: 20260110090200,
    name: "create_posts_and_tags",
    migration: defineMigration({
      up(m) {
        m.createTable("posts", (t) => {
          t.id();
          t.references("author_id", "users").notNull();
          t.text("title").notNull();
          t.text("body");
          t.boolean("published").default(false);
          t.integer("views").default(0);
          t.array("tags", "text");
          t.timestamptz("published_at");
          t.timestamps();
        });
        m.createIndex("posts", ["author_id"]);
        m.createTable("tags", (t) => {
          t.id();
          t.text("name").unique();
        });
        m.createTable("posts_tags", (t) => {
          t.references("post_id", "posts", { onDelete: "cascade" }).notNull().primaryKey();
          t.references("tag_id", "tags", { onDelete: "cascade" }).notNull().primaryKey();
        });
      },
      down(m) {
        m.dropTable("posts_tags");
        m.dropTable("tags");
        m.dropIndex("posts", ["author_id"]);
        m.dropTable("posts");
      },
    }),
  },
  {
    version: 20260110090300,
    name: "create_comments",
    migration: defineMigration({
      up(m) {
        m.createTable("comments", (t) => {
          t.id();
          t.references("post_id", "posts", { onDelete: "cascade" }).notNull();
          t.references("author_id", "users");
          t.text("body").notNull();
          t.timestamptz("created_at").notNull();
        });
        m.createIndex("comments", ["post_id"]);
        m.createIndex("comments", ["author_id"]);
      },
      down(m) {
        m.dropTable("comments");
      },
    }),
  },
  {
    version: 20260110090400,
    name: "create_memberships",
    migration: defineMigration({
      up(m) {
        m.createTable("memberships", (t) => {
          t.references("org_id", "orgs", { type: "uuid", onDelete: "cascade" }).notNull().primaryKey();
          t.references("user_id", "users", { onDelete: "cascade" }).notNull().primaryKey();
          t.text("role").notNull().default("member");
        });
      },
      down(m) {
        m.dropTable("memberships");
      },
    }),
  },
];

/** The tables the blog migrations create, sorted. */
export const BLOG_TABLES: readonly string[] = [
  "comments",
  "memberships",
  "orgs",
  "posts",
  "posts_tags",
  "profiles",
  "tags",
  "users",
];
