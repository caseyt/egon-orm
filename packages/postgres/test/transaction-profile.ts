// The Postgres profile of the transaction conformance suite.
import { fragment } from "egon-orm";
import type { TransactionConformanceProfile } from "../../core/test/conformance/transaction/index.js";
import { POSTGRES_READ_PROFILE } from "./read-profile.js";

const wideColumns = Array.from({ length: 40 }, (_, i) => `c${i} integer not null`).join(", ");

export const POSTGRES_TRANSACTION_PROFILE: TransactionConformanceProfile = {
  label: "postgres",
  server: "postgres",
  makeAdapter: POSTGRES_READ_PROFILE.makeAdapter,
  sleep: POSTGRES_READ_PROFILE.sleep,
  sessionId: fragment`select pg_backend_pid() as id`,
  isolationLevel: fragment`select current_setting('transaction_isolation') as level`,
  schema: `
    create table wide_rows (id bigserial primary key, ${wideColumns}, constraint wide_rows_c0_key unique (c0));
    create table slow_commits (id integer);
    create function slow_commit() returns trigger language plpgsql as $$ begin perform pg_sleep(5); return null; end $$;
    create constraint trigger slow_commit after insert on slow_commits
      deferrable initially deferred for each row execute function slow_commit();
  `,
  // A deferred constraint trigger runs at COMMIT; this one sleeps there.
  slowCommit: fragment`insert into slow_commits values (1)`,
  module: { url: import.meta.url, exportName: "POSTGRES_TRANSACTION_PROFILE" },
  // The application name of a session is visible to every other in pg_stat_activity.
  rendezvous: {
    announce: (marker) => fragment`select set_config('application_name', ${marker}, false) as name`,
    count: (marker) =>
      fragment`select count(*)::int as n from pg_stat_activity where application_name = ${marker}`,
  },
};
