import assert from "node:assert/strict";
import { test } from "node:test";
import { anchoredLinks } from "./check-anchors.mjs";

test("links with an anchor are read with their page and heading; others are not", () => {
  const page =
    "See [upserts](/guide/repo#upserts), [the guide](/guide/), [x](https://example.com/#a) and [y](/guide/#why).";
  assert.deepEqual(anchoredLinks(page), [
    { path: "/guide/repo", anchor: "upserts" },
    { path: "/guide/", anchor: "why" },
  ]);
});
