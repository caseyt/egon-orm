// The checked source of the example in packages/sqlite/README.md.
// scripts/check-release-config.mjs checks that the README's copy is this region.
// #region example
import { sqlite } from "@egon-orm/sqlite";
import { createRepo, from, Schema, t } from "egon-orm";

class Note extends Schema("notes", {
  id: t.integer().primaryKey().dbGenerated(),
  body: t.string(),
}) {}

const repo = createRepo({ adapter: sqlite({ filename: "app.db", pragmas: { journal_mode: "WAL" } }) });

const notes = await repo.all(from(Note, "n").where(({ n }) => n.body.like("%egon%")));
await repo.close();

// #endregion example

export { notes };
