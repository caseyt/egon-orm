# @egon-orm/mysql

The MySQL adapter for [Egon ORM](https://www.npmjs.com/package/egon-orm), over
[`mysql2`](https://www.npmjs.com/package/mysql2).

## Install

```sh
npm install egon-orm @egon-orm/mysql mysql2
```

`mysql2` 3.11 or later is a peer dependency. Egon is tested against MySQL 8.4.

## Example

<!-- example: docs/site/examples/readme/mysql.ts#example -->
```ts
import { mysql } from "@egon-orm/mysql";
import { createRepo, from, Schema, t } from "egon-orm";

class Order extends Schema("orders", {
  id: t.integer().primaryKey().dbGenerated(),
  total: t.integer(),
}) {}

const repo = createRepo({
  adapter: mysql({ connectionString: process.env.DATABASE_URL, pool: { max: 10 } }),
});

const large = await repo.all(from(Order, "o").where(({ o }) => o.total.gt(1000)));
await repo.close();
```

## Documentation

[Adapters](https://egon-orm.github.io/egon-orm/guide/adapters#mysql) covers the options and
what MySQL does differently; the
[dialect support](https://egon-orm.github.io/egon-orm/reference/dialect-support) table
lists the features per database. The full documentation is at
https://egon-orm.github.io/egon-orm/.

MIT licence.
