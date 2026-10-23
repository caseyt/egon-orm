// Run by `pnpm test:unit` (node --test).
import assert from "node:assert/strict";
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
