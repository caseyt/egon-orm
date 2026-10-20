// Runs every docs example marked `// @run` against a database of its own, and checks its
// `// =>` comments (vitest.config.ts, project docs:integration, rewrites them into calls of
// the check below). An example runs when it is imported; one that exports `run` has it
// awaited after that. Each must close the adapters it opens.
import { readdirSync, readFileSync } from "node:fs";
import { withDatabase } from "@egon-orm/test-support";
import { expect, test, vi } from "vitest";

declare global {
  var __egonDocsCheck: (actual: unknown, expected: unknown, where: string) => void;
}

let checks = 0;
globalThis.__egonDocsCheck = (actual, expected, where) => {
  checks += 1;
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
      const before = checks;
      const module: { run?: () => Promise<void> } = await import(new URL(file, examples).href);
      if (module.run !== undefined) await module.run();
      expect(checks - before, "a runnable example checks at least one // => comment").toBeGreaterThan(0);
    }));
}
