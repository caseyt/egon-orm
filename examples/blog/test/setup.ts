// #region setup
// test/setup.ts: a Vitest setup file (setupFiles in vitest.config.ts), run before each test
// file. DATABASE_URL points at a database for the tests; this brings its tables up to date.
import { afterAll } from "vitest";
import { adapter } from "../src/db.js";
import { migrate } from "../src/migrate.js";

await migrate(adapter); // nothing to do after the first file: every migration is applied

afterAll(() => adapter.close());
// #endregion setup
