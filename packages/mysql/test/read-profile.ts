// The MySQL profile of the read conformance suite.
import { fragment, t, val } from "egon-orm";
import type { ReadConformanceProfile } from "../../core/test/conformance/read/index.js";
import { MYSQL_PROFILE } from "./profile.js";

/** `insert into <target> …` of the rows `<columns>` for n in 1..`count`, with the recursion limit raised for it. */
const numbers = (count: number, target: string, columns: string): string =>
  `insert into ${target} with recursive s(n) as (select 1 union all select n + 1 from s where n < ${count}) select /*+ SET_VAR(cte_max_recursion_depth = ${count + 1}) */ ${columns} from s`;

const quote = (name: string): string => `\`${name.replaceAll("`", "``")}\``;

/** The database schemas each test database's suite copied tables into, to drop at its end. */
const copies = new Map<string, Set<string>>();

export const MYSQL_READ_PROFILE: ReadConformanceProfile = {
  label: "mysql",
  server: "mysql",
  makeAdapter: MYSQL_PROFILE.makeAdapter,
  param: () => "?",
  quoteIdentifier: (name) => `\`${name.replaceAll("`", "``")}\``,
  columnType: MYSQL_PROFILE.columnType,
  // A database schema is a database on MySQL, named server-wide. Each copy is made fresh
  // (the table dropped and re-created from the test database's), and the suite drops the
  // databases when it ends. Every suite uses schema names of its own, so files running at
  // the same time do not share one.
  copyTableInto: (schema, table, db) => {
    const made = copies.get(db.name) ?? new Set<string>();
    copies.set(db.name, made);
    made.add(schema);
    const target = `${quote(schema)}.${quote(table)}`;
    return `create database if not exists ${quote(schema)}; drop table if exists ${target}; create table ${target} like ${quote(db.name)}.${quote(table)}`;
  },
  dropCopies: (db) => {
    const made = copies.get(db.name);
    copies.delete(db.name);
    if (made === undefined || made.size === 0) return undefined;
    return [...made].map((schema) => `drop database if exists ${quote(schema)}`).join("; ");
  },
  defaultSchema: (db) => db.name,
  insertSeries: (count) => numbers(count, "stream_rows (id, label)", "n, concat('row ', n)"),
  insertPairs: (count) => numbers(count, "pairs (a, b)", "n, concat('k', n % 7)"),
  microsecondTimestamp: "datetime(6)",
  sleep: (seconds) => fragment`select sleep(${val(seconds, t.float())}) as slept`,
};
