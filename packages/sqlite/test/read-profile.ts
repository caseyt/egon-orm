// The SQLite profile of the read conformance suite.
import { fragment, t, val } from "egon-orm";
import type { ReadConformanceProfile } from "../../core/test/conformance/read/index.js";
import { SQLITE_PROFILE } from "./profile.js";

/** `with recursive s(n) …` producing 1..`count`, ahead of an insert. */
const numbers = (count: number): string =>
  `with recursive s(n) as (select 1 union all select n + 1 from s where n < ${count})`;

export const SQLITE_READ_PROFILE: ReadConformanceProfile = {
  label: "sqlite",
  server: "sqlite",
  makeAdapter: SQLITE_PROFILE.makeAdapter,
  param: () => "?",
  quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
  columnType: SQLITE_PROFILE.columnType,
  // A database schema is an attached database of the adapter's own handle: the suite's DDL,
  // run on another handle, cannot make one. The SQLite tests cover attached databases.
  copyTableInto: undefined,
  insertSeries: (count) =>
    `${numbers(count)} insert into stream_rows (id, label) select n, 'row ' || n from s`,
  insertPairs: (count) => `${numbers(count)} insert into pairs (a, b) select n, 'k' || (n % 7) from s`,
  // Timestamps are text with milliseconds.
  microsecondTimestamp: undefined,
  // SQLite has no sleep function: a recursive count keeps it busy for about that long.
  sleep: (seconds) =>
    fragment`with recursive busy(x) as (select 1 union all select x + 1 from busy where x < ${val(
      Math.max(1, Math.round(seconds * 10_000_000)),
      t.integer(),
    )}) select count(*) as slept from busy`,
};
