// Builds the app with `next build`, serves it with `next start` against a database of its
// own on the Compose Postgres, asks /api/check, and compares the answer. Run `pnpm build`
// at the workspace root first (the app uses the built packages). Telemetry is off.
//
// Settings: EGON_PG_HOST, EGON_PG_PORT, EGON_PG_USER, EGON_PG_PASSWORD (defaults
// 127.0.0.1:54329, egon/egon); NEXT_CHECK_PORT (default 3311).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = fileURLToPath(new URL(".", import.meta.url));
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
const settings = {
  host: process.env.EGON_PG_HOST ?? "127.0.0.1",
  port: Number(process.env.EGON_PG_PORT ?? "54329"),
  user: process.env.EGON_PG_USER ?? "egon",
  password: process.env.EGON_PG_PASSWORD ?? "egon",
};
const port = Number(process.env.NEXT_CHECK_PORT ?? "3311");

execFileSync(process.execPath, [nextBin, "build"], { cwd: here, env, stdio: "inherit" });

const name = `egon_next_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const admin = new pg.Client({ ...settings, database: process.env.EGON_PG_DATABASE ?? "egon_dev" });
await admin.connect();
// The name is made here from digits and lower-case letters only.
await admin.query(`create database ${name}`);
const url = `postgres://${encodeURIComponent(settings.user)}:${encodeURIComponent(settings.password)}@${settings.host}:${settings.port}/${name}`;
const server = spawn(
  process.execPath,
  [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: here,
    env: { ...env, DATABASE_URL: url },
    stdio: ["ignore", "inherit", "inherit"],
  },
);
try {
  let answer;
  for (let attempt = 0; attempt < 60 && answer === undefined; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/check`);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      answer = await response.json();
    } catch (error) {
      if (attempt === 59) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  assert.deepEqual(answer, {
    count: 3,
    authors: ["Ann: One, Two", "Bo: Three"],
    streamed: ["One", "Two", "Three"],
  });
  console.log(`next: ok   next build + next start on node ${process.version}`);
} finally {
  server.kill();
  await new Promise((resolve) => server.once("exit", resolve));
  await admin.query(`drop database ${name} with (force)`);
  await admin.end();
}
