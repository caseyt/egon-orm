/**
 * Dialect tables: everything the SQL emitter needs to know about one database, as a plain
 * object. There is one emitter and no emitter subclass per database (ADR 0003, rule 5);
 * where databases differ, the emitter reads one of these tables.
 *
 * Every piece of fixed SQL text the emitter writes for a name that comes from the AST (an
 * operator, a function, an aggregate, a lock clause, a join kind, a type) is looked up
 * here. A name that is not in its table is refused with `QueryError`; it never reaches the
 * SQL as written (ADR 0003, rule 1).
 *
 * There is one table per database: Postgres, MySQL 8 and SQLite.
 *
 * @module
 */
import type { Capabilities, Dialect } from "../contracts/adapter.js";
import type { BinaryOp } from "../contracts/query.js";
import type { DbType } from "../contracts/type.js";
import { CUSTOM_SQL_TYPE } from "../contracts/type.js";
import { QueryError } from "../errors.js";

/**
 * How a dialect writes a placeholder: numbered (`$1`, `$2`, …) or positional (`?`).
 *
 * @example
 * ```ts
 * const style: PlaceholderStyle = "numbered";
 * ```
 */
export type PlaceholderStyle = "numbered" | "positional";

/**
 * The logical column types that have a fixed SQL name (every {@link DbType} kind except
 * `array` and `custom`, which are built from their parts).
 *
 * @example
 * ```ts
 * const kind: ScalarDbKind = "timestamptz";
 * ```
 */
export type ScalarDbKind = Exclude<DbType["kind"], "array" | "custom">;

/**
 * The binary operators written between their operands. `in`, `notIn` and `has` have
 * forms of their own (`x = any($1)`, `$1 = any(x)`) and are not in the table.
 *
 * @example
 * ```ts
 * const op: TableOperator = "gte";
 * ```
 */
export type TableOperator = Exclude<BinaryOp, "in" | "notIn" | "has">;

/**
 * A database as the emitter sees it. A plain object; build one with a literal and
 * `Object.freeze` it.
 *
 * @example
 * ```ts
 * const name = postgresDialect.name; // "postgres"
 * ```
 */
export interface SqlDialect {
  /** The dialect's name, used in error messages ("FULL JOIN is not supported by sqlite"). */
  readonly name: Dialect;
  /** The character identifiers are quoted with. Inside a name it is doubled. */
  readonly quote: string;
  /** `$1` or `?`. */
  readonly placeholder: PlaceholderStyle;
  /** What the database supports; the emitter refuses the rest with `QueryError`. */
  readonly capabilities: Capabilities;
  /** The SQL of each binary operator that is written between its operands (`gte` is `>=`). */
  readonly operators: Readonly<Record<TableOperator, string>>;
  /** Function names as the query layer writes them (`arrayAppend`) to SQL names (`array_append`). */
  readonly functions: Readonly<Record<string, string>>;
  /** The aggregate names (`arrayAgg`) to SQL names (`array_agg`). */
  readonly aggregates: Readonly<Record<string, string>>;
  /**
   * The lock clauses a query may hold as strings (`LockNode.clause`), to the SQL written
   * for them. Its keys are `capabilities.lockModes`.
   */
  readonly locks: Readonly<Record<string, string>>;
  /** Row locks are accepted and not written (SQLite: one writer at a time). */
  readonly ignoresLocks: boolean;
  /** The SQL name of each scalar column type, for `CAST`. */
  readonly types: Readonly<Record<ScalarDbKind, string>>;
  /**
   * How a JSON path is written:
   *
   * - `"pathArray"`: one operator and an array of keys (`x #> array[$1, $2]`);
   * - `"arrows"`: one operator per key (`x -> ? ->> ?`);
   * - `"pathOperators"`: one operator and a JSON path text built from the keys
   *   (`x ->> ('$' || ? || ?)`, SQLite);
   * - `"pathFunctions"`: the path text given to functions
   *   (`json_unquote(json_extract(x, concat('$', ?, ?)))`, MySQL, whose path operators take
   *   only a literal).
   *
   * With the last two, each key is bound as one step of the path (`."theme"`, `[0]`).
   */
  readonly jsonPath: "pathArray" | "arrows" | "pathOperators" | "pathFunctions";
  /** An `ON CONFLICT … DO UPDATE` needs a conflict target (Postgres and SQLite do; MySQL takes none). */
  readonly conflictUpdateNeedsTarget: boolean;
  /**
   * How `EXPLAIN` is written: `"options"` is `explain (analyze, format json) …`,
   * `"keywords"` is `explain analyze format=json …` (MySQL), `"queryPlan"` is
   * `explain query plan …` (SQLite, which takes no options).
   */
  readonly explain: "options" | "keywords" | "queryPlan";
  /**
   * The longest identifier the database keeps, in bytes; a longer one is cut to it (Postgres:
   * 63, `NAMEDATALEN - 1`). `undefined` when names are not shortened. The repo uses it to
   * match a constraint whose default name the database shortened.
   */
  readonly identifierMaxBytes: number | undefined;
  /** How `concat` is written: `a || b`, or `concat(a, b)` (MySQL, where `||` means `OR`). */
  readonly concat: "operator" | "function";
  /** How `isDistinctFrom` is written: `a is distinct from b`, or `not (a <=> b)` (MySQL). */
  readonly distinctFrom: "operator" | "nullSafeEqual";
  /**
   * Without a native `ILIKE` (`capabilities.ilike` false), whether `ilike` is written as
   * `LIKE`, which is case-insensitive on this database (SQLite for ASCII letters, MySQL
   * under a case-insensitive collation). Otherwise `ilike` is refused.
   */
  readonly ilikeAsLike: boolean;
  /**
   * Text written after the pattern of every `LIKE`, so that a backslash escapes `%` and `_`
   * as it does on Postgres and MySQL (SQLite has no escape character unless one is named).
   */
  readonly likeEscape: string;
  /**
   * The row count written as `LIMIT` when a query has an `OFFSET` and no limit, for a
   * database that needs a `LIMIT` before `OFFSET`; `undefined` when it needs none.
   */
  readonly offsetWithoutLimit: string | undefined;
  /**
   * How the operand of a set operation is written: `union (…)`, or `union select * from
   * (…)` (SQLite takes no parentheses there, and applies the operators left to right).
   */
  readonly setOperand: "parenthesized" | "subquery";
  /** How a tuple of one item is written: `row(x)`, or `(x)`. */
  readonly singleTuple: "row" | "parenthesized";
  /**
   * How a values source is written: `(values (…), …) as v (a, b)`, the same with `row(…)`
   * (MySQL), or `(select column1 as a, column2 as b from (values (…), …)) as v` (SQLite,
   * which takes no column list after the alias and names the columns of `values` itself).
   */
  readonly valuesSource: "values" | "valuesRow" | "valuesSelect";
  /**
   * Whether a source takes a column list after its alias (`… as g (n)`). SQLite does not:
   * a fragment source with columns is refused there.
   */
  readonly sourceColumnList: boolean;
  /** How an insert without columns is written: ` default values`, or ` () values ()` (MySQL). */
  readonly defaultValues: string;
  /**
   * How an upsert is written: `on conflict … do …`, or MySQL's `as excluded on duplicate
   * key update …`. In the second form `onConflict: "nothing"` sets a column to itself.
   */
  readonly upsert: "onConflict" | "onDuplicateKey";
  /**
   * How a join is written in `updateAll` and `deleteAll`: `update … from …` and `delete …
   * using …`, or the join clause of MySQL (`update t as a inner join … set …`,
   * `delete a from t as a inner join …`).
   */
  readonly updateJoin: "fromUsing" | "joinClause";
  /**
   * How `RETURNING` of `updateAll` and `deleteAll` names the target's columns: by the
   * target's alias (`"p"."title"`), or bare (`"title"`: SQLite does not know the alias there).
   */
  readonly returningColumns: "qualified" | "bare";
  /**
   * Functions without arguments that are written as fixed text, by the name the query layer
   * uses (SQLite has no `now()`). For a call without arguments it is looked up before
   * {@link SqlDialect.functions}.
   */
  readonly niladic: Readonly<Record<string, string>>;
}

/**
 * Every clause `lock()` writes into `LockNode.clause`: the four modes, each alone or with
 * `SKIP LOCKED` or `NOWAIT`. A dialect that ignores locks accepts each of these and writes
 * nothing.
 *
 * @example
 * ```ts
 * LOCK_CLAUSES.includes("FOR UPDATE NOWAIT"); // true
 * ```
 */
export const LOCK_CLAUSES: readonly string[] = Object.freeze(
  ["FOR UPDATE", "FOR SHARE", "FOR NO KEY UPDATE", "FOR KEY SHARE"].flatMap((mode) => [
    mode,
    `${mode} SKIP LOCKED`,
    `${mode} NOWAIT`,
  ]),
);

/** Lock keywords for the clauses the query builder writes into `LockNode.clause`. */
const POSTGRES_LOCKS: Readonly<Record<string, string>> = Object.freeze({
  "FOR UPDATE": "for update",
  "FOR UPDATE SKIP LOCKED": "for update skip locked",
  "FOR UPDATE NOWAIT": "for update nowait",
  "FOR SHARE": "for share",
  "FOR SHARE SKIP LOCKED": "for share skip locked",
  "FOR SHARE NOWAIT": "for share nowait",
  "FOR NO KEY UPDATE": "for no key update",
  "FOR NO KEY UPDATE SKIP LOCKED": "for no key update skip locked",
  "FOR NO KEY UPDATE NOWAIT": "for no key update nowait",
  "FOR KEY SHARE": "for key share",
  "FOR KEY SHARE SKIP LOCKED": "for key share skip locked",
  "FOR KEY SHARE NOWAIT": "for key share nowait",
});

/**
 * What Postgres supports: everything.
 *
 * @example
 * ```ts
 * POSTGRES_CAPABILITIES.fullJoin; // true
 * ```
 */
export const POSTGRES_CAPABILITIES: Capabilities = Object.freeze({
  returning: true,
  onConflict: true,
  conflictTarget: true,
  ilike: true,
  lateralJoin: true,
  fullJoin: true,
  distinctOn: true,
  arrays: true,
  arrayParams: true,
  jsonb: true,
  nullsOrder: true,
  updateJoin: true,
  cteMaterialized: true,
  writingCtes: true,
  intersectExceptAll: true,
  insertDefaultValues: true,
  defaultInValues: true,
  aggregateFilter: true,
  cancel: true,
  readOnlyTransactions: true,
  deferrableTransactions: true,
  multipleConnections: true,
  serializationFailures: true,
  nonFiniteFloats: true,
  exactDecimals: true,
  explainOptions: true,
  limitExpressions: true,
  foreignKeyNames: true,
  conflictConstraint: true,
  longIdentifiers: true,
  lockModes: Object.freeze(Object.keys(POSTGRES_LOCKS)),
  isolationLevels: Object.freeze(["read committed", "repeatable read", "serializable"] as const),
  savepoints: true,
  ddlTransactions: true,
  stream: true,
  maxParams: 65_535,
});

/**
 * The Postgres dialect table.
 *
 * @example
 * ```ts
 * import { createCompiler, postgresDialect } from "./index.js";
 *
 * const compiler = createCompiler(postgresDialect);
 * ```
 */
export const postgresDialect: SqlDialect = Object.freeze({
  name: "postgres",
  quote: '"',
  placeholder: "numbered",
  capabilities: POSTGRES_CAPABILITIES,
  operators: Object.freeze({
    eq: "=",
    neq: "<>",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
    isDistinctFrom: "is distinct from",
    like: "like",
    notLike: "not like",
    ilike: "ilike",
    add: "+",
    sub: "-",
    mul: "*",
    div: "/",
    mod: "%",
    concat: "||",
    contains: "@>",
    containedBy: "<@",
    overlaps: "&&",
  }),
  functions: Object.freeze({
    lower: "lower",
    upper: "upper",
    coalesce: "coalesce",
    now: "now",
    arrayAppend: "array_append",
    arrayRemove: "array_remove",
  }),
  aggregates: Object.freeze({
    count: "count",
    sum: "sum",
    avg: "avg",
    min: "min",
    max: "max",
    arrayAgg: "array_agg",
    jsonAgg: "json_agg",
    stringAgg: "string_agg",
    // Window functions (step 09): written like aggregates, and always with OVER.
    rowNumber: "row_number",
    rank: "rank",
    denseRank: "dense_rank",
    percentRank: "percent_rank",
    cumeDist: "cume_dist",
    ntile: "ntile",
    lag: "lag",
    lead: "lead",
    firstValue: "first_value",
    lastValue: "last_value",
    nthValue: "nth_value",
  }),
  locks: POSTGRES_LOCKS,
  ignoresLocks: false,
  types: Object.freeze({
    integer: "integer",
    bigint: "bigint",
    float: "double precision",
    decimal: "numeric",
    boolean: "boolean",
    text: "text",
    uuid: "uuid",
    binary: "bytea",
    date: "date",
    time: "time",
    timestamp: "timestamp",
    timestamptz: "timestamptz",
    json: "json",
    jsonb: "jsonb",
  }),
  jsonPath: "pathArray",
  conflictUpdateNeedsTarget: true,
  explain: "options",
  identifierMaxBytes: 63,
  concat: "operator",
  distinctFrom: "operator",
  ilikeAsLike: false,
  likeEscape: "",
  offsetWithoutLimit: undefined,
  setOperand: "parenthesized",
  singleTuple: "row",
  valuesSource: "values",
  sourceColumnList: true,
  defaultValues: " default values",
  upsert: "onConflict",
  updateJoin: "fromUsing",
  returningColumns: "qualified",
  niladic: Object.freeze({}),
});

/** The window functions (step 09): written like aggregates, always with `OVER`, by the same names on every database. */
const WINDOW_FUNCTIONS: Readonly<Record<string, string>> = Object.freeze({
  rowNumber: "row_number",
  rank: "rank",
  denseRank: "dense_rank",
  percentRank: "percent_rank",
  cumeDist: "cume_dist",
  ntile: "ntile",
  lag: "lag",
  lead: "lead",
  firstValue: "first_value",
  lastValue: "last_value",
  nthValue: "nth_value",
});

/** The operators MySQL and SQLite write as Postgres does. */
const COMMON_OPERATORS = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "like",
  notLike: "not like",
  add: "+",
  sub: "-",
  mul: "*",
  div: "/",
  mod: "%",
  // Refused before they are written: neither database has arrays or jsonb operators.
  contains: "@>",
  containedBy: "<@",
  overlaps: "&&",
} as const;

/** MySQL's lock clauses: `FOR UPDATE` and `FOR SHARE`, alone or with `SKIP LOCKED` or `NOWAIT`. */
const MYSQL_LOCKS: Readonly<Record<string, string>> = Object.freeze({
  "FOR UPDATE": "for update",
  "FOR UPDATE SKIP LOCKED": "for update skip locked",
  "FOR UPDATE NOWAIT": "for update nowait",
  "FOR SHARE": "for share",
  "FOR SHARE SKIP LOCKED": "for share skip locked",
  "FOR SHARE NOWAIT": "for share nowait",
});

/**
 * What MySQL 8 supports, as the compiler's reference copy. An adapter uses the
 * capabilities of its dialect package (`@egon-orm/mysql`), whose tests compare them with
 * this one.
 *
 * @example
 * ```ts
 * MYSQL_CAPABILITIES.returning; // false: the row is read back after a write
 * ```
 */
export const MYSQL_CAPABILITIES: Capabilities = Object.freeze({
  returning: false,
  onConflict: true,
  conflictTarget: false,
  ilike: false,
  lateralJoin: true,
  fullJoin: false,
  distinctOn: false,
  arrays: false,
  arrayParams: false,
  jsonb: false,
  nullsOrder: false,
  updateJoin: true,
  cteMaterialized: false,
  writingCtes: false,
  intersectExceptAll: true,
  insertDefaultValues: true,
  defaultInValues: true,
  aggregateFilter: false,
  cancel: true,
  readOnlyTransactions: true,
  deferrableTransactions: false,
  multipleConnections: true,
  serializationFailures: false,
  nonFiniteFloats: false,
  exactDecimals: false,
  explainOptions: true,
  // LIMIT and OFFSET take a value or a placeholder only.
  limitExpressions: false,
  foreignKeyNames: true,
  conflictConstraint: false,
  longIdentifiers: false,
  lockModes: Object.freeze(Object.keys(MYSQL_LOCKS)),
  isolationLevels: Object.freeze(["read committed", "repeatable read", "serializable"] as const),
  savepoints: true,
  ddlTransactions: false,
  stream: true,
  // The protocol counts the parameters of a prepared statement in 16 bits.
  maxParams: 65_535,
});

/**
 * What SQLite (3.39 and later) supports, as the compiler's reference copy. An adapter uses
 * the capabilities of its dialect package (`@egon-orm/sqlite`), whose tests compare them
 * with this one.
 *
 * @example
 * ```ts
 * SQLITE_CAPABILITIES.lockModes; // []: row locks are accepted and not written
 * ```
 */
export const SQLITE_CAPABILITIES: Capabilities = Object.freeze({
  returning: true,
  onConflict: true,
  conflictTarget: true,
  ilike: false,
  lateralJoin: false,
  fullJoin: true,
  distinctOn: false,
  arrays: false,
  arrayParams: false,
  jsonb: false,
  nullsOrder: true,
  updateJoin: false,
  cteMaterialized: true,
  // SQLite has no CTE that writes.
  writingCtes: false,
  intersectExceptAll: false,
  insertDefaultValues: true,
  defaultInValues: false,
  aggregateFilter: true,
  cancel: false,
  readOnlyTransactions: false,
  deferrableTransactions: false,
  multipleConnections: false,
  serializationFailures: false,
  nonFiniteFloats: false,
  exactDecimals: false,
  explainOptions: false,
  limitExpressions: true,
  foreignKeyNames: false,
  conflictConstraint: false,
  longIdentifiers: true,
  lockModes: Object.freeze([]),
  isolationLevels: Object.freeze([]),
  savepoints: true,
  ddlTransactions: true,
  stream: true,
  // SQLITE_MAX_VARIABLE_NUMBER of the SQLite library that better-sqlite3 builds.
  maxParams: 32_766,
});

/**
 * The MySQL 8 dialect table: backtick quotes, `?` placeholders, lists expanded,
 * `concat()` for `concat`, `on duplicate key update` for upserts, and the type names
 * MySQL's `CAST` accepts (`signed`, `char`, `datetime(6)`, …).
 *
 * @example
 * ```ts
 * import { createCompiler, mysqlDialect } from "./index.js";
 *
 * const compiler = createCompiler(mysqlDialect);
 * ```
 */
export const mysqlDialect: SqlDialect = Object.freeze({
  name: "mysql",
  quote: "`",
  placeholder: "positional",
  capabilities: MYSQL_CAPABILITIES,
  operators: Object.freeze({
    ...COMMON_OPERATORS,
    // Not written as operators (see distinctFrom, ilikeAsLike and concat below).
    isDistinctFrom: "<=>",
    ilike: "like",
    concat: "concat",
  }),
  functions: Object.freeze({
    lower: "lower",
    upper: "upper",
    coalesce: "coalesce",
    now: "now",
  }),
  aggregates: Object.freeze({
    count: "count",
    sum: "sum",
    avg: "avg",
    min: "min",
    max: "max",
    jsonAgg: "json_arrayagg",
    ...WINDOW_FUNCTIONS,
  }),
  locks: MYSQL_LOCKS,
  ignoresLocks: false,
  types: Object.freeze({
    integer: "signed",
    bigint: "signed",
    float: "double",
    // A bare decimal is decimal(10, 0) in MySQL, which would cut the fraction off.
    decimal: "decimal(65, 30)",
    boolean: "signed",
    text: "char",
    uuid: "char(36)",
    binary: "binary",
    date: "date",
    time: "time(6)",
    timestamp: "datetime(6)",
    timestamptz: "datetime(6)",
    json: "json",
    jsonb: "json",
  }),
  jsonPath: "pathFunctions",
  conflictUpdateNeedsTarget: false,
  explain: "keywords",
  // MySQL refuses an identifier longer than 64 characters instead of shortening it.
  identifierMaxBytes: undefined,
  concat: "function",
  distinctFrom: "nullSafeEqual",
  ilikeAsLike: true,
  likeEscape: "",
  offsetWithoutLimit: "18446744073709551615",
  setOperand: "parenthesized",
  singleTuple: "parenthesized",
  valuesSource: "valuesRow",
  sourceColumnList: true,
  defaultValues: " () values ()",
  upsert: "onDuplicateKey",
  updateJoin: "joinClause",
  returningColumns: "qualified",
  niladic: Object.freeze({ now: "current_timestamp(6)" }),
});

/**
 * The SQLite dialect table: double quotes, `?` placeholders, lists expanded, row locks
 * ignored, JSON paths as path text, and SQLite's own type names (`integer`, `real`,
 * `text`, `blob`) in casts.
 *
 * @example
 * ```ts
 * import { createCompiler, sqliteDialect } from "./index.js";
 *
 * const compiler = createCompiler(sqliteDialect);
 * ```
 */
export const sqliteDialect: SqlDialect = Object.freeze({
  name: "sqlite",
  quote: '"',
  placeholder: "positional",
  capabilities: SQLITE_CAPABILITIES,
  operators: Object.freeze({
    ...COMMON_OPERATORS,
    isDistinctFrom: "is distinct from",
    // Not written as an operator (see ilikeAsLike below).
    ilike: "like",
    concat: "||",
  }),
  functions: Object.freeze({
    lower: "lower",
    upper: "upper",
    coalesce: "coalesce",
  }),
  aggregates: Object.freeze({
    count: "count",
    sum: "sum",
    avg: "avg",
    min: "min",
    max: "max",
    jsonAgg: "json_group_array",
    stringAgg: "string_agg",
    ...WINDOW_FUNCTIONS,
  }),
  locks: Object.freeze({}),
  ignoresLocks: true,
  types: Object.freeze({
    integer: "integer",
    bigint: "integer",
    float: "real",
    decimal: "text",
    boolean: "integer",
    text: "text",
    uuid: "text",
    binary: "blob",
    date: "text",
    time: "text",
    timestamp: "text",
    timestamptz: "text",
    json: "text",
    jsonb: "text",
  }),
  jsonPath: "pathOperators",
  conflictUpdateNeedsTarget: true,
  explain: "queryPlan",
  // SQLite keeps identifiers of any length.
  identifierMaxBytes: undefined,
  concat: "operator",
  distinctFrom: "operator",
  ilikeAsLike: true,
  likeEscape: " escape '\\'",
  offsetWithoutLimit: "-1",
  setOperand: "subquery",
  singleTuple: "parenthesized",
  valuesSource: "valuesSelect",
  sourceColumnList: false,
  defaultValues: " default values",
  upsert: "onConflict",
  updateJoin: "fromUsing",
  returningColumns: "bare",
  // A timestamp as the adapter stores one: ISO 8601 text in UTC, with milliseconds.
  niladic: Object.freeze({ now: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" }),
});

/**
 * Quotes an identifier for `dialect`: wraps it in the quote character and doubles that
 * character inside it. Every table, alias, column and other name the emitter writes goes
 * through here (ADR 0003, rule 3).
 *
 * @example
 * ```ts
 * quoteIdentifier(postgresDialect, "created_at"); // '"created_at"'
 * quoteIdentifier(postgresDialect, 'a"b'); // '"a""b"'
 * ```
 */
export function quoteIdentifier(dialect: SqlDialect, name: string): string {
  const q = dialect.quote;
  return name.includes(q) ? `${q}${name.split(q).join(q + q)}${q}` : `${q}${name}${q}`;
}

/**
 * The SQL type name of a logical column type, for `CAST(x AS …)`. A `custom` type's `sql`
 * is written only when it matches `CUSTOM_SQL_TYPE` (ADR 0003, rule 1).
 *
 * @example
 * ```ts
 * sqlTypeName(postgresDialect, { kind: "array", of: { kind: "integer" } }); // "integer[]"
 * ```
 *
 * @throws QueryError for a `custom` type whose `sql` is not a plain type name, or a kind
 * the dialect has no name for.
 */
export function sqlTypeName(dialect: SqlDialect, db: DbType): string {
  switch (db.kind) {
    case "array":
      if (!dialect.capabilities.arrays) throw unsupported(dialect, "An array type");
      return `${sqlTypeName(dialect, db.of)}[]`;
    case "custom":
      if (typeof db.sql !== "string" || !CUSTOM_SQL_TYPE.test(db.sql)) {
        throw new QueryError(
          "A custom column type's sql is not a plain type name (letters, digits, underscores, single spaces or dots, an optional (n) or (n, m) and [] pairs), so it was not written into the SQL.",
        );
      }
      return db.sql;
    default: {
      const name = Object.hasOwn(dialect.types, db.kind) ? dialect.types[db.kind as ScalarDbKind] : undefined;
      if (name === undefined) {
        throw new QueryError(`The column type kind "${String(db.kind)}" has no SQL name in ${dialect.name}.`);
      }
      return name;
    }
  }
}

/**
 * The `QueryError` for a feature `dialect` lacks: `"FULL JOIN is not supported by sqlite"`.
 *
 * @example
 * ```ts
 * if (!dialect.capabilities.fullJoin) throw unsupported(dialect, "FULL JOIN");
 * ```
 */
export function unsupported(dialect: SqlDialect, feature: string): QueryError {
  return new QueryError(`${feature} is not supported by ${dialect.name}.`);
}

/**
 * Looks `key` up in one of a dialect's name tables (`functions`, `aggregates`, `locks`),
 * as an own property only, so that `"constructor"` or `"__proto__"` never find anything.
 *
 * @example
 * ```ts
 * lookup(postgresDialect.functions, "arrayAppend"); // "array_append"
 * lookup(postgresDialect.functions, "pg_sleep"); // undefined
 * ```
 */
export function lookup(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined;
}
