// Runs every docs example marked `// @run` against a database of its own, and checks its
// `// =>` comments (vitest.config.ts, project docs:integration, rewrites them into calls of
// the functions below). An example runs when it is imported; one that exports `run` has it
// awaited after that. Each must close the adapters it opens. A header
// `// @run after: ./a.ts, ./b.ts` imports those files first.
//
// Every check must run: the rewritten file announces its checks when it loads
// (`__egonDocsExpect`), and a check that was announced but never reached fails the test.
import { readdirSync, readFileSync } from "node:fs";
import { withDatabase } from "@egon-orm/test-support";
import { expect, test, vi } from "vitest";

declare global {
  var __egonDocsCheck: (actual: unknown, expected: unknown, where: string) => void;
  var __egonDocsExpect: (wheres: readonly string[]) => void;
}

const announced = new Set<string>();
const ran = new Set<string>();

globalThis.__egonDocsExpect = (wheres) => {
  for (const where of wheres) announced.add(where);
};
// Deep equality as `toEqual` checks it: a row (an instance of its schema class) equals the
// plain object a comment writes for it.
globalThis.__egonDocsCheck = (actual, expected, where) => {
  ran.add(where);
  expect(actual, `the // => comment at ${where}`).toEqual(expected);
};

const examples = new URL("../examples/", import.meta.url);
const runnable = readdirSync(examples, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .filter((file) => /^\/\/ @run\b/m.test(readFileSync(new URL(file, examples), "utf8").slice(0, 2000)))
  .sort();

test("there are examples to run", () => {
  expect(runnable.length).toBeGreaterThan(0);
});

for (const file of runnable) {
  test(`docs example ${file} runs, and prints what its comments say`, () =>
    withDatabase("postgres", { label: "docs" }, async (db) => {
      process.env.DATABASE_URL = db.url;
      vi.resetModules(); // every example starts from fresh modules, which read the URL above
      announced.clear();
      ran.clear();
      // `// @run after: ./setup.ts` runs that file first, as the reader would (a script that
      // creates the tables, say).
      const source = readFileSync(new URL(file, examples), "utf8");
      const before = /^\/\/ @run after: (.+)$/m.exec(source.slice(0, 2000))?.[1]?.split(",") ?? [];
      for (const path of before) await import(new URL(path.trim(), new URL(file, examples)).href);
      const module: { run?: () => Promise<void> } = await import(new URL(file, examples).href);
      if (module.run !== undefined) await module.run();
      expect(announced.size, "a runnable example checks at least one // => comment").toBeGreaterThan(0);
      const skipped = [...announced].filter((where) => !ran.has(where));
      expect(skipped, "every // => comment of a runnable example must be reached").toEqual([]);
    }));
}
