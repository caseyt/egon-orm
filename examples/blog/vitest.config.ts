// #region config
// vitest.config.ts: the blog's tests are test/*.itest.ts, and test/setup.ts runs before each
// file. Run them with DATABASE_URL pointing at the test database: npx vitest run
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.itest.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
// #endregion config
// (In this repository, the root vitest.config.ts runs these tests instead, as the project
// blog:integration, with a database per test file; this file is what a project of its own
// uses.)
