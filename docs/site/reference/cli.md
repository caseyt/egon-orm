# CLI

`egon`, from `@egon-orm/cli`, runs and writes [migrations](/guide/migrations) and manages
the development database.

Install it as a development dependency of your project, beside `egon-orm` and an adapter:

```sh
npm install -D @egon-orm/cli
```

Then run it with `npx egon` (or `pnpm exec egon`, `yarn egon`, or an npm script such as
`"migrate": "egon migrate"`):

```sh
npx egon --help
npx egon migrate create create_users
npx egon migrate
```

## Configuration

`egon` reads `egon.config.ts` (or `.mts`, `.js`, `.mjs`) in the current directory, or the
file given with `--config <file>`. It exports the configuration as its default export (or
as `config`):

<<< @/examples/egon.config.ts#config

| Key | Meaning |
|---|---|
| `adapter` | The database to migrate. `egon` closes it when the command ends. |
| `migrations` | The `createMigrator` options besides the adapter: `directory` (relative to the config file, default `migrations`) or `migrations` (a list), `table`, `schema`, `timestampColumn`, `lockTimeoutMs`, `timeoutMs`. |
| `database` | For `egon db` only: `name`, and `admin`, an adapter connected to another database of the same server, through which `CREATE DATABASE` and `DROP DATABASE` run. |

A TypeScript config file (and TypeScript migrations) need a TypeScript loader: Node 22.18 or
later strips types by itself; on 22.12 to 22.17 turn it on with
`NODE_OPTIONS=--experimental-strip-types npx egon …`. Node's type stripping does not map
`./db.js` to `./db.ts`, so a TypeScript config or migration that imports your own files the
way TypeScript writes them (`from "./db.js"`) needs tsx instead
(`NODE_OPTIONS="--import tsx" npx egon …`), or Bun. Without a loader, `egon` says so and
exits with 1.

## Commands

### `egon migrate`

Applies the pending migrations, oldest first, each in its own transaction. It takes no
argument other than the subcommand `create` (below).

| Flag | Meaning |
|---|---|
| `--to <version>` | Apply up to and including this version. |
| `--step <n>` | Apply this many. |
| `--dry-run` | Print the SQL of each pending migration; run nothing. |
| `--json` | Print one JSON object instead of log lines. |

### `egon migrate create <name>`

Writes a new, empty migration file, `<version>_<name>.ts`, in the migrations directory, and
prints its path. The version is the current UTC time, `YYYYMMDDHHMMSS`; the name is
lower-case letters, digits and underscores, at most 100 characters. The file exports
`migration`, `export const migration = defineMigration({ up(m) { … }, down() { … } })`, with
both bodies empty but for a comment (the runner also accepts a default export, for a file
you write yourself): fill `up` with the change, and `down` with what undoes it, adding the `m`
parameter (`down(m)`); or leave a `// noop` comment in `down` when there is nothing to undo
([Up and down](/guide/migrations#up-and-down)). `down` has no parameter until you need one,
so an untouched `down` compiles under `noUnusedParameters`. Both functions are required.

It never overwrites a file: if a migration with the same version already exists (two runs
in the same second), it exits with 1 and asks you to run it again a second later.

When the config lists its migrations (`migrations: { migrations: [...] }`) instead of naming
a directory, there is no directory to write to: `--dir` is then required.

| Flag | Meaning |
|---|---|
| `--dir <directory>` | Where to write it, instead of the configured directory (`migrations` without a config file). |
| `--json` | Print `{ "ok": true, "command": "migrate create", "version", "name", "path" }` instead of the path; `path` is absolute. |

### `egon rollback`

Rolls back applied migrations, newest first, by running each one's `down`. Without a flag,
the latest one.

| Flag | Meaning |
|---|---|
| `--to <version>` | Roll back down to and including this version. |
| `--step <n>` | Roll back this many. |
| `--all` | Roll back every applied migration. |
| `--dry-run` | Print the SQL that would run; run nothing. |
| `--json` | Print one JSON object instead of log lines. |

### `egon migrations`

Lists every migration with its state: `up` (applied), `down` (pending) or `missing`
(recorded as applied, but its file is gone). On SQLite a row `claimed` (version `-1`) means a
runner is running a migration without a transaction, or stopped in the middle of one: every
run waits while it is there (see [Migrations](/guide/migrations#how-the-runner-works)).
`--json` prints them as JSON.

### `egon db create | drop | reset`

Development conveniences, through `database.admin`: `create` runs `CREATE DATABASE`, `drop`
runs `DROP DATABASE IF EXISTS` (everything in it is lost), and `reset` drops, creates, and
applies every migration. All three refuse to run when `NODE_ENV` is `production`, unless
`--force` is given.

### Every command

| Flag | Meaning |
|---|---|
| `--config <file>` | The config file. |
| `--help` | The help of `egon`, or of the command. |
| `--version` | `egon --version` prints the version. |

## Output and exit codes

| Exit code | Meaning |
|---|---|
| `0` | Success. |
| `1` | A failure: a migration failed (and was rolled back where it ran in a transaction), the config is missing or wrong, the database refused, or the production guard stopped `egon db`. |
| `2` | A usage error: an unknown command or flag, or a bad value. |

Log lines go to standard output, one per migration with its duration; warnings and errors go
to standard error. A failed statement is printed after the error. Database error messages
are printed as the adapter reports them, which leaves out what may quote a value.

With `--json`, standard output holds one JSON object: `{ "ok": true, "command", … }` on
success, and `{ "ok": false, "error": { "name", "code", "message", "version", "sql" } }` on
a failure.
