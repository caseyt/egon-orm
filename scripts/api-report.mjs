// The API report: one file per public entry point under api-report/, written by
// @microsoft/api-extractor from the built declarations (`dist/*.d.ts`). The report is the
// reviewed public surface: a change to it is a public API change and is reviewed as one.
//
//   pnpm api:report   rewrites the reports (builds first)
//   pnpm api:check    fails when a committed report differs from the built declarations,
//                     or on an api-extractor error (run by CI after `pnpm build`)
//
// api-extractor writes each report to temp/api-report/; this script normalises it (below)
// and compares it with, or copies it to, api-report/.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_FOLDER = join(ROOT, "api-report");
const TEMP_FOLDER = join(ROOT, "temp", "api-report");

/** Every public entry point: its package folder and its built declarations. */
export const ENTRY_POINTS = [
  { specifier: "egon-orm", folder: "packages/core", dts: "dist/index.d.ts" },
  { specifier: "egon-orm/testing", folder: "packages/core", dts: "dist/testing.d.ts" },
  { specifier: "egon-orm/migration", folder: "packages/core", dts: "dist/migration.d.ts" },
  { specifier: "egon-orm/messages", folder: "packages/core", dts: "dist/messages.d.ts" },
  { specifier: "@egon-orm/postgres", folder: "packages/postgres", dts: "dist/index.d.ts" },
  { specifier: "@egon-orm/sqlite", folder: "packages/sqlite", dts: "dist/index.d.ts" },
  { specifier: "@egon-orm/mysql", folder: "packages/mysql", dts: "dist/index.d.ts" },
  { specifier: "@egon-orm/zod", folder: "packages/zod", dts: "dist/index.d.ts" },
  { specifier: "@egon-orm/cli", folder: "packages/cli", dts: "dist/index.d.ts" },
];

/** `egon-orm/testing` -> `egon-orm-testing.api.md`, `@egon-orm/zod` -> `egon-orm-zod.api.md`. */
export function reportFileName(specifier) {
  return `${specifier.replace(/^@/, "").replaceAll("/", "-")}.api.md`;
}

/**
 * Findings api-extractor cannot place next to a declaration are listed at the end of the
 * report with their location, `// dist/batch-CjAnxdq6.d.ts:1803:9 - (ae-…) …`. The file
 * name carries the declaration bundler's content hash and the line moves with every edit
 * of a comment, so the location is dropped: the finding itself stays in the report.
 */
export function normalizeReport(text) {
  return text.replace(/^\/\/ \S+\.d\.ts:\d+:\d+ - \(/gm, "// (");
}

async function extract(entry) {
  const { Extractor, ExtractorConfig, ExtractorLogLevel } = await import("@microsoft/api-extractor");
  // Findings that fail the run.
  const FAIL = { logLevel: ExtractorLogLevel.Error, addToApiReportFile: false };
  // Written into the report as a warning comment, so that it is reviewed with the API.
  const REPORT = { logLevel: ExtractorLogLevel.None, addToApiReportFile: true };
  const QUIET = { logLevel: ExtractorLogLevel.None, addToApiReportFile: false };
  const projectFolder = join(ROOT, entry.folder);
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder,
      mainEntryPointFilePath: join(projectFolder, entry.dts),
      bundledPackages: [],
      // The declarations are type-checked when they are built, and by examples/smoke with
      // `skipLibCheck: false`; here the compiler only has to resolve them.
      compiler: {
        overrideTsconfig: {
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            types: ["node"],
            strict: true,
            skipLibCheck: true,
          },
          files: [join(projectFolder, entry.dts)],
        },
      },
      apiReport: {
        enabled: true,
        reportFileName: reportFileName(entry.specifier),
        // api-extractor's own copy; the committed one is compared below.
        reportFolder: TEMP_FOLDER,
        reportTempFolder: join(TEMP_FOLDER, "work"),
        // Types the public API uses but no entry point exports are written out in full, so
        // a change to one is a report change too.
        includeForgottenExports: true,
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      newlineKind: "lf",
      messages: {
        compilerMessageReporting: { default: FAIL },
        extractorMessageReporting: {
          default: FAIL,
          // Release tags (@public, @beta) are not used: every export of an entry point is public.
          "ae-missing-release-tag": QUIET,
          // Every export has TSDoc with an @example, which TypeDoc enforces (`pnpm docs:build`);
          // members (option fields, methods) are documented where they need it.
          "ae-undocumented": QUIET,
          // A type the public API uses that the entry point does not export. Each one is
          // written into the report, so a new one is a report change and gets reviewed:
          // export it if a user has to name it, leave it if it is a helper no one writes.
          "ae-forgotten-export": REPORT,
          // `{@link}` targets are validated by TypeDoc (`validation.invalidLink`).
          "ae-unresolved-link": QUIET,
        },
        // TSDoc syntax is TypeDoc's concern; api-extractor's stricter dialect rejects tags
        // TypeDoc needs, such as `@module`.
        tsdocMessageReporting: { default: QUIET },
      },
    },
    configObjectFullPath: undefined,
    packageJsonFullPath: join(projectFolder, "package.json"),
  });
  const result = Extractor.invoke(config, {
    // A local build writes the report instead of failing on a difference; this script
    // makes the comparison itself.
    localBuild: true,
    showVerboseMessages: false,
    messageCallback(message) {
      // The bundled compiler (TypeScript 5.9) is older than the workspace's, which is fine
      // for reading declarations; say nothing about it, and nothing about the report file
      // api-extractor writes in temp/.
      if (message.category === "console") message.logLevel = ExtractorLogLevel.None;
    },
  });
  return result.errorCount;
}

async function main() {
  const update = process.argv.includes("--update");
  rmSync(TEMP_FOLDER, { recursive: true, force: true });
  mkdirSync(REPORT_FOLDER, { recursive: true });
  const failed = [];
  const changed = [];
  for (const entry of ENTRY_POINTS) {
    if (!existsSync(join(ROOT, entry.folder, entry.dts))) {
      failed.push(`${entry.specifier}: ${entry.folder}/${entry.dts} is missing (run pnpm build first)`);
      continue;
    }
    const errors = await extract(entry);
    if (errors > 0) {
      failed.push(`${entry.specifier}: ${errors} api-extractor error(s), printed above`);
      continue;
    }
    const name = reportFileName(entry.specifier);
    const fresh = normalizeReport(readFileSync(join(TEMP_FOLDER, name), "utf8"));
    const committedPath = join(REPORT_FOLDER, name);
    const committed = existsSync(committedPath) ? readFileSync(committedPath, "utf8") : undefined;
    if (committed === fresh) continue;
    if (update) {
      writeFileSync(committedPath, fresh);
      changed.push(`api-report/${name}`);
    } else {
      // Kept for `diff` when the check fails in CI.
      writeFileSync(join(TEMP_FOLDER, `${name}.fresh`), fresh);
      failed.push(
        `${entry.specifier}: api-report/${name} ${committed === undefined ? "is missing" : "differs"}`,
      );
    }
  }
  if (failed.length > 0) {
    process.stderr.write(`API report check failed:\n${failed.map((f) => `  - ${f}`).join("\n")}\n`);
    if (!update) {
      process.stderr.write(
        "\nThe public API changed. Run `pnpm api:report`, read the diff under api-report/, and\n" +
          "commit it with the change; the reviewer reviews it as an API change. The generated\n" +
          "reports are in temp/api-report/*.api.md.fresh.\n",
      );
    }
    process.exit(1);
  }
  if (update) {
    const what = changed.length > 0 ? `rewrote ${changed.join(", ")}` : "nothing changed";
    process.stdout.write(`API report: ${what}.\n`);
  } else {
    process.stdout.write(`API report up to date for ${ENTRY_POINTS.length} entry points.\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
