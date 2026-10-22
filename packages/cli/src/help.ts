/**
 * The help texts of `egon`.
 *
 * @module
 */

/**
 * The commands, each with its help text.
 *
 * @example
 * ```ts
 * process.stdout.write(COMMAND_HELP.migrate ?? "");
 * ```
 */
export const COMMAND_HELP: Readonly<Record<string, string>> = /* @__PURE__ */ Object.freeze({
  migrate: `Usage: egon migrate [options]
       egon migrate create <name> [options]

Applies the pending migrations, oldest first. With create, writes a new migration file
instead (egon migrate create --help).

Options:
  --to <version>         Apply up to and including this version.
  --step <n>             Apply this many.
  --dry-run              Print the SQL of each pending migration; run nothing.
  --json                 Print one JSON object instead of log lines.
  --config <file>        The config file (default: egon.config.ts in this directory).
`,
  "migrate create": `Usage: egon migrate create <name> [options]

Writes a new, empty migration file, <version>_<name>.ts, in the migrations directory.
The version is the current UTC time (YYYYMMDDHHMMSS); the name is lower-case letters,
digits and underscores. An existing file is never overwritten.

Options:
  --dir <directory>      Where to write it (default: the configured migrations directory).
  --json                 Print one JSON object instead of the path.
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

/**
 * The help of `egon` itself.
 *
 * @example
 * ```ts
 * process.stdout.write(MAIN_HELP);
 * ```
 */
export const MAIN_HELP = `Usage: egon <command> [options]

Commands:
  migrate                Apply pending migrations.
  migrate create <name>  Write a new, empty migration file.
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
strips types by itself. On 22.12 to 22.17:
  NODE_OPTIONS=--experimental-strip-types npx egon …
With tsx (or use Bun):
  NODE_OPTIONS="--import tsx" npx egon …
`;
