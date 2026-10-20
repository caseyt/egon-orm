// Type-level smoke test: a consumer project compiles against the built packages the way it
// would after `npm install`. Run `pnpm build` first, then `pnpm smoke`.
//
// Inside the workspace a package's .d.ts resolves its imports from the package's own
// node_modules, where its dev dependencies are (`@types/pg`, for one), so a check run from
// here would not see what a consumer sees. This script therefore packs the packages, installs
// the tarballs with their peer dependencies (optional ones included, at the versions the
// workspace pins; their own dependencies under the workspace's strict minimum release age)
// into a fresh directory outside the workspace, and runs tsc there on types/consumer.ts with
//
// - `declaration: true`: every type that an exported, inferred declaration mentions must be
//   reachable from a public entry point (TS2883 otherwise);
// - `skipLibCheck: false`: the packages' own .d.ts must be valid (TS2637, TS7016, ...), and
//   resolve with nothing installed beyond the packages, their declared peers and @types/node.
//
// tsc is the workspace's pinned TypeScript. `--typescript <version>` installs and uses that
// version instead (for a manual check on another major); `--keep` leaves the directory.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const tsIndex = args.indexOf("--typescript");
const tsVersion = tsIndex === -1 ? undefined : args[tsIndex + 1];
const packages = ["core", "postgres", "mysql", "sqlite", "zod"];

// pnpm, as the script that started this one ran it (`pnpm smoke` sets npm_execpath).
function pnpm(argv, cwd) {
  const execPath = process.env.npm_execpath;
  const [command, prefix] =
    execPath !== undefined && /\.c?js$/.test(execPath) ? [process.execPath, [execPath]] : ["pnpm", []];
  return execFileSync(command, [...prefix, ...argv], { cwd, encoding: "utf8", stdio: "pipe" });
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const dir = mkdtempSync(join(tmpdir(), "egon-smoke-types-"));
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
      // The version the workspace tests the package with, which satisfies the peer range.
      const pinned = manifest.devDependencies?.[peer];
      if (pinned === undefined)
        throw new Error(`${manifest.name}: peer ${peer} has no pinned dev dependency`);
      peers[peer] = pinned;
    }
  }
  // A Node project has the Node types (mysql2's declarations use them); the workspace's pin.
  const tools = { "@types/node": readJson(join(root, "package.json")).devDependencies["@types/node"] };
  if (tsVersion !== undefined) tools.typescript = tsVersion;

  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ name: "egon-types-consumer", private: true, type: "module", dependencies: { ...dependencies, ...peers, ...tools } }, null, 2)}\n`,
  );
  writeFileSync(
    join(project, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          declaration: true,
          emitDeclarationOnly: true,
          skipLibCheck: false,
          types: ["node"],
          rootDir: "src",
          outDir: "out",
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
  );
  copyFileSync(new URL("types/consumer.ts", import.meta.url), join(project, "src", "consumer.ts"));
  // No install scripts: only the declarations are needed (better-sqlite3 would build).
  // The project is outside the workspace, so the workspace's supply-chain policy is given
  // here: the direct dependencies are pinned above, and everything they pull in resolves
  // under the same strict minimum release age (pnpm refuses a release that is too new). The
  // store is preferred, so CI fetches only what its cache lacks.
  pnpm(
    [
      "install",
      "--ignore-scripts",
      "--prefer-offline",
      "--config.minimumReleaseAgeStrict=true",
      "--config.confirmModulesPurge=false",
    ],
    project,
  );

  // The `tsc` bin of the package (TypeScript 7 does not export `typescript/bin/tsc`).
  const typescriptDir = join(tsVersion === undefined ? root : project, "node_modules", "typescript");
  const { bin } = readJson(join(typescriptDir, "package.json"));
  const tsc = join(typescriptDir, typeof bin === "string" ? bin : bin.tsc);
  const version = execFileSync(process.execPath, [tsc, "--version"], { encoding: "utf8" }).trim();
  try {
    execFileSync(process.execPath, [tsc, "-p", project], { cwd: project, encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    console.error(
      `types: tsc (${version}) failed in a consumer of the packed packages:\n${error.stdout}${error.stderr}`,
    );
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    console.log(
      `types: a consumer compiles against the packed packages (${version}, declaration: true, skipLibCheck: false; peers: ${Object.keys(peers).join(", ")})`,
    );
  }
} finally {
  if (keep) console.log(`types: kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
