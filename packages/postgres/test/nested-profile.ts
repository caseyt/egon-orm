// The Postgres profile of the nested-write conformance suite.
import type { NestedConformanceProfile } from "../../core/test/conformance/nested/index.js";
import { POSTGRES_READ_PROFILE } from "./read-profile.js";

export const POSTGRES_NESTED_PROFILE: NestedConformanceProfile = {
  label: "postgres",
  server: "postgres",
  makeAdapter: POSTGRES_READ_PROFILE.makeAdapter,
  schema: `
    create table orders (id bigserial primary key, customer text not null);
    create table line_items (id bigserial primary key,
      order_id bigint not null references orders (id) on delete cascade,
      sku text not null, qty integer not null, constraint line_items_qty_check check (qty > 0));
    create table contacts (id bigserial primary key, name text not null, address jsonb,
      phones jsonb not null default '[]', card jsonb);
  `,
};
