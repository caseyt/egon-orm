// The Postgres profile of the write conformance suite.
import { fragment, t, val } from "egon-orm";
import type { WriteConformanceProfile } from "../../core/test/conformance/write/index.js";
import { POSTGRES_PROFILE } from "./profile.js";
import { POSTGRES_READ_PROFILE } from "./read-profile.js";

export const POSTGRES_WRITE_PROFILE: WriteConformanceProfile = {
  label: "postgres",
  server: "postgres",
  makeAdapter: POSTGRES_READ_PROFILE.makeAdapter,
  columnType: POSTGRES_PROFILE.columnType,
  generatedKey: "bigserial primary key",
  schema: `
    create table books (id bigserial primary key, title text not null, pages integer not null,
      constraint books_pages_check check (pages > 0));
    create table bookings (id bigserial primary key, room integer not null, during int4range not null,
      constraint bookings_during_excl exclude using gist (during with &&));
    create table stamps (id bigserial primary key, label text not null, code text not null default 'db-code',
      note text default 'db-note', made_at timestamptz not null default now());
  `,
  rangeType: "int4range",
  copyTableInto: POSTGRES_READ_PROFILE.copyTableInto,
  sleep: (seconds) => fragment`(select 0 from pg_sleep(${val(seconds, t.float())}))`.as<number>(),
};
