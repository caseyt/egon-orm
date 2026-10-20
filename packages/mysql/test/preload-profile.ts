// The MySQL profile of the preload conformance suite.
import { fragment, t, val } from "egon-orm";
import type { PreloadConformanceProfile } from "../../core/test/conformance/preload/index.js";
import { MYSQL_READ_PROFILE } from "./read-profile.js";

export const MYSQL_PRELOAD_PROFILE: PreloadConformanceProfile = {
  label: "mysql",
  server: "mysql",
  makeAdapter: MYSQL_READ_PROFILE.makeAdapter,
  schema: `
    create table shelves (region varchar(255), code integer, label text not null, primary key (region, code));
    create table volumes (id integer primary key, shelf_region varchar(255), shelf_code integer, title text not null);
    create table categories (id integer primary key, parent_id integer, name text not null);
    create table post_labels (post_id bigint not null, tag_id bigint not null, featured boolean not null);
  `,
  copyTableInto: MYSQL_READ_PROFILE.copyTableInto,
  dropCopies: MYSQL_READ_PROFILE.dropCopies,
  insertUsers: (count) =>
    `insert into users (id, email) with recursive s(n) as (select 1 union all select n + 1 from s where n < ${count}) select /*+ SET_VAR(cte_max_recursion_depth = ${count + 1}) */ 1000 + n, concat('u', 1000 + n, '@example.com') from s`,
  sleep: (seconds) => fragment`(sleep(${val(seconds, t.float())}) = 0)`.as<boolean>(),
};
