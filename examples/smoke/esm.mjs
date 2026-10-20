// ESM consumer of the built packages. Run `pnpm build` first, then `pnpm smoke`.
import assert from "node:assert/strict";
import { postgres, VERSION as postgresVersion } from "@egon-orm/postgres";
import { VERSION as zodVersion } from "@egon-orm/zod";
import { createRepo, EgonError, VERSION } from "egon-orm";
import { defineMigration, MigrationError } from "egon-orm/migration";
import { createSandbox, expectQueries } from "egon-orm/testing";

assert.match(VERSION, /^\d+\.\d+\.\d+/);
assert.equal(postgresVersion, VERSION);
assert.equal(zodVersion, VERSION);

// The second entry point shares the first one's code (one copy of every class and
// registry): its sandbox recognises a repo made by `egon-orm`. Nothing connects here.
const repo = createRepo({ adapter: postgres({ connectionString: "postgres://localhost/unused" }) });
assert.equal(typeof (await createSandbox(repo)).begin, "function");
assert.deepEqual(await expectQueries(repo, () => undefined), []);
await repo.close();
// The subpath `egon-orm/migration` shares its classes with the main entry (one build, chunks).
assert.ok(new MigrationError("x") instanceof EgonError);
assert.equal(defineMigration({ up() {} }).transaction, true);

console.log(`esm: egon-orm ${VERSION} (resolved to ${import.meta.resolve("egon-orm")})`);
console.log(`esm: egon-orm/testing (resolved to ${import.meta.resolve("egon-orm/testing")})`);
