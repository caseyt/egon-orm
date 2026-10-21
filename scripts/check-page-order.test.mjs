import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pagesToCheck, problemsOfPage, SITE } from "./check-page-order.mjs";

// A file that is never written: the page's includes read it through `readSource`.
const FILE = join(SITE, "examples/page-order-fixture.ts");
const PAGE = join(SITE, "guide/page-order-fixture.md");

const SOURCE = `// #region declare
export class Note {
  text = "";
}

export function makeNote(text: string): Note {
  const note = new Note();
  note.text = text;
  return note;
}
// #endregion declare

const draft = makeNote("draft");

// #region use
export const shown = makeNote("hello");
export const copy = new Note();
export const length = draft.text.length;
// #endregion use

// #region use-declared
export const greeting = makeNote("hello");
// #endregion use-declared
`;

/** @param {string[]} regions */
function page(...regions) {
  return regions.map((region) => `<<< @/examples/page-order-fixture.ts#${region}\n`).join("\n");
}

/** @param {string} markdown */
function problems(markdown) {
  return problemsOfPage(PAGE, markdown, (file) => {
    assert.equal(file, FILE);
    return SOURCE;
  });
}

test("regions shown in file order compile", () => {
  assert.deepEqual(problems(page("declare", "use-declared")), []);
});

test("regions shown out of order are reported, hoisted functions included", () => {
  const found = problems(page("use-declared", "declare"));
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(
    found[0],
    /`makeNote` at line \d+ of the joined parts is used before the part that declares it/,
  );

  // A class is not hoisted: the compiler itself refuses it.
  const classFirst = problems(page("use", "declare"));
  assert.ok(
    classFirst.some((p) => /TS2449/.test(p)),
    classFirst.join("\n"),
  );
});

test("a name declared only in code the page does not show is reported", () => {
  const found = problems(page("declare", "use"));
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], /TS2304 at line \d+ of the joined parts: Cannot find name 'draft'/);
});

test("every recipe but the index is checked", () => {
  const pages = pagesToCheck();
  assert.ok(pages.includes("recipes/pagination.md"));
  assert.ok(pages.includes("guide/tutorial.md"));
  assert.ok(!pages.includes("recipes/index.md"));
});
