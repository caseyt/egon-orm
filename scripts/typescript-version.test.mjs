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

test("refuses an unknown name", () => {
  assert.throws(() => pickVersion("beta", distTags, times, Date.now()), /unknown version beta/);
});
