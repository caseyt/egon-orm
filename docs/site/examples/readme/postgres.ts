// The checked source of the example in packages/postgres/README.md.
// scripts/check-release-config.mjs checks that the README's copy is this region.
// #region example
import { postgres } from "@egon-orm/postgres";
import { createRepo, from, Schema, t } from "egon-orm";

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
}) {}

const repo = createRepo({
  adapter: postgres({ connectionString: process.env.DATABASE_URL, pool: { max: 10 } }),
});

const latest = await repo.all(
  from(Post, "p")
    .orderBy(({ p }) => p.id.desc())
    .limit(10),
);
await repo.close();

// #endregion example

export { latest };
