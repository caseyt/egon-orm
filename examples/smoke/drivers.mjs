// Each adapter against its driver, as installed in a consumer project by
// `consumer.mjs --drivers` (with `--peers lower` or `--peers upper` for the bounds of the
// peer-dependency ranges): insert through a changeset, read back, a transaction that rolls
// back, a stream, and a unique-constraint violation reported as a changeset error. Then
// @egon-orm/zod against the installed Zod.
//
// Postgres runs always (the Compose database on 127.0.0.1:54329, or EGON_PG_*); MySQL when
// EGON_TEST_TIER2=1 (127.0.0.1:33069, or EGON_MYSQL_*); SQLite in memory. Each run uses a
// table of its own with a random name and drops it at the end, so runs can share a server.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mysql } from "@egon-orm/mysql";
import { postgres } from "@egon-orm/postgres";
import { sqlite } from "@egon-orm/sqlite";
import { castWith, toZod } from "@egon-orm/zod";
import { cast, createRepo, from, Schema, t } from "egon-orm";
import { z } from "zod";

const env = process.env;
const table = `egon_peers_${randomBytes(4).toString("hex")}`;
// The installed version of a dependency of the consumer project (not every package exports
// its package.json, so it is read from node_modules).
const version = (name) =>
  JSON.parse(readFileSync(new URL(`node_modules/${name}/package.json`, import.meta.url), "utf8")).version;

class Item extends Schema(table, {
  id: t.integer().primaryKey().dbGenerated(),
  name: t.string(),
  qty: t.integer(),
}) {
  static changeset(item, params) {
    return cast(item, params, ["name", "qty"])
      .validateRequired(["name", "qty"])
      .validateNumber("qty", { greaterThanOrEqualTo: 0 })
      .uniqueConstraint("name");
  }
}

const ddl = {
  postgres: `create table ${table} (id serial primary key, name text not null unique, qty integer not null)`,
  // MySQL names an inline unique index after its column; this one gets the name a changeset's
  // uniqueConstraint("name") expects by default.
  mysql: `create table ${table} (id int auto_increment primary key, name varchar(100) not null, qty int not null, unique key ${table}_name_key (name))`,
  sqlite: `create table ${table} (id integer primary key, name text not null unique, qty integer not null)`,
};

async function exercise(dialect, adapter, driver) {
  const repo = createRepo({ adapter });
  try {
    await adapter.execute(ddl[dialect], []);
    try {
      const first = await repo.insert(Item.changeset(Item, { name: "bolt", qty: 3 }));
      assert.ok(first.success, `${dialect}: insert failed`);
      assert.equal(typeof first.data.id, "number");
      await repo.insertOrThrow(Item.changeset(Item, { name: "nut", qty: 5 }));

      const taken = await repo.insert(Item.changeset(Item, { name: "bolt", qty: 1 }));
      assert.ok(!taken.success, `${dialect}: a duplicate name was inserted`);
      assert.deepEqual(taken.error.errorMessages(), { name: ["has already been taken"] });

      const rows = await repo.all(from(Item, "i").orderBy(({ i }) => i.name.asc()));
      assert.deepEqual(
        rows.map((row) => [row.name, row.qty]),
        [
          ["bolt", 3],
          ["nut", 5],
        ],
      );

      const rolledBack = await repo.transaction(async (tx) => {
        await tx.insertOrThrow(Item.changeset(Item, { name: "washer", qty: 9 }));
        return tx.rollback("undo");
      });
      assert.deepEqual(rolledBack, { success: false, error: "undo" });
      assert.equal(await repo.count(from(Item, "i")), 2);

      const streamed = [];
      for await (const row of repo.stream(
        from(Item, "i").orderBy(({ i }) => i.id.asc()),
        { batchSize: 1 },
      )) {
        streamed.push(row.name);
      }
      assert.deepEqual(streamed, ["bolt", "nut"]);
      console.log(`drivers: ${dialect} ok (${driver})`);
    } finally {
      await adapter.execute(`drop table ${table}`, []);
    }
  } finally {
    await repo.close();
  }
}

await exercise("sqlite", sqlite({ filename: ":memory:" }), `better-sqlite3 ${version("better-sqlite3")}`);

await exercise(
  "postgres",
  postgres({
    host: env.EGON_PG_HOST || "127.0.0.1",
    port: Number(env.EGON_PG_PORT || 54329),
    user: env.EGON_PG_USER || "egon",
    password: env.EGON_PG_PASSWORD || "egon",
    database: env.EGON_PG_DATABASE || "egon_dev",
  }),
  `pg ${version("pg")}, pg-cursor ${version("pg-cursor")}`,
);

if (env.EGON_TEST_TIER2 === "1") {
  await exercise(
    "mysql",
    mysql({
      host: env.EGON_MYSQL_HOST || "127.0.0.1",
      port: Number(env.EGON_MYSQL_PORT || 33069),
      user: env.EGON_MYSQL_USER || "root",
      password: env.EGON_MYSQL_PASSWORD || "egon",
      database: env.EGON_MYSQL_DATABASE || "egon_dev",
    }),
    `mysql2 ${version("mysql2")}`,
  );
} else {
  console.log("drivers: mysql skipped (set EGON_TEST_TIER2=1)");
}

// @egon-orm/zod: a derived schema parses, and castWith reports Zod's issues as field errors.
const InsertItem = toZod(Item, { mode: "insert", pick: ["name", "qty"] });
assert.deepEqual(InsertItem.parse({ name: "bolt", qty: 1 }), { name: "bolt", qty: 1 });
assert.equal(InsertItem.safeParse({ name: "bolt", qty: "many" }).success, false);
const checked = castWith(Item, { name: "", qty: 1 }, InsertItem.extend({ name: z.string().min(1) }));
assert.equal(checked.valid, false);
assert.deepEqual(Object.keys(checked.errorMessages()), ["name"]);
console.log(`drivers: zod ok (zod ${version("zod")})`);
