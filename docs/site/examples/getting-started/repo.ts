// #region file
// repo.ts
import { postgres } from "@egon-orm/postgres";
import { createRepo } from "egon-orm";

export const repo = createRepo({
  adapter: postgres({ connectionString: process.env.DATABASE_URL }),
});
// #endregion file
