// The security review of step 21: what `egon` prints when the database fails. The adapter's
// own errors carry no connection settings (packages/postgres/test/secrets.itest.ts); a
// driver's error, kept as their cause, may (a connection string, a server's message). The
// CLI prints the Egon error's message and nothing of a driver's cause, as text or --json.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type CliIo, run } from "./cli.js";

const SECRET = "hunter2-correct-horse";

/** A config whose adapter fails as an adapter does: an Egon error whose cause is the driver's. */
const CONFIG = `
const fail = () => {
  const error = new Error("database.unreachable: Could not reach the database, or lost the connection to it (ECONNREFUSED).");
  error.name = "DatabaseError";
  error.code = "connection";
  error[Symbol.for("egon.error")] = true;
  error.cause = new Error("connect ECONNREFUSED postgres://egon:${SECRET}@127.0.0.1:1/egon");
  throw error;
};
const adapter = {
  dialect: "postgres",
  acquire: async () => fail(),
  execute: async () => fail(),
  compileFragment() { throw new Error("not used"); },
  close: async () => {},
};
export default { adapter, migrations: { migrations: [] } };
`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "egon-cli-secrets-"));
  await writeFile(join(cwd, "egon.config.mjs"), CONFIG);
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function capture(): { io: CliIo; text: () => string } {
  let text = "";
  const write = (chunk: string) => {
    text += chunk;
  };
  return { io: { stdout: write, stderr: write, cwd, env: {}, now: () => new Date() }, text: () => text };
}

test.each([[["migrations"]], [["migrate"]], [["migrations", "--json"]], [["migrate", "--json"]]])(
  "egon %j: the failure is reported without the driver's message",
  async (argv) => {
    const captured = capture();
    expect(await run(argv, captured.io)).toBe(1);
    expect(captured.text()).toContain("Could not reach the database");
    expect(captured.text()).not.toContain(SECRET);
  },
);
