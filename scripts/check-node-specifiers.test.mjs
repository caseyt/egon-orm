// Run by `pnpm test:unit` (node --test).
import assert from "node:assert/strict";
import { test } from "node:test";
import { bareBuiltins } from "./check-node-specifiers.mjs";

test("finds built-ins imported without node:, statically, dynamically or required", () => {
  const code = [
    'import { connect } from "net";',
    'const tls = await import("tls");',
    'const fs = require("fs");',
    'import "events";',
  ].join("\n");
  assert.deepEqual(bareBuiltins(code), ["net", "tls", "fs", "events"]);
});

test("accepts node: specifiers, packages and relative imports", () => {
  const code = [
    'import { connect } from "node:net";',
    'const tls = await import("node:tls");',
    'import pg from "pg";',
    'import { x } from "./net.js";',
    'import { y } from "egon-orm";',
  ].join("\n");
  assert.deepEqual(bareBuiltins(code), []);
});
