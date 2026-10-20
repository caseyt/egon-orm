// Runs before each test file (vitest.config.ts, project blog:integration): gives the file a
// database of its own, points DATABASE_URL at it before the application is imported, and
// applies the migrations. The sandbox in each file then keeps the tables empty between tests.
import { createTestDatabase } from "@egon-orm/test-support";
import { afterAll } from "vitest";

const handle = await createTestDatabase("postgres", { label: "blog" });
process.env.DATABASE_URL = handle.db.url;

const { adapter } = await import("../src/db.js");
const { migrate } = await import("../src/migrate.js");
await migrate(adapter);

afterAll(async () => {
  await adapter.close();
  await handle.drop();
});
