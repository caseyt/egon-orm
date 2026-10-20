// The SQLite profile of the transaction conformance suite.
import { fragment } from "egon-orm";
import type { TransactionConformanceProfile } from "../../core/test/conformance/transaction/index.js";
import { SQLITE_READ_PROFILE } from "./read-profile.js";

const wideColumns = Array.from({ length: 40 }, (_, i) => `c${i} integer not null`).join(", ");

export const SQLITE_TRANSACTION_PROFILE: TransactionConformanceProfile = {
  label: "sqlite",
  server: "sqlite",
  makeAdapter: SQLITE_READ_PROFILE.makeAdapter,
  sleep: SQLITE_READ_PROFILE.sleep,
  // One handle, and no session to tell apart.
  sessionId: fragment`select 1 as id`,
  // SQLite has no isolation levels to choose from.
  isolationLevel: fragment`select null as level`,
  schema: `
    create table wide_rows (id integer primary key autoincrement, ${wideColumns}, constraint wide_rows_c0_key unique (c0));
    create table egon_rendezvous (marker text not null);
  `,
  module: { url: import.meta.url, exportName: "SQLITE_TRANSACTION_PROFILE" },
  // No sessions to list: each file writes its marker into a table, committed at once.
  rendezvous: {
    announce: (marker) => fragment`insert into egon_rendezvous (marker) values (${marker})`,
    count: (marker) => fragment`select count(*) as n from egon_rendezvous where marker = ${marker}`,
  },
};
