// #region factory
// test/factories.ts: test data as plain functions. insertOrThrow makes a broken fixture
// fail loudly.
import { change } from "egon-orm";
import { repo } from "../src/db.js";
import { Post, User } from "../src/schemas.js";

export function insertUser(name: string) {
  return repo.insertOrThrow(
    change(User, { email: `${name.toLowerCase()}@example.com`, name, passwordHash: "x" }),
  );
}

export function insertPost(author: User, title: string, publishedAt: Date | null = new Date()) {
  return repo.insertOrThrow(change(Post, { authorId: author.id, title, body: `${title}.`, publishedAt }));
}
// #endregion factory
