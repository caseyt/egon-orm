// The body of `sandbox-a.pair.ts` and `sandbox-b.pair.ts`, which together check that the
// sandbox isolates test files from each other: two files, each with a sandbox of its own
// over one database, write a user with the same unique email at the same time, and each
// sees exactly its own.
//
// They run in a Vitest run of their own (project `core:sandbox-pair`) with two workers,
// started by the transaction conformance suite, which passes the profile, the database and
// a token unique to the run in the environment. Each file refuses to start writing until
// it has seen the other one's connection, so they pass only when they really overlap. The
// second insert of the email waits for the first file's transaction to end (the unique
// index makes it wait), which it does by rolling back.
import { cast, createRepo, fragment, from, type Repo } from "egon-orm";
import { createSandbox, type Sandbox } from "egon-orm/testing";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { type ConnectionSettings, type TestDatabase, User } from "../../support/index.js";
import type { TransactionConformanceProfile } from "./profile.js";

/** `{ url, exportName }` of the profile module, as JSON. */
export const SANDBOX_PROFILE_ENV = "EGON_SANDBOX_PAIR_PROFILE";
/** `{ name, settings }` of the database both files use, as JSON. */
export const SANDBOX_DB_ENV = "EGON_SANDBOX_PAIR_DATABASE";
/** A token unique to one run of the pair, so that two runs on one server cannot meet each other. */
export const SANDBOX_TOKEN_ENV = "EGON_SANDBOX_PAIR_TOKEN";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fromEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is not set: the sandbox pair runs only from the transaction conformance suite.`);
  }
  return value;
}

/** The database as the profile's `makeAdapter` needs it: its name and settings. */
function databaseFromEnv(): TestDatabase {
  const given = JSON.parse(fromEnv(SANDBOX_DB_ENV)) as { name: string; settings: ConnectionSettings };
  const unavailable = (): never => {
    throw new Error("not available in the sandbox pair");
  };
  return {
    dialect: "postgres",
    name: given.name,
    settings: given.settings,
    url: "",
    query: unavailable,
    exec: unavailable,
  };
}

/**
 * Sets up one file of the pair with Vitest's hooks (a sandbox around each test, as an
 * application's test file would) and returns its test body.
 */
export function sandboxPeer(self: "a" | "b"): () => Promise<void> {
  const peer = self === "a" ? "b" : "a";
  const marker = (who: string): string => `egon-sandbox-${fromEnv(SANDBOX_TOKEN_ENV)}-${who}`;
  let repo: Repo | undefined;
  let watcher: Repo | undefined;
  let sandbox: Sandbox | undefined;

  beforeAll(async () => {
    const spec = JSON.parse(fromEnv(SANDBOX_PROFILE_ENV)) as { url: string; exportName: string };
    const module = (await import(spec.url)) as Record<string, TransactionConformanceProfile | undefined>;
    const profile = module[spec.exportName];
    if (profile === undefined) throw new Error(`${spec.url} exports no ${spec.exportName}`);
    const db = databaseFromEnv();
    repo = createRepo({ adapter: profile.makeAdapter(db, { poolMax: 2 }) });
    // Outside the sandbox, on a connection of its own: what is committed, and the rendezvous.
    watcher = createRepo({ adapter: profile.makeAdapter(db, { poolMax: 1 }) });
    sandbox = await createSandbox(repo);
  });
  beforeEach(async () => {
    await sandbox?.begin();
  });
  afterEach(async () => {
    await sandbox?.rollback();
  });
  afterAll(async () => {
    await repo?.close();
    await watcher?.close();
  });

  return async () => {
    const app = repo as Repo;
    const outside = watcher as Repo;
    // The application name is visible to every session: it is the rendezvous signal.
    await outside.raw(fragment`select set_config('application_name', ${marker(self)}, false) as name`);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } = await outside.raw(
        fragment`select count(*)::int as n from pg_stat_activity where application_name = ${marker(peer)}`,
      );
      if (rows[0]?.n === 1) break;
      if (Date.now() > deadline) throw new Error(`sandbox-${self} never saw sandbox-${peer}`);
      await sleep(25);
    }
    // Both files write the same email; the name says whose row it is.
    const user = await app.insertOrThrow(
      cast(User, { email: "shared@example.com", name: self }, ["email", "name"]).uniqueConstraint("email"),
    );
    expect(user.name).toBe(self);
    const mine = await app.all(from(User, "u").where({ email: "shared@example.com" }));
    expect(mine.map((each) => each.name)).toEqual([self]);
    // Nothing is committed: a connection outside the sandbox sees no user at all.
    expect(await outside.count(User)).toBe(0);
    // Stay inside the sandbox a little, so that the peer's insert has to wait for it.
    await sleep(300);
  };
}
