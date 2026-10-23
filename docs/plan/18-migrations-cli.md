# Step 18 — Migrations and CLI

**Depends on:** 11 (04 for the schema-aware generator). **Parallel with:** 12–17.
**Owns:** `packages/core/src/migration/`, `packages/cli/`,
`packages/core/test/conformance/migration/`, `docs/site/guide/migrations.md`, `docs/site/reference/cli.md`.

**Follow-up step:** per the owner's decision (plan README §10) this runs after step 21 and
is not part of the first release. It is isolated from the rest of the library.
Superseded: step 18 was brought forward and merged on 2026-10-20 (#34), and the owner decided
the same day that `@egon-orm/cli` ships like the other packages (#52). Migrations and the CLI
are part of the first release.

## Goal

Hand-written, versioned, reversible migrations in the style of `Ecto.Migration`, a runner
that is safe under concurrent deploys, and a small CLI.

## Public API

```ts
// migrations/20261012093000_create_users.ts
import { defineMigration } from "egon-orm/migration";

export default defineMigration({
  change(m) {                                   // reversible: the runner derives `down`
    m.createTable("users", (t) => {
      t.id();                                   // bigserial primary key "id" (a migration column helper, unrelated to the removed schema builder t.id())
      t.string("email").notNull();
      t.string("name");
      t.integer("age");
      t.enumText("role", ["admin", "member"]).notNull().default("member");   // text + check constraint
      t.jsonb("settings");
      t.references("org_id", "orgs", { type: "uuid", onDelete: "cascade" });
      t.timestamps();
    });
    m.createIndex("users", ["email"], { unique: true });       // users_email_key
  },
});

// Non-reversible work: provide both directions
export default defineMigration({
  async up(m) { m.execute(fragment`UPDATE users SET role = 'member' WHERE role IS NULL`); },
  async down(m) { /* ... */ },
  transaction: true,          // default; set false for CREATE INDEX CONCURRENTLY
  lock: true,
});
```

Operations: `createTable` (options: `primaryKey: false`, `schema`, `ifNotExists`),
`alterTable` (`add`, `modify(name, type, { from })`, `remove(name, type?)`, `rename`),
`dropTable`, `renameTable`, `createIndex`/`dropIndex` (`unique`, `where`, `using`,
`concurrently`, `include`, `name`), `createConstraint`/`dropConstraint` (`check`,
`exclude`), `execute(up, down?)`, `createSchema`/`dropSchema` (database schema),
`createExtension`. Column builders mirror `DbType` from step 02, and names default to the
conventions the changeset constraint functions expect (`<table>_<cols>_key` for a unique index,
`<table>_<col>_fkey`) — test this pairing explicitly.

Runner:

```ts
import { createMigrator } from "egon-orm/migration";
const migrator = createMigrator({ repo, directory: "./migrations", table: "schema_migrations" });
await migrator.up({ to?: version, step?: n });
await migrator.down({ to?: version, step?: n });      // default step: 1
await migrator.status();                               // [{ version, name, state: "up" | "down" | "missing" }]
```

CLI (`egon`, from `@egon-orm/cli`; config in `egon.config.ts` exporting `{ repo, migrations }`):

```
egon gen migration <name>         # timestamped file from a template
egon gen migration <name> --from-schema src/schemas/user.ts   # createTable prefilled from a schema class
egon migrate [--to V | --step N] [--dry-run]
egon rollback [--to V | --step N | --all]
egon migrations                   # status table
egon db create | drop | reset     # dev conveniences; refuse when NODE_ENV=production unless --force
```

## Behaviour

1. **DDL generation** is our own emitter (ADR 0003): one function per migration operation
   writing SQL text through the dialect tables of steps 10 and 17, under the same rules as
   the query emitter (every identifier quoted; type names from the `DbType` tables or a
   checked `custom.sql`). The `Adapter` contract has no
   DDL method yet: this step adds one (`compileFragment` covers `m.execute`). Capability-gated features
   (`concurrently`, exclusion constraints, partial indexes) throw `MigrationError` on dialects without them.
2. **`change` reversal.** Record operations; `down` replays inverses in reverse order.
   Operations lacking enough information to reverse (`remove` without a type, `execute`
   with one argument, `modify` without `from`, `dropTable` without a definition) throw
   `MigrationError` **at rollback time** with the fix, as Ecto does.
3. **Tracking table** `schema_migrations(version bigint primary key, created_at timestamp)`
   — compatible with Ecto's, so a database migrated by Ecto can be adopted.
4. **Locking.** The runner takes a lock so concurrent deploys do not race: Postgres
   advisory lock (session-level, keyed by a hash of the table name), MySQL `GET_LOCK`,
   SQLite `BEGIN IMMEDIATE`. Released in `finally`.
5. **Transactions.** Each migration runs in its own transaction where the dialect supports
   transactional DDL; on MySQL (no transactional DDL) run without, and document that a
   failed migration may be half-applied. `transaction: false` opts out per migration.
6. **Ordering and gaps.** Versions are the 14-digit timestamp prefix; apply pending ones in
   order. A pending migration older than the latest applied one is applied (with a warning),
   as Ecto does. A recorded version whose file is missing shows as `missing` and blocks
   rollback past it.
7. **Dry run** prints the SQL for each pending migration without executing.
8. **Loading.** Migration files are loaded with dynamic `import()`; TypeScript files work
   when the process has a TS loader (`tsx`, Node's type stripping, Bun) — the CLI detects
   and explains what to install otherwise. Also accept an in-memory list (`migrations: [...]`)
   for bundlers and edge deployments.
9. **`--from-schema` generator.** Uses `SchemaMeta` to emit column definitions (types,
   nullability, defaults, references from `belongsTo`, unique indexes are not inferable —
   leave a comment). It is a one-time scaffold, not a diff tool; say so in the output.
10. **Output.** Human-readable log lines per migration with duration; `--json` for machines. Non-zero exit on failure.

## Tests

- Unit: DDL snapshots for every operation per dialect; reversal of every reversible
  operation; every irreversible case's error; version parsing; ordering with gaps.
- Integration (conformance/migration): up/down/redo of a 5-migration set leaves an empty
  database; two migrators racing (only one applies each version); failing migration rolls
  back cleanly on Postgres/SQLite; adopting an Ecto-created `schema_migrations` table;
  constraint names produced by migrations are matched by default changeset constraint
  functions end to end (insert a duplicate, get a changeset error).
- CLI: spawn the built binary against a temp project for each command; exit codes; dry run;
  production guard on `db drop`.

## Docs

`migrations.md`: writing migrations, the operation reference, reversible vs up/down, index
and constraint naming and how it ties to changesets, zero-downtime notes (concurrent
indexes, `transaction: false`), running in CI/CD, adopting an existing database.
`reference/cli.md`: every command and flag, config file.

## Acceptance

- [ ] Full up → down → up cycle of the blog schema as migrations on all supported dialects.
- [ ] Concurrent-runner test passes 50 consecutive times.
- [ ] Migration-generated constraint names interoperate with changeset constraint defaults (tested).
- [ ] CLI commands tested via the built binary; `--help` output snapshot.

## Out of scope

Automatic schema diffing. Data migration frameworks. Seeds beyond a documented pattern.
