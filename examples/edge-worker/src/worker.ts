// The reference app as a Cloudflare Worker: one table, an insert and a select with
// where/orderBy/limit. A Worker may not reuse I/O across requests, so the repo (and its
// pool) is made per request and closed after the response, with ctx.waitUntil. Schemas
// are defined once, when the Worker starts; the compiled plans are shared by every
// adapter of the same configuration, so a later request reuses them.
//
// examples/edge-worker/run.mjs runs it in workerd (Miniflare) against Postgres.
import { postgres } from "@egon-orm/postgres";
import { change, createRepo, from, isEgonError, Schema, t, useFullErrorMessages } from "egon-orm";
import { explain, messages } from "egon-orm/messages";

/** The parts of the Workers runtime this Worker uses (no dependency on its type package). */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface Env {
  readonly DATABASE_URL: string;
}

export class Note extends Schema("notes", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  stars: t.integer().default(0),
}) {}

/** Whether this runtime refuses to generate code now (workerd does while it handles a request). */
function codegenRefused(): boolean {
  try {
    return new Function("return false")() as boolean;
  } catch {
    return true;
  }
}

/** The latest notes with at least `min` stars. */
const latest = (min: number) =>
  from(Note, "n")
    .where(({ n }) => n.stars.gte(min))
    .orderBy(({ n }) => n.id.desc())
    .limit(10);

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/error") {
    // A query error, as thrown by default, as explained, and as sent to a client.
    if (url.searchParams.has("full")) useFullErrorMessages(messages);
    try {
      from(Note, "n").join(Note, "n", () => true as never);
      return new Response("no error", { status: 500 });
    } catch (error) {
      useFullErrorMessages(null);
      return Response.json({ message: (error as Error).message, explained: explain(error), json: error });
    }
  }
  const repo = createRepo({ adapter: postgres({ connectionString: env.DATABASE_URL }) });
  try {
    if (url.pathname === "/insert") {
      const title = url.searchParams.get("title") ?? "untitled";
      const stars = Number(url.searchParams.get("stars") ?? "0");
      const note = await repo.insertOrThrow(change(Note, { title, stars }));
      return Response.json({ note, plans: repo.planCacheStats() });
    }
    if (url.pathname === "/select") {
      const notes = await repo.all(latest(Number(url.searchParams.get("min") ?? "0")));
      return Response.json({
        notes,
        rowsAreNotes: notes.every((note) => note instanceof Note),
        codegenRefused: codegenRefused(),
        plans: repo.planCacheStats(),
      });
    }
    return new Response("not found", { status: 404 });
  } catch (error) {
    // The id is stable to switch on and safe to show; the details stay in the log.
    console.error(explain(error));
    return Response.json(isEgonError(error) ? error : { name: "Error" }, { status: 500 });
  } finally {
    ctx.waitUntil(repo.close());
  }
}

export default { fetch: handle };
