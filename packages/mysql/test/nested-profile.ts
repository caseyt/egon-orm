// The MySQL profile of the nested-write conformance suite.
import type { NestedConformanceProfile } from "../../core/test/conformance/nested/index.js";
import { MYSQL_READ_PROFILE } from "./read-profile.js";

export const MYSQL_NESTED_PROFILE: NestedConformanceProfile = {
  label: "mysql",
  server: "mysql",
  makeAdapter: MYSQL_READ_PROFILE.makeAdapter,
  schema: `
    create table orders (id bigint auto_increment primary key, customer text not null);
    create table line_items (id bigint auto_increment primary key, order_id bigint not null,
      sku varchar(255) not null, qty integer not null,
      constraint line_items_order_id_fkey foreign key (order_id) references orders (id) on delete cascade,
      constraint line_items_qty_check check (qty > 0));
    create table contacts (id bigint auto_increment primary key, name text not null, address json,
      phones json not null default ('[]'), card json);
    create trigger line_items_slow before insert on line_items for each row
      set @egon_slept = if(new.sku = 'slow', sleep(0.3), 0);
  `,
};
