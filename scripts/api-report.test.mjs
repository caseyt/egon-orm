// Run by `pnpm test:unit` (node --test).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ENTRY_POINTS, normalizeReport, reportFileName } from "./api-report.mjs";

test("names a report after its entry point", () => {
  assert.equal(reportFileName("egon-orm"), "egon-orm.api.md");
  assert.equal(reportFileName("egon-orm/testing"), "egon-orm-testing.api.md");
  assert.equal(reportFileName("@egon-orm/postgres"), "egon-orm-postgres.api.md");
});

test("gives every entry point its own report", () => {
  const names = ENTRY_POINTS.map((entry) => reportFileName(entry.specifier));
  assert.equal(new Set(names).size, names.length);
});

test("covers every public entry point of every package, with the declarations its exports name", () => {
  const packagesDir = new URL("../packages/", import.meta.url);
  const expected = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(readFileSync(new URL(`${entry.name}/package.json`, packagesDir), "utf8"));
    if (manifest.private === true) continue;
    for (const [key, target] of Object.entries(manifest.exports ?? {})) {
      if (key === "./package.json") continue;
      expected.push({
        specifier: key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`,
        folder: `packages/${entry.name}`,
        dts: target.types.replace(/^\.\//, ""),
      });
    }
  }
  const sort = (list) => [...list].sort((a, b) => a.specifier.localeCompare(b.specifier));
  assert.deepEqual(sort(ENTRY_POINTS), sort(expected));
});

test("drops the hashed file name and line of an unplaced finding, and keeps the finding", () => {
  const report = [
    "// Warnings were encountered during analysis:",
    "//",
    '// dist/batch-CjAnxdq6.d.ts:1803:9 - (ae-forgotten-export) The symbol "Errors" needs to be exported',
    '// dist/index.d.ts:12:1 - (ae-forgotten-export) The symbol "X" needs to be exported',
  ].join("\n");
  assert.equal(
    normalizeReport(report),
    [
      "// Warnings were encountered during analysis:",
      "//",
      '// (ae-forgotten-export) The symbol "Errors" needs to be exported',
      '// (ae-forgotten-export) The symbol "X" needs to be exported',
    ].join("\n"),
  );
});

test("leaves declarations and inline findings alone", () => {
  const report = [
    '// Warning: (ae-forgotten-export) The symbol "ErrorId" needs to be exported by the entry point messages.d.ts',
    "export function explain(error: unknown, catalog?: ErrorCatalog): string;",
  ].join("\n");
  assert.equal(normalizeReport(report), report);
});
