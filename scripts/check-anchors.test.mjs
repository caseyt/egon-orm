import assert from "node:assert/strict";
import { test } from "node:test";
import { anchoredLinks } from "./check-anchors.mjs";

test("site links with an anchor are read with their page and heading; others are not", () => {
  const page =
    "See [upserts](/guide/repo#upserts), [the guide](/guide/), [x](https://example.com/#a) and [y](/guide/#why).";
  assert.deepEqual(anchoredLinks(page, "guide/batch.md"), [
    { path: "/guide/repo", anchor: "upserts" },
    { path: "/guide/", anchor: "why" },
  ]);
});

test("a same-page anchor resolves to the page itself, an index page included", () => {
  assert.deepEqual(anchoredLinks("[select](#select)", "guide/queries.md"), [
    { path: "/guide/queries", anchor: "select" },
  ]);
  assert.deepEqual(anchoredLinks("[why](#why)", "guide/index.md"), [{ path: "/guide/", anchor: "why" }]);
});

test("relative links resolve against the page's directory, with or without .md", () => {
  const page = "[a](./repo#upserts) [b](types.md#custom-types) [c](../reference/errors#classes)";
  assert.deepEqual(anchoredLinks(page, "guide/batch.md"), [
    { path: "/guide/repo", anchor: "upserts" },
    { path: "/guide/types", anchor: "custom-types" },
    { path: "/reference/errors", anchor: "classes" },
  ]);
});
