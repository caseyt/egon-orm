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
    create function line_items_slow() returns trigger language plpgsql as $$
      begin if new.sku = 'slow' then perform pg_sleep(0.3); end if; return new; end $$;
    create trigger line_items_slow before insert on line_items for each row execute function line_items_slow();
  `,
};
