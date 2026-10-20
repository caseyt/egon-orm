// The SQLite profile of the read conformance suite.
import { fragment, t, val } from "egon-orm";
import type { ReadConformanceProfile } from "../../core/test/conformance/read/index.js";
import { sqlite } from "../src/index.js";
import { SQLITE_PROFILE } from "./profile.js";
import { attachments, copyTableInto, SUITE_SCHEMAS } from "./schemas.js";

/** `with recursive s(n) …` producing 1..`count`, ahead of an insert. */
const numbers = (count: number): string =>
  `with recursive s(n) as (select 1 union all select n + 1 from s where n < ${count})`;

export const SQLITE_READ_PROFILE: ReadConformanceProfile = {
  label: "sqlite",
  server: "sqlite",
  makeAdapter: (db) => sqlite({ filename: db.settings.database, attach: attachments(db, SUITE_SCHEMAS) }),
  param: () => "?",
  quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
  columnType: SQLITE_PROFILE.columnType,
  // A database schema is an attached database: the adapter attaches the suites' schema
  // files when it opens its handle, and the helper's handle when it first copies into one.
  copyTableInto,
  defaultSchema: () => "main",
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
