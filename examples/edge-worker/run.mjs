// Runs the built Worker (dist/worker.js, from `pnpm run build`) in workerd through Miniflare,
// against a database of its own on the test Postgres, and checks three requests: an insert,
// a select, and a second select that reuses the schemas and the compiled plans of the
// first. Also checks the error messages: short by default, full after the opt-in, and
// { name, code, id } as JSON. Prints the bundle's size (to the job summary in CI).
//
// workerd refuses code generation while it handles a request, so the decoders of these
// queries are the interpreted ones: the rows coming back as instances of Note shows that
// the fallback works there.
//
//   DATABASE_URL defaults to the test Postgres of docker-compose.yml (pnpm db:up).
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { Miniflare } from "miniflare";
import pg from "pg";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const server = process.env.EGON_TEST_PG_URL ?? "postgres://egon:egon@127.0.0.1:54329/egon_dev";
const database = `egon_edge_worker_${process.pid}`;
const url = new URL(server);
url.pathname = `/${database}`;

function check(condition, message, detail) {
  if (!condition) {
    console.error(`FAIL: ${message}`, detail === undefined ? "" : JSON.stringify(detail, null, 2));
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const admin = new pg.Client({ connectionString: server });
await admin.connect();
await admin.query(`create database ${database}`);
let mf;
try {
  const setup = new pg.Client({ connectionString: url.href });
  await setup.connect();
  await setup.query(
    "create table notes (id serial primary key, title text not null, stars integer not null default 0)",
  );
  await setup.end();

  mf = new Miniflare({
    scriptPath: here("./dist/worker.js"),
    modules: true,
    // As in wrangler.toml; no later than the workerd that this Miniflare runs.
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { DATABASE_URL: url.href },
  });
  const get = async (path) => {
    const response = await mf.dispatchFetch(`http://worker${path}`);
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text };
    }
  };

  const inserted = await get("/insert?title=first&stars=3");
  check(
    inserted.status === 200 && inserted.body.note?.title === "first",
    "a request inserts a row",
    inserted,
  );
  const first = await get("/select?min=1");
  check(
    first.status === 200 && first.body.notes?.length === 1,
    "a request selects it with where, orderBy and limit",
    first,
  );
  check(
    first.body.codegenRefused === true,
    "workerd refuses code generation while it handles a request",
    first,
  );
  check(
    first.body.rowsAreNotes === true,
    "the rows are instances of the schema class (decoded without generated code)",
    first,
  );
  const second = await get("/select?min=2");
  check(
    second.status === 200 && second.body.notes?.length === 1,
    "a second request runs the same query again",
    second,
  );
  check(
    second.body.plans?.hits > first.body.plans?.hits &&
      second.body.plans?.misses === first.body.plans?.misses,
    "the second request's new repo reuses the plan the first compiled",
    { first: first.body.plans, second: second.body.plans },
  );

  const short = await get("/error");
  check(
    /^query\.aliasTaken: .+ See https:\/\/egon-orm\.github\.io\/egon-orm\/reference\/errors\/query#query-aliastaken$/.test(
      short.body.message,
    ) && !short.body.message.includes("Each binding needs its own alias"),
    "a thrown message is short by default: identifier, sentence, link",
    short.body,
  );
  check(
    short.body.explained?.includes("Each binding needs its own alias"),
    "explain(error) gives the full text",
    short.body,
  );
  check(
    JSON.stringify(short.body.json) ===
      JSON.stringify({ name: "QueryError", code: "query", id: "query.aliasTaken" }),
    "JSON.stringify(error) is { name, code, id }",
    short.body,
  );
  const full = await get("/error?full=1");
  check(
    full.body.message?.includes("Each binding needs its own alias"),
    "after useFullErrorMessages(messages), the message has the full text",
    full.body,
  );
} finally {
  await mf?.dispose();
  await admin.query(`drop database if exists ${database} with (force)`);
  await admin.end();
}

const bundle = readFileSync(here("./dist/worker.js"));
const size = `Worker bundle (minified, with pg): ${(bundle.length / 1024).toFixed(1)} KiB, ${(gzipSync(bundle).length / 1024).toFixed(1)} KiB gzip`;
console.log(size);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${size}\n`);
