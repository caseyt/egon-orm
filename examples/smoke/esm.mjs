// ESM consumer of the built packages. Run `pnpm build` first, then `pnpm smoke`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { VERSION as cliVersion, defineConfig, run } from "@egon-orm/cli";
import { mysql, VERSION as mysqlVersion } from "@egon-orm/mysql";
import { postgres, VERSION as postgresVersion } from "@egon-orm/postgres";
import { sqlite, VERSION as sqliteVersion } from "@egon-orm/sqlite";
import { VERSION as zodVersion } from "@egon-orm/zod";
import { createRepo, EgonError, VERSION } from "egon-orm";
import { explain } from "egon-orm/messages";
import { defineMigration, MigrationError } from "egon-orm/migration";
import { createSandbox, expectQueries } from "egon-orm/testing";

assert.match(VERSION, /^\d+\.\d+\.\d+/);
assert.equal(postgresVersion, VERSION);
assert.equal(zodVersion, VERSION);
assert.equal(sqliteVersion, VERSION);
assert.equal(mysqlVersion, VERSION);
assert.equal(cliVersion, VERSION);

// @egon-orm/cli: its library entry, and the `egon` binary its package.json declares, run as
// an installed binary is (`egon --version` needs no config file and no database).
assert.equal(typeof defineConfig, "function");
let printed = "";
const io = {
  stdout: (text) => (printed += text),
  stderr: (text) => (printed += text),
  cwd: process.cwd(),
  env: {},
  now: () => new Date(),
};
assert.equal(await run(["--version"], io), 0);
assert.equal(printed, `${VERSION}\n`);
const cliManifest = createRequire(import.meta.url).resolve("@egon-orm/cli/package.json");
const bin = join(dirname(cliManifest), JSON.parse(readFileSync(cliManifest, "utf8")).bin.egon);
assert.equal(execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }), `${VERSION}\n`);

// SQLite runs in-process: an in-memory database answers a query through the built adapter.
const memory = sqlite({ filename: ":memory:" });
assert.deepEqual((await memory.execute("select 1 as one", [])).rows, [{ one: 1 }]);
await memory.close();
// The MySQL adapter is created without connecting.
await mysql({ host: "127.0.0.1", port: 1 }).close();

// The second entry point shares the first one's code (one copy of every class and
// registry): its sandbox recognises a repo made by `egon-orm`. Nothing connects here.
const repo = createRepo({ adapter: postgres({ connectionString: "postgres://localhost/unused" }) });
assert.equal(typeof (await createSandbox(repo)).begin, "function");
assert.deepEqual(await expectQueries(repo, () => undefined), []);
await repo.close();
// The subpath `egon-orm/migration` shares its classes with the main entry (one build, one
// file per module).
assert.ok(new MigrationError("migration.failed", "x") instanceof EgonError);
// `egon-orm/messages` explains an error of the main entry: it shares its error module.
const short = new MigrationError("migration.missingSteps", "defineMigration() was given no down().");
assert.match(short.message, /^migration\.missingSteps: .+ See https:\/\//);
assert.match(explain(short), /A migration has both up\(m\) and down\(m\)/);
assert.deepEqual(JSON.parse(JSON.stringify(short)), { name: "MigrationError", code: "migration", id: "migration.missingSteps" });
assert.equal(defineMigration({ up() {}, down() {} }).transaction, true);

console.log(`esm: egon-orm ${VERSION} (resolved to ${import.meta.resolve("egon-orm")})`);
console.log(`esm: egon-orm/testing (resolved to ${import.meta.resolve("egon-orm/testing")})`);
console.log(`esm: @egon-orm/cli ${cliVersion}, and its egon binary (${bin})`);
