// Fails when code branches on a database's name outside the places that own dialect
// differences: core's `adapter/` and `compiler/` (whose dialect tables hold the syntax) and
// the dialect packages themselves. Everywhere else a difference between databases is a
// capability (`adapter.capabilities.returning`), so that a new dialect fills in a table
// instead of hunting for `if (dialect === "mysql")`. Tests are not checked.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The source trees checked, and the directories inside them that may branch on a dialect. */
const CHECKED = [
  { dir: "packages/core/src", allowed: ["adapter", "compiler"] },
  { dir: "packages/zod/src", allowed: [] },
  { dir: "packages/cli/src", allowed: [] },
];

const NAMES = "postgres|mysql|sqlite";
/** `x === "mysql"`, `"sqlite" !== x`, `case "postgres":`, with either quote. */
const CONDITIONAL = new RegExp(
  `(?:[!=]==?\\s*["'](?:${NAMES})["'])|(?:["'](?:${NAMES})["']\\s*[!=]==?)|(?:\\bcase\\s+["'](?:${NAMES})["']\\s*:)`,
);
const TEST_FILE = /\.(?:test|test-d|itest)\.ts$/;

/** The lines of `text` that branch on a dialect name, as `{ line, text }`, comments left out. */
export function findConditionals(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
    if (CONDITIONAL.test(code)) found.push({ line: i + 1, text: lines[i].trim() });
  }
  return found;
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.name.endsWith(".ts") && !TEST_FILE.test(entry.name)) yield path;
  }
}

/** Every dialect-name conditional in the checked trees, as `path:line: text`. */
export function findProblems() {
  const problems = [];
  for (const { dir, allowed } of CHECKED) {
    const base = join(root, dir);
    let files;
    try {
      files = [...sourceFiles(base)];
    } catch {
      continue;
    }
    for (const file of files) {
      const first = relative(base, file).split(sep)[0];
      if (allowed.includes(first)) continue;
      for (const { line, text } of findConditionals(readFileSync(file, "utf8"))) {
        problems.push(`${relative(root, file)}:${line}: ${text}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = findProblems();
  if (problems.length > 0) {
    console.error(
      `A dialect-name conditional outside adapter/, compiler/ and the dialect packages. Use a capability instead:\n${problems.join("\n")}`,
    );
    process.exit(1);
  }
  console.log("ok: no dialect-name conditionals outside adapter/, compiler/ and the dialect packages");
}
