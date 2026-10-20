# Getting started

From an empty directory to a first query in about five minutes. You need Node.js 22.12 or
later and a Postgres server (14 or later).

## Create the project

```sh
mkdir egon-start && cd egon-start
npm init -y
npm pkg set type=module
npm install egon-orm @egon-orm/postgres pg
npm install -D typescript tsx @types/node @types/pg
```

Egon ORM is published as ES modules, hence `"type": "module"`. (A CommonJS project can
still load it with `require()` on Node.js 22.12 or later.) For SQLite, install
`@egon-orm/sqlite` with `better-sqlite3`; for MySQL, `@egon-orm/mysql` with `mysql2`. See
[Adapters](/guide/adapters).

Add a `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

`tsx` runs the TypeScript files, and `npx tsc` checks their types. Two settings matter
today:

- **`skipLibCheck: true` is required.** Without it, `tsc` reports `TS2637` inside the
  library's own declaration files.
- **Declaration output does not work yet.** With `declaration: true`, a file that exports a
  schema class fails with `TS2883`. An application does not need declarations; keep
  `noEmit` (or leave `declaration` off).

Both are known problems of the library, being fixed.

## Start Postgres

If you have no Postgres at hand, Docker starts one:

```sh
docker run -d --name egon-pg -e POSTGRES_PASSWORD=egon -p 5432:5432 postgres:16
export DATABASE_URL=postgres://postgres:egon@localhost:5432/postgres
```

Any other Postgres 14 or later works too (a local install, or a hosted one): point
`DATABASE_URL` at it.

## Define two schemas

A schema is a class that describes a table. Its instances are the rows you read. Create
`schemas.ts`:

<<< @/examples/getting-started/schemas.ts#file

- Fields are non-null unless they say `.nullable()`.
- `createdAt` is stored in the column `created_at`: fields are camelCase, columns snake_case.
- The keys are `bigserial` columns (below), which are 64-bit, so they use
  `t.bigint({ mode: "number" })`, which gives a plain `number`. Declare a key with the
  type of its column: a `t.integer()` field over a `bigint` column is a mistake (a 32-bit
  `serial` column is the one for `t.integer()`).
- `User.changeset` is a **changeset function**: it says which fields this form may set and
  how to check them.

## Connect

Create `repo.ts`:

<<< @/examples/getting-started/repo.ts#file

The repo is an ordinary value: export it and import it where you need it. Nothing connects
until the first query.

## Create the tables

A migration creates them. Create `setup.ts`, and run it once with `npx tsx setup.ts`:

<<< @/examples/getting-started/setup.ts#file

Here the migration is defined and run from a script; in a project, each migration is a
file in a `migrations/` directory (see [Migrations](/guide/migrations)). If you already
manage your tables with another tool, skip this step.

The table callback names its builder `table`: `t` is already the field builder imported
from `egon-orm` elsewhere, and the two are different things.

## Insert, query, update

The rest goes in `main.ts`, which starts with its imports:

<<< @/examples/getting-started/main.ts#imports

A `// =>` comment in the examples gives the value of its line: these examples run in the
documentation's tests, and those values are checked. A `// type:` comment gives the type
TypeScript infers.

### Insert

<<< @/examples/getting-started/main.ts#insert

`insert` returns a result. An invalid changeset comes back without touching the database,
and a duplicate email comes back as a field error, because the changeset declared
`uniqueConstraint("email")`. Every write has a throwing twin, `insertOrThrow`.

### Query

<<< @/examples/getting-started/main.ts#query

Queries are built with `from` and run by the repo. The result type follows from the query:
rows of the schema, or the shape of the `select`. Preloading (`.preload("posts")`) is
described in [Associations](/guide/associations).

### Update and delete

<<< @/examples/getting-started/main.ts#update

An update takes a changeset of a row you loaded and writes only what changed.

### Shut down

<<< @/examples/getting-started/main.ts#close

Run it with `npx tsx main.ts`, and check the types with `npx tsc`.

::: tip Good to know
- **No `new User()`.** New records are changesets (`User.changeset(User, params)`); a
  `User` object comes only from the database.
- **Writes return a result.** Check `result.success`, or use the `OrThrow` twin.
- **Nothing is loaded lazily.** `user.posts` exists only on rows loaded with
  `preload("posts")`.
:::

## See also

- [Tutorial](/guide/tutorial): a small blog, step by step.
- [Schemas](/guide/schemas) for every field option.
- [Changesets](/guide/changesets) for validating and tracking changes.
- [Queries](/guide/queries) for the query builder.
- [Repo](/guide/repo) for every read and write method.
