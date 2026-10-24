// Runs scenario.cjs against each target database and checks what it read back. Shared by
// every entry of the runtime matrix; it takes the packages from its caller, so the entry
// decides how they are loaded (import, require, or a bundle).
//
// Targets: `RUNTIME_TARGETS` (default "postgres,sqlite"). Postgres is the Compose server
// (EGON_PG_HOST, EGON_PG_PORT, EGON_PG_USER, EGON_PG_PASSWORD; defaults 127.0.0.1:54329,
// egon/egon): a database of its own is created for the run and dropped afterwards. SQLite
// is a file in the system's temporary directory, removed afterwards.
"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const pg = require("pg");
const { EXPECTED, run } = require("./scenario.cjs");

function runtime() {
  if (typeof globalThis.Bun !== "undefined") return `bun ${globalThis.Bun.version}`;
  if (typeof globalThis.Deno !== "undefined") return `deno ${globalThis.Deno.version.deno}`;
  return `node ${process.version}`;
}

function serverSettings() {
  return {
    host: process.env.EGON_PG_HOST ?? "127.0.0.1",
    port: Number(process.env.EGON_PG_PORT ?? "54329"),
    user: process.env.EGON_PG_USER ?? "egon",
    password: process.env.EGON_PG_PASSWORD ?? "egon",
  };
}

async function onPostgres(egon, adapters) {
  const settings = serverSettings();
  const name = `egon_runtime_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ ...settings, database: process.env.EGON_PG_DATABASE ?? "egon_dev" });
  await admin.connect();
  try {
    // The name is made here from digits and lower-case letters only.
    await admin.query(`create database ${name}`);
    try {
      return await run(
        egon,
        adapters.postgres({ ...settings, database: name, pool: { max: 2 } }),
        "postgres",
      );
    } finally {
      await admin.query(`drop database ${name} with (force)`);
    }
  } finally {
    await admin.end();
  }
}

async function onSqlite(egon, adapters) {
  const dir = mkdtempSync(join(tmpdir(), "egon-runtime-"));
  try {
    return await run(egon, adapters.sqlite({ filename: join(dir, "runtime.db") }), "sqlite");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} label how the packages were loaded ("esm", "cjs", "esbuild esm", ...)
 * @param {typeof import("egon-orm")} egon
 * @param {{ postgres?: Function, sqlite?: Function }} adapters
 */
async function main(label, egon, adapters) {
  const targets = (process.env.RUNTIME_TARGETS ?? "postgres,sqlite").split(",").filter(Boolean);
  let failed = 0;
  for (const target of targets) {
    try {
      const got = target === "postgres" ? await onPostgres(egon, adapters) : await onSqlite(egon, adapters);
      assert.deepEqual(got, EXPECTED);
      process.stdout.write(`runtime: ok   ${runtime()} ${label} ${target}\n`);
    } catch (error) {
      failed++;
      process.stdout.write(`runtime: FAIL ${runtime()} ${label} ${target}\n${error?.stack ?? error}\n`);
    }
  }
  if (failed > 0) process.exitCode = 1;
}

module.exports = { main };
