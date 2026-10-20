// ESM consumer of the built packages. Run `pnpm build` first, then `pnpm smoke`.
import assert from "node:assert/strict";
import { VERSION as postgresVersion } from "@egon-orm/postgres";
import { VERSION as zodVersion } from "@egon-orm/zod";
import { EgonError, VERSION } from "egon-orm";
import { defineMigration, MigrationError } from "egon-orm/migration";

assert.match(VERSION, /^\d+\.\d+\.\d+/);
assert.equal(postgresVersion, VERSION);
assert.equal(zodVersion, VERSION);

// The subpath `egon-orm/migration` shares its classes with the main entry (one build, chunks).
assert.ok(new MigrationError("x") instanceof EgonError);
assert.equal(defineMigration({ up() {} }).transaction, true);

console.log(`esm: egon-orm ${VERSION} (resolved to ${import.meta.resolve("egon-orm")})`);
