// The MySQL profile of the compiler conformance suite. A MySQL database schema is a
// database: the matrices name `audit`, `tenant_1` and `archive`, so those three are created
// on the test server when missing and kept (their tables stay empty: every statement that
// writes to them is rolled back). They are not named like a test database, so the sweep
// leaves them alone.
import { mysqlDialect } from "../../core/src/compiler/dialect.js";
import type { CompilerConformanceProfile } from "../../core/test/conformance/compiler/index.js";
import { makeMysql } from "./profile.js";

export const MYSQL_COMPILER_PROFILE: CompilerConformanceProfile = {
  label: "mysql",
  server: "mysql",
  sqlDialect: mysqlDialect,
  makeAdapter: (db) => makeMysql(db, 1),
  async prepare(db, connection) {
    const statements = [
      "create database if not exists audit",
      "create database if not exists tenant_1",
      "create database if not exists archive",
      "create table if not exists audit.audit_logs (id bigint auto_increment primary key, action text not null, user_id bigint)",
      "create table events (name text not null, payload json)",
      `create table categories (
        id bigint auto_increment primary key,
        parent_id bigint,
        name text not null,
        constraint categories_parent_id_fkey foreign key (parent_id) references categories (id)
      )`,
    ];
    for (const schema of ["tenant_1", "archive"]) {
      for (const table of ["users", "posts"]) {
        statements.push(`create table if not exists ${schema}.${table} like \`${db.name}\`.${table}`);
      }
    }
    for (const statement of statements) await connection.execute(statement, []);
  },
  timestamp: (iso) => `'${iso.replace("T", " ").replace("Z", "")}'`,
  restartIds: ["users", "posts", "tags", "categories"].map(
    (table) => `alter table ${table} auto_increment = 101`,
  ),
};
