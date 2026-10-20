// The MySQL profile of the read conformance suite.
import { fragment, t, val } from "egon-orm";
import type { ReadConformanceProfile } from "../../core/test/conformance/read/index.js";
import { MYSQL_PROFILE } from "./profile.js";

/** `insert into <target> …` of the rows `<columns>` for n in 1..`count`, with the recursion limit raised for it. */
const numbers = (count: number, target: string, columns: string): string =>
  `insert into ${target} with recursive s(n) as (select 1 union all select n + 1 from s where n < ${count}) select /*+ SET_VAR(cte_max_recursion_depth = ${count + 1}) */ ${columns} from s`;

export const MYSQL_READ_PROFILE: ReadConformanceProfile = {
  label: "mysql",
  server: "mysql",
  makeAdapter: MYSQL_PROFILE.makeAdapter,
  param: () => "?",
  quoteIdentifier: (name) => `\`${name.replaceAll("`", "``")}\``,
  columnType: MYSQL_PROFILE.columnType,
  // A database schema is a database on MySQL, named server-wide: the suite's fixed names
  // would collide between runs that share a server. The MySQL tests cover them with
  // names of their own.
  copyTableInto: undefined,
  insertSeries: (count) => numbers(count, "stream_rows (id, label)", "n, concat('row ', n)"),
  insertPairs: (count) => numbers(count, "pairs (a, b)", "n, concat('k', n % 7)"),
  microsecondTimestamp: "datetime(6)",
  sleep: (seconds) => fragment`select sleep(${val(seconds, t.float())}) as slept`,
};
