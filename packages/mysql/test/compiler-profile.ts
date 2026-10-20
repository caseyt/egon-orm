// The MySQL profile of the compiler conformance suite. A MySQL database schema is a
// database, named server-wide: the matrices name `audit`, `tenant_1` and `archive`, which
// no other suite uses. They are made fresh when the suite starts (dropped first, so a table
// left by an older fixture is never reused) and dropped when it ends.
import { mysqlDialect } from "../../core/src/compiler/dialect.js";
import type { CompilerConformanceProfile } from "../../core/test/conformance/compiler/index.js";
import { makeMysql } from "./profile.js";

/** The database schemas the SQL matrices name. */
const SCHEMAS = ["audit", "tenant_1", "archive"];

export const MYSQL_COMPILER_PROFILE: CompilerConformanceProfile = {
  label: "mysql",
  server: "mysql",
  sqlDialect: mysqlDialect,
  makeAdapter: (db) => makeMysql(db, 1),
  async prepare(db, connection) {
    const statements = [
      ...SCHEMAS.flatMap((schema) => [`drop database if exists ${schema}`, `create database ${schema}`]),
      "create table audit.audit_logs (id bigint auto_increment primary key, action text not null, user_id bigint)",
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
        statements.push(`create table ${schema}.${table} like \`${db.name}\`.${table}`);
      }
    }
    for (const statement of statements) await connection.execute(statement, []);
  },
  async cleanup(connection) {
    for (const schema of SCHEMAS) await connection.execute(`drop database if exists ${schema}`, []);
  },
  timestamp: (iso) => `'${iso.replace("T", " ").replace("Z", "")}'`,
  restartIds: ["users", "posts", "tags", "categories"].map(
    (table) => `alter table ${table} auto_increment = 101`,
  ),
};
