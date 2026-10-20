// #region db
// src/db.ts
import { postgres } from "@egon-orm/postgres";
import { createRepo } from "egon-orm";

export const adapter = postgres({ connectionString: process.env.DATABASE_URL });
export const repo = createRepo({ adapter });
// #endregion db
