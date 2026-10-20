// The SQLite profile of the nested-write conformance suite.
import type { NestedConformanceProfile } from "../../core/test/conformance/nested/index.js";
import { SQLITE_READ_PROFILE } from "./read-profile.js";

export const SQLITE_NESTED_PROFILE: NestedConformanceProfile = {
  label: "sqlite",
  server: "sqlite",
  makeAdapter: SQLITE_READ_PROFILE.makeAdapter,
  // No trigger slows the inserts of 'slow' items: SQLite has no sleep, and the case that
  // relies on it (cancelling a statement on its timeoutMs) is skipped by capability cancel.
  schema: `
    create table orders (id integer primary key autoincrement, customer text not null);
    create table line_items (id integer primary key autoincrement,
      order_id integer not null references orders (id) on delete cascade,
      sku text not null, qty integer not null, constraint line_items_qty_check check (qty > 0));
    create table contacts (id integer primary key autoincrement, name text not null, address text,
      phones text not null default '[]', card text);
  `,
};
