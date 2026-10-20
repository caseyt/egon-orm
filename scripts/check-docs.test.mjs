import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exportedNames,
  fencedBlocks,
  forbiddenNameMentions,
  handWrittenBlocks,
  hasRegion,
  regionText,
  snippetIncludes,
  uncheckedValueComments,
} from "./check-docs.mjs";

test("a hand-written TypeScript block is reported, with its line", () => {
  const page = "# Page\n\nText.\n\n```ts\nconst x = 1;\n```\n";
  const problems = handWrittenBlocks(page);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^line 5: a hand-written `ts` block/);
});

test("every JavaScript-family language counts as hand-written code", () => {
  for (const language of ["ts", "typescript", "tsx", "js", "javascript", "mjs"]) {
    assert.equal(handWrittenBlocks(`\`\`\`${language}\nx;\n\`\`\`\n`).length, 1, language);
  }
});

test("shell, SQL, text and unlabelled blocks are allowed", () => {
  const page = "```sh\npnpm i\n```\n\n```sql\nselect 1;\n```\n\n```text\nerror\n```\n\n```\nplain\n```\n";
  assert.deepEqual(handWrittenBlocks(page), []);
});

test("an illustrative marker on the line above allows a block, blank lines between included", () => {
  const page = "<!-- illustrative -->\n\n```ts\nconst wrong: number = 'a';\n```\n";
  assert.deepEqual(handWrittenBlocks(page), []);
});

test("a fence inside a longer fence does not end it", () => {
  const blocks = fencedBlocks("````md\n```ts\nx\n```\n````\n");
  assert.deepEqual(
    blocks.map((b) => b.language),
    ["md"],
  );
});

test("snippet includes are read with their path and region", () => {
  const page =
    "<<< @/examples/a.ts#one\n\ntext\n\n<<< ../../examples/blog/src/db.ts\n<<< @/examples/b.tsx#two{2}\n";
  assert.deepEqual(snippetIncludes(page), [
    { path: "@/examples/a.ts", region: "one", line: 1 },
    { path: "../../examples/blog/src/db.ts", region: undefined, line: 5 },
    { path: "@/examples/b.tsx", region: "two", line: 6 },
  ]);
});

test("a region must be opened and closed, by its whole name", () => {
  const source = "// #region feed\nx;\n// #endregion feed\n// #region feed-test\n";
  assert.equal(hasRegion(source, "feed"), true);
  assert.equal(hasRegion(source, "feed-test"), false);
  assert.equal(hasRegion(source, "fee"), false);
  assert.equal(regionText(source, "feed"), "x;");
});

test("the forbidden name is found as a word, in any case, and not inside other words", () => {
  assert.deepEqual(forbiddenNameMentions("one\nas in Ecto\nECTO here\nectoplasm\nselectors"), [2, 3]);
});

test("a // => comment is reported outside a // @run file only", () => {
  assert.deepEqual(uncheckedValueComments("const a = 1;\na; // => 1\n"), [2]);
  assert.deepEqual(uncheckedValueComments("// @run\nconst a = 1;\na; // => 1\n"), []);
});

test("exported names are read from every form of export, with whether they are types", () => {
  const source = `
export const VERSION: string = "0";
export type { A, B as C } from "./a.js";
export { d, type E, f as g } from "./d.js";
export function h() {}
export interface I {}
export class J {}
`;
  assert.deepEqual(exportedNames(source), [
    { name: "A", typeOnly: true },
    { name: "C", typeOnly: true },
    { name: "d", typeOnly: false },
    { name: "E", typeOnly: true },
    { name: "g", typeOnly: false },
    { name: "h", typeOnly: false },
    { name: "I", typeOnly: true },
    { name: "J", typeOnly: false },
    { name: "VERSION", typeOnly: false },
  ]);
});
