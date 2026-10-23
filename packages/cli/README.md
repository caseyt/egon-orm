# @egon-orm/cli

`egon`, the command line of [Egon ORM](https://www.npmjs.com/package/egon-orm): it writes and
runs migrations and creates, drops and resets the development database.

## Install

```sh
npm install -D @egon-orm/cli
```

Beside `egon-orm` and an adapter (`@egon-orm/postgres`, `@egon-orm/sqlite` or
`@egon-orm/mysql`). Node.js 22.12 or later.

## Example

`egon` reads `egon.config.ts` in the current directory:

<!-- example: docs/site/examples/egon.config.ts#config -->
```ts
// egon.config.ts
import { defineConfig } from "@egon-orm/cli";
import { postgres } from "@egon-orm/postgres";

export default defineConfig({
  adapter: postgres({ connectionString: process.env.DATABASE_URL }),
  migrations: {
    directory: "migrations", //      relative to this file; the default
    table: "schema_migrations", //   the default
  },
  // Only for `egon db create | drop | reset`:
  database: {
    name: "blog_dev",
    admin: postgres({ connectionString: process.env.ADMIN_DATABASE_URL }), // e.g. …/postgres
  },
});
```

```sh
npx egon migrate create create_users   # writes migrations/<version>_create_users.ts
npx egon migrate                       # applies the pending migrations
npx egon rollback                      # reverts the last one
npx egon --help
```

A TypeScript config file needs a TypeScript loader: Node.js 22.18 or later strips types by
itself; on 22.12 to 22.17 set `NODE_OPTIONS=--experimental-strip-types`, or use tsx.

## Documentation

The [CLI reference](https://egon-orm.github.io/egon-orm/reference/cli) lists every command
and flag; [Migrations](https://egon-orm.github.io/egon-orm/guide/migrations) covers writing
them. The full documentation is at https://egon-orm.github.io/egon-orm/.

MIT licence.
