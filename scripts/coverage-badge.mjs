// Writes the README's coverage badge: a shields.io endpoint file
// (https://shields.io/badges/endpoint-badge) with the line coverage of the unit tests, read
// from the json-summary report that `vitest --coverage` writes. Run by docs.yml, which
// publishes the file with the site at badges/coverage.json; tested by
// coverage-badge.test.mjs.
//
//   node scripts/coverage-badge.mjs <coverage-summary.json> <output.json>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The badge for a coverage summary. The percentage is rounded down to one decimal, so the
 * badge never shows more than was covered.
 * @param {{ total: { lines: { pct: number } } }} summary vitest's coverage-summary.json
 * @returns {{ schemaVersion: 1, label: string, message: string, color: string }}
 */
export function badgeOf(summary) {
  const pct = summary?.total?.lines?.pct;
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error(`coverage-badge: no line percentage in the summary (total.lines.pct is ${pct})`);
  }
  const shown = Math.floor(pct * 10) / 10;
  // The thresholds in vitest.config.ts are 95%: below them CI has already failed.
  const color = shown >= 95 ? "brightgreen" : shown >= 90 ? "green" : shown >= 80 ? "yellow" : "red";
  return { schemaVersion: 1, label: "coverage", message: `${shown}%`, color };
}

function main() {
  const [input, output] = process.argv.slice(2);
  if (input === undefined || output === undefined) {
    process.stderr.write("usage: node scripts/coverage-badge.mjs <coverage-summary.json> <output.json>\n");
    process.exitCode = 1;
    return;
  }
  const badge = badgeOf(JSON.parse(readFileSync(input, "utf8")));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(badge)}\n`);
  process.stdout.write(`coverage-badge: ${badge.message} -> ${output}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
