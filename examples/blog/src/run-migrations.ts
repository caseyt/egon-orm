// #region run
// src/run-migrations.ts, run with tsx: `npx tsx src/run-migrations.ts`
import { adapter } from "./db.js";
import { migrate } from "./migrate.js";

await migrate(adapter);
await adapter.close();
// #endregion run
