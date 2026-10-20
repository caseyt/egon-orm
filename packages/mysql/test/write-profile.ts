// The MySQL profile of the write conformance suite.
import { fragment, t, val } from "egon-orm";
import type { WriteConformanceProfile } from "../../core/test/conformance/write/index.js";
import { MYSQL_PROFILE } from "./profile.js";
import { MYSQL_READ_PROFILE } from "./read-profile.js";

export const MYSQL_WRITE_PROFILE: WriteConformanceProfile = {
  label: "mysql",
  server: "mysql",
  makeAdapter: MYSQL_READ_PROFILE.makeAdapter,
  columnType: MYSQL_PROFILE.columnType,
  generatedKey: "bigint auto_increment primary key",
  schema: `
    create table books (id bigint auto_increment primary key, title text not null, pages integer not null,
      constraint books_pages_check check (pages > 0));
    create table stamps (id bigint auto_increment primary key, label text not null,
      code varchar(255) not null default 'db-code', note varchar(255) default 'db-note',
      made_at datetime(6) not null default current_timestamp(6));
  `,
  // MySQL has no range types, and no exclusion constraints.
  rangeType: undefined,
  copyTableInto: MYSQL_READ_PROFILE.copyTableInto,
  dropCopies: MYSQL_READ_PROFILE.dropCopies,
  sleep: (seconds) => fragment`(select sleep(${val(seconds, t.float())}))`.as<number>(),
};
