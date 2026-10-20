// The SQLite profile of the write conformance suite.
import { fragment, t, val } from "egon-orm";
import type { WriteConformanceProfile } from "../../core/test/conformance/write/index.js";
import { SQLITE_PROFILE } from "./profile.js";
import { SQLITE_READ_PROFILE } from "./read-profile.js";

export const SQLITE_WRITE_PROFILE: WriteConformanceProfile = {
  label: "sqlite",
  server: "sqlite",
  makeAdapter: SQLITE_READ_PROFILE.makeAdapter,
  columnType: SQLITE_PROFILE.columnType,
  generatedKey: "integer primary key autoincrement",
  schema: `
    create table books (id integer primary key autoincrement, title text not null, pages integer not null,
      constraint books_pages_check check (pages > 0));
    create table stamps (id integer primary key autoincrement, label text not null, code text not null default 'db-code',
      note text default 'db-note', made_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
  `,
  // SQLite has no range types, and no exclusion constraints.
  rangeType: undefined,
  copyTableInto: SQLITE_READ_PROFILE.copyTableInto,
  // No sleep function: a recursive count keeps SQLite busy for about that long.
  sleep: (seconds) =>
    fragment`(select count(*) * 0 from (with recursive busy(x) as (select 1 union all select x + 1 from busy where x < ${val(
      Math.max(1, Math.round(seconds * 10_000_000)),
      t.integer(),
    )}) select x from busy))`.as<number>(),
};
