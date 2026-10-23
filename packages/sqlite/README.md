# @egon-orm/sqlite

The SQLite adapter for [Egon ORM](https://www.npmjs.com/package/egon-orm), over
[`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3).

## Install

```sh
npm install egon-orm @egon-orm/sqlite better-sqlite3
```

`better-sqlite3` 12.4.1 or later, or 13, is a peer dependency. better-sqlite3 13 needs
Node-API 10 (Node.js 22.14 or later); on Node.js 22.12 and 22.13 use 12.

## Example

<!-- example: docs/site/examples/readme/sqlite.ts#example -->
```ts
import { sqlite } from "@egon-orm/sqlite";
import { createRepo, from, Schema, t } from "egon-orm";

class Note extends Schema("notes", {
  id: t.integer().primaryKey().dbGenerated(),
  body: t.string(),
}) {}

const repo = createRepo({ adapter: sqlite({ filename: "app.db", pragmas: { journal_mode: "WAL" } }) });

const notes = await repo.all(from(Note, "n").where(({ n }) => n.body.like("%egon%")));
await repo.close();
```

## Documentation

[Adapters](https://egon-orm.github.io/egon-orm/guide/adapters#sqlite) covers the options,
attached databases and what SQLite does differently; the
[dialect support](https://egon-orm.github.io/egon-orm/reference/dialect-support) table
lists the features per database. The full documentation is at
https://egon-orm.github.io/egon-orm/.

MIT licence.
