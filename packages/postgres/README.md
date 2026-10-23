# @egon-orm/postgres

The PostgreSQL adapter for [Egon ORM](https://www.npmjs.com/package/egon-orm), over
[`pg`](https://www.npmjs.com/package/pg). Postgres is the fully supported database: every
feature, every test.

## Install

```sh
npm install egon-orm @egon-orm/postgres pg
```

`pg` 8.23 or later is a peer dependency. Two optional peers: `pg-cursor` (2.22 or later),
which `repo.stream` loads on its first use, and, in a TypeScript project, `@types/pg`
(8.23 or later), since the adapter's options can take a `pg.Pool` of your own.

## Example

<!-- example: docs/site/examples/readme/postgres.ts#example -->
```ts
import { postgres } from "@egon-orm/postgres";
import { createRepo, from, Schema, t } from "egon-orm";

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
}) {}

const repo = createRepo({
  adapter: postgres({ connectionString: process.env.DATABASE_URL, pool: { max: 10 } }),
});

const latest = await repo.all(
  from(Post, "p")
    .orderBy(({ p }) => p.id.desc())
    .limit(10),
);
await repo.close();
```

## Documentation

[Adapters](https://egon-orm.github.io/egon-orm/guide/adapters) covers the connection
options, pools, timeouts and how database errors are reported. The full documentation is
at https://egon-orm.github.io/egon-orm/.

MIT licence.
