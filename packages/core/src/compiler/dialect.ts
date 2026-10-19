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
 * This step ships the Postgres table; step 17 adds MySQL and SQLite.
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
   * How a JSON path is written: `"pathArray"` is one operator and an array of keys
   * (`x #> array[$1, $2]`), `"arrows"` one operator per key (`x -> ? ->> ?`).
   */
  readonly jsonPath: "pathArray" | "arrows";
  /** An `ON CONFLICT … DO UPDATE` needs a conflict target (Postgres and SQLite do; MySQL takes none). */
  readonly conflictUpdateNeedsTarget: boolean;
  /** The `EXPLAIN` options this dialect accepts, written into `explain (…)`. */
  readonly explainOptions: Readonly<{ analyze: boolean; format: boolean }>;
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
  insertDefaultValues: true,
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
  explainOptions: Object.freeze({ analyze: true, format: true }),
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
