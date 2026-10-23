// Consumer matrix: a project outside the workspace installs the packed packages the way it
// would after `npm install`, then
//
// 1. runs the ESM consumer (esm.mjs) and the CommonJS consumer (require-esm.cjs) from that
//    project, on this Node and on every `--node <path>` given (CI passes Node 22.12.0, the
//    first release that can `require()` an ES module, decision D14);
// 2. type-checks a TypeScript consumer under each module resolution a project may use:
//    `nodenext` and `node16` (an ES module project), `bundler`, and a CommonJS file (`.cts`)
//    under `nodenext`, which compiles imports to `require()`; plus, in a program of its own
//    (so that nothing checked before it warms TypeScript's caches), types/json-return.ts;
// 3. with `--drivers`, runs drivers.mjs there: each adapter against a real database (and
//    the Zod package against Zod), the check behind the peer-dependency bounds.
//
// Run `pnpm build` first. `pnpm smoke` runs this script with the defaults.
//
// Why outside the workspace: inside it a package's .d.ts resolves its imports from the
// package's own node_modules, where its dev dependencies are (`@types/pg`, for one), so a
// check run from here would not see what a consumer sees. The project gets the tarballs,
// their peer dependencies (optional ones included) and @types/node, nothing else.
//
// Every TypeScript check uses
//
// - `declaration: true`: every type that an exported, inferred declaration mentions must be
//   reachable from a public entry point (TS2883 otherwise);
// - `skipLibCheck: false`: the packages' own .d.ts must be valid (TS2637, TS7016, ...), and
//   resolve with nothing installed beyond the packages, their declared peers and @types/node.
//
// Options:
//
//   --peers pinned|lower|upper   which versions of the peer dependencies to install:
//                                `pinned` (default) the versions the workspace tests with
//                                (each package's dev dependency); `lower` the lowest version
//                                each declared range allows; `upper` the range itself, which
//                                pnpm resolves to the newest release old enough for the
//                                minimum release age.
//   --node <path>                also run the runtime consumers on this Node binary (repeatable);
//                                the same major as the Node running this script, since
//                                better-sqlite3's native module is installed for that one.
//   --typescript <version>       use this TypeScript instead of the workspace's pinned one.
//   --drivers                    also run drivers.mjs (needs Postgres; MySQL with EGON_TEST_TIER2=1).
//   --no-types, --no-runtime     skip a part.
//   --keep                       leave the project directory and print where it is.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const packages = ["core", "postgres", "mysql", "sqlite", "zod", "cli"];

const args = process.argv.slice(2);
function values(flag) {
  const out = [];
  args.forEach((arg, index) => {
    if (arg === flag) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      out.push(value);
    }
  });
  return out;
}
const keep = args.includes("--keep");
const runTypes = !args.includes("--no-types");
const runRuntime = !args.includes("--no-runtime");
const runDrivers = args.includes("--drivers");
const tsVersion = values("--typescript").at(-1);
const nodes = [process.execPath, ...values("--node")];
const peerMode = values("--peers").at(-1) ?? "pinned";
if (!["pinned", "lower", "upper"].includes(peerMode)) throw new Error(`--peers: unknown mode ${peerMode}`);

// pnpm, as the script that started this one ran it (`pnpm smoke` sets npm_execpath).
function pnpm(argv, cwd) {
  const execPath = process.env.npm_execpath;
  const [command, prefix] =
    execPath !== undefined && /\.c?js$/.test(execPath) ? [process.execPath, [execPath]] : ["pnpm", []];
  return execFileSync(command, [...prefix, ...argv], { cwd, encoding: "utf8", stdio: "pipe" });
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/**
 * The lowest version a peer range allows, as the range states it: the floor of its first
 * alternative (`^8.23.0` gives 8.23.0; `^12.4.1 || ^13.0.0` gives 12.4.1). The range must
 * start with an exact floor (`^x.y.z`, `~x.y.z`, `>=x.y.z` or `x.y.z`), so that the lower
 * bound tested is the one users read.
 */
function lowerBound(range) {
  const first = range.split("||")[0].trim();
  const match = /^(?:\^|~|>=)?\s*(\d+\.\d+\.\d+)$/.exec(first.split(/\s+/)[0] ?? "");
  if (match === null) throw new Error(`peer range ${JSON.stringify(range)} has no exact lower bound`);
  return match[1];
}

/** What to install for one peer dependency in the chosen mode. */
function peerSpec(manifest, peer) {
  const range = manifest.peerDependencies[peer];
  if (peerMode === "lower") return lowerBound(range);
  if (peerMode === "upper") return range;
  // The version the workspace tests the package with, which satisfies the peer range.
  const pinned = manifest.devDependencies?.[peer];
  if (pinned === undefined) throw new Error(`${manifest.name}: peer ${peer} has no pinned dev dependency`);
  return pinned;
}

function run(command, argv, cwd) {
  return execFileSync(command, argv, { cwd, encoding: "utf8", stdio: "pipe" });
}

const failures = [];
function attempt(label, action) {
  try {
    const output = action();
    console.log(`consumer: ok   ${label}`);
    return output;
  } catch (error) {
    failures.push(label);
    console.error(
      `consumer: FAIL ${label}\n${error.stdout ?? ""}${error.stderr ?? ""}${error.stdout === undefined ? error.stack : ""}`,
    );
    return undefined;
  }
}

const dir = mkdtempSync(join(tmpdir(), "egon-consumer-"));
try {
  const tarballs = join(dir, "tarballs");
  const project = join(dir, "consumer");
  mkdirSync(tarballs);
  mkdirSync(join(project, "src"), { recursive: true });

  const dependencies = {};
  const peers = {};
  for (const name of packages) {
    const packageDir = join(root, "packages", name);
    const manifest = readJson(join(packageDir, "package.json"));
    const { filename } = JSON.parse(pnpm(["pack", "--json", "--pack-destination", tarballs], packageDir));
    dependencies[manifest.name] = `file:${filename}`;
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (peer.startsWith("egon-orm") || peer.startsWith("@egon-orm/")) continue;
      const spec = peerSpec(manifest, peer);
      if (peers[peer] !== undefined && peers[peer] !== spec)
        throw new Error(`peer ${peer}: two packages ask for ${peers[peer]} and ${spec}`);
      peers[peer] = spec;
    }
  }
  // A Node project has the Node types (mysql2's declarations use them); the workspace's pin.
  const tools = { "@types/node": readJson(join(root, "package.json")).devDependencies["@types/node"] };
  if (tsVersion !== undefined) tools.typescript = tsVersion;

  writeJson(join(project, "package.json"), {
    name: "egon-consumer",
    private: true,
    type: "module",
    dependencies: { ...dependencies, ...peers, ...tools },
  });
  // The workspace's supply-chain policy, given here because the project is outside it: the
  // direct dependencies are pinned above (or, for --peers upper, resolved by pnpm), and
  // everything resolves under the same strict minimum release age. better-sqlite3 runs its
  // install script (it fetches or builds its native module) only when the runtime part runs.
  writeFileSync(
    join(project, "pnpm-workspace.yaml"),
    `minimumReleaseAgeStrict: true\n${runRuntime || runDrivers ? "allowBuilds:\n  better-sqlite3: true\n" : ""}`,
  );
  // The store is preferred, so CI fetches only what its cache lacks.
  pnpm(
    [
      "install",
      "--prefer-offline",
      "--config.confirmModulesPurge=false",
      ...(runRuntime || runDrivers ? [] : ["--ignore-scripts"]),
    ],
    project,
  );
  const installed = Object.keys(peers)
    .map((peer) => `${peer}@${readJson(join(project, "node_modules", peer, "package.json")).version}`)
    .join(", ");
  console.log(`consumer: peers (${peerMode}): ${installed}`);

  if (runRuntime) {
    copyFileSync(join(here, "esm.mjs"), join(project, "esm.mjs"));
    copyFileSync(join(here, "require-esm.cjs"), join(project, "require-esm.cjs"));
    for (const node of nodes) {
      const version = run(node, ["--version"], project).trim();
      for (const script of ["esm.mjs", "require-esm.cjs"]) {
        const output = attempt(`runtime: node ${version} ${script}`, () => run(node, [script], project));
        if (output !== undefined) process.stdout.write(`${output.trimEnd().replace(/^/gm, "  ")}\n`);
      }
    }
  }

  if (runDrivers) {
    copyFileSync(join(here, "drivers.mjs"), join(project, "drivers.mjs"));
    const output = attempt(`drivers: peers (${peerMode}) ${installed}`, () =>
      run(process.execPath, ["drivers.mjs"], project),
    );
    if (output !== undefined) process.stdout.write(`${output.trimEnd().replace(/^/gm, "  ")}\n`);
  }

  if (runTypes) {
    copyFileSync(join(here, "types", "consumer.ts"), join(project, "src", "consumer.ts"));
    copyFileSync(join(here, "types", "json-return.ts"), join(project, "src", "json-return.ts"));
    copyFileSync(join(here, "types", "require.cts"), join(project, "src", "require.cts"));
    const base = {
      target: "ES2022",
      strict: true,
      declaration: true,
      emitDeclarationOnly: true,
      skipLibCheck: false,
      types: ["node"],
      rootDir: "src",
    };
    // One program per resolution mode; each line is what a project of that kind sets.
    const programs = [
      {
        name: "nodenext",
        files: ["src/consumer.ts"],
        options: { module: "NodeNext", moduleResolution: "NodeNext" },
      },
      {
        name: "node16",
        files: ["src/consumer.ts"],
        options: { module: "Node16", moduleResolution: "Node16" },
      },
      {
        name: "bundler",
        files: ["src/consumer.ts"],
        options: { module: "Preserve", moduleResolution: "Bundler" },
      },
      {
        name: "commonjs",
        files: ["src/require.cts"],
        options: { module: "NodeNext", moduleResolution: "NodeNext" },
      },
      {
        name: "json-return",
        files: ["src/json-return.ts"],
        options: { module: "NodeNext", moduleResolution: "NodeNext" },
      },
    ];

    // The `tsc` bin of the package (TypeScript 7 does not export `typescript/bin/tsc`).
    const typescriptDir = join(tsVersion === undefined ? root : project, "node_modules", "typescript");
    const { bin } = readJson(join(typescriptDir, "package.json"));
    const tsc = join(typescriptDir, typeof bin === "string" ? bin : bin.tsc);
    const version = run(process.execPath, [tsc, "--version"], project).trim();
    for (const program of programs) {
      const config = join(project, `tsconfig.${program.name}.json`);
      writeJson(config, {
        compilerOptions: { ...base, ...program.options, outDir: `out-${program.name}` },
        files: program.files,
      });
      attempt(`types: ${version}, ${program.name} (${program.files.join(", ")})`, () =>
        run(process.execPath, [tsc, "-p", config], project),
      );
    }
  }
} finally {
  if (keep) console.log(`consumer: kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`consumer: ${failures.length} failed: ${failures.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("consumer: every check passed");
}
