// Run by `pnpm test:unit` (node --test).
import assert from "node:assert/strict";
import { test } from "node:test";
import { disallowedErrors } from "./allowed-lib-errors.mjs";

const PG =
  "node_modules/.pnpm/pg-protocol@1.16.1/node_modules/pg-protocol/dist/serializer.d.ts(34,18): error TS2315: Type 'Buffer' is not generic.";

test("allows an error located in an allowed package's declarations", () => {
  assert.deepEqual(disallowedErrors(`${PG}\n${PG}\n`, ["pg-protocol"]), []);
  const absolute = `/tmp/egon-smoke-types-x/consumer/${PG}`;
  assert.deepEqual(disallowedErrors(absolute, ["pg-protocol"]), []);
});

test("an error without a location is never allowed", () => {
  const output = `${PG}\nerror TS2688: Cannot find type definition file for 'nonexistent'.\n  The file is in the program because:\n`;
  assert.deepEqual(disallowedErrors(output, ["pg-protocol"]), [
    "error TS2688: Cannot find type definition file for 'nonexistent'.",
  ]);
});

test("an error elsewhere that mentions the package is not allowed", () => {
  const line =
    "src/consumer.ts(3,1): error TS2307: Cannot find module 'node_modules/.pnpm/pg-protocol@1.16.1/node_modules/pg-protocol/x'.";
  assert.deepEqual(disallowedErrors(line, ["pg-protocol"]), [line]);
  const egon =
    "node_modules/.pnpm/egon-orm@0.0.0/node_modules/egon-orm/dist/index.d.ts(1,1): error TS2637: x";
  assert.deepEqual(disallowedErrors(egon, ["pg-protocol"]), [egon]);
});

test("a package whose name only starts with an allowed one is not allowed", () => {
  const line =
    "node_modules/.pnpm/pg-protocol-extra@1.0.0/node_modules/pg-protocol-extra/a.d.ts(1,1): error TS1: x";
  assert.deepEqual(disallowedErrors(line, ["pg-protocol"]), [line]);
});

test("with nothing allowed, every error is reported", () => {
  assert.deepEqual(disallowedErrors(PG, []), [PG]);
});
