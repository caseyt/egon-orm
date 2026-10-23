// Prints the TypeScript version that CI checks a consumer project with
// (examples/smoke/consumer.mjs --typescript <version>):
//
//   node scripts/typescript-version.mjs minimum            the oldest supported release (below)
//   node scripts/typescript-version.mjs commonjs-minimum   the newest 5.8.x: the oldest line for a CommonJS project
//   node scripts/typescript-version.mjs latest             the `latest` dist-tag
//   node scripts/typescript-version.mjs next               the newest build of the `next` tag
//
// `commonjs-minimum`, `latest` and `next` are releases older than pnpm's minimum release age (see pickVersion),
// so that the strict supply-chain policy (which the consumer install keeps) accepts
// them. A `next` build is published daily; the newest one is usually too young.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The oldest TypeScript the packages support (decision D14: TypeScript >= 5.5), checked
 * at its last patch release.
 */
export const MINIMUM = "5.5.4";

/**
 * The oldest TypeScript line for a CommonJS project, which `require()`s the packages: 5.8 is
 * the first release that types a `require()` of an ES module (earlier ones report TS1479).
 * Provisional, like the minimum above, until the owner decides.
 */
export const COMMONJS_MINIMUM_LINE = "5.8";

/** pnpm's default minimum release age, in minutes, when the configuration sets none. */
const DEFAULT_AGE_MINUTES = 1440;

/** Margin over the release age, so that a version picked now is still accepted at install. */
const MARGIN_MINUTES = 60;

/** Compares two `x.y.z` versions numerically. */
function compareStable(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * The version of `which` to check with, among those published before `cutoff`.
 *
 * - "latest": the `latest` dist-tag when it is old enough; otherwise the highest stable
 *   version that is. Not the most recently published one: a patch to an older line (5.9.4
 *   after 7.0.2) is published later but is not the latest.
 * - "commonjs-minimum": the highest stable version of the {@link COMMONJS_MINIMUM_LINE} line.
 * - "next": the most recent build with the same major.minor and prerelease tag as the
 *   `next` dist-tag (builds of one line are published in version order).
 */
export function pickVersion(which, distTags, times, cutoff) {
  const oldEnough = (version) => times[version] !== undefined && Date.parse(times[version]) <= cutoff;
  if (which === "latest") {
    const tagged = distTags.latest;
    if (tagged !== undefined && oldEnough(tagged)) return tagged;
    const stable = Object.keys(times).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && oldEnough(v));
    if (stable.length === 0) throw new Error("no latest release of TypeScript is older than the release age");
    return stable.sort(compareStable)[stable.length - 1];
  }
  if (which === "commonjs-minimum") {
    const line = `${COMMONJS_MINIMUM_LINE}.`;
    const patches = Object.keys(times).filter(
      (v) => v.startsWith(line) && /^\d+\.\d+\.\d+$/.test(v) && oldEnough(v),
    );
    if (patches.length === 0)
      throw new Error(`no ${COMMONJS_MINIMUM_LINE}.x release of TypeScript is old enough`);
    return patches.sort(compareStable)[patches.length - 1];
  }
  let matches;
  if (which === "next") {
    const tag = distTags.next;
    const family = tag?.match(/^(\d+\.\d+\.\d+-[a-z]+)\./)?.[1];
    if (family === undefined) throw new Error(`the next dist-tag (${tag}) is not a prerelease build`);
    matches = (version) => version.startsWith(`${family}.`);
  } else {
    throw new Error(`unknown version ${which}: use minimum, commonjs-minimum, latest or next`);
  }
  let best;
  for (const [version, published] of Object.entries(times)) {
    if (!matches(version) || Date.parse(published) > cutoff) continue;
    if (best === undefined || Date.parse(published) > Date.parse(times[best])) best = version;
  }
  if (best === undefined) throw new Error(`no ${which} release of TypeScript is older than the release age`);
  return best;
}

function pnpm(args) {
  const execPath = process.env.npm_execpath;
  const [command, prefix] =
    execPath !== undefined && /\.c?js$/.test(execPath) ? [process.execPath, [execPath]] : ["pnpm", []];
  return execFileSync(command, [...prefix, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const which = process.argv[2];
  if (which === "minimum") {
    process.stdout.write(`${MINIMUM}\n`);
  } else {
    const configured = Number(pnpm(["config", "get", "minimumReleaseAge"]).trim());
    const age = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_AGE_MINUTES;
    const cutoff = Date.now() - (age + MARGIN_MINUTES) * 60_000;
    const distTags = JSON.parse(pnpm(["view", "typescript", "dist-tags", "--json"]));
    const times = JSON.parse(pnpm(["view", "typescript", "time", "--json"]));
    process.stdout.write(`${pickVersion(which, distTags, times, cutoff)}\n`);
  }
}
