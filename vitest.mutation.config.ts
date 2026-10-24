import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";
import workspace from "./vitest.config.js";

/**
 * Step 21: the Vitest configuration mutation testing runs (stryker.config.json,
 * `pnpm test:mutation`): the `core:unit` project of vitest.config.ts and nothing else,
 * without coverage, which Stryker measures itself.
 */
const coreUnit = (workspace.test?.projects ?? []).find(
  (project): project is TestProjectInlineConfiguration =>
    typeof project === "object" &&
    project !== null &&
    "test" in project &&
    project.test?.name === "core:unit",
);
if (coreUnit === undefined) throw new Error("vitest.config.ts has no core:unit project");

export default defineConfig({
  ...coreUnit,
  test: { ...coreUnit.test, name: "core:mutation" },
});
