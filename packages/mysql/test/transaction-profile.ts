// The MySQL profile of the transaction conformance suite.
import { fragment } from "egon-orm";
import type { TransactionConformanceProfile } from "../../core/test/conformance/transaction/index.js";
import { MYSQL_READ_PROFILE } from "./read-profile.js";

const wideColumns = Array.from({ length: 40 }, (_, i) => `c${i} integer not null`).join(", ");

export const MYSQL_TRANSACTION_PROFILE: TransactionConformanceProfile = {
  label: "mysql",
  server: "mysql",
  makeAdapter: MYSQL_READ_PROFILE.makeAdapter,
  sleep: MYSQL_READ_PROFILE.sleep,
  sessionId: fragment`select connection_id() as id`,
  // The running transaction's level: @@transaction_isolation is the session's default.
  isolationLevel: fragment`select lower(isolation_level) as level from performance_schema.events_transactions_current where thread_id = ps_current_thread_id()`,
  schema: `create table wide_rows (id bigint auto_increment primary key, ${wideColumns}, constraint wide_rows_c0_key unique (c0))`,
  module: { url: import.meta.url, exportName: "MYSQL_TRANSACTION_PROFILE" },
  // A session's user variables are visible to every other in performance_schema.
  rendezvous: {
    announce: (marker) => fragment`set @egon_rendezvous = ${marker}`,
    count: (marker) =>
      fragment`select count(*) as n from performance_schema.user_variables_by_thread where variable_name = 'egon_rendezvous' and variable_value = ${marker}`,
  },
};
