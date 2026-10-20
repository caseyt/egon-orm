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
  schema: `create table wide_rows (id bigserial primary key, ${wideColumns}, constraint wide_rows_c0_key unique (c0))`,
  module: { url: import.meta.url, exportName: "POSTGRES_TRANSACTION_PROFILE" },
};
