/**
 * The help texts of `egon`.
 *
 * @module
 */

/** The commands, each with its help text. */
export const COMMAND_HELP: Readonly<Record<string, string>> = Object.freeze({
  "gen migration": `Usage: egon gen migration <name> [options]

Writes a new migration file, <version>_<name>.ts, in the migrations directory. The
version is the current UTC time (YYYYMMDDHHMMSS); the name is lower-case letters,
digits and underscores.

Options:
  --from-schema <file>   Prefill createTable from the schema classes the file exports.
                         A one-time scaffold, not a diff: check and edit what it writes.
  --export <names>       With --from-schema: the exports to use, comma-separated
                         (needed when the file exports more than one schema class).
  --dir <directory>      Where to write it (default: the configured migrations directory).
  --config <file>        The config file (default: egon.config.ts in this directory).
`,
  migrate: `Usage: egon migrate [options]

Applies the pending migrations, oldest first.

Options:
  --to <version>         Apply up to and including this version.
  --step <n>             Apply this many.
  --dry-run              Print the SQL of each pending migration; run nothing.
  --json                 Print one JSON object instead of log lines.
  --config <file>        The config file (default: egon.config.ts in this directory).
`,
  rollback: `Usage: egon rollback [options]

Rolls back applied migrations, newest first. Without an option, the latest one.

Options:
  --to <version>         Roll back down to and including this version.
  --step <n>             Roll back this many.
  --all                  Roll back every applied migration.
  --dry-run              Print the SQL that would run; run nothing.
  --json                 Print one JSON object instead of log lines.
  --config <file>        The config file (default: egon.config.ts in this directory).
`,
  migrations: `Usage: egon migrations [options]

Lists every migration with its state: up (applied), down (pending) or missing
(recorded as applied, but its file is gone).

Options:
  --json                 Print one JSON object instead of a table.
  --config <file>        The config file (default: egon.config.ts in this directory).
`,
  db: `Usage: egon db create | drop | reset [options]

Development conveniences, through the config's database.admin adapter:
  create                 CREATE DATABASE <database.name>.
  drop                   DROP DATABASE IF EXISTS <database.name>. Everything in it is lost.
  reset                  drop, create, then apply every migration.

All three refuse to run when NODE_ENV is "production", unless --force is given.

Options:
  --force                Run even when NODE_ENV is "production".
  --json                 Print one JSON object instead of log lines.
  --config <file>        The config file (default: egon.config.ts in this directory).
`,
});

/** The help of `egon` itself. */
export const MAIN_HELP = `Usage: egon <command> [options]

Commands:
  gen migration <name>   Write a new migration file (--from-schema to prefill it).
  migrate                Apply pending migrations.
  rollback               Roll back applied migrations (the latest one by default).
  migrations             List migrations and their state.
  db create|drop|reset   Create, drop or recreate the development database.

Options:
  --config <file>        The config file (default: egon.config.ts, .mts, .js or .mjs
                         in this directory).
  --help                 Show help (also: egon <command> --help).
  --version              Show the version.

Configuration (egon.config.ts):
  import { defineConfig } from "@egon-orm/cli";
  import { postgres } from "@egon-orm/postgres";

  export default defineConfig({
    adapter: postgres({ connectionString: process.env.DATABASE_URL }),
    migrations: { directory: "migrations" },
  });

TypeScript config and migration files need a TypeScript loader: Node 22.18 or later
strips types by itself; otherwise run egon with tsx (node --import tsx) or Bun.
`;
