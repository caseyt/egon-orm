// The SQLite profile of the preload conformance suite.
import { fragment, t, val } from "egon-orm";
import type { PreloadConformanceProfile } from "../../core/test/conformance/preload/index.js";
import { SQLITE_READ_PROFILE } from "./read-profile.js";

export const SQLITE_PRELOAD_PROFILE: PreloadConformanceProfile = {
  label: "sqlite",
  server: "sqlite",
  makeAdapter: SQLITE_READ_PROFILE.makeAdapter,
  schema: `
    create table shelves (region text, code integer, label text not null, primary key (region, code));
    create table volumes (id integer primary key, shelf_region text, shelf_code integer, title text not null);
    create table categories (id integer primary key, parent_id integer, name text not null);
    create table post_labels (post_id integer not null, tag_id integer not null, featured boolean not null);
  `,
  copyTableInto: SQLITE_READ_PROFILE.copyTableInto,
  insertUsers: (count) =>
    `with recursive s(n) as (select 1 union all select n + 1 from s where n < ${count}) insert into users (id, email) select 1000 + n, 'u' || (1000 + n) || '@example.com' from s`,
  // No sleep function: a recursive count keeps SQLite busy for about that long.
  sleep: (seconds) =>
    fragment`((with recursive busy(x) as (select 1 union all select x + 1 from busy where x < ${val(
      Math.max(1, Math.round(seconds * 10_000_000)),
      t.integer(),
    )}) select count(*) from busy) > 0)`.as<boolean>(),
};
