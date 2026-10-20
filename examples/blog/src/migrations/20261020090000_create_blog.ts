// #region migration
// src/migrations/20261020090000_create_blog.ts
import { defineMigration } from "egon-orm/migration";

export const migration = defineMigration({
  change(m) {
    m.createTable("users", (t) => {
      t.id();
      t.text("email").notNull().unique(); //  users_email_key
      t.text("name").notNull();
      t.text("password_hash").notNull();
      t.timestamps();
    });

    m.createTable("posts", (t) => {
      t.id();
      t.references("author_id", "users").notNull(); // posts_author_id_fkey
      t.text("title").notNull();
      t.text("body").notNull();
      t.timestamptz("published_at");
      t.timestamps();
    });

    m.createTable("comments", (t) => {
      t.id();
      t.references("post_id", "posts", { onDelete: "cascade" }).notNull();
      t.text("author_name").notNull();
      t.text("body").notNull();
      t.timestamps();
    });

    // Who follows whom: a reader is told when an author they follow publishes.
    m.createTable("subscriptions", (t) => {
      t.references("reader_id", "users", { onDelete: "cascade" }).notNull().primaryKey();
      t.references("author_id", "users", { onDelete: "cascade" }).notNull().primaryKey();
    });

    m.createTable("notifications", (t) => {
      t.id();
      t.references("user_id", "users", { onDelete: "cascade" }).notNull();
      t.references("post_id", "posts", { onDelete: "cascade" }).notNull();
      t.timestamptz("read_at");
      t.timestamps();
    });
  },
});
// #endregion migration
