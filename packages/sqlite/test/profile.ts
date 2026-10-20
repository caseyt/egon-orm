// The SQLite profile of the adapter conformance suite.
import type { AnyFieldType, DbType } from "egon-orm";
import type { AdapterConformanceProfile } from "../../core/test/conformance/adapter/index.js";
import { sqlite } from "../src/index.js";

/** SQLite's column types: integers, reals, text (also for decimals, dates, times and JSON) and blobs. */
const COLUMN_TYPES: Readonly<Record<Exclude<DbType["kind"], "array" | "custom">, string>> = {
  integer: "integer",
  bigint: "integer",
  float: "real",
  decimal: "text",
  boolean: "boolean",
  text: "text",
  uuid: "text",
  binary: "blob",
  date: "text",
  time: "text",
  timestamp: "text",
  timestamptz: "text",
  json: "text",
  jsonb: "text",
};

function columnType(db: DbType): string | undefined {
  if (db.kind === "custom") return db.sql;
  // An array is stored as the JSON text of its elements.
  if (db.kind === "array") return "text";
  return COLUMN_TYPES[db.kind];
}

/** A statement that keeps SQLite busy for about `seconds`: it has no sleep function. */
export function busyFor(seconds: number): string {
  const steps = Math.max(1, Math.round(seconds * 10_000_000));
  return `with recursive busy(x) as (select 1 union all select x + 1 from busy where x < ${steps}) select count(*) as slept from busy`;
}

/** The rows 1..`count` in column `n`. */
export function series(count: number): string {
  return `with recursive s(n) as (select 1 union all select n + 1 from s where n < ${count}) select n from s`;
}

export const SQLITE_PROFILE: AdapterConformanceProfile = {
  label: "sqlite",
  server: "sqlite",
  makeAdapter: (db) => sqlite({ filename: db.settings.database }),
  param: () => "?",
  columnType: (type: AnyFieldType) => columnType(type.db),
  sleep: busyFor,
  series,
  // abs() of the smallest integer overflows: the error comes when that row is stepped.
  failingSeries: (count, failAt) =>
    `with recursive s(n) as (select 1 union all select n + 1 from s where n < ${count}) select n, case when n = ${failAt} then abs(-9223372036854775807 - 1) else 0 end as boom from s`,
  // One handle, and no server process behind it.
  backendId: "select 1 as id",
  terminate: () => Promise.reject(new Error("SQLite has no server process to end.")),
  isolationLevel: "select null as level",
  schema: `
    create table authors (id integer primary key, email text not null constraint authors_email_key unique);
    create table books (
      id integer primary key,
      author_id integer not null constraint books_author_id_fkey references authors (id),
      pages integer not null constraint books_pages_check check (pages > 0)
    );
    create table counters (id integer primary key, value integer not null);
    insert into authors values (1, 'ada@example.com');
    insert into counters values (1, 0), (2, 0);
  `,
  // One writer, and a COMMIT that cannot be cancelled once it runs.
  slowCommit: undefined,
  violations: {
    // SQLite names the columns; the adapter rebuilds the default name from them.
    unique: {
      sql: "insert into authors values (2, 'ada@example.com')",
      constraint: "authors_email_key",
      table: "authors",
      column: "email",
    },
    // SQLite reports neither the constraint nor the table of a foreign-key violation.
    foreignKey: {
      sql: "insert into books values (1, 99, 10)",
      constraint: undefined,
      table: undefined,
      column: undefined,
    },
    check: {
      sql: "insert into books values (1, 1, 0)",
      constraint: "books_pages_check",
      table: undefined,
      column: undefined,
    },
    exclusion: undefined,
    notNull: {
      sql: "insert into authors values (3, null)",
      constraint: undefined,
      table: "authors",
      column: "email",
    },
  },
};
