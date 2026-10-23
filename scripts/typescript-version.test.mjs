// Run by `pnpm test:unit` (node --test).
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickVersion } from "./typescript-version.mjs";

const distTags = { latest: "7.0.2", next: "7.1.0-dev.20261022.1", beta: "7.1.0-beta" };
const times = {
  created: "2012-10-01T15:00:00.000Z",
  modified: "2026-10-22T08:12:07.173Z",
  "6.0.3": "2026-04-16T23:38:27.905Z",
  "7.0.2": "2026-07-08T15:55:18.431Z",
  "7.1.0-beta": "2026-10-01T10:00:00.000Z",
  "7.1.0-dev.20261020.3": "2026-10-20T08:15:07.129Z",
  "7.1.0-dev.20261021.1": "2026-10-21T08:23:20.167Z",
  "7.1.0-dev.20261022.1": "2026-10-22T08:12:07.173Z",
};

test("latest is the newest stable release published before the cutoff", () => {
  assert.equal(pickVersion("latest", distTags, times, Date.parse("2026-10-22T12:00:00Z")), "7.0.2");
  assert.equal(pickVersion("latest", distTags, times, Date.parse("2026-07-01T00:00:00Z")), "6.0.3");
});

test("next is the newest build of the next tag's family that is old enough", () => {
  assert.equal(
    pickVersion("next", distTags, times, Date.parse("2026-10-22T12:00:00Z")),
    "7.1.0-dev.20261022.1",
  );
  assert.equal(
    pickVersion("next", distTags, times, Date.parse("2026-10-22T08:00:00Z")),
    "7.1.0-dev.20261021.1",
  );
});

test("next never picks a beta, and latest never picks a prerelease", () => {
  const cutoff = Date.parse("2026-10-02T00:00:00Z");
  assert.throws(() => pickVersion("next", distTags, times, cutoff), /no next release/);
  assert.equal(pickVersion("latest", distTags, times, cutoff), "7.0.2");
});

test("latest is the latest tag, not a patch to an older line published after it", () => {
  const patched = { ...times, "5.9.4": "2026-09-01T00:00:00.000Z" };
  const cutoff = Date.parse("2026-10-22T12:00:00Z");
  assert.equal(pickVersion("latest", distTags, patched, cutoff), "7.0.2");
  // When the tag is too young, the highest stable version that is old enough, by version.
  const young = { ...patched, "7.0.3": "2026-10-22T10:00:00.000Z" };
  const tags = { ...distTags, latest: "7.0.3" };
  assert.equal(pickVersion("latest", tags, young, Date.parse("2026-10-22T09:00:00Z")), "7.0.2");
});

test("commonjs-minimum is the highest old-enough 5.8 patch, by version", () => {
  const withLine = {
    ...times,
    "5.8.2": "2025-02-28T16:52:08.252Z",
    "5.8.3": "2025-04-05T00:17:37.851Z",
    "5.8.10": "2026-10-22T10:00:00.000Z",
    "5.80.0": "2025-01-01T00:00:00.000Z",
  };
  assert.equal(
    pickVersion("commonjs-minimum", distTags, withLine, Date.parse("2026-10-22T09:00:00Z")),
    "5.8.3",
  );
  assert.equal(
    pickVersion("commonjs-minimum", distTags, withLine, Date.parse("2026-10-22T12:00:00Z")),
    "5.8.10",
  );
  assert.throws(() => pickVersion("commonjs-minimum", distTags, times, Date.now()), /no 5\.8\.x release/);
});

test("refuses an unknown name", () => {
  assert.throws(() => pickVersion("beta", distTags, times, Date.now()), /unknown version beta/);
});
