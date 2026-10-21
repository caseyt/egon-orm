// #region migrate
// src/migrate.ts
import { fileURLToPath } from "node:url";
import type { DatabaseAdapter } from "egon-orm";
import { createMigrator } from "egon-orm/migration";

export async function migrate(adapter: DatabaseAdapter): Promise<void> {
  const migrator = createMigrator({
    adapter,
    directory: fileURLToPath(new URL("./migrations", import.meta.url)),
  });
  await migrator.up(); // applies every pending migration, each in its own transaction
}
// #endregion migrate
