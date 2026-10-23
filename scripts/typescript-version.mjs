// Prints the TypeScript version that CI checks a consumer project with
// (examples/smoke/check-types.mjs --typescript <version>):
//
//   node scripts/typescript-version.mjs minimum   the oldest supported release (below)
//   node scripts/typescript-version.mjs latest    the newest stable release
//   node scripts/typescript-version.mjs next      the newest build of the `next` tag
//
// `latest` and `next` are the newest releases that are older than pnpm's minimum release
// age, so that the strict supply-chain policy (which the consumer install keeps) accepts
// them. A `next` build is published daily; the newest one is usually too young.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The oldest TypeScript the packages support (decision D14: TypeScript >= 5.5), checked
 * at its last patch release.
 */
export const MINIMUM = "5.5.4";

/** pnpm's default minimum release age, in minutes, when the configuration sets none. */
const DEFAULT_AGE_MINUTES = 1440;

/** Margin over the release age, so that a version picked now is still accepted at install. */
const MARGIN_MINUTES = 60;

/**
 * The newest version of `which` ("latest": a stable release; "next": a build with the
 * same major.minor and prerelease tag as the `next` dist-tag) published before `cutoff`.
 */
export function pickVersion(which, distTags, times, cutoff) {
  let matches;
  if (which === "latest") {
    matches = (version) => /^\d+\.\d+\.\d+$/.test(version);
  } else if (which === "next") {
    const tag = distTags.next;
    const family = tag?.match(/^(\d+\.\d+\.\d+-[a-z]+)\./)?.[1];
    if (family === undefined) throw new Error(`the next dist-tag (${tag}) is not a prerelease build`);
    matches = (version) => version.startsWith(`${family}.`);
  } else {
    throw new Error(`unknown version ${which}: use minimum, latest or next`);
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
