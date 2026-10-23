// Mutation testing of packages/core (step 21, robustness): Stryker, with the core unit tests
// (vitest.mutation.config.ts), over the changeset, query and compiler areas, one Stryker run
// per area so that each gets a score of its own. CPU-heavy: two test processes at a time
// (stryker.config.json); not part of CI on pull requests.
//
//   pnpm test:mutation                     every area
//   pnpm test:mutation compiler query      some of them
//
// Each area writes reports/mutation/<area>.html and .json. The script prints the score of
// every area (killed and timed-out mutants over all mutants that ran or had no coverage)
// and fails when one is under 80%.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const TARGET = 80;

/** Each area's files, without tests and the fixtures that only tests import. */
const AREAS = {
  changeset: ["packages/core/src/changeset/**/*.ts"],
  query: [
    "packages/core/src/query/**/*.ts",
    "!packages/core/src/query/expr-fixtures.ts",
    "!**/test-helpers.ts",
  ],
  compiler: [
    "packages/core/src/compiler/**/*.ts",
    "!packages/core/src/compiler/sql-cases*.ts",
    "!packages/core/src/compiler/sql-fixtures.ts",
    "!packages/core/src/compiler/advanced/advanced-cases.ts",
    "!packages/core/src/compiler/advanced/advanced-queries.ts",
  ],
};
const NOT_SOURCE = ["!**/*.test.ts", "!**/*.test-d.ts", "!**/*.itest.ts"];

const requested = process.argv.slice(2);
const areas = requested.length === 0 ? Object.keys(AREAS) : requested;
for (const area of areas) {
  if (!(area in AREAS)) throw new Error(`unknown area ${area}; one of ${Object.keys(AREAS).join(", ")}`);
}

// The package exports no bin path; its binary is at a fixed place in the root node_modules.
const stryker = `${root}node_modules/@stryker-mutator/core/bin/stryker.js`;

/** Counts the mutants of a Stryker JSON report (mutation-testing-report-schema) by status. */
function tally(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const counts = {};
  for (const file of Object.values(report.files)) {
    for (const mutant of file.mutants) counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
  }
  const detected = (counts.Killed ?? 0) + (counts.Timeout ?? 0);
  const undetected = (counts.Survived ?? 0) + (counts.NoCoverage ?? 0);
  const score = detected + undetected === 0 ? 100 : (100 * detected) / (detected + undetected);
  return { counts, score };
}

const base = JSON.parse(readFileSync(`${root}stryker.config.json`, "utf8"));
mkdirSync(`${root}reports/mutation`, { recursive: true });

const results = [];
for (const area of areas) {
  const json = `reports/mutation/${area}.json`;
  // Stryker's command line cannot set the reporters' file names, so each area gets a
  // configuration file of its own: the shared one, plus the files to mutate and the reports.
  const config = `reports/mutation/${area}.stryker.json`;
  writeFileSync(
    `${root}${config}`,
    `${JSON.stringify(
      {
        ...base,
        $schema: undefined,
        mutate: [...AREAS[area], ...NOT_SOURCE],
        htmlReporter: { fileName: `reports/mutation/${area}.html` },
        jsonReporter: { fileName: json },
      },
      null,
      2,
    )}\n`,
  );
  const run = spawnSync(process.execPath, [stryker, "run", config], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) {
    results.push({ area, error: `stryker exited with ${run.status}` });
    continue;
  }
  results.push({ area, ...tally(`${root}${json}`) });
}

let failed = false;
for (const result of results) {
  if (result.error !== undefined) {
    failed = true;
    console.log(`mutation: ${result.area}: ${result.error}`);
    continue;
  }
  const ok = result.score >= TARGET;
  failed ||= !ok;
  console.log(
    `mutation: ${ok ? "ok  " : "FAIL"} ${result.area}: ${result.score.toFixed(2)}% ${JSON.stringify(result.counts)}`,
  );
}
if (failed) process.exitCode = 1;
