# Coming from Prisma

This page maps the things you do every day with Prisma Client to Egon, task by task. The
Prisma calls are shown inline for reference; every Egon block is a checked, runnable
example (it runs in CI against Postgres, and the `// =>` comments are the values it
produces).

The Prisma calls are those of Prisma ORM 7, the current major release in October 2026;
where Prisma 6 differs, the page says so. The examples use a `User` with many `Post`s.

## The model in one paragraph

Prisma generates a client from `schema.prisma`; Egon has no schema file and no generate
step. A table is a TypeScript **schema class**, and the types of rows, preloads and
selects are inferred from it. Reads go through **queries** (`from(User, "u")…`), which are
values you can keep and extend. Writes go through **changesets**, which filter and validate
input and turn constraint violations into field errors. A **repo** runs both, like the
Prisma client does.

## Defining models

Prisma: a `model User { … posts Post[] }` block in `schema.prisma`, then `prisma generate`.

<<< @/examples/coming-from.ts#define

- Fields are non-null unless `.nullable()`, as in Prisma (where `String?` opts in).
- `@relation` is replaced by `static` associations. The foreign key (`authorId`) is a field
  you declare, as in Prisma.
- `@unique` and `@default` belong to the database: declare them in a
  [migration](/guide/migrations). `.default()` on a field is the value a new record starts
  with in your code.
- The changeset functions (`User.changeset`) have no Prisma counterpart: they replace
  validating input by hand before `create`.

## Connecting

Prisma 7: `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`, with the
`@prisma/adapter-pg` driver adapter (Prisma 6: `new PrismaClient()`).

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

Prisma: `prisma migrate dev`, from the `@unique` and `@default` attributes in `schema.prisma`. In Egon, a migration you write
creates them, and unique indexes and defaults are part of it:

<<< @/examples/coming-from.ts#migration

Run it once, before the rest:

<<< @/examples/coming-from.ts#migrate

::: warning Match the key types
Declare each key with the type of its column. `table.id("id", { type: "integer" })` is a
32-bit `serial`, for `t.integer()`, as here. A bare `table.id()` is a 64-bit `bigserial`, for
`t.bigint({ mode: "number" })` (or `t.bigint()`). The types cannot see a mismatch between a
schema class and its table: an integer field over a `bigint` column reads its values wrongly.
:::

## Common tasks

### Create a record

Prisma: `prisma.user.create({ data: { email, name } })`.

<<< @/examples/coming-from.ts#create

### Handle a unique violation

Prisma: catch `Prisma.PrismaClientKnownRequestError` and check `e.code === "P2002"`.

<<< @/examples/coming-from.ts#create-error

The changeset declared `uniqueConstraint("email")`, so the violation comes back as a field
error instead of an exception. See [Constraints](/guide/constraints).

### Create with related records

Prisma: `prisma.user.create({ data: { email, posts: { create: [{ title }] } } })`.

<<< @/examples/coming-from.ts#nested-create

The returned row holds the saved posts, but its type is a plain `User`: the type of a
write's result does not list associations. To use them, narrow it with
`isLoaded(User, row, "posts")`, or read the user again with a preload, as the example does.

Each post is validated by `Post.changeset`. See [Nested changesets](/guide/nested-changesets).

### Sample data

The reads below run against these rows, besides the users created above:

<<< @/examples/coming-from.ts#fixtures

### Find by id

Prisma: `prisma.user.findUnique({ where: { id } })` and `findUniqueOrThrow`.

<<< @/examples/coming-from.ts#find-by-id

### Find by a unique field

Prisma: `prisma.user.findUnique({ where: { email } })`.

<<< @/examples/coming-from.ts#find-unique

`getBy` is strict: it throws `MultipleResultsError` if more than one row matches.

### Filter, order and limit

Prisma: `prisma.post.findMany({ where: { published: true }, orderBy: { views: "desc" }, take: 10 })`.

<<< @/examples/coming-from.ts#find-many

### The first match

Prisma: `prisma.post.findFirst({ orderBy: { id: "desc" } })`.

<<< @/examples/coming-from.ts#find-first

### Select some fields

Prisma: `prisma.user.findMany({ select: { id: true, email: true } })`.

<<< @/examples/coming-from.ts#select

The result type is the shape of the `select`.

### Operators: `endsWith`, `in`, `OR`, `null`

Prisma: `where: { email: { endsWith: "@example.com" }, OR: [{ name: null }, { id: { in: ids } }] }`.

<<< @/examples/coming-from.ts#operators

Operators are methods on columns. Comparing with `null` is a compile error: use
`isNull()`. The object form, `.where({ name: null })`, does mean `IS NULL`, as in Prisma.
See [Expressions](/guide/query-expressions).

### Count

Prisma: `prisma.post.count({ where: { published: true } })`.

<<< @/examples/coming-from.ts#count

### Paginate

Prisma: `skip` and `take` for offsets; `cursor: { id }, skip: 1, take` for cursors.

<<< @/examples/coming-from.ts#paginate

For a cursor over several columns, see [Pagination](/recipes/pagination).

### Include relations

Prisma: `include: { posts: true }`, or `include: { posts: { where, orderBy, take: 1 } }`.

<<< @/examples/coming-from.ts#include

Related rows are read with one extra query per level of `preload`, never one per parent,
and `limit` in a preload callback applies to each parent, like `take` inside an
`include`. See [Preloading](/guide/associations#preloading).

### Filter by a relation

Prisma: `prisma.user.findMany({ where: { posts: { some: { published: true } } } })`.

<<< @/examples/coming-from.ts#filter-relation

`joinAssoc` writes the join from the association. An `exists` subquery is the other way
to say "some"; see [Subqueries](/guide/queries-advanced#subqueries).

### Group and aggregate

Prisma: `prisma.post.groupBy({ by: ["authorId"], _count: { id: true } })`.

<<< @/examples/coming-from.ts#group-by

### Update a record

Prisma: `prisma.user.update({ where: { id }, data: { name } })`.

<<< @/examples/coming-from.ts#update

An update starts from the row you loaded and writes only the fields that changed.

### Update many, and increment

Prisma: `prisma.post.updateMany({ where: { published: true }, data: { views: { increment: 1 } } })`.

<<< @/examples/coming-from.ts#update-many

### Upsert

Prisma: `prisma.user.upsert({ where: { email }, update: { name }, create: { email, name } })`.

<<< @/examples/coming-from.ts#upsert

This is a single `INSERT … ON CONFLICT` statement. See [Upserts](/guide/repo#upserts).

### Transactions

Prisma: `prisma.$transaction(async (tx) => { … })`.

<<< @/examples/coming-from.ts#transaction

As in Prisma's interactive transactions, only calls on `tx` are inside. A callback that
throws rolls back; one that returns commits, and the result says which happened. See
[Transactions](/guide/transactions).

### Raw SQL

Prisma: ``prisma.$queryRaw`select … where views > ${min}` ``.

<<< @/examples/coming-from.ts#raw

As with `$queryRaw`, interpolations are bound parameters. There is no `$queryRawUnsafe`:
a string never becomes SQL text.

### Delete

Prisma: `prisma.post.delete({ where: { id } })` and `deleteMany({ where })`.

<<< @/examples/coming-from.ts#delete

<<< @/examples/coming-from.ts#delete-many

## Not supported, and what to do instead

| Prisma | In Egon |
|---|---|
| `prisma generate` and `schema.prisma` | Not needed: schema classes are TypeScript. |
| `prisma migrate dev` (migrations from schema changes) | Not supported. Migrations are written by hand; `egon migrate create <name>` writes an empty one to fill in. See [Migrations](/guide/migrations). |
| Fluent API (`prisma.user.findUnique(…).posts()`) | Not supported. Use `assoc(User, user, "posts")` for a query of the related rows, or preload. |
| Nested `select` of relations (`select: { posts: { select: { title: true } } }`) | A preload callback with a `select`: `preload("posts", (q) => q.select(…))`. |
| `createMany` | `repo.insertAll(Post, rows)`: no changesets, no validation, but defaults and timestamps. |
| Client extensions (`$extends`) | No equivalent. Changeset functions, `prepareChanges` and query functions cover the common uses. |
| Prisma Accelerate (pooling and caching as a service) | No equivalent. |
| SQL Server, CockroachDB, and MongoDB (Prisma 6; Prisma 7 does not support it yet) | Not supported: Postgres, SQLite and MySQL only. |

## What works differently

::: tip Good to know
- **Writes return a result.** `repo.insert` returns `{ success: false, error }` for invalid
  input and declared constraints instead of throwing; `insertOrThrow` throws
  `InvalidChangesetError`.
- **Input is filtered by a changeset.** Only the fields a changeset function permits are
  taken from `params`, so a request cannot set `role` by adding it to the body.
- **Updates need the row.** Load it, then `update` a changeset of it; to update by a
  condition without loading, use `updateAll` with `.set(…)`.
- **Relations are associations, loaded with `preload`.** A row's type says which ones
  were loaded, so a missing one is a compile error.
- **Queries are values.** `from(Post, "p").where(…)` can be stored, passed to a function
  and extended before it runs.
- **Explicit transactions.** As with interactive transactions, pass `tx` to the code that
  must run inside.
:::

## See also

- [Introduction](/guide/): the four concepts and why they are separate.
- [Tutorial](/guide/tutorial): a blog, step by step.
- [Recipes](/recipes/): pagination, soft deletes, multi-tenancy and more.
