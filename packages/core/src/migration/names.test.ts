// The names a migration gives its indexes and constraints are the names the changeset
// constraint functions expect by default. The conformance suite checks the same pairing
// end to end (a duplicate insert becomes a changeset error).
import { Comment, Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { cast, change } from "../changeset/index.js";
import { MigrationBuilder } from "./builder.js";
import type { CreateTableOp, Operation } from "./types.js";

function recorded(define: (m: MigrationBuilder) => void): readonly Operation[] {
  const m = new MigrationBuilder(63);
  define(m);
  return m.operations;
}

describe("migration names pair with changeset defaults", () => {
  test("a unique index on one column is what uniqueConstraint(field) looks for", () => {
    const [index] = recorded((m) => m.createIndex("users", ["email"], { unique: true }));
    const cs = cast(User, { email: "a@b.c" }, ["email"]).uniqueConstraint("email");
    expect(index?.op === "createIndex" && index.index.name).toBe(cs.constraints[0]?.name);
  });

  test("a unique column constraint is too", () => {
    const [table] = recorded((m) => m.createTable("users", (t) => t.text("email").primaryKey().unique()));
    const cs = cast(User, {}, []).uniqueConstraint("email");
    expect((table as CreateTableOp).columns[0]?.unique).toBe(cs.constraints[0]?.name);
  });

  test("a unique index on several columns is what uniqueConstraint([fields]) looks for", () => {
    const [index] = recorded((m) => m.createIndex("posts", ["author_id", "title"], { unique: true }));
    const cs = cast(Post, {}, []).uniqueConstraint(["authorId", "title"]);
    expect(index?.op === "createIndex" && index.index.name).toBe(cs.constraints[0]?.name);
  });

  test("references() is what foreignKeyConstraint, assocConstraint and noAssocConstraint look for", () => {
    const [comments] = recorded((m) =>
      m.createTable("comments", (t) => {
        t.id();
        t.references("post_id", "posts", { onDelete: "cascade" });
      }),
    );
    const fkey = (comments as CreateTableOp).columns[1]?.references?.name;
    expect(fkey).toBe("comments_post_id_fkey");
    expect(cast(Comment, {}, []).foreignKeyConstraint("postId").constraints[0]?.name).toBe(fkey);
    const [posts] = recorded((m) =>
      m.createTable("posts", (t) => {
        t.id();
        t.references("author_id", "users");
      }),
    );
    const authorKey = (posts as CreateTableOp).columns[1]?.references?.name;
    expect(cast(Post, {}, []).assocConstraint("author").constraints[0]?.name).toBe(authorKey);
    expect(change(User, {}).noAssocConstraint("posts").constraints[0]?.name).toBe(authorKey);
  });
});
