// The checked source of the example in packages/mysql/README.md.
// scripts/check-release-config.mjs checks that the README's copy is this region.
// #region example
import { mysql } from "@egon-orm/mysql";
import { createRepo, from, Schema, t } from "egon-orm";

class Order extends Schema("orders", {
  id: t.integer().primaryKey().dbGenerated(),
  total: t.integer(),
}) {}

const repo = createRepo({
  adapter: mysql({ connectionString: process.env.DATABASE_URL, pool: { max: 10 } }),
});

const large = await repo.all(from(Order, "o").where(({ o }) => o.total.gt(1000)));
await repo.close();

// #endregion example

export { large };
