// Scaffolding shared by the recipe examples (not included in any page): creates the tables
// a runnable recipe needs, in the database DATABASE_URL points at.
import { postgres } from "@egon-orm/postgres";

/** Runs a script of DDL statements without parameters. */
export async function createTables(ddl: string): Promise<void> {
  const adapter = postgres({ connectionString: process.env.DATABASE_URL });
  try {
    await adapter.execute(ddl, []);
  } finally {
    await adapter.close();
  }
}
