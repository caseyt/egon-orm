// The runtime matrix, ESM entry: the packages loaded with `import`. Run `pnpm build` first.
import { postgres } from "@egon-orm/postgres";
import * as egon from "egon-orm";
import harness from "./harness.cjs";

const adapters = { postgres };
if ((process.env.RUNTIME_TARGETS ?? "postgres,sqlite").includes("sqlite")) {
  // better-sqlite3 is a native module: loaded only when SQLite is a target (Bun cannot load it).
  adapters.sqlite = (await import("@egon-orm/sqlite")).sqlite;
}
await harness.main(process.env.RUNTIME_LABEL ?? "esm", egon, adapters);
