# egon-orm

A TypeScript ORM for Postgres, SQLite and MySQL with schemas, changesets, composable
queries and a repo, typed end to end with no code generation.

- **Typed from the schema.** Row types, preloaded associations and `select` results are
  inferred from your classes. No generate step.
- **Changes are values.** A changeset filters and validates input and turns a violated
  unique index into a field error. Writes return `{ success: true, data }`
  or `{ success: false, error }`.
- **Queries are values.** Build them in one place, extend them in another; every value is
  a bound parameter.
- **Nothing implicit.** No lazy loading, no `save()` on rows, no transaction you did not open.

This is the core package. Pair it with an adapter: `@egon-orm/postgres`, `@egon-orm/sqlite`
or `@egon-orm/mysql`.

## Install

```sh
npm install egon-orm @egon-orm/postgres pg
```

Node.js 22.12 or later. The packages are ES modules; a CommonJS project loads them with
`require()`.

## Example

<!-- example: docs/site/examples/readme/core.ts#example -->
```ts
import { postgres } from "@egon-orm/postgres";
import { cast, createRepo, from, Schema, t } from "egon-orm";

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
}) {
  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"]).validateRequired(["email"]).uniqueConstraint("email");
  }
}

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

const result = await repo.insert(User.changeset(User, { email: "ada@example.com" }));
// A taken email is a field error, not an exception: { email: ["has already been taken"] }
if (!result.success) console.log(result.error.errorMessages());

const named = await repo.all(from(User, "u").where(({ u }) => u.name.isNotNull()));
```

## Entry points

| Import | What it holds |
|---|---|
| `egon-orm` | Schemas, types, changesets, queries, the repo, batches, errors |
| `egon-orm/migration` | `defineMigration` and the migration runner (the `egon` command is `@egon-orm/cli`) |
| `egon-orm/testing` | The test sandbox and query assertions |
| `egon-orm/messages` | The full text of error messages, for development |

## Documentation

https://egon-orm.github.io/egon-orm/ — start with
[Getting started](https://egon-orm.github.io/egon-orm/guide/getting-started).

MIT licence.
