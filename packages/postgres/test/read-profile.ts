// The Postgres profile of the read conformance suite.
import { fragment, t, val } from "egon-orm";
import type { ReadConformanceProfile } from "../../core/test/conformance/read/index.js";
import { postgres } from "../src/index.js";
import { POSTGRES_PROFILE } from "./profile.js";

export const POSTGRES_READ_PROFILE: ReadConformanceProfile = {
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
  quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
  columnType: POSTGRES_PROFILE.columnType,
  copyTableInto: (schema, table) =>
    `create schema if not exists ${schema}; create table ${schema}.${table} (like public.${table} including all)`,
  insertSeries: (count) =>
    `insert into stream_rows (id, label) select n, 'row ' || n from generate_series(1, ${count}) as n`,
  insertPairs: (count) =>
    `insert into pairs (a, b) select n, 'k' || (n % 7) from generate_series(1, ${count}) as n`,
  microsecondTimestamp: "timestamptz(6)",
  sleep: (seconds) => fragment`select pg_sleep(${val(seconds, t.float())}) as slept`,
};
