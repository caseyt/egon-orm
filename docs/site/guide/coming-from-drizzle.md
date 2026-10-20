# Coming from Drizzle

Drizzle and Egon have much in common: the schema is TypeScript, the types are inferred
without a generate step, and queries read like SQL. This page maps everyday Drizzle code
to Egon, task by task. The Drizzle calls are shown inline for reference; every Egon block
is a checked, runnable example (it runs in CI against Postgres, and the `// =>` comments
are the values it produces).

The Drizzle calls are those of drizzle-orm 0.45 (npm's `latest` in October 2026): tables
with `relations()`, and the relational query API v1 (`db.query`). Drizzle 1.0, in release
candidates, replaces `relations()` with `defineRelations()` (Relational Queries v2, with
object filters), and moves `drizzle-zod` to `drizzle-orm/zod`. The examples use a `User`
with many `Post`s.

## The model in one paragraph

A Drizzle table object becomes a **schema class**, and the rows you read are instances of
it. Drizzle's two query styles (the SQL-like builder and the relational `db.query` API) are
one builder here: `from(User, "u")` starts a query, the clauses take callbacks that receive
the tables by alias, and `preload` loads related rows. Writes go through **changesets**,
which filter and validate input and turn constraint violations into field errors; Drizzle
leaves validation to you (or to `drizzle-zod`). A **repo** runs everything, like `db`.

## Defining tables

Drizzle: `pgTable("users", { id: serial("id").primaryKey(), email: text("email").notNull().unique(), … })`,
and `relations(users, ({ many }) => ({ posts: many(posts) }))`.

<<< @/examples/coming-from.ts#define

- **Non-null by default.** Drizzle columns are nullable until `.notNull()`; Egon fields are
  non-null until `.nullable()`.
- Field names are camelCase and become snake_case columns (`authorId` is `author_id`), like
  Drizzle's `casing: "snake_case"` option; `.column("…")` names one explicitly.
- Associations are `static` members of the class, not a separate `relations()` call.
- `.unique()`, indexes and foreign keys belong to the database: declare them in a
  [migration](/guide/migrations).
- Rows are instances of the class, so the class can carry getters and methods.

## Connecting

Drizzle: `drizzle({ client: pool })` from `drizzle-orm/node-postgres`.

<<< @/examples/coming-from.ts#connect

## Setting up

The examples are one runnable file. To follow them in a project of your own:

```sh
npm install egon-orm @egon-orm/postgres pg
npm install -D typescript tsx @types/node @types/pg
```

with the `tsconfig.json` of [Getting started](/guide/getting-started#create-the-project), and
these imports:

<<< @/examples/coming-from.ts#imports

### The tables

Drizzle: `drizzle-kit generate`, from the `.unique()` and `.default()` calls on the table objects. In Egon, a migration you write
creates them, and unique indexes and defaults are part of it:

<<< @/examples/coming-from.ts#migration

Run it once, before the rest:

<<< @/examples/coming-from.ts#migrate

::: warning Match the key types
Declare each key with the type of its column. `table.id({ type: "integer" })` is a 32-bit
`serial`, for `t.integer()`, as here. A bare `table.id()` is a 64-bit `bigserial`, for
`t.bigint({ mode: "number" })` (or `t.bigint()`). The types cannot see a mismatch between a
schema class and its table; at run time, a `t.integer()` field over a `bigint` column
throws `CastError` when a row is read. See [Types](/guide/types#built-in-types).
:::

## Common tasks

### Insert a row

Drizzle: `db.insert(users).values({ email, name }).returning()`.

<<< @/examples/coming-from.ts#create

### Handle a unique violation

Drizzle (0.44 and later): catch the `DrizzleQueryError`, which keeps the driver's error as
its `cause`, and check `error.cause.code === "23505"`.

<<< @/examples/coming-from.ts#create-error

The changeset declared `uniqueConstraint("email")`, so the violation comes back as a field
error. See [Constraints](/guide/constraints).

### Insert related rows

Drizzle: two inserts in a transaction, the second using the first's returned id.

<<< @/examples/coming-from.ts#nested-create

The returned row holds the saved posts, but its type is a plain `User`: the type of a
write's result does not list associations. To use them, narrow it with
`isLoaded(User, row, "posts")`, or read the user again with a preload, as the example does.

See [Nested changesets](/guide/nested-changesets).

### Sample data

The reads below run against these rows, besides the users created above:

<<< @/examples/coming-from.ts#fixtures

### Find by id

Drizzle: `db.select().from(users).where(eq(users.id, id))`, then take the first row.

<<< @/examples/coming-from.ts#find-by-id

### Find by a unique column

Drizzle: `db.query.users.findFirst({ where: eq(users.email, email) })`.

<<< @/examples/coming-from.ts#find-unique

### Filter, order and limit

Drizzle: `db.select().from(posts).where(eq(posts.published, true)).orderBy(desc(posts.views)).limit(10)`.

<<< @/examples/coming-from.ts#find-many

Where Drizzle uses free functions (`eq(a, b)`, `desc(c)`), Egon uses methods on the column
(`p.views.desc()`); the logical functions `and`, `or` and `not` exist in both forms.

### The first match

Drizzle: `.orderBy(desc(posts.id)).limit(1)`, then take the first row.

<<< @/examples/coming-from.ts#find-first

### Select some columns

Drizzle: `db.select({ id: users.id, email: users.email }).from(users)`.

<<< @/examples/coming-from.ts#select

### Operators: `like`, `inArray`, `or`, `isNull`

Drizzle: `and(like(users.email, "%@example.com"), or(isNull(users.name), inArray(users.id, ids)))`.

<<< @/examples/coming-from.ts#operators

Comparing with `null` (`eq(users.name, null)`) is a compile error here: use `isNull()`.
See [Expressions](/guide/query-expressions).

### Count

Drizzle: `db.$count(posts, eq(posts.published, true))`.

<<< @/examples/coming-from.ts#count

### Paginate

Drizzle: `.limit(2).offset(2)`, or `.where(gt(posts.id, afterId))` for a cursor.

<<< @/examples/coming-from.ts#paginate

### Load relations

Drizzle: `db.query.users.findMany({ with: { posts: true } })`, or
`with: { posts: { where, orderBy, limit: 1 } }`.

<<< @/examples/coming-from.ts#include

`preload` reads related rows with one extra query per level, and its result type says
which associations are loaded. A preload can also be filled from a join the query already
has: `preload({ posts: "p" })`. See [Preloading](/guide/associations#preloading).

### Filter by a relation

Drizzle: `db.selectDistinct().from(users).innerJoin(posts, eq(posts.authorId, users.id)).where(eq(posts.published, true))`.

<<< @/examples/coming-from.ts#filter-relation

`joinAssoc` writes the `ON` condition from the association; `join(Post, "p", on)` takes
one written by hand, as Drizzle's `innerJoin` does.

### Group and aggregate

Drizzle: `db.select({ authorId: posts.authorId, posts: count() }).from(posts).groupBy(posts.authorId)`.

<<< @/examples/coming-from.ts#group-by

### Update a row

Drizzle: `db.update(users).set({ name }).where(eq(users.id, id)).returning()`.

<<< @/examples/coming-from.ts#update

### Update many, and increment

Drizzle: ``db.update(posts).set({ views: sql`${posts.views} + 1` }).where(eq(posts.published, true))``.

<<< @/examples/coming-from.ts#update-many

### Upsert

Drizzle: `db.insert(users).values(row).onConflictDoUpdate({ target: users.email, set: { name } })`.

<<< @/examples/coming-from.ts#upsert

### Transactions

Drizzle: `db.transaction(async (tx) => { … })`.

<<< @/examples/coming-from.ts#transaction

As in Drizzle, only calls on `tx` are inside. Here the callback's return value comes back
as a result, and `tx.rollback(reason)` ends it with `{ success: false, error: reason }`.
See [Transactions](/guide/transactions).

### Raw SQL

Drizzle: ``db.execute(sql`select … where views > ${min}`)``.

<<< @/examples/coming-from.ts#raw

`fragment` is the counterpart of Drizzle's `sql` template: interpolations are bound
parameters, and `fragment.ident(name)` quotes an identifier. There is no `sql.raw`: a
string never becomes SQL text.

### Delete

Drizzle: `db.delete(posts).where(eq(posts.id, id))`, or with any condition.

<<< @/examples/coming-from.ts#delete

<<< @/examples/coming-from.ts#delete-many

## Not supported, and what to do instead

| Drizzle | In Egon |
|---|---|
| `drizzle-kit generate` / `push` (migrations from schema changes) | Not supported. Migrations are written by hand; `egon migrate create <name>` writes an empty one to fill in. See [Migrations](/guide/migrations). |
| `drizzle-zod` (`drizzle-orm/zod` in 1.0) | [`@egon-orm/zod`](/guide/validation#deriving-zod-schemas-from-a-schema-class) derives Zod schemas from schema classes. |
| `sql.raw(…)` | Not supported on purpose. Build dynamic identifiers with `fragment.ident()`. |
| Lateral joins | Planned; see the [Roadmap](/reference/roadmap). |
| Views, sequences, enums as schema objects | Create them in a migration; map a Postgres enum with `t.enum([...])` on the field. |
| Serverless HTTP drivers (Neon HTTP, PlanetScale, D1, …) | Not supported: Postgres through `pg`, SQLite through `better-sqlite3`, MySQL through `mysql2`. |

## What works differently

::: tip Good to know
- **Writes go through changesets.** `insert` and `update` take a changeset, not a plain
  object, so input is filtered and validated first. For trusted bulk data, `insertAll`
  takes plain rows.
- **Writes return a result.** Invalid input and declared constraint violations come back
  as `{ success: false, error }`; the `OrThrow` twins throw.
- **Rows are class instances.** `repo.all(User)` returns `User` objects with the class's
  getters and methods, not plain objects; a `select` returns plain objects.
- **Fields are non-null by default**, the opposite of Drizzle's columns.
- **One query builder.** The callbacks receive every table of the query by alias:
  `.where(({ u, p }) => …)`.
:::

## See also

- [Introduction](/guide/): the four concepts and why they are separate.
- [Queries](/guide/queries) and [Expressions](/guide/query-expressions).
- [Recipes](/recipes/): pagination, soft deletes, multi-tenancy and more.
