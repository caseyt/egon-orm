// The Postgres profile of the adapter conformance suite.
import type { AnyFieldType, DbType } from "egon-orm";
import type { AdapterConformanceProfile } from "../../core/test/conformance/adapter/index.js";
import { postgres } from "../src/index.js";

const COLUMN_TYPES: Readonly<Record<Exclude<DbType["kind"], "array" | "custom">, string>> = {
  integer: "integer",
  bigint: "bigint",
  float: "double precision",
  decimal: "numeric",
  boolean: "boolean",
  text: "text",
  uuid: "uuid",
  binary: "bytea",
  date: "date",
  time: "time",
  timestamp: "timestamp(3)",
  timestamptz: "timestamptz(3)",
  json: "json",
  jsonb: "jsonb",
};

function columnType(db: DbType): string | undefined {
  if (db.kind === "custom") return db.sql;
  if (db.kind === "array") {
    const element = columnType(db.of);
    return element === undefined ? undefined : `${element}[]`;
  }
  return COLUMN_TYPES[db.kind];
}

export const POSTGRES_PROFILE: AdapterConformanceProfile = {
  label: "postgres",
  server: "postgres",
  makeAdapter: (db, { poolMax }) =>
    postgres({
      host: db.settings.host,
      port: db.settings.port,
      user: db.settings.user,
      password: db.settings.password,
      database: db.name,
      pool: { max: poolMax },
    }),
  param: (n) => `$${n}`,
  columnType: (type: AnyFieldType) => columnType(type.db),
  sleep: (seconds) => `select pg_sleep(${seconds}) as slept`,
  series: (count) => `select n from generate_series(1, ${count}) as n`,
  failingSeries: (count, failAt) =>
    `select n, 1 / (${failAt} - n) as boom from generate_series(1, ${count}) as n`,
  backendId: "select pg_backend_pid() as id",
  terminate: async (db, id) => {
    // With a timeout, pg_terminate_backend waits until the process has ended (Postgres 14+).
    await db.query("select pg_terminate_backend($1, 5000)", [id]);
  },
  isolationLevel: "select current_setting('transaction_isolation') as level",
  schema: `
    create table authors (id integer primary key, email text not null constraint authors_email_key unique);
    create table books (
      id integer primary key,
      author_id integer not null constraint books_author_id_fkey references authors (id),
      pages integer not null constraint books_pages_check check (pages > 0)
    );
    create table bookings (id integer primary key, during int4range not null,
      constraint bookings_during_excl exclude using gist (during with &&));
    create table counters (id integer primary key, value integer not null);
    insert into authors values (1, 'ada@example.com');
    insert into bookings values (1, '[1,5)');
    insert into counters values (1, 0), (2, 0);
    create table slow_commits (id integer);
    create function slow_commit() returns trigger language plpgsql as $$ begin perform pg_sleep(5); return null; end $$;
    create constraint trigger slow_commit after insert on slow_commits
      deferrable initially deferred for each row execute function slow_commit();
  `,
  // A deferred constraint trigger runs at COMMIT; this one sleeps there.
  slowCommit: "insert into slow_commits values (1)",
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
      table: "books",
      column: undefined,
    },
    exclusion: {
      sql: "insert into bookings values (2, '[3,7)')",
      constraint: "bookings_during_excl",
      table: "bookings",
      column: undefined,
    },
    notNull: {
      sql: "insert into authors values (3, null)",
      constraint: undefined,
      table: "authors",
      column: "email",
    },
  },
};
