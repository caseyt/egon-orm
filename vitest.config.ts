import { fileURLToPath } from "node:url";
import { defineConfig, type TestProjectConfiguration } from "vitest/config";

/** Every workspace package gets the same three Vitest projects: unit, types, integration. */
const PACKAGES = ["core", "postgres", "zod", "cli", "sqlite", "mysql"] as const;

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** Tests run against package sources, so no build is needed before `pnpm test:*`. */
const alias = {
  // Before "egon-orm": an alias also matches the subpaths of its key, and the first match wins.
  "egon-orm/migration": fromRoot("./packages/core/src/migration/index.ts"),
  "egon-orm": fromRoot("./packages/core/src/index.ts"),
  "@egon-orm/postgres": fromRoot("./packages/postgres/src/index.ts"),
  "@egon-orm/sqlite": fromRoot("./packages/sqlite/src/index.ts"),
  "@egon-orm/mysql": fromRoot("./packages/mysql/src/index.ts"),
  "@egon-orm/zod": fromRoot("./packages/zod/src/index.ts"),
  "@egon-orm/cli": fromRoot("./packages/cli/src/index.ts"),
  // Shared test helpers (not a published package): packages/core/test/support.
  "@egon-orm/test-support": fromRoot("./packages/core/test/support/index.ts"),
};

function projectsFor(pkg: (typeof PACKAGES)[number]): TestProjectConfiguration[] {
  const root = fromRoot(`./packages/${pkg}`);
  return [
    {
      resolve: { alias },
      test: {
        name: `${pkg}:unit`,
        root,
        environment: "node",
        include: ["src/**/*.test.ts", "test/**/*.test.ts"],
      },
    },
    {
      resolve: { alias },
      test: {
        name: `${pkg}:types`,
        root,
        environment: "node",
        include: [],
        typecheck: {
          enabled: true,
          only: true,
          checker: "tsc",
          // `tsc --build`: a package whose tests import another package (through a project
          // reference) needs that package's declarations built first, as on a fresh checkout.
          build: true,
          tsconfig: "./tsconfig.json",
          include: ["src/**/*.test-d.ts", "test/**/*.test-d.ts"],
        },
      },
    },
    {
      resolve: { alias },
      test: {
        name: `${pkg}:integration`,
        root,
        environment: "node",
        include: ["src/**/*.itest.ts", "test/**/*.itest.ts"],
        // Gives the run an id and sweeps leaked test databases before and after it.
        globalSetup: [fromRoot("./packages/core/test/support/global-setup.ts")],
        // Files run in parallel (each owns a database, see test/support/db.ts);
        // tests inside one file run serially.
        fileParallelism: true,
        sequence: { concurrent: false },
        testTimeout: 30_000,
        hookTimeout: 60_000,
      },
    },
  ];
}

/**
 * The two files that prove integration files can run concurrently (step 01 acceptance).
 * They only pass when they overlap in time, which needs two workers, so they are not part
 * of `core:integration`: `parallel.itest.ts` there starts this project in its own Vitest
 * process with exactly two workers. No globalSetup on purpose; the outer run owns the sweep.
 */
const parallelPair: TestProjectConfiguration = {
  resolve: { alias },
  test: {
    name: "core:parallel-pair",
    root: fromRoot("./packages/core"),
    environment: "node",
    include: ["test/support/parallel-*.pair.ts"],
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
};

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [...PACKAGES.flatMap(projectsFor), parallelPair],
    coverage: {
      provider: "v8",
      // Resolved against each project root (packages/<name>), not the repository root.
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.test-d.ts", "**/*.itest.ts", "**/*.d.ts"],
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      thresholds: {
        // README §6: CI enforces 95% lines and branches per package.
        "packages/core/src/**": { lines: 95, branches: 95 },
        "packages/postgres/src/**": { lines: 95, branches: 95 },
        "packages/cli/src/**": { lines: 95, branches: 95 },
      },
    },
  },
});
