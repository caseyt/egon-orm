// The checked sources of the code blocks in guide/edge.md. Each `#region` is included in the
// page by name; everything outside a region is the scaffolding that makes the regions
// compile. examples/edge-worker is the same Worker, run in workerd in CI.
import { postgres } from "@egon-orm/postgres";
import { createRepo, from, Schema, t, useFullErrorMessages } from "egon-orm";
import { messages } from "egon-orm/messages";

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export class Note extends Schema("notes", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
}) {}

// #region worker
interface Env {
  readonly DATABASE_URL: string;
}

export default {
  async fetch(_request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // A repo per request: a Worker may not reuse a connection made by another request.
    const repo = createRepo({ adapter: postgres({ connectionString: env.DATABASE_URL }) });
    try {
      const notes = await repo.all(
        from(Note, "n")
          .orderBy(({ n }) => n.id.desc())
          .limit(10),
      );
      return Response.json(notes);
    } finally {
      // Closes the pool after the response is sent.
      ctx.waitUntil(repo.close());
    }
  },
};
// #endregion worker

interface HyperdriveEnv {
  readonly HYPERDRIVE: { readonly connectionString: string };
}

export function withHyperdrive(env: HyperdriveEnv) {
  // #region hyperdrive
  const repo = createRepo({ adapter: postgres({ connectionString: env.HYPERDRIVE.connectionString }) });
  // #endregion hyperdrive
  return repo;
}

export function development(env: { readonly ENVIRONMENT?: string }) {
  // #region messages
  // At the start of fetch(), where the Worker sees its env: full messages in development only.
  if (env.ENVIRONMENT === "development") useFullErrorMessages(messages);
  // #endregion messages
}
