# Getting started

From an empty directory to a first query in about five minutes. You need Node.js 22.12 or
later and a Postgres server.

## Install

```sh
pnpm add egon-orm @egon-orm/postgres pg
pnpm add -D typescript tsx @types/node
```

Egon ORM is published as ES modules (set `"type": "module"` in `package.json`). A CommonJS
project can still load it with `require()` on Node.js 22.12 or later.

For SQLite, install `@egon-orm/sqlite` with `better-sqlite3`; for MySQL, `@egon-orm/mysql`
with `mysql2`. See [Adapters](/guide/adapters).

If you have no Postgres at hand, Docker starts one:

```sh
docker run -d --name egon-pg -e POSTGRES_PASSWORD=egon -p 5432:5432 postgres:16
export DATABASE_URL=postgres://postgres:egon@localhost:5432/postgres
```

The examples import these:

<<< @/examples/getting-started.ts#imports

## Define two schemas

A schema is a class that describes a table. Its instances are the rows you read.

<<< @/examples/getting-started.ts#schemas

- Fields are non-null unless they say `.nullable()`.
- `createdAt` is stored in the column `created_at`: fields are camelCase, columns snake_case.
- `bigserial` keys are 64-bit, so they use `t.bigint({ mode: "number" })`, which gives a
  plain `number`. For a 32-bit `serial` key, use `t.integer()`.
- `User.changeset` is a **changeset function**: it says which fields this form may set and
  how to check them.

## Connect

<<< @/examples/getting-started.ts#repo

The repo is an ordinary value: export it and import it where you need it. Nothing connects
until the first query.

## Create the tables

A migration creates them. Here it is defined and run from a script; in a project, each
migration is a file in a `migrations/` directory (see [Migrations](/guide/migrations)).
If you already manage your tables with another tool, skip this step.

<<< @/examples/getting-started.ts#tables

Run the script once, for example with `npx tsx setup.ts`.

## Insert

<<< @/examples/getting-started.ts#insert

`insert` returns a result. An invalid changeset comes back without touching the database,
and a duplicate email comes back as a field error, because the changeset declared
`uniqueConstraint("email")`. Every write has a throwing twin, `insertOrThrow`.

## Query

<<< @/examples/getting-started.ts#query

Queries are built with `from` and run by the repo. The result type follows from the query:
rows of the schema, or the shape of the `select`. Preloading (`.preload("posts")`) is
described in [Associations](/guide/associations).

## Update and delete

<<< @/examples/getting-started.ts#update

An update takes a changeset of a row you loaded and writes only what changed.

## Shut down

<<< @/examples/getting-started.ts#close

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
