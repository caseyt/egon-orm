// The runtime matrix, CommonJS entry: the ES module packages loaded with `require()`
// (Node >= 22.12). Run `pnpm build` first.
"use strict";

const egon = require("egon-orm");
const { postgres } = require("@egon-orm/postgres");
const { main } = require("./harness.cjs");

const adapters = { postgres };
if ((process.env.RUNTIME_TARGETS ?? "postgres,sqlite").includes("sqlite")) {
  // better-sqlite3 is a native module: loaded only when SQLite is a target (Bun cannot load it).
  adapters.sqlite = require("@egon-orm/sqlite").sqlite;
}
main(process.env.RUNTIME_LABEL ?? "cjs", egon, adapters);
