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

See [Nested changesets](/guide/nested-changesets).

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
