// The SQLite profile of the compiler conformance suite. A database schema is an attached
// database of the adapter's handle: `audit`, `tenant_1` and `archive` are files next to the
// test database, removed with it.
import { sqliteDialect } from "../../core/src/compiler/dialect.js";
import type { CompilerConformanceProfile } from "../../core/test/conformance/compiler/index.js";
import { sqlite } from "../src/index.js";
import { attachments, blogTable } from "./schemas.js";

/** The database schemas the SQL matrices name. */
const SCHEMAS = ["audit", "tenant_1", "archive"];

export const SQLITE_COMPILER_PROFILE: CompilerConformanceProfile = {
  label: "sqlite",
  server: "sqlite",
  sqlDialect: sqliteDialect,
  makeAdapter: (db) => sqlite({ filename: db.settings.database, attach: attachments(db, SCHEMAS) }),
  async prepare(_db, connection) {
    const statements = [
      "create table audit.audit_logs (id integer primary key autoincrement, action text not null, user_id integer)",
      "create table events (name text not null, payload text)",
      "create table categories (id integer primary key autoincrement, parent_id integer references categories (id), name text not null)",
    ];
    for (const schema of ["tenant_1", "archive"]) {
      statements.push(blogTable("users", schema), blogTable("posts", schema));
    }
    for (const statement of statements) await connection.execute(statement, []);
  },
  timestamp: (iso) => `'${iso}'`,
  restartIds: ["update sqlite_sequence set seq = 100 where name in ('users', 'posts', 'tags', 'categories')"],
};
