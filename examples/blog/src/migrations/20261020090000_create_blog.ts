// #region migration
// src/migrations/20261020090000_create_blog.ts
import { defineMigration } from "egon-orm/migration";

export const migration = defineMigration({
  up(m) {
    m.createTable("users", (table) => {
      table.id();
      table.text("email").notNull().unique(); //  users_email_key
      table.text("name").notNull();
      table.text("password_hash").notNull();
      table.timestamps();
    });

    m.createTable("posts", (table) => {
      table.id();
      table.references("author_id", "users").notNull(); // posts_author_id_fkey
      table.text("title").notNull();
      table.text("body").notNull();
      table.timestamptz("published_at");
      table.timestamps();
    });

    m.createTable("comments", (table) => {
      table.id();
      table.references("post_id", "posts", { onDelete: "cascade" }).notNull();
      table.text("author_name").notNull();
      table.text("body").notNull();
      table.timestamps();
    });

    // Who follows whom: a reader is told when an author they follow publishes.
    m.createTable("subscriptions", (table) => {
      table.references("reader_id", "users", { onDelete: "cascade" }).notNull().primaryKey();
      table.references("author_id", "users", { onDelete: "cascade" }).notNull().primaryKey();
    });

    m.createTable("notifications", (table) => {
      table.id();
      table.references("user_id", "users", { onDelete: "cascade" }).notNull();
      table.references("post_id", "posts", { onDelete: "cascade" }).notNull();
      table.timestamptz("read_at");
      table.timestamps();
    });
  },

  // The undo: the tables in the reverse order, so that no foreign key points at a dropped one.
  down(m) {
    for (const name of ["notifications", "subscriptions", "comments", "posts", "users"]) {
      m.dropTable(name);
    }
  },
});
// #endregion migration
