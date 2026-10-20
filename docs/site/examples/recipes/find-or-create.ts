// @run
// The checked source of recipes/find-or-create.md. Each `#region` is included in the page by
// name; the rest makes it compile and run (docs:integration checks the `// =>` comments).
import { postgres } from "@egon-orm/postgres";
import { cast, createRepo, type Repo, Schema, t } from "egon-orm";
import { createTables } from "./support.js";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

class Tag extends Schema("tags", {
  id: t.integer().primaryKey().dbGenerated(),
  name: t.string(),
}) {
  static changeset(tag: Tag | typeof Tag, params: unknown) {
    return cast(tag, params, ["name"])
      .validateRequired(["name"])
      .updateChange("name", (name) => name.trim().toLowerCase())
      .uniqueConstraint("name");
  }
}

// #region find-or-create
// Safe under concurrency: the unique index decides, and a lost race reads the winner's row.
export async function findOrCreateTag(db: Repo, name: string): Promise<Tag> {
  const changeset = Tag.changeset(Tag, { name });
  const inserted = await db.insertOrThrow(changeset, { onConflict: "nothing" }); // null on a conflict
  return inserted ?? (await db.getByOrThrow(Tag, { name: changeset.getField("name") }));
}
// #endregion find-or-create

export async function run(): Promise<void> {
  await createTables("create table tags (id serial primary key, name text not null unique)");

  // #region use
  const first = await findOrCreateTag(repo, "TypeScript");
  const again = await findOrCreateTag(repo, " typescript "); // the same tag
  // #endregion use
  again.id === first.id; // => true
  first.name; // => "typescript"

  const together = await Promise.all(["Rust", "rust", "RUST"].map((name) => findOrCreateTag(repo, name)));
  new Set(together.map((tag) => tag.id)).size; // => 1
  await repo.count(Tag); // => 2

  await repo.close();
}
