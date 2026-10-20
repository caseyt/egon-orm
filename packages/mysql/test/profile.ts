// The MySQL profile of the adapter conformance suite.
import type { AnyFieldType, DbType } from "egon-orm";
import type { AdapterConformanceProfile } from "../../core/test/conformance/adapter/index.js";
import type { TestDatabase } from "../../core/test/support/index.js";
import { mysql } from "../src/index.js";

const COLUMN_TYPES: Readonly<Record<Exclude<DbType["kind"], "array" | "custom">, string>> = {
  integer: "int",
  bigint: "bigint",
  float: "double",
  decimal: "decimal(65, 30)",
  boolean: "boolean",
  text: "text",
  uuid: "char(36)",
  binary: "longblob",
  date: "date",
  time: "time(6)",
  timestamp: "datetime(6)",
  timestamptz: "datetime(6)",
  json: "json",
  jsonb: "json",
};

function columnType(db: DbType): string | undefined {
  if (db.kind === "custom") return db.sql;
  // An array is stored as a JSON array of its elements.
  if (db.kind === "array") return "json";
  return COLUMN_TYPES[db.kind];
}

/** Connects the adapter under test to `db`. */
export function makeMysql(db: TestDatabase, poolMax: number) {
  return mysql({
    host: db.settings.host,
    port: db.settings.port,
    user: db.settings.user,
    password: db.settings.password,
    database: db.name,
    pool: { max: poolMax },
  });
}

/** The rows 1..`count` in column `n`; the recursion limit (1,000 by default) is raised for the statement. */
export function series(count: number): string {
  return `with recursive s(n) as (select 1 union all select n + 1 from s where n < ${count}) select /*+ SET_VAR(cte_max_recursion_depth = ${count + 1}) */ n from s`;
}

export const MYSQL_PROFILE: AdapterConformanceProfile = {
  label: "mysql",
  server: "mysql",
  makeAdapter: (db, { poolMax }) => makeMysql(db, poolMax),
  param: () => "?",
  columnType: (type: AnyFieldType) => columnType(type.db),
  sleep: (seconds) => `select sleep(${seconds}) as slept`,
  series,
  // Extracting from text that is not JSON fails when that row is computed.
  failingSeries: (count, failAt) =>
    `with recursive s(n) as (select 1 union all select n + 1 from s where n < ${count}) select /*+ SET_VAR(cte_max_recursion_depth = ${count + 1}) */ n, case when n = ${failAt} then json_extract('not json', '$') else null end as boom from s`,
  backendId: "select connection_id() as id",
  terminate: async (db, id) => {
    await db.query("kill ?", [id]);
    for (let i = 0; i < 100; i++) {
      const rows = await db.query("select id from information_schema.processlist where id = ?", [id]);
      if (rows.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  },
  // The running transaction's level: @@transaction_isolation is the session's default, which
  // `set transaction` (for the next transaction only) leaves as it is.
  isolationLevel:
    "select lower(isolation_level) as level from performance_schema.events_transactions_current where thread_id = ps_current_thread_id()",
  schema: `
    create table authors (id integer primary key, email varchar(255) not null, constraint authors_email_key unique (email));
    create table books (
      id integer primary key,
      author_id integer not null,
      pages integer not null,
      constraint books_author_id_fkey foreign key (author_id) references authors (id),
      constraint books_pages_check check (pages > 0)
    );
    create table counters (id integer primary key, value integer not null);
    insert into authors values (1, 'ada@example.com');
    insert into counters values (1, 0), (2, 0);
  `,
  violations: {
    unique: {
      sql: "insert into authors values (2, 'ada@example.com')",
      constraint: "authors_email_key",
      table: "authors",
      column: undefined,
    },
    foreignKey: {
      sql: "insert into books values (1, 99, 10)",
      constraint: "books_author_id_fkey",
      table: "books",
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
      table: undefined,
      column: "email",
    },
  },
};
