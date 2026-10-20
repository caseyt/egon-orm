// The Postgres profile of the preload conformance suite.
import { fragment, t, val } from "egon-orm";
import type { PreloadConformanceProfile } from "../../core/test/conformance/preload/index.js";
import { POSTGRES_READ_PROFILE } from "./read-profile.js";

export const POSTGRES_PRELOAD_PROFILE: PreloadConformanceProfile = {
  label: "postgres",
  server: "postgres",
  makeAdapter: POSTGRES_READ_PROFILE.makeAdapter,
  schema: `
    create table shelves (region text, code integer, label text not null, primary key (region, code));
    create table volumes (id integer primary key, shelf_region text, shelf_code integer, title text not null);
    create table categories (id integer primary key, parent_id integer, name text not null);
    create table post_labels (post_id bigint not null, tag_id bigint not null, featured boolean not null);
  `,
  copyTableInto: POSTGRES_READ_PROFILE.copyTableInto,
  insertUsers: (count) =>
    `insert into users (id, email) select 1000 + n, 'u' || (1000 + n) || '@example.com' from generate_series(1, ${count}) as n`,
  sleep: (seconds) => fragment`(pg_sleep(${val(seconds, t.float())}) is not null)`.as<boolean>(),
};
