# Getting started

## Install

```sh
pnpm add egon-orm @egon-orm/postgres pg
```

Egon ORM needs Node 22.12 or later and is published as ES modules. A CommonJS project can
load it with `require()` on those Node versions.

For SQLite or MySQL, install `@egon-orm/sqlite` with `better-sqlite3`, or
`@egon-orm/mysql` with `mysql2`. See [Adapters](/guide/adapters).

## Create the tables

Migrations are not part of the first release (see the [Roadmap](/reference/roadmap)).
Create tables with the tool you already use, or with plain SQL:

```sql
create table users (
  id bigserial primary key,
  email text not null unique,
  name text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table posts (
  id bigserial primary key,
  author_id bigint not null references users (id),
  title text not null,
  published boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

## Define two schemas

```ts
// schemas.ts
import { Schema, t, timestamps, hasMany, belongsTo, cast } from "egon-orm";

export class User extends Schema("users", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"])
      .validateRequired(["email"])
      .validateFormat("email", /^[^@\s]+@[^@\s]+$/)
      .uniqueConstraint("email");
  }
}

export class Post extends Schema("posts", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  authorId: t.bigint({ mode: "number" }),
  title: t.string(),
  published: t.boolean().default(false),
  ...timestamps(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
}
```

`bigserial` columns are 64-bit, so the keys use `t.bigint({ mode: "number" })`, which
gives a plain `number`. For a 32-bit `serial` column use `t.integer()`.

## Connect

```ts
// repo.ts
import { createRepo } from "egon-orm";
import { postgres } from "@egon-orm/postgres";
```

<<< @/examples/repo.ts#create

The repo is an ordinary value. Export it and import it where you need it.

## Insert

```ts
const result = await repo.insert(User.changeset(User, { email: "ada@example.com" }));

if (!result.success) {
  console.log(result.error.errorMessages()); // { email: ["has already been taken"] }
} else {
  console.log(result.data.id); // number
}
```

## Query

```ts
import { from, count } from "egon-orm";
```

<<< @/examples/repo.ts#query

Preloading (`.preload("posts")`) is described in [Associations](/guide/associations).

## Update and delete

```ts
const updated = await repo.updateOrThrow(User.changeset(ada, { name: "Ada" }));
await repo.deleteOrThrow(updated);
```

## Shut down

```ts
await repo.close(); // waits for running queries, then closes the pool
```

## Next

- [Schemas](/guide/schemas) for every field option.
- [Changesets](/guide/changesets) for validating and tracking changes.
- [Queries](/guide/queries) for the query builder.
- [Repo](/guide/repo) for every read and write method.
