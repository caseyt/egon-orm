// Draws the seeded sample of surviving mutants that the step 21 status note classifies by
// hand (docs/plan/status/21-robustness.md, appendix). Reads a Stryker JSON report
// (reports/mutation/<area>.json, written by `pnpm test:mutation <area>`).
//
//   node scripts/mutation-sample.mjs <report.json> --seed <n> [--files <regex>] [--messages <regex>] [--size 30]
//
// Each surviving or uncovered mutant goes into one of three classes:
//
// - error id: a StringLiteral mutant whose original text is an id ("query.deleteNoKey");
// - error message: any other StringLiteral mutant on a line where, counting the three
//   lines before it, `--messages` matches (default: `Error\(|\`\$\{fn\}`);
// - logic: everything else. The sample is drawn from this class only.
//
// The draw: a linear congruential generator (seed = (seed * 1103515245 + 12345) mod 2^31,
// value = seed / 2^31, computed with JavaScript numbers, whose rounding above 2^53 is part
// of the sequence) picks indexes into the logic pool, in report order (files, then
// mutants as the report lists them), skipping repeats, until `--size` are picked. The pick
// is printed sorted by file and line.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const report = args[0];
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
if (report === undefined || option("seed", undefined) === undefined) {
  console.error(
    "usage: node scripts/mutation-sample.mjs <report.json> --seed <n> [--files <regex>] [--messages <regex>] [--size 30]",
  );
  process.exit(2);
}
let seed = Number(option("seed"));
const size = Number(option("size", "30"));
const files = option("files", undefined);
const messages = new RegExp(option("messages", "Error\\(|`\\$\\{fn\\}"));

const data = JSON.parse(readFileSync(report, "utf8"));
const pool = [];
let ids = 0;
let texts = 0;
for (const [file, entry] of Object.entries(data.files)) {
  const short = file.split("/src/")[1] ?? file;
  if (files !== undefined && !new RegExp(files).test(short)) continue;
  const lines = entry.source.split("\n");
  for (const mutant of entry.mutants) {
    if (mutant.status !== "Survived" && mutant.status !== "NoCoverage") continue;
    const { start, end } = mutant.location;
    const line = lines[start.line - 1];
    const original = start.line === end.line ? line.slice(start.column - 1, end.column - 1) : "(multi)";
    if (mutant.mutatorName === "StringLiteral" && /^"[a-z]+\.[A-Za-z]+"$/.test(original)) {
      ids++;
      continue;
    }
    if (
      mutant.mutatorName === "StringLiteral" &&
      messages.test(lines.slice(Math.max(0, start.line - 4), start.line).join(" "))
    ) {
      texts++;
      continue;
    }
    pool.push({
      file: short,
      line: start.line,
      id: mutant.id,
      status: mutant.status,
      isStatic: mutant.static,
      mutator: mutant.mutatorName,
      original,
      replacement: mutant.replacement,
    });
  }
}
const next = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const picked = [];
const used = new Set();
while (picked.length < Math.min(size, pool.length)) {
  const at = Math.floor(next() * pool.length);
  if (used.has(at)) continue;
  used.add(at);
  picked.push(pool[at]);
}
picked.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
console.log(`error ids ${ids}, error messages ${texts}, logic pool ${pool.length}`);
picked.forEach((m, i) => {
  console.log(
    [
      i + 1,
      m.file,
      m.line,
      m.id,
      m.status === "NoCoverage" ? "no coverage" : "survived",
      m.isStatic ? "static" : "",
      m.mutator,
      JSON.stringify(m.original).slice(0, 80),
      JSON.stringify(m.replacement).slice(0, 60),
    ].join("\t"),
  );
});
