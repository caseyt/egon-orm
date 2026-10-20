// The SQLite profile of the nested-write conformance suite.
import type { NestedConformanceProfile } from "../../core/test/conformance/nested/index.js";
import { SQLITE_READ_PROFILE } from "./read-profile.js";

export const SQLITE_NESTED_PROFILE: NestedConformanceProfile = {
  label: "sqlite",
  server: "sqlite",
  makeAdapter: SQLITE_READ_PROFILE.makeAdapter,
  // SQLite has no sleep, and a trigger cannot hold a WITH: a 'slow' item counts a cross join
  // of 5,200 rows with themselves (about 0.6 s), which overruns the timeoutMs case's budget.
  // The rows come from a view, which the suite's truncation between tests leaves alone.
  schema: `
    create table orders (id integer primary key autoincrement, customer text not null);
    create table line_items (id integer primary key autoincrement,
      order_id integer not null references orders (id) on delete cascade,
      sku text not null, qty integer not null, constraint line_items_qty_check check (qty > 0));
    create table contacts (id integer primary key autoincrement, name text not null, address text,
      phones text not null default '[]', card text);
    create view busy_rows as
      with recursive s(n) as (select 1 union all select n + 1 from s where n < 5200) select n from s;
    create trigger line_items_slow before insert on line_items when new.sku = 'slow'
      begin select count(*) from busy_rows a, busy_rows b where a.n + b.n > 0; end;
  `,
};
