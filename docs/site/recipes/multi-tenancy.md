# Multi-tenancy with database schemas

Give each tenant its own database schema (a Postgres schema, a MySQL database) with the
same tables, and choose the schema per request. The schema classes stay the same for every
tenant.

::: details The schemas and tables this recipe uses
<<< @/examples/recipes/multi-tenancy.ts#setup
:::

## Creating a tenant's tables

The same migration runs once per tenant, with the schema in its operations:

<<< @/examples/recipes/multi-tenancy.ts#migration

Each tenant gets its own tracking table, so a new tenant starts with every migration
pending, and a migration added later is applied to each tenant by running `provision`
again for each.

## Choosing the schema per call

Every read and write takes a `schema` option:

<<< @/examples/recipes/multi-tenancy.ts#per-call

## Or a repo per tenant

A repo created with `schema` uses it by default. Repos are cheap: several can share one
adapter, and so one connection pool.

<<< @/examples/recipes/multi-tenancy.ts#per-tenant-repo

<<< @/examples/recipes/multi-tenancy.ts#use

Where the schema comes from, strongest first: a query's own `.schema(…)`, a schema class
that declares one, the call's `schema` option, the repo's default. A write of a loaded row
goes back to the schema the row was read from. See
[Parameters and options](/guide/repo#parameters-and-options).

::: tip Good to know
- **Names are identifiers.** A schema name is written into the SQL as a quoted
  identifier, never as a parameter. Build it from your own tenant ids (a slug you
  validated), not from raw input.
- **Constraint names** are per table, so `uniqueConstraint("name")` matches the violation in
  every tenant's schema.
- **SQLite** has no schemas; the `schema` option names an attached database there.
- **Shared tables** (users, plans) can live in `public`: give their schema class
  `Schema("plans", fields, { schema: "public" })` so that no tenant default moves them.
:::

## See also

- [Schema options](/guide/schemas#schema-options)
- [Repo options](/guide/repo#creating-a-repo)
- [Migrations](/guide/migrations)
