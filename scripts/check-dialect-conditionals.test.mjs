// Run by `pnpm test:unit` (node --test).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findConditionals, findProblems } from "./check-dialect-conditionals.mjs";

describe("findConditionals", () => {
  for (const line of [
    'if (dialect === "mysql") return;',
    "if (adapter.dialect !== 'sqlite') x();",
    'const quote = "postgres" == name ? a : b;',
    '  case "sqlite":',
  ]) {
    test(`finds ${line.trim()}`, () => {
      assert.deepEqual(findConditionals(`const a = 1;\n${line}\n`), [{ line: 2, text: line.trim() }]);
    });
  }

  test("ignores names that are not compared, and comments", () => {
    const text = [
      'const dialect: Dialect = "postgres";',
      "TABLES = { mysql: MYSQL, sqlite: SQLITE };",
      '// if (dialect === "mysql") is what this replaces',
      ' * dialect === "sqlite" in a doc comment',
      "if (capabilities.returning) run();",
    ].join("\n");
    assert.deepEqual(findConditionals(text), []);
  });
});

test("the repository has no dialect-name conditional outside adapter/, compiler/ and the dialect packages", () => {
  assert.deepEqual(findProblems(), []);
});
