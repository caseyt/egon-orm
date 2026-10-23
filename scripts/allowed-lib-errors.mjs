// Which errors of a tsc run are not covered by `--allow-lib-errors` in
// examples/smoke/check-types.mjs. Every line with `error TS<n>` is an error. One is allowed
// only when its location (the file before `(line,col)`) lies inside one of the allowed
// packages as pnpm installs them: `node_modules/.pnpm/<name>@<version>/node_modules/<name>/`.
// An error without a location (a bad option, a missing type library) is never allowed, nor
// one whose message merely mentions an allowed package.

const ERROR = /error TS\d+:/;
const LOCATED = /^(.+?)\(\d+,\d+\): error TS\d+:/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The error lines of `output` that no allowed package covers. */
export function disallowedErrors(output, allowed) {
  const inside = allowed.map((name) => {
    const store = escapeRegExp(name.replace("/", "+"));
    return new RegExp(`(?:^|/)node_modules/\\.pnpm/${store}@[^/]+/node_modules/${escapeRegExp(name)}/`);
  });
  const disallowed = [];
  for (const line of output.split("\n")) {
    if (!ERROR.test(line)) continue;
    const location = LOCATED.exec(line)?.[1]?.replaceAll("\\", "/");
    if (location !== undefined && inside.some((pattern) => pattern.test(location))) continue;
    disallowed.push(line);
  }
  return disallowed;
}
