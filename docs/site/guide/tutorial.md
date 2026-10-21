# Tutorial: a blog

This tutorial builds a small blog with each part of the library in turn: schemas, a
migration, a sign-up form validated with Zod, queries and preloads, a form that edits a
post together with its comments, a batch that publishes a post and notifies readers, and
tests that run each case in a transaction that is rolled back.

The code on this page is the source of a working application,
[`examples/blog`](https://github.com/egon-orm/egon-orm/tree/main/examples/blog) in the
repository, and its test suite runs in CI. Every block starts with the name of its file.
You can read the page from top to bottom, or clone the repository and run it (see the
end).

It takes about thirty minutes. You need Node.js 22.18 or later and a Postgres server, 14 or
later. (The `egon` command loads your TypeScript configuration and migrations with Node's own
type stripping, which 22.18 turns on by itself; on 22.12 to 22.17, see the
[CLI](/reference/cli#configuration).)

## 1. Set up the project

```sh
mkdir blog && cd blog
npm init -y
npm pkg set type=module
npm install egon-orm @egon-orm/postgres pg zod
npm install -D @egon-orm/cli typescript vitest @types/node @types/pg
mkdir -p src/migrations test
```

Egon is published as ES modules only, hence `"type": "module"`.

`@egon-orm/cli` is the `egon` command: it writes migration files, applies them, and creates
databases. It is a development dependency, run with `npx egon`.

Add a `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true
  },
  "include": ["src", "test", "egon.config.ts", "vitest.config.ts"]
}
```

Node.js and Vitest run the TypeScript; `npx tsc` checks its types (`@types/pg` is for `tsc`:
the adapter's types refer to `pg`'s). The imports between your own files end in `.js`, as
Node.js expects.

Start a database and tell the application where it is:

```sh
docker run -d --name blog-db -e POSTGRES_PASSWORD=blog -e POSTGRES_DB=blog -p 5432:5432 postgres:16
export DATABASE_URL=postgres://postgres:blog@localhost:5432/blog
```

`POSTGRES_DB=blog` creates the blog's own database, so its tables do not land in the server's
default `postgres` database. Without Docker, any Postgres 14 or later works (a local install
or a hosted one): point `DATABASE_URL` at a database named `blog` there, and create it with
`npx egon db create` once the configuration of step 3 exists.

## 2. Connect

The **repo** is the one object that talks to the database. It takes an **adapter**, which
wraps the driver (`pg` here):

<<< ../../../examples/blog/src/db.ts#db

Nothing connects until the first query. The repo is an ordinary value: other files import
it.

## 3. Create the tables

A migration describes a change to the database. `egon` reads where the migrations are, and
which database they run on, from `egon.config.ts` at the root of the project:

<<< ../../../examples/blog/egon.config.ts#config

`DATABASE_URL` (step 1) names the database. `database` is for `egon db` (step 10): the name
of the database to create, and an adapter connected to the same server's `postgres`
database, through which `CREATE DATABASE` runs.

Then let `egon` write the migration file:

```sh
npx egon migrate create create_blog
```

It prints the path of a new file in `src/migrations`, such as
`src/migrations/20261020090000_create_blog.ts`: its name starts with its version (the
current UTC time, `YYYYMMDDHHMMSS`) and then its name. The file has an empty `up` and
`down`. Fill them in:

<<< ../../../examples/blog/src/migrations/20261020090000_create_blog.ts#migration

`up` makes the change and `down` undoes it, so the migration can be rolled back.
`table.references` adds a foreign key, and `.unique()` a unique index named
`users_email_key`; the changesets below refer to these names. The table builder is named
`table` because `t` is the field builder of the schema classes, imported from `egon-orm`.

Apply it:

```sh
npx egon migrate
```

`egon migrate` applies every pending migration, each in its own transaction, and prints one
line per migration; `npx egon migrations` lists them with their state. The
[Migrations](/guide/migrations) guide covers rollbacks (`npx egon rollback`) and deployments,
and the [CLI](/reference/cli) page lists every command.

## 4. Describe the tables

A **schema** is a class that describes one table. Its instances are the rows the database
returns, so the class name is the row type. All the classes of this step go in one file,
`src/schemas.ts`, which starts with:

<<< ../../../examples/blog/src/schemas.ts#imports

<<< ../../../examples/blog/src/schemas.ts#user

- Fields are **non-null unless they say `.nullable()`**: `name` is a `string`, never
  `null`.
- Field names are camelCase and columns snake_case: `passwordHash` is the column
  `password_hash`.
- `password` is `.virtual()`: a sign-up form can send it, but it is never stored.
- There is no `new User(...)`. A `User` comes only from the database.

A post belongs to its author, and has comments:

<<< ../../../examples/blog/src/schemas.ts#post

Associations are `static` members that point at the other class through a function, so
two classes can refer to each other. The foreign key, `authorId`, is an ordinary field
you declare. A schema class can have getters and methods, like `isPublished`, and
**changeset functions**: static methods that say which fields a form may change and how to
check them.

<<< ../../../examples/blog/src/schemas.ts#comment

Last, the two tables that step 9 uses, for readers who follow an author and the
notifications they get:

<<< ../../../examples/blog/src/schemas.ts#follow

## 5. Sign up with a changeset

Writes go through a **changeset**: a value that holds the input a form sent, filtered to
the fields it may change and converted to their types, with the validation errors and the
database constraints to watch for. It never touches the database.

<<< ../../../examples/blog/src/accounts.ts#registration

`cast` keeps only `email`, `name` and `password` from `params`: a request that also sends
`passwordHash` or `id` has no effect. The Zod schema reports every problem at once, each on
its field, and a field gets one message: `name: ""` is `can't be blank` (`cast` turns the
empty string into `null`, which a non-null field refuses), and Zod's own complaint about
the missing value is not added. `uniqueConstraint("email")` tells the repo that a violation of
`users_email_key` is a form error, not a crash. `pipe` applies a step of your own: here,
hashing the password once the input is valid.

The repo writes the changeset and returns a **result**, never a half-saved row. In the same
file:

<<< ../../../examples/blog/src/accounts.ts#register

`result.success` tells the two cases apart. On failure, `result.error` is the changeset
with its errors; `errorMessages()` gives `{ email: ["has already been taken"] }`, ready for a
form. Every write also has a throwing twin, `insertOrThrow`, for code where a failure is
a bug.

## 6. Write posts

The functions of steps 6 and 7 go in `src/posts.ts`, which starts with:

<<< ../../../examples/blog/src/posts.ts#imports

<<< ../../../examples/blog/src/posts.ts#write

The author is put on the changeset with `putChange`, not cast from the form: a reader
cannot post in someone else's name by sending `authorId`. `Post.changeset` takes the class
for a new post and a loaded row for an update; an update writes only the columns that
changed.

## 7. Read with queries

A **query** is an immutable value. Building one runs nothing, so a base query can be kept
in a constant and extended:

<<< ../../../examples/blog/src/posts.ts#feed

`from(Post, "p")` names the table `p`, its **binding**; the callbacks receive the bindings
by name. Every value in a query is sent as a bound parameter. `preload("author")` loads
the authors of the whole page in one more query, whatever the number of posts.

Nothing is loaded lazily. A preloaded association is in the row's type, so the compiler
knows which rows have their author and comments:

<<< ../../../examples/blog/src/posts.ts#post-page

Calling `render` with a post loaded without its comments is a compile error, not an
`undefined` at run time.

A `select` decides the shape and the type of the result:

<<< ../../../examples/blog/src/posts.ts#stats

`joinAssoc` writes the join condition from the association.

## 8. A form with nested rows

This step's two functions go in `src/comments.ts`:

<<< ../../../examples/blog/src/comments.ts#imports

Readers comment:

<<< ../../../examples/blog/src/comments.ts#add

A moderator edits a post and its comments in one form: fix a typo in one comment, delete
spam, reply. The changeset of the post carries a changeset for each comment:

<<< ../../../examples/blog/src/comments.ts#moderate

`castAssoc("comments")` reads `params.comments`, matches each item to an existing comment
by `id` (an update) or creates one (no `id`), and validates each with
`Comment.changeset`. Comments the form leaves out are deleted, because the association
says `onReplace: "delete"`; without it, leaving one out is an error, so nothing is ever
removed by accident. The association has to be preloaded first: the changeset compares
the form with what is there.

`repo.update` writes the post and every comment in one transaction. If one comment is
invalid, nothing is written and the errors come back nested, one entry per submitted
comment, in the order of the form: a form that keeps an existing comment as it is and adds
one with an empty body gets `{ comments: [{}, { body: ["can't be blank"] }] }`. The `{}`
says that the first item is valid, so a form can show each item's errors next to it.

## 9. Publish and notify, in one batch

Publishing sets `publishedAt` and creates a notification for each reader who follows the
author (the `Subscription` and `Notification` classes of step 4).

A **batch** is a list of named steps that run in one transaction. Each step can use the
results of the steps before it, by name and fully typed. In `src/publishing.ts`:

<<< ../../../examples/blog/src/publishing.ts#imports

<<< ../../../examples/blog/src/publishing.ts#publish

Three functions appear here for the first time. `change(row, values)` is the changeset of
values you trust, such as a timestamp your code computed: unlike `cast`, it filters and
converts nothing ([Creating a changeset](/guide/changesets#creating-a-changeset)). A `run`
step returns `success(value)` to go on, with `value` as its result, or `failure(error)` to
stop the batch and roll it back ([Steps](/guide/batch#steps)).

The batch takes the post's id and reads the post again, locked, as its first step. A `Post`
object in memory is a copy of the row as it was read: one read before someone else
published the post still says `publishedAt: null`, so a guard that trusted it would
publish twice. Reading the row in the transaction, with `lock("update")`, makes the guard
see the current row, and keeps a second publisher waiting until the first one's
transaction ends.

If any step fails, everything is rolled back and the result says which step failed and
what had already completed. `result.error.step` is typed as the names of the steps that can
fail, here `"unpublished" | "published"` (the `run` step that may return `failure`, and the
update); a read such as `one` cannot fail, so it is not in the union. `publish` returns
`published: true` or `false` beside the rest, so a caller can tell the two cases apart with
one check. Because a batch is a value, a test can check its steps without running
it (see below).

## 10. Test it

Tests need a database of their own. Create it with `egon db create`, with `DATABASE_URL`
naming it for that one command:

```sh
DATABASE_URL=postgres://postgres:blog@localhost:5432/blog_test npx egon db create
```

`egon.config.ts` (step 3) takes the name of the database to create, `blog_test`, from
`DATABASE_URL`.

A Vitest setup file brings its tables up to date before the tests run:

<<< ../../../examples/blog/test/setup.ts#setup

It calls `createMigrator`, the runner behind `egon migrate`, rather than the command, so the
tests always run against the current tables and `npx vitest run` needs nothing before it.

The Vitest configuration names the test files and the setup file:

<<< ../../../examples/blog/vitest.config.ts#config

Then run the tests against the test database:

```sh
DATABASE_URL=postgres://postgres:blog@localhost:5432/blog_test npx vitest run
```

With another Postgres, the URL names your server and the test database:
`postgres://<user>:<password>@<host>:<port>/blog_test`.

`egon-orm/testing` has a **sandbox**: each test runs in a transaction that is rolled back
afterwards, so tests see their own writes, start from empty tables, and need no cleanup.
It works with the repo your application already imports, and test files that run at the
same time do not see each other's rows. Every test file sets it up for itself:

<<< ../../../examples/blog/test/accounts.itest.ts#sandbox

Test data is plain functions, in a file the tests share:

<<< ../../../examples/blog/test/factories.ts#factory

The tests of the feed and the moderation form are a second test file, with the same
sandbox setup. `expectQueries` returns the statements a piece of code ran, so the first
test can pin down that the feed does not run one query per post; the second sends the
nested form, with an update, an insert and a delete in one call:

<<< ../../../examples/blog/test/posts.itest.ts#file

And publishing, in a third file. Its last test checks the batch as data, without running
it:

<<< ../../../examples/blog/test/publishing.itest.ts#file

The repository's blog has a few more tests (`test/pages.itest.ts`: creating a post, the
post page, the statistics, an invalid comment), written the same way.

### Running the blog from the repository

The finished blog is in the repository, with its tests. They use the Postgres that the
repository's Docker Compose file starts (on port 54329), and give each test file a database
of its own:

```sh
pnpm i
pnpm db:up
pnpm --filter @egon-orm/example-blog test
```

## What you used

| Part | What it did here | Guide |
|---|---|---|
| Schema | `User`, `Post`, `Comment`: fields, associations, a getter, changeset functions | [Schemas](/guide/schemas) |
| Migration | the tables, keys and constraint names, written with `egon migrate create` and applied with `egon migrate` | [Migrations](/guide/migrations), [CLI](/reference/cli) |
| Changeset | sign-up and post forms: permitted fields, Zod, unique email | [Changesets](/guide/changesets), [Validation](/guide/validation) |
| Query | the feed, the post page, statistics | [Queries](/guide/queries) |
| Preload | authors and comments, without N+1 | [Associations](/guide/associations) |
| Nested changeset | the moderation form | [Nested changesets](/guide/nested-changesets) |
| Batch | publish and notify | [Batch](/guide/batch) |
| Sandbox | tests without cleanup | [Testing](/guide/testing) |

::: tip Good to know
- **Rows are data.** There is no `post.save()`: you describe a change with a changeset
  and give it to the repo. A row in memory is a copy of the database row as it was read.
- **Writes return a result.** Check `result.success`, or use the `OrThrow` twin.
- **Nothing is loaded lazily.** Preload what a page needs; the types tell you when you
  forgot.
- **Transactions are explicit.** Only a batch, `repo.transaction`, or a write that spans
  several statements (the moderation form) opens one.
:::

## See also

- [Recipes](/recipes/) for pagination, soft deletes, upserts and other common tasks.
- [Framework integration](/guide/frameworks) for using the repo in a web server.
- Coming from [Prisma](/guide/coming-from-prisma), [Drizzle](/guide/coming-from-drizzle) or
  [Sequelize](/guide/coming-from-sequelize).
