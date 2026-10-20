// The SQLite profile of the compiler conformance suite. A database schema is an attached
// database of the adapter's handle: `audit`, `tenant_1` and `archive` are files next to the
// test database, removed with it.
import { dirname, join } from "node:path";
import { sqliteDialect } from "../../core/src/compiler/dialect.js";
import type { CompilerConformanceProfile } from "../../core/test/conformance/compiler/index.js";
import { readFixture } from "../../core/test/support/index.js";
import { sqlite } from "../src/index.js";

/** The `create table` statement of `table` in the blog fixture, placed in database schema `schema`. */
function blogTable(fixture: string, table: string, schema: string): string {
  const match = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(fixture);
  if (match === null) throw new Error(`The SQLite blog fixture has no table ${table}.`);
  return `create table ${schema}.${table} (${match[1]})`;
}

export const SQLITE_COMPILER_PROFILE: CompilerConformanceProfile = {
  label: "sqlite",
  server: "sqlite",
  sqlDialect: sqliteDialect,
  makeAdapter: (db) => sqlite({ filename: db.settings.database }),
  async prepare(db, connection) {
    const directory = dirname(db.settings.database);
    for (const schema of ["audit", "tenant_1", "archive"]) {
      await connection.execute(`attach database ? as ${schema}`, [join(directory, `${schema}.sqlite`)]);
    }
    const fixture = await readFixture("blog", "sqlite");
    const statements = [
      "create table audit.audit_logs (id integer primary key autoincrement, action text not null, user_id integer)",
      "create table events (name text not null, payload text)",
      "create table categories (id integer primary key autoincrement, parent_id integer references categories (id), name text not null)",
    ];
    for (const schema of ["tenant_1", "archive"]) {
      statements.push(blogTable(fixture, "users", schema), blogTable(fixture, "posts", schema));
    }
    for (const statement of statements) await connection.execute(statement, []);
  },
  timestamp: (iso) => `'${iso}'`,
  restartIds: ["update sqlite_sequence set seq = 100 where name in ('users', 'posts', 'tags', 'categories')"],
};
