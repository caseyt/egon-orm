/**
 * The adapter contract: everything the repo needs from a database, and nothing about how
 * it is provided. Egon emits its own SQL and wraps the drivers itself (decision D12,
 * ADR 0003), but no driver type appears here, so a back end can be replaced without
 * touching the repo.
 *
 * Implemented by step 10 (the `compile*` methods and the plan cache), step 11 (execution,
 * connections, errors, `@egon-orm/postgres`) and step 17 (SQLite, MySQL). Consumed by the
 * repo (12, 13, 14, 16) and by migrations (18).
 *
 * @module
 */
import type { ExprNode, FragmentNode, QueryAst, QueryOperation } from "./query.js";
import type { FieldMeta, SchemaMeta } from "./schema.js";
import type { AnyFieldType, Codec } from "./type.js";

/**
 * The SQL dialects.
 *
 * @example
 * ```ts
 * const dialect: Dialect = "postgres";
 * ```
 */
export type Dialect = "postgres" | "mysql" | "sqlite";

/**
 * Where one placeholder of a compiled statement gets its value at execution time. A
 * compiled statement has one slot per placeholder, in placeholder order, so building the
 * driver's parameter array is one loop over the slots (`bindParams`, step 10).
 *
 * - `inline`: the value at `params[index]`.
 * - `list`: the array at `params[index]`, bound as **one** parameter (`= ANY($1)`).
 * - `element`: `params[index][element]`, one placeholder of a list that the dialect
 *   expands to `IN (?, ?, …)`. The list's length is then part of the plan-cache key
 *   (`QueryAst.listLengths`).
 * - `named`: the value the caller supplied under `name`.
 *
 * `params` is the array the compiled statement was defined over: `QueryAst.params` for
 * {@link Adapter.compile}, and the arrays described on {@link Adapter.compileInsert},
 * {@link Adapter.compileUpdate}, {@link Adapter.compileDelete} and
 * {@link Adapter.compileFragment} for those.
 *
 * `toDb` converts the application value to the driver value. `undefined` means "pass it
 * through" (the type's toDb was the identity), so the hot path tests one property instead
 * of calling a function. It is never called with `null`. For `list` it is applied to
 * every element.
 *
 * `redact` is true when the value belongs to a redacted field (`FieldMeta.redact`, or a
 * parameter node marked `redact`). Telemetry and logs show `**redacted**` in its place.
 *
 * The same parameter may fill several slots.
 *
 * @example
 * ```ts
 * // WHERE "u"."id" = ANY($1) AND "u"."age" >= $2
 * const slots: ParamSlot[] = [
 *   { kind: "list", index: 1, toDb: undefined, redact: false },
 *   { kind: "named", name: "minAge", toDb: undefined, redact: false },
 * ];
 * ```
 */
export type ParamSlot =
  | {
      readonly kind: "inline";
      readonly index: number;
      readonly toDb: ToDb | undefined;
      readonly redact: boolean;
    }
  | {
      readonly kind: "list";
      readonly index: number;
      readonly toDb: ToDb | undefined;
      readonly redact: boolean;
    }
  | {
      readonly kind: "element";
      readonly index: number;
      readonly element: number;
      readonly toDb: ToDb | undefined;
      readonly redact: boolean;
    }
  | {
      readonly kind: "named";
      readonly name: string;
      readonly toDb: ToDb | undefined;
      readonly redact: boolean;
    };

/**
 * Converts one non-null application value to what the driver takes.
 *
 * @example
 * ```ts
 * const dumpDate: ToDb = (value) => (value as Date).toISOString();
 * ```
 */
export type ToDb = (value: unknown) => unknown;

/**
 * A preloaded association that a `row` leaf of an {@link OutputPlan} carries (step 14).
 * The compiler lists every association the query preloads on that row, taken from
 * `QueryAst.preloads` (preload names are part of `shape`, so they belong to the plan).
 *
 * - With `row`, it is a **join preload**: the child is built from columns of the same
 *   result row, as `row` says.
 * - With `row` undefined, the association is loaded by a **separate query** after
 *   decoding; the plan only reserves the property.
 *
 * @example
 * ```ts
 * declare const posts: OutputPlan & { kind: "row" };
 * const joined: OutputPreload = { assoc: "posts", cardinality: "many", row: posts };
 * const separate: OutputPreload = { assoc: "profile", cardinality: "one", row: undefined };
 * ```
 */
export interface OutputPreload {
  /** The association name: the property the children are stored under. */
  readonly assoc: string;
  /** `"many"` holds an array of children; `"one"` holds a child or `null`. */
  readonly cardinality: "one" | "many";
  /** How to build one child from the result row (a `row` leaf, which may nest further); `undefined` for a separate-query preload. */
  readonly row: OutputPlan | undefined;
}

/**
 * How to turn one result row into what the query selected. It mirrors the query's
 * `SelectShape` with, at every leaf, the output column alias (`c0`, `c1`, …) to read.
 * Produced by the compiler (step 10); step 12 builds the {@link RowDecoder} from it.
 *
 * - `value`: one column; `type` loads it when present.
 * - `row`: a schema row; `aliases[i]` is the output column of `meta.persisted[i]`.
 *   `nullable` is true when the binding can be absent from a result row (it is on the
 *   optional side of an outer join): the decoder then yields `null` instead of a row
 *   when every `key` column is `null`. For a schema without a primary key `key` is empty
 *   and proves nothing, so the test is then that every column in `aliases` is `null`
 *   (the compiler always lists them all; a real row of such a schema whose columns are
 *   all `NULL` cannot be told from an absent one, which is a limit of keyless schemas).
 *   `key` holds the output columns of the primary key, in `meta.primaryKey` order
 *   (empty for a schema without one): what identifies the row in the result.
 *   `schema` is the resolved database schema of the table source the rows originate from, or the
 *   schema's declared database schema when they have no single origin ("Database schemas" on
 *   {@link Adapter}, rule 2). The decoder stamps each row from its own leaf:
 *   `leaf.meta.rowMeta("loaded", leaf.schema)`.
 *   `preloads` lists the associations the row carries (empty for an ordinary row). A row
 *   with preloads is built with `meta.createWith(preloads.map((p) => p.assoc))`.
 * - `constant`: no column. The value is `constants[index]` of the query's `SelectNode`,
 *   returned as it is; it was never sent to the database.
 * - `object` / `tuple`: an object or array of the nested plans.
 *
 * ## Join preloads: who does what
 *
 * A {@link RowDecoder} sees one result row, is generated once per plan and is shared by
 * every execution of it, so it holds no state and **cannot de-duplicate parents**. With a
 * join preload several result rows describe one parent, and the work is split:
 *
 * 1. **The decoder, per result row,** builds the parent with the child of *that* row in
 *    place: for a join preload with cardinality `many`, an array holding the one child
 *    (empty when the child's `key` columns are all `null`); with cardinality `one`, the
 *    child or `null`. A separate-query preload starts as an empty array or `null`.
 * 2. **The repo's post-decode stage** (step 12's `afterDecode(rows, plan, ctx)` hook,
 *    implemented by step 14) merges the decoded values: parents with equal primary keys
 *    become the first one seen, in first-seen order; their `many` children are
 *    concatenated and de-duplicated by the child's primary key; the same is applied to
 *    each child's own join preloads. It needs nothing but the plan: the `row` leaves say
 *    where parents and children are, `meta.primaryKey` names the key fields to compare on
 *    the decoded rows, and `preloads` names the properties and their cardinality.
 *
 * @example
 * ```ts
 * // select(({ u }) => ({ id: u.id, email: u.email, kind: "user" }))
 * const plan: OutputPlan = {
 *   kind: "object",
 *   keys: ["id", "email", "kind"],
 *   values: [
 *     { kind: "value", alias: "c0", type: undefined },
 *     { kind: "value", alias: "c1", type: undefined },
 *     { kind: "constant", index: 0 },
 *   ],
 * };
 * ```
 */
export type OutputPlan =
  | { readonly kind: "value"; readonly alias: string; readonly type: AnyFieldType | undefined }
  | {
      readonly kind: "row";
      readonly meta: SchemaMeta;
      readonly aliases: readonly string[];
      readonly key: readonly string[];
      readonly schema: string | undefined;
      readonly nullable: boolean;
      readonly preloads: readonly OutputPreload[];
    }
  | { readonly kind: "constant"; readonly index: number }
  | { readonly kind: "object"; readonly keys: readonly string[]; readonly values: readonly OutputPlan[] }
  | { readonly kind: "tuple"; readonly items: readonly OutputPlan[] };

/**
 * Turns one raw result row into the value the query selected. Generated once per plan and
 * shared by every execution of it, so it is a pure function of its arguments: it keeps no
 * state between rows. Anything that spans rows (merging the parents of a join preload) is
 * done after decoding; see {@link OutputPlan}.
 * `constants` is the `constants` array of the executed query's `SelectNode` (an empty
 * array when it has none): a plan is shared by every query of one shape, so the values
 * of selected constants come from the query, never from the plan.
 *
 * @example
 * ```ts
 * const decode: RowDecoder = (row, constants) => ({ id: row.c0, kind: constants[0] });
 * ```
 */
export type RowDecoder = (row: Readonly<Record<string, unknown>>, constants: readonly unknown[]) => unknown;

/**
 * A compiled statement, as the plan cache holds it: SQL text, and the recipe for the
 * parameter array of each execution. It holds no values, so one plan serves every query
 * of the same shape.
 *
 * `decoder` is the one mutable member: the repo fills it in the first time the plan is
 * executed (the adapter always creates it as `undefined`), so that the decoder is built
 * once per plan and found without a lookup.
 *
 * @example
 * ```ts
 * const plan: CompiledQuery = {
 *   sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."age" >= $1',
 *   slots: [{ kind: "inline", index: 0, toDb: undefined, redact: false }],
 *   output: { kind: "value", alias: "c0", type: undefined },
 *   schema: undefined,
 *   decoder: undefined,
 * };
 * ```
 */
export interface CompiledQuery {
  readonly sql: string;
  /** One per placeholder, in placeholder order. */
  readonly slots: readonly ParamSlot[];
  /** What the result rows hold; `undefined` when the rows are returned raw or there are none. */
  readonly output: OutputPlan | undefined;
  /**
   * The database schema the statement's **target or root table** resolved to (see "Database schemas" on
   * {@link Adapter}): the table written by a row-level write, an `updateAll` or a
   * `deleteAll`; the root source of a query when that is a table; `undefined` otherwise
   * (a fragment, or a root that is a subquery, a CTE or a values list).
   *
   * It is what the repo stamps on the row it returns from a **row-level write**
   * (`meta.rowMeta("loaded", plan.schema)`), where there is one table and no output-plan
   * leaf to ask, and what telemetry reports. Rows decoded from a query's
   * {@link OutputPlan} are **not** stamped with it: each takes the database schema of its own
   * `row` leaf, because a joined table can resolve to another database schema than the root. For a
   * query whose root is a table it equals the root leaf's `schema`; it is kept, although
   * redundant there, so that writes and queries report their table the same way.
   */
  readonly schema: string | undefined;
  /** Set by the repo, not by the adapter. */
  decoder: RowDecoder | undefined;
}

/**
 * What a statement returned, exactly as the driver reported it.
 *
 * @example
 * ```ts
 * const result: RawResult = { rows: [{ c0: 1 }], rowCount: 1, insertId: undefined };
 * ```
 */
export interface RawResult {
  readonly rows: readonly Record<string, unknown>[];
  /** Rows returned by a `SELECT`; rows affected by an `INSERT`, `UPDATE` or `DELETE`. */
  readonly rowCount: number;
  /**
   * The key the database generated for the last inserted row, on dialects that report it
   * with the result (MySQL's `insertId`, SQLite's `lastInsertRowid`); `undefined`
   * otherwise, and always on Postgres. It is what the insert path reads back on a dialect
   * without `RETURNING` (step 13).
   */
  readonly insertId: bigint | number | undefined;
}

/**
 * What a dialect supports. The compiler checks these before it lowers a feature and
 * throws `QueryError` naming the feature and the dialect, so that an unsupported query
 * fails when it is compiled and never reaches the database as a syntax error.
 * Conformance tests are skipped by these flags, never by dialect name.
 *
 * @example
 * ```ts
 * function supportsUpsert(capabilities: Capabilities): boolean {
 *   return capabilities.onConflict && capabilities.returning;
 * }
 * ```
 */
export interface Capabilities {
  /** `INSERT`/`UPDATE`/`DELETE … RETURNING`. */
  readonly returning: boolean;
  /** `ON CONFLICT` (or an equivalent upsert clause). */
  readonly onConflict: boolean;
  /** A conflict target can be named: columns, a constraint, or an index expression. */
  readonly conflictTarget: boolean;
  /** A native case-insensitive `ILIKE`. */
  readonly ilike: boolean;
  readonly lateralJoin: boolean;
  readonly fullJoin: boolean;
  readonly distinctOn: boolean;
  /** Array columns and the array operators. */
  readonly arrays: boolean;
  /** An array can be bound as one parameter (`= ANY($1)`); otherwise lists are expanded. */
  readonly arrayParams: boolean;
  /** A binary JSON column type with operators. */
  readonly jsonb: boolean;
  /** `ORDER BY … NULLS FIRST | NULLS LAST`. */
  readonly nullsOrder: boolean;
  /** `UPDATE … FROM` and `DELETE … USING`. */
  readonly updateJoin: boolean;
  /** `WITH … AS [NOT] MATERIALIZED`. */
  readonly cteMaterialized: boolean;
  /** A CTE whose query writes (`updateAll` or `deleteAll` in a `WITH`): Postgres only. */
  readonly writingCtes: boolean;
  /** `INTERSECT ALL` and `EXCEPT ALL` (`UNION ALL` is everywhere). */
  readonly intersectExceptAll: boolean;
  /** `INSERT … DEFAULT VALUES`. */
  readonly insertDefaultValues: boolean;
  /**
   * The keyword `DEFAULT` as a value in an `INSERT … VALUES` list, which is how rows with
   * different sets of fields share one statement (`insertAll`). SQLite has no such form.
   */
  readonly defaultInValues: boolean;
  /** `aggregate(…) FILTER (WHERE …)`. */
  readonly aggregateFilter: boolean;
  /**
   * A running statement can be stopped by its `signal` or `timeoutMs`. Without it (SQLite,
   * whose driver runs a statement synchronously) both bound only the wait for the
   * connection, and the time between the batches of a stream.
   */
  readonly cancel: boolean;
  /** `begin({ readOnly: true })`: a transaction that refuses writes. */
  readonly readOnlyTransactions: boolean;
  /** `begin({ deferrable })`. */
  readonly deferrableTransactions: boolean;
  /**
   * The adapter holds several connections at a time, each a session of its own on the
   * database server. Without it (SQLite) there is one handle, which one caller uses at a
   * time: a second caller, a pooled statement included, waits until the transaction or
   * stream that holds it ends, and there is no server session to end from outside.
   */
  readonly multipleConnections: boolean;
  /**
   * A transaction under `repeatable read` or `serializable` that loses a conflict with
   * another fails with a serialization failure (retryable). Without it (MySQL) conflicts
   * are resolved with row locks: the other transaction waits, or one of the two fails with
   * a deadlock.
   */
  readonly serializationFailures: boolean;
  /**
   * A float column stores `NaN`, `Infinity` and `-Infinity`. Without it (MySQL has none of
   * them, SQLite stores `NaN` as `NULL`) writing one throws `CastError`.
   */
  readonly nonFiniteFloats: boolean;
  /**
   * A decimal column keeps a number as it was given, its scale included, and compares by
   * value (`1.0` equals `1.00`, and reads back as written). Without it a decimal column has
   * a fixed scale (MySQL reads `1.0` back from a `decimal(10, 2)` as `1.00`), or is stored
   * as the text it was given and compares as text (SQLite).
   */
  readonly exactDecimals: boolean;
  /** `explain` takes the `analyze` and `format` options. */
  readonly explainOptions: boolean;
  /**
   * `LIMIT` and `OFFSET` take an expression. Without it (MySQL) they take a value only,
   * and `first()` of a query whose limit is a named parameter is refused.
   */
  readonly limitExpressions: boolean;
  /**
   * A foreign-key violation names its constraint, so that a declared `foreignKeyConstraint`
   * or `noAssocConstraint` can match it. SQLite names none (nor the table): the violation
   * is then a `ConstraintError` of type `foreignKey` whatever the changeset declares.
   */
  readonly foreignKeyNames: boolean;
  /** An upsert's conflict target may name a constraint (`{ constraint: "users_email_key" }`). */
  readonly conflictConstraint: boolean;
  /**
   * Identifiers longer than 64 bytes can be used: kept whole (SQLite), or shortened to the
   * database's limit (Postgres), which the repo allows for when it matches a constraint's
   * default name. MySQL refuses an identifier longer than 64 characters: a default name
   * that long cannot exist there, so name such a constraint and declare it with `{ name }`.
   */
  readonly longIdentifiers: boolean;
  /** The lock clauses `lock()` accepts as plain strings, upper case: `"FOR UPDATE"`, … Empty when none. */
  readonly lockModes: readonly string[];
  /** The isolation levels `begin` accepts. Empty when the dialect has none to choose from. */
  readonly isolationLevels: readonly IsolationLevel[];
  readonly savepoints: boolean;
  /** DDL statements take part in transactions (false means an implicit commit). */
  readonly ddlTransactions: boolean;
  /** Rows can be streamed with a server-side cursor. */
  readonly stream: boolean;
  /** The largest number of bound parameters in one statement. */
  readonly maxParams: number;
}

/**
 * The transaction isolation levels.
 *
 * @example
 * ```ts
 * const level: IsolationLevel = "serializable";
 * ```
 */
export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

/**
 * Options for starting a transaction.
 *
 * @example
 * ```ts
 * const options: BeginOptions = { isolation: "serializable", readOnly: true };
 * ```
 */
export interface BeginOptions {
  readonly isolation?: IsolationLevel;
  /** Where `capabilities.readOnlyTransactions` holds. */
  readonly readOnly?: boolean;
  /** Postgres: `DEFERRABLE`, meaningful with `serializable` and `readOnly` (`capabilities.deferrableTransactions`). */
  readonly deferrable?: boolean;
}

/**
 * Options for one execution.
 *
 * @example
 * ```ts
 * declare const plan: CompiledQuery;
 * const options: ExecuteOptions = {
 *   timeoutMs: 5_000,
 *   slots: plan.slots,
 *   context: { operation: "all", source: "users" },
 * };
 * ```
 */
export interface ExecuteOptions {
  /** Aborting cancels the statement on the server; the call rejects with `DatabaseError` (code `"aborted"`). */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /**
   * Runs the statement as a named server-side prepared statement, where the dialect has
   * them (step 09, `prepare(query, { name })`). The same name must always go with the
   * same SQL text. Ignored by dialects without named statements.
   */
  readonly statementName?: string;
  /**
   * The slots of the plan being executed (`plan.slots`, no copy). The adapter needs them
   * for one thing: `params[i]` is replaced by `**redacted**` in a {@link QueryEvent} when
   * `slots[i].redact` is true. Without them an adapter that reports parameters must
   * treat every parameter as redacted.
   */
  readonly slots?: readonly ParamSlot[];
  /**
   * Anything the caller wants back: it is handed, untouched, to the listeners as
   * {@link QueryEvent.context} of the event for this execution. This is how the repo
   * attaches its own facts (operation, source schema, the caller's `context` option) to
   * the right event when executions overlap.
   */
  readonly context?: unknown;
}

/**
 * Options for a streamed execution.
 *
 * @example
 * ```ts
 * const options: StreamOptions = { batchSize: 500 };
 * ```
 */
export interface StreamOptions extends ExecuteOptions {
  /** How many rows to fetch from the server at a time. */
  readonly batchSize?: number;
}

/**
 * Anything that can run SQL: an {@link Adapter} (on any pooled connection) or a
 * {@link Connection} (on that connection). The repo is written against this, which is
 * how a transaction-scoped repo is the same code as the root repo.
 *
 * Errors thrown by the driver are passed through {@link Adapter.normalizeError} first.
 *
 * @example
 * ```ts
 * async function countUsers(db: Executor): Promise<number> {
 *   const result = await db.execute('select count(*)::int as "c0" from "users"', []);
 *   return result.rows[0]?.c0 as number;
 * }
 * ```
 */
export interface Executor {
  /** Runs one statement and returns all of its rows. */
  execute(sql: string, params: readonly unknown[], options?: ExecuteOptions): Promise<RawResult>;
  /**
   * Runs one statement and yields its rows as they arrive. Leaving the loop early closes
   * the cursor and frees the connection.
   */
  stream(
    sql: string,
    params: readonly unknown[],
    options?: StreamOptions,
  ): AsyncIterable<Record<string, unknown>>;
}

/**
 * One checked-out database connection: the unit a transaction runs on. Every method
 * runs on this connection and nowhere else.
 *
 * A connection that fails fatally (socket closed, protocol error) is destroyed on
 * `release`, not returned to the pool. The caller can force that with `destroy`, for a
 * connection whose state it can no longer trust (step 16: a `ROLLBACK` that failed).
 *
 * @example
 * ```ts
 * async function inTransaction(adapter: Adapter, work: (db: Executor) => Promise<void>): Promise<void> {
 *   const connection = await adapter.acquire();
 *   try {
 *     await connection.begin();
 *     await work(connection);
 *     await connection.commit();
 *   } catch (error) {
 *     try {
 *       await connection.rollback();
 *     } catch {
 *       await connection.destroy();
 *     }
 *     throw error;
 *   } finally {
 *     await connection.release();
 *   }
 * }
 * ```
 */
export interface Connection extends Executor {
  begin(options?: BeginOptions): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** `SAVEPOINT name`. The name is quoted as an identifier. */
  savepoint(name: string): Promise<void>;
  /** `ROLLBACK TO SAVEPOINT name`. */
  rollbackTo(name: string): Promise<void>;
  /** `RELEASE SAVEPOINT name`. */
  releaseSavepoint(name: string): Promise<void>;
  /** Returns the connection to the pool. Idempotent, and a no-op after `destroy`. */
  release(): Promise<void>;
  /** Closes the connection and removes it from the pool instead of returning it. Idempotent. */
  destroy(): Promise<void>;
}

/**
 * What a compiled insert does when the row collides with an existing one. An insert with
 * no conflict handling has none of this (`InsertPlanOptions.onConflict` is `undefined`)
 * and a conflict is an error.
 *
 * - `"nothing"`: `DO NOTHING`.
 * - `{ target, update }`: update the existing row; see {@link ConflictUpdate} and
 *   {@link ConflictTarget}. `target` is `undefined` when none was given, which is the
 *   only form MySQL accepts.
 *
 * @example
 * ```ts
 * declare const email: FieldMeta;
 * declare const name: FieldMeta;
 * const onConflict: OnConflict = { target: [email], update: [name] };
 * ```
 */
export type OnConflict =
  | "nothing"
  | { readonly target: ConflictTarget | undefined; readonly update: ConflictUpdate };

/**
 * Which columns a conflicting insert updates on the existing row.
 *
 * - `"all"`: every inserted column.
 * - a list of fields: these fields.
 * - `{ except }`: every inserted column except these fields.
 *
 * @example
 * ```ts
 * declare const createdAt: FieldMeta;
 * const update: ConflictUpdate = { except: [createdAt] };
 * ```
 */
export type ConflictUpdate = "all" | readonly FieldMeta[] | { readonly except: readonly FieldMeta[] };

/**
 * Which conflict a compiled insert handles: the unique index on these fields, a named
 * constraint, or a fragment (an index expression, possibly with a predicate).
 *
 * @example
 * ```ts
 * const target: ConflictTarget = { constraint: "users_email_key" };
 * ```
 */
export type ConflictTarget = readonly FieldMeta[] | { readonly constraint: string } | FragmentNode;

/**
 * One cell of an insert whose rows are not all plain values.
 *
 * - `value`: a bound value, taken from the insert's parameter array.
 * - `default`: the keyword `DEFAULT`: the column's database default applies. This is how
 *   rows with different sets of fields ("ragged" rows) share one statement.
 * - `expr`: an expression, which may be a subquery (`{ kind: "subquery", … }`) or a
 *   fragment. Its parameter nodes carry their values, as in a query.
 * - `placeholder`: a value supplied by name and shared by many cells; it compiles to a
 *   `named` slot.
 *
 * @example
 * ```ts
 * const cells: InsertCell[] = [{ kind: "value" }, { kind: "default" }, { kind: "placeholder", name: "now" }];
 * ```
 */
export type InsertCell =
  | { readonly kind: "value" }
  | { readonly kind: "default" }
  | { readonly kind: "expr"; readonly expr: ExprNode }
  | { readonly kind: "placeholder"; readonly name: string };

/**
 * What an insert inserts.
 *
 * - `values`: `rows` rows, each a bound value for every column. The common case, and the
 *   one whose plan depends on nothing but the column list and the row count.
 * - `cells`: rows spelled out cell by cell (see {@link InsertCell}); every row has one
 *   cell per column.
 * - `query`: `INSERT INTO … (columns) SELECT …`; the query's select list supplies the
 *   columns, in order.
 *
 * @example
 * ```ts
 * const single: InsertSource = { kind: "values", rows: 1 };
 * const ragged: InsertSource = {
 *   kind: "cells",
 *   rows: [
 *     [{ kind: "value" }, { kind: "value" }],
 *     [{ kind: "value" }, { kind: "default" }],
 *   ],
 * };
 * ```
 */
export type InsertSource =
  | { readonly kind: "values"; readonly rows: number }
  | { readonly kind: "cells"; readonly rows: readonly (readonly InsertCell[])[] }
  | { readonly kind: "query"; readonly query: QueryAst };

/**
 * Everything about a compiled insert besides the table and the columns.
 *
 * @example
 * ```ts
 * declare const id: FieldMeta;
 * const options: InsertPlanOptions = {
 *   source: { kind: "values", rows: 1 },
 *   returning: [id],
 *   onConflict: undefined,
 * };
 * ```
 */
export interface InsertPlanOptions {
  readonly source: InsertSource;
  /** The fields to return, in order; empty for none. */
  readonly returning: readonly FieldMeta[];
  /** `undefined` when the insert handles no conflict: a conflict is then an error. */
  readonly onConflict: OnConflict | undefined;
}

/**
 * Options for {@link Adapter.compileExplain}.
 *
 * @example
 * ```ts
 * const options: ExplainOptions = { analyze: true, format: "json" };
 * ```
 */
export interface ExplainOptions {
  /** Executes the statement and reports actual timings. A write really happens. */
  readonly analyze?: boolean;
  readonly format?: "text" | "json";
}

/**
 * One executed statement, as reported to telemetry listeners. `params` is present only
 * when the adapter was configured to log parameters. A parameter that fills a slot marked
 * `redact` appears as `**redacted**`; when the execution was not given its slots
 * (`ExecuteOptions.slots`), every parameter does.
 *
 * @example
 * ```ts
 * function logSlow(event: QueryEvent): void {
 *   if (event.durationMs > 100) process.stderr.write(`slow query (${event.durationMs} ms): ${event.sql}\n`);
 * }
 * ```
 */
export interface QueryEvent {
  readonly sql: string;
  readonly paramCount: number;
  /** Time spent executing, in milliseconds. */
  readonly durationMs: number;
  /** Time spent waiting for a connection, in milliseconds. */
  readonly queueMs: number;
  readonly rowCount: number;
  /** The normalised error, when the statement failed. */
  readonly error: unknown;
  readonly params: readonly unknown[] | undefined;
  /** The `context` the caller passed in `ExecuteOptions`, untouched; `undefined` when it passed none. */
  readonly context: unknown;
}

/**
 * The state of the connection pool, reported with pool events.
 *
 * @example
 * ```ts
 * function isSaturated(event: PoolEvent): boolean {
 *   return event.idle === 0 && event.waiting > 0;
 * }
 * ```
 */
export interface PoolEvent {
  /** Open connections. */
  readonly size: number;
  /** Open connections that are not checked out. */
  readonly idle: number;
  /** Callers waiting for a connection. */
  readonly waiting: number;
}

/**
 * The events an adapter emits, by name.
 *
 * @example
 * ```ts
 * type Listener = (event: AdapterEvents["query"]) => void;
 * ```
 */
export interface AdapterEvents {
  readonly query: QueryEvent;
  readonly connect: PoolEvent;
  readonly disconnect: PoolEvent;
  readonly poolExhausted: PoolEvent;
}

/**
 * A database, as the repo sees it: compile statements, run them, hand out connections.
 *
 * `compile*` methods are synchronous and cached per adapter instance: the same query
 * shape, or the same (schema, operation, column set, options), with the same database schema,
 * returns the same {@link CompiledQuery}.
 *
 * ## Database schemas
 *
 * A database schema is the Postgres schema or the MySQL database a table lives in. Two rules
 * decide every database schema; everything after them is a consequence.
 *
 * **Rule 1, resolution.** A database schema is decided in exactly one place: where a table source
 * is lowered. It is the first that is set of
 *
 * `source.schema ?? schemaMeta.schema ?? query.schema ?? argument`
 *
 * where `source.schema` is the database schema given to that `from` or join, `schemaMeta.schema`
 * the one the schema declares, `query.schema` the database schema of the nearest enclosing query
 * that sets one (the query the source sits in, else the one around it, and so on
 * outward), and `argument` the `schema` parameter of `compile` and `compileExplain`.
 * Nothing else in the compiler decides a database schema.
 *
 * **Rule 2, provenance.** A `row` leaf of the {@link OutputPlan} carries the resolved
 * database schema of the table source its rows originate from. The value travels upward unchanged
 * through whatever wraps that source (a subquery, a CTE, a join preload, `RETURNING`),
 * because an outer leaf is built from the inner leaf and never resolved again. A row with
 * no single originating table source has no provenance, and its leaf takes the database schema
 * its schema declares (`SchemaMeta.schema`).
 *
 * **To step 10:** implement this as one resolve function, called where a table source is
 * lowered, plus propagation of the leaf's value; there must be no database schema logic per node
 * kind. The enclosing query's database schema is just the value handed down when a nested query
 * (a subquery, a CTE body, a set-operation branch) is lowered: its own if it sets one,
 * else the one it was handed.
 *
 * ### What the repo passes
 *
 * - **A query** (`compile`, `compileExplain`): `argument` is the per-call `schema` option,
 *   else the repo default. It is the weakest position.
 * - **A row-level write** (`compileInsert`, `compileUpdate`, `compileDelete`): the
 *   statement has one table source and no query, and its `schema` parameter is that
 *   source's `source.schema`, the strongest position (there is no `argument`). The repo
 *   passes the per-call option, else the row's `RowMeta.schema`, else its default.
 *   An insert has no row (a new record is a changeset, decision D2), and neither has
 *   `insertAll`: both use the schema's declared database schema in the row's place.
 * - **`reload`:** the repo puts the row's `RowMeta.schema` on the source of the query it
 *   builds (`source.schema`), with rows of different database schemas in separate queries.
 * - **A separate-query preload (step 14):** the repo passes the parents'
 *   `RowMeta.schema` as `argument`, with parents of different database schemas in separate
 *   queries.
 *
 * A decoded row is stamped from its leaf: `leaf.meta.rowMeta("loaded", leaf.schema)`.
 * The repo never rewrites an AST to apply a database schema.
 *
 * ### Consequences
 *
 * - A schema that declares a database schema keeps it whatever the query, the call or the repo
 *   say; a per-call database schema on a read does not override a query's own; a per-call database schema
 *   on a write overrides everything.
 * - A row is written back, and reloaded, where it was read: both put the row's own
 *   database schema in the strongest position.
 * - The tables of one statement can resolve differently, so rows of one result can carry
 *   different database schemas (second table below). Children of a join preload carry theirs.
 * - A row read through a subquery or a CTE carries the database schema of the inner table (third
 *   table below). A CTE reference (`CteSourceNode`) is not a table source: rule 1 does
 *   not apply to it, and its leaf is the CTE's own, including inside a recursive CTE,
 *   where the self-reference adds nothing to the anchor's provenance.
 * - A set operation has provenance when all its branches agree on the database schema, and none
 *   when they differ. Rows built from expressions, from a values list or from a fragment
 *   have none. With no provenance the row holds its schema's declared database schema and is
 *   written back to it; select the database schema as a column to do otherwise.
 * - A separate-query preload is a query of its own: its children are stamped from its
 *   own leaves.
 * - A nested query that sets no database schema reads where its enclosing query reads (fourth
 *   table below), so the branches of a set operation normally agree.
 * - `updateAll` and `deleteAll` are queries: every table resolves by rule 1, `RETURNING`
 *   rows are stamped from their leaves, and {@link CompiledQuery.schema} is the target's.
 *   `compileExplain` resolves as `compile` does. Streams use the same decoder.
 * - The plan cache key is the top-level query's structure plus the `schema` parameter.
 *   The per-source database schemas, the database schema of the query and of every query nested in it, and
 *   each schema (its name and declared database schema) are part of the structure; see "Shape" in
 *   `query.ts`. A nested query has no plan of its own: what it compiles to depends on the
 *   database schema it inherits.
 *
 * ### Checks
 *
 * One table, no per-call option. Every operation lands on the same table:
 *
 * | Schema declares | Repo default | insert | get / all | update | delete |
 * |---|---|---|---|---|---|
 * | `auth` | none | `auth` (schema) | `auth` (schema) | `auth` (the row's) | `auth` |
 * | none | `tenant_1` | `tenant_1` (repo default) | `tenant_1` (argument) | `tenant_1` (the row's) | `tenant_1` |
 * | `auth` | `tenant_1` | `auth` (schema before repo default) | `auth` (schema before argument) | `auth` (the row's) | `auth` |
 *
 * Several tables. Repo default `tenant_1`; `User` declares none; `Org` declares `global`;
 * `Post` is joined with the per-source database schema `archive`; all three bindings selected:
 *
 * | Binding | Rule 1 stops at | Read from | Row's `RowMeta.schema` | `update` / `delete` of that row |
 * |---|---|---|---|---|
 * | `u` (`User`) | the argument | `tenant_1.users` | `tenant_1` | `tenant_1.users` |
 * | `o` (`Org`) | the schema | `global.orgs` | `global` | `global.orgs` |
 * | `p` (`Post`) | the source | `archive.posts` | `archive` | `archive.posts` |
 *
 * Through a subquery. Repo default `tenant_1`; `Post` declares none; a subquery over
 * `Post` whose source has the per-source database schema `archive` (or whose query database schema is
 * `archive`), used as the source of an outer binding `s` that is selected whole:
 *
 * | Binding | Rule 1, at the inner source | Rule 2 | Read from | Row's database schema | `update` / `delete` | `reload` |
 * |---|---|---|---|---|---|---|
 * | `s` | `archive` | the outer leaf is the inner leaf's | `archive.posts` | `archive` | `archive.posts` | `archive.posts` |
 *
 * Inherited query database schema. Repo default `tenant_1`; `Post` declares none; no per-source
 * database schema anywhere:
 *
 * | Query | `query.schema` at the inner source | Read from | Row's database schema |
 * |---|---|---|---|
 * | a subquery `from(Post, "p")` with no database schema, as the source of an outer query whose database schema is `archive` | `archive`, inherited from the outer query | `archive.posts` | `archive` |
 * | `from(Post, "p")` with database schema `archive`, `unionAll` a branch `from(Post, "p")` with none | `archive` in both: the branch inherits it | `archive.posts`, both branches | `archive` (the branches agree, so there is provenance) |
 *
 * @example
 * ```ts
 * async function all(adapter: Adapter, ast: QueryAst): Promise<readonly Record<string, unknown>[]> {
 *   const plan = adapter.compile(ast, "all", undefined);
 *   const params = plan.slots.map((slot) => (slot.kind === "inline" ? ast.params[slot.index] : undefined));
 *   return (await adapter.execute(plan.sql, params, { slots: plan.slots })).rows;
 * }
 * ```
 */
export interface Adapter extends Executor {
  readonly dialect: Dialect;
  readonly capabilities: Capabilities;

  /**
   * Compiles a query. Slots refer to `ast.params`.
   *
   * @throws QueryError when the query is invalid or uses a feature the dialect lacks.
   */
  compile(ast: QueryAst, operation: QueryOperation, schema: string | undefined): CompiledQuery;

  /**
   * Compiles the statement that asks the database for the plan of a query: what
   * `repo.explain` runs. The `EXPLAIN` syntax and its options are the dialect's. Slots
   * refer to `ast.params`; `output` is `undefined` (the rows are the database's report).
   *
   * @throws QueryError when the dialect lacks an option that was asked for.
   */
  compileExplain(
    ast: QueryAst,
    operation: QueryOperation,
    schema: string | undefined,
    options: ExplainOptions,
  ): CompiledQuery;

  /**
   * Compiles a bare fragment as a whole statement: what `repo.raw(fragment\`…\`)` runs.
   * The static strings are emitted as written, values are bound, and `fragment.ident`
   * names are quoted for the dialect. Slots refer to the values of the fragment's
   * parameter nodes in canonical order (`collectParams(fragment)`). `output` is
   * `undefined`: the rows are returned raw.
   */
  compileFragment(fragment: FragmentNode): CompiledQuery;

  /**
   * Compiles `INSERT INTO source (columns…) … [ON CONFLICT …] [RETURNING …]`.
   *
   * Slots refer to one flat parameter array, which the repo builds in two sections:
   *
   * 1. **The source.**
   *    - `values`: row by row; the value of `columns[c]` for row `r` is at index
   *      `r * columns.length + c`.
   *    - `cells`: row by row and cell by cell; a `value` cell takes one entry, an `expr`
   *      cell takes the values of its parameter nodes in canonical order, a `default` or
   *      `placeholder` cell takes none.
   *    - `query`: `query.params`.
   * 2. **The conflict target**, when it is a fragment: the values of its parameter nodes
   *    in canonical order.
   *
   * `placeholder` cells and named parameter nodes compile to `named` slots.
   *
   * @throws QueryError when a form is used that the dialect lacks (`capabilities`).
   */
  compileInsert(
    meta: SchemaMeta,
    columns: readonly FieldMeta[],
    options: InsertPlanOptions,
    schema: string | undefined,
  ): CompiledQuery;

  /**
   * Compiles `UPDATE source SET set… WHERE where… [RETURNING …]`, where every `where`
   * field is compared for equality. Slots refer to the `set` values followed by the
   * `where` values.
   */
  compileUpdate(
    meta: SchemaMeta,
    set: readonly FieldMeta[],
    where: readonly FieldMeta[],
    returning: readonly FieldMeta[],
    schema: string | undefined,
  ): CompiledQuery;

  /**
   * Compiles `DELETE FROM source WHERE where… [RETURNING …]`. Slots refer to the `where` values.
   */
  compileDelete(
    meta: SchemaMeta,
    where: readonly FieldMeta[],
    returning: readonly FieldMeta[],
    schema: string | undefined,
  ): CompiledQuery;

  /** Checks a connection out of the pool. The caller must `release` it. */
  acquire(): Promise<Connection>;

  /**
   * Maps a driver error to an Egon error (`ConstraintError`, `DatabaseError`, …), keeping
   * the original as `cause`. Anything it does not recognise is returned unchanged.
   */
  normalizeError(error: unknown): unknown;

  /**
   * The driver conversions this adapter needs for `type`, replacing the type's own
   * `fromDb` and `toDb`; `undefined` when the type's own are right. For example Postgres
   * sends `int8` and `numeric` as text. The answer depends on this adapter's options
   * (two Postgres adapters may fromDb `int8` differently), so `resolveCodec` (step 03)
   * caches it per (type, adapter instance), not per dialect.
   */
  readonly typeOverrides: (type: AnyFieldType) => Codec | undefined;

  /** Subscribes to an event. Returns the function that unsubscribes. */
  on<E extends keyof AdapterEvents>(event: E, listener: (payload: AdapterEvents[E]) => void): () => void;

  /** Closes the pool after the checked-out connections are released. Idempotent. */
  close(): Promise<void>;
}
