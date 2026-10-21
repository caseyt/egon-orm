// #region setup
// test/setup.ts: a Vitest setup file (setupFiles in vitest.config.ts), run before each test
// file. DATABASE_URL points at a database for the tests; this brings its tables up to date
// with the runner `egon migrate` uses, so `npx vitest run` needs no step before it.
import { fileURLToPath } from "node:url";
import { createMigrator } from "egon-orm/migration";
import { afterAll } from "vitest";
import { adapter } from "../src/db.js";

const directory = fileURLToPath(new URL("../src/migrations", import.meta.url));
await createMigrator({ adapter, directory }).up(); // after the first file: nothing to apply

afterAll(() => adapter.close());
// #endregion setup
