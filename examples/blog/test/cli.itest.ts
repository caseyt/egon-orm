// This repository's CI only: the blog's egon.config.ts, run through the egon command as the
// tutorial runs it (`npx egon db create`, `npx egon migrate`), on a database the commands
// create and drop themselves.
import { fileURLToPath } from "node:url";
import { type CliIo, run } from "@egon-orm/cli";
import { uniqueDatabaseName } from "@egon-orm/test-support";
import pg from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

const BLOG = fileURLToPath(new URL("..", import.meta.url));
const name = uniqueDatabaseName("blogcli");
const fileDatabaseUrl = process.env.DATABASE_URL;
let output = "";

function io(): CliIo {
  return {
    stdout: (text) => {
      output += text;
    },
    stderr: (text) => {
      output += text;
    },
    cwd: BLOG,
    env: process.env,
    now: () => new Date(),
  };
}

/** Runs `egon <argv>` in the blog's directory; the config is imported again for each. */
async function egon(argv: readonly string[]): Promise<{ code: number; output: string }> {
  vi.resetModules();
  output = "";
  const code = await run(argv, io());
  return { code, output };
}

beforeAll(() => {
  const url = new URL(fileDatabaseUrl ?? "");
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.href; // what egon.config.ts reads
});

/** Whether the database the commands work on exists, asked through this file's own database. */
async function exists(): Promise<boolean> {
  const client = new pg.Client({ connectionString: fileDatabaseUrl });
  await client.connect();
  try {
    return (await client.query("select 1 from pg_database where datname = $1", [name])).rowCount === 1;
  } finally {
    await client.end();
  }
}

afterAll(async () => {
  if (await exists()) await egon(["db", "drop"]); // only when the test stopped before its drop
  if (fileDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = fileDatabaseUrl;
});

test("egon db create, migrate, migrations and db drop work with the blog's config", async () => {
  expect(await egon(["db", "create"])).toEqual({ code: 0, output: `Created the database "${name}".\n` });
  expect(await exists()).toBe(true);

  const migrate = await egon(["migrate", "--json"]);
  expect(migrate.code).toBe(0);
  expect(JSON.parse(migrate.output)).toMatchObject({
    ok: true,
    migrations: [{ version: 20261020090000, name: "create_blog" }],
  });

  const status = await egon(["migrations", "--json"]);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.output)).toMatchObject({
    ok: true,
    migrations: [{ version: 20261020090000, name: "create_blog", state: "up" }],
  });

  expect(await egon(["db", "drop"])).toEqual({
    code: 0,
    output: `Dropped the database "${name}" (if it existed).\n`,
  });
  expect(await exists()).toBe(false);
});
