/**
 * The repo: the one object that talks to the database. {@link createRepo} makes one over
 * an adapter; {@link Repo} is its type, and the type of the transaction-scoped repo too.
 *
 * @module
 */
import type { PoolStats } from "../adapter/adapter.js";
import type { PlanCacheStats } from "../compiler/index.js";
import type { PoolEvent } from "../contracts/adapter.js";
import type { AnySchema, PrimaryKeyOf, Row } from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import type { ColumnNames, SchemaOfBinding } from "../query/bindings.js";
import type { Queryable, QueryLike, QueryParams, QueryResult, WhereObject } from "../query/builder.js";
import type { Expr, NoParams, ParamsOf, SomeParams } from "../query/expr.js";
import { isSchema } from "../schema/guards.js";
import {
  checkReadOptions,
  EXPLAIN_OPTION_KEYS,
  type ExplainReadOptions,
  READ_OPTION_KEYS,
  type ReadOptions,
  type RepoOptions,
  type RepoQueryEvent,
  repoSettings,
  type SplitArgs,
  SQL_OPTION_KEYS,
  STREAM_OPTION_KEYS,
  type StreamReadOptions,
  splitArgs,
  writeToStderr,
} from "./options.js";
import {
  type AggregateFunction,
  aggregate,
  byClauses,
  byKey,
  exactlyOne,
  exists,
  explain,
  first,
  inputOf,
  isFragment,
  load,
  QueryHub,
  type QueryInput,
  type RawRows,
  ReadCore,
  raw,
  reload,
  single,
  stream,
  toSql,
} from "./read.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What a read of `Q` returns per row: the rows of a schema class, or what a query selects.
 *
 * @example
 * ```ts
 * type U = ResultOf<typeof User>; // User
 * ```
 */
export type ResultOf<Q> = Q extends QueryLike ? QueryResult<Q> : Q extends AnySchema ? Row<Q> : never;

/** The named parameters a read of `Q` needs: none for a schema class. */
type ParamsOfQueryable<Q> = Q extends QueryLike ? QueryParams<Q> : NoParams;

/**
 * The arguments after the queryable: `[options?]` when the query has no named parameters,
 * `[params, options?]` when it has some (then `params` is required and typed).
 *
 * @example
 * ```ts
 * type A = ReadArgs<typeof adults, ReadOptions>; // [params: { minAge: number }, options?: ReadOptions]
 * ```
 */
export type ReadArgs<Q, O> = [keyof ParamsOfQueryable<Q>] extends [never]
  ? [options?: O]
  : [params: ParamsOfQueryable<Q>, options?: O];

/** Like {@link ReadArgs}, with the options required. */
type ReadArgsWith<Q, O> = [keyof ParamsOfQueryable<Q>] extends [never]
  ? [options: O]
  : [params: ParamsOfQueryable<Q>, options: O];

/** The arguments of `raw(fragment, …)`: its named parameters when it has some, then options. */
type RawArgs<X> = [keyof ParamsOf<X>] extends [never]
  ? [options?: ReadOptions]
  : [params: ParamsOf<X>, options?: ReadOptions];

/**
 * The schema class of the root binding of `Q`: `Q` itself for a schema class.
 *
 * @example
 * ```ts
 * type S = RootSchemaOf<typeof q>; // typeof User, for from(User, "u")…
 * ```
 */
export type RootSchemaOf<Q> = Q extends AnySchema
  ? Q
  : Q extends { readonly "~query": { readonly bindings: infer B; readonly root: infer A } }
    ? A extends keyof B
      ? SchemaOfBinding<B[A]>
      : never
    : never;

/** The object form of `where` over the root binding of `Q`: what `getBy` takes. */
type ClausesOf<Q> = RootSchemaOf<Q> extends infer S extends AnySchema ? WhereObject<S> : never;

/** The columns of the root binding of `Q`. */
type RootColumn<Q> = ColumnNames<RootSchemaOf<Q>>;

/** The application type of column `F` of the root binding of `Q`. */
type RootValue<Q, F> = F extends keyof Row<RootSchemaOf<Q>> ? Row<RootSchemaOf<Q>>[F] : never;

/** The root columns that `sum` and `avg` take: numbers, bigints and decimals. */
type NumericColumn<Q> = {
  [F in RootColumn<Q>]: RootValue<Q, F> extends number | bigint | string | null ? F : never;
}[RootColumn<Q>];

/** The type of `sum` over a column of type `T`, as the `sum` expression gives it. */
type SumOf<T> =
  | (NonNullable<T> extends bigint ? bigint : NonNullable<T> extends number ? number : string)
  | null;

/** The type of `avg` over a column of type `T`, as the `avg` expression gives it. */
type AvgOf<T> = (NonNullable<T> extends string ? string : number) | null;

/** Options of `repo.toSql`: only the database schema matters there. */
type SqlOptions = Pick<ReadOptions, "schema">;

/**
 * What `repo.toSql` returns: the SQL text and the parameters exactly as they would be
 * sent, converted for the driver (redacted values included: it is a debugging tool).
 *
 * @example
 * ```ts
 * const { sql, params }: SqlAndParams = repo.toSql(q);
 * ```
 */
export interface SqlAndParams {
  readonly sql: string;
  readonly params: unknown[];
}

/**
 * The repo: reads (this step), and the writes, preloads and transactions the later steps
 * add to the same interface. A transaction-scoped repo has the same type.
 *
 * Every read takes a **queryable**, a schema class (all of its rows) or a query. A query
 * with named parameters takes them as the second argument and its options third; one
 * without takes its options second.
 *
 * @example
 * ```ts
 * const repo: Repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });
 * const adults = await repo.all(from(User, "u").where(({ u }) => u.age.gte(18)));
 * ```
 */
export interface Repo {
  /**
   * Every row the query returns, in a fresh array.
   *
   * @example
   * ```ts
   * const users = await repo.all(User);
   * const titles = await repo.all(from(Post, "p").select(({ p }) => p.title), { timeoutMs: 500 });
   * ```
   *
   * @throws QueryError when the query cannot be compiled, or a named parameter is missing.
   * @throws DatabaseError when the database fails, times out (`"timeout"`) or the call is aborted (`"aborted"`).
   */
  all<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<ResultOf<Q>[]>;

  /**
   * The only row the query returns, or `null`. It adds no `LIMIT`: a second row means the
   * query is wrong, and is an error.
   *
   * @example
   * ```ts
   * const ada = await repo.one(from(User, "u").where({ email: "ada@example.com" }));
   * ```
   *
   * @throws MultipleResultsError when the query returns more than one row.
   */
  one<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<ResultOf<Q> | null>;

  /**
   * The only row the query returns.
   *
   * @example
   * ```ts
   * const ada = await repo.oneOrThrow(from(User, "u").where({ email: "ada@example.com" }));
   * ```
   *
   * @throws NoResultsError when the query returns no row.
   * @throws MultipleResultsError when it returns more than one.
   */
  oneOrThrow<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<ResultOf<Q>>;

  /**
   * The first row of the query with `LIMIT 1` (replacing a limit of its own), or `null`.
   * It never throws for extra rows; give the query an order to say which row is first.
   *
   * @example
   * ```ts
   * const newest = await repo.first(from(Post, "p").orderBy(({ p }) => p.createdAt.desc()));
   * ```
   */
  first<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<ResultOf<Q> | null>;

  /**
   * The row with primary key `id`, or `null`. For a composite key, `id` is an object of
   * the key fields.
   *
   * @example
   * ```ts
   * const user = await repo.get(User, 1);
   * const membership = await repo.get(Membership, { orgId, userId: 1 });
   * ```
   *
   * @throws QueryError when `id` is `null` or `undefined`, has the wrong shape for the key,
   * or the schema has no primary key.
   */
  get<S extends AnySchema>(schema: S, id: PrimaryKeyOf<S>, options?: ReadOptions): Promise<Row<S> | null>;

  /**
   * The row with primary key `id`.
   *
   * @example
   * ```ts
   * const user = await repo.getOrThrow(User, 1);
   * ```
   *
   * @throws NoResultsError when there is no such row.
   * @throws QueryError as {@link Repo.get} does.
   */
  getOrThrow<S extends AnySchema>(schema: S, id: PrimaryKeyOf<S>, options?: ReadOptions): Promise<Row<S>>;

  /**
   * The only row matching `clauses` (the object form of `where`, on the root binding), or
   * `null`. Strict, like {@link Repo.one}.
   *
   * @example
   * ```ts
   * const ada = await repo.getBy(User, { email: "ada@example.com" });
   * ```
   *
   * @throws MultipleResultsError when more than one row matches.
   */
  getBy<Q extends Queryable>(
    queryable: Q,
    clauses: ClausesOf<Q>,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q> | null>;

  /**
   * The only row matching `clauses`.
   *
   * @example
   * ```ts
   * const ada = await repo.getByOrThrow(User, { email: "ada@example.com" });
   * ```
   *
   * @throws NoResultsError when no row matches.
   * @throws MultipleResultsError when more than one does.
   */
  getByOrThrow<Q extends Queryable>(
    queryable: Q,
    clauses: ClausesOf<Q>,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q>>;

  /**
   * Whether the query returns any row. It runs `SELECT 1 … LIMIT 1`, without the select,
   * the order and the preloads.
   *
   * @example
   * ```ts
   * const taken = await repo.exists(from(User, "u").where({ email }));
   * ```
   */
  exists<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<boolean>;

  /**
   * How many rows the query returns: `aggregate(queryable, "count")`.
   *
   * @example
   * ```ts
   * const published = await repo.count(from(Post, "p").where({ published: true }));
   * ```
   */
  count<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<number>;

  /**
   * An aggregate over the query's rows: `count` of the rows, or `count`, `sum`, `avg`,
   * `min`, `max` of a column of its root binding. A query with a limit, an offset,
   * `distinct`, a set operation, a `groupBy` or a `having` is aggregated as a subquery,
   * so the aggregate sees exactly its rows. Over no rows `count` is 0 and the others are
   * `null`.
   *
   * @example
   * ```ts
   * const users = await repo.aggregate(User, "count");
   * const views = await repo.aggregate(Post, "sum", "views"); // number | null
   * const newest = await repo.aggregate(Post, "max", "createdAt"); // Date | null
   * ```
   *
   * @throws QueryError when the field is not a column of the root binding, or (`sum`,
   * `avg`) not a number.
   */
  aggregate<Q extends Queryable>(
    queryable: Q,
    fn: "count",
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<number>;
  aggregate<Q extends Queryable, F extends RootColumn<Q>>(
    queryable: Q,
    fn: "count",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<number>;
  aggregate<Q extends Queryable, F extends NumericColumn<Q>>(
    queryable: Q,
    fn: "sum",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<SumOf<RootValue<Q, F>>>;
  aggregate<Q extends Queryable, F extends NumericColumn<Q>>(
    queryable: Q,
    fn: "avg",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<AvgOf<RootValue<Q, F>>>;
  aggregate<Q extends Queryable, F extends RootColumn<Q>>(
    queryable: Q,
    fn: "min" | "max",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<NonNullable<RootValue<Q, F>> | null>;

  /**
   * The query's rows, fetched in batches through a server-side cursor and decoded one at
   * a time. Leaving the loop early (`break`, `return`, an exception) closes the cursor and
   * returns the connection. A stream cannot preload associations.
   *
   * @example
   * ```ts
   * for await (const user of repo.stream(from(User, "u"), { batchSize: 1_000 })) {
   *   await sendNewsletter(user);
   * }
   * ```
   *
   * @throws QueryError (when iterated) for a query with preloads.
   */
  stream<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgs<Q, StreamReadOptions>
  ): AsyncIterable<ResultOf<Q>>;

  /**
   * A fresh copy of a row, read again from the table (and database schema) it was read
   * from, or `null` when it is gone. Given an array, the copies in the same order.
   * Preloaded associations are not read again.
   *
   * The database matches the keys, with its own equality. Two limits:
   * - a key value the row could not hold exactly no longer equals the stored one, so such
   *   a row comes back `null` (a timestamp key with microseconds, read into a millisecond
   *   `Date`);
   * - the keys are sent cast to their fields' declared types, so a key column whose real
   *   type differs fails ("operator does not exist"): a `t.enum` key on a native Postgres
   *   enum column, for example. Declare such a field with `defineType` and the column's
   *   SQL type (`db: { kind: "custom", sql: "mood" }`), and the keys are cast to it.
   *
   * @example
   * ```ts
   * const fresh = await repo.reload(user);
   * const [a, b] = await repo.reload([first, second]);
   * ```
   *
   * @throws TypeError when given something that is not a row read from the database.
   */
  reload<R extends object>(rows: readonly R[], options?: ReadOptions): Promise<(R | null)[]>;
  reload<R extends object>(row: R, options?: ReadOptions): Promise<R | null>;

  /**
   * Like {@link Repo.reload}, but a row that is gone is an error.
   *
   * @example
   * ```ts
   * const fresh = await repo.reloadOrThrow(user);
   * ```
   *
   * @throws NoResultsError when a row is gone.
   */
  reloadOrThrow<R extends object>(rows: readonly R[], options?: ReadOptions): Promise<R[]>;
  reloadOrThrow<R extends object>(row: R, options?: ReadOptions): Promise<R>;

  /**
   * The SQL of the query and the parameters exactly as they would be sent. Redacted values
   * are included: this is a debugging tool, not a log.
   *
   * @example
   * ```ts
   * const { sql, params } = repo.toSql(from(User, "u").where(({ u }) => u.age.gte(18)));
   * ```
   */
  toSql<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, SqlOptions>): SqlAndParams;

  /**
   * The database's plan for the query: text by default, the database's structured plan
   * with `format: "json"`. With `analyze: true` the query really runs.
   *
   * @example
   * ```ts
   * const plan = await repo.explain(from(User, "u").where({ email }));
   * const json = await repo.explain(from(User, "u"), { format: "json", analyze: true });
   * ```
   */
  explain<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgsWith<Q, ExplainReadOptions & { readonly format: "json" }>
  ): Promise<unknown>;
  explain<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ExplainReadOptions>): Promise<string>;

  /**
   * Runs a statement written as a `fragment`, whose interpolations are bound parameters,
   * and returns its rows as the driver gave them. A plain string is refused, by the types
   * and at run time: SQL text comes only from the template's own strings.
   *
   * @example
   * ```ts
   * const { rows } = await repo.raw(fragment`select count(*) as n from users where age >= ${18}`);
   * ```
   *
   * @throws QueryError when `statement` is not a fragment.
   */
  raw<X extends Expr<unknown, SomeParams>>(statement: X, ...args: RawArgs<X>): Promise<RawRows>;

  /**
   * Subscribes to the repo's events; returns the function that unsubscribes. `query`
   * reports each statement the repo ran ({@link RepoQueryEvent}); `connect`,
   * `disconnect` and `poolExhausted` come from the adapter's pool. A listener that throws
   * does not fail the statement; its error is rethrown as an uncaught exception.
   *
   * @example
   * ```ts
   * const off = repo.on("query", (event) => metrics.observe(event.operation, event.durationMs));
   * off();
   * ```
   *
   * @throws TypeError when the event is unknown or the listener is not a function.
   */
  on(event: "query", listener: (event: RepoQueryEvent) => void): () => void;
  on(event: "connect" | "disconnect" | "poolExhausted", listener: (event: PoolEvent) => void): () => void;

  /**
   * Checks that the database answers.
   *
   * @example
   * ```ts
   * await repo.ping();
   * ```
   *
   * @throws DatabaseError with the code `"connection"` when it cannot be reached.
   */
  ping(): Promise<void>;

  /**
   * The connection pool: `{ size, idle, waiting }`.
   *
   * @example
   * ```ts
   * const { size, idle } = repo.poolStats();
   * ```
   */
  poolStats(): PoolStats;

  /**
   * The counters of the adapter's plan cache: `{ hits, misses, collisions, size }`.
   *
   * @example
   * ```ts
   * const { hits, misses } = repo.planCacheStats();
   * ```
   */
  planCacheStats(): PlanCacheStats;

  /**
   * Waits for running queries, then closes the pool. Idempotent; calls made afterwards
   * reject with `DatabaseError` (code `"connection"`).
   *
   * @example
   * ```ts
   * await repo.close();
   * ```
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// createRepo
// ---------------------------------------------------------------------------

/**
 * Creates a repo over an adapter. Nothing connects until the first query.
 *
 * @example
 * ```ts
 * import { createRepo } from "egon-orm";
 * import { postgres } from "@egon-orm/postgres";
 *
 * export const repo = createRepo({
 *   adapter: postgres({ connectionString: process.env.DATABASE_URL }),
 * });
 * ```
 *
 * @throws TypeError when an option is unknown or has the wrong type.
 */
export function createRepo(options: RepoOptions): Repo {
  const settings = repoSettings(options, writeToStderr);
  const hub = new QueryHub(settings.adapter, settings.logParams);
  if (settings.logger !== undefined) hub.on(settings.logger);
  const core = new ReadCore(settings.adapter, settings.adapter, settings.schema, settings.codegen, hub);
  return new DatabaseRepo(core);
}

const POOL_EVENTS = ["connect", "disconnect", "poolExhausted"];

/** The repo of {@link createRepo}. */
class DatabaseRepo implements Repo {
  readonly #core: ReadCore;

  constructor(core: ReadCore) {
    this.#core = core;
  }

  // Not async: the call goes straight to `load`, the one async function of the pipeline.
  all<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<ResultOf<Q>[]> {
    let input: QueryInput;
    let split: SplitArgs<ReadOptions>;
    try {
      input = inputOf("all", queryable);
      split = splitArgs<ReadOptions>("all", input.names, args, READ_OPTION_KEYS);
    } catch (error) {
      return Promise.reject(error);
    }
    return load(this.#core, "all", input.ast, split.named, split.options) as Promise<ResultOf<Q>[]>;
  }

  async one<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q> | null> {
    const input = inputOf("one", queryable);
    const { named, options } = splitArgs<ReadOptions>("one", input.names, args, READ_OPTION_KEYS);
    return single(await load(this.#core, "one", input.ast, named, options), input.ast) as ResultOf<Q> | null;
  }

  async oneOrThrow<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q>> {
    const input = inputOf("oneOrThrow", queryable);
    const { named, options } = splitArgs<ReadOptions>("oneOrThrow", input.names, args, READ_OPTION_KEYS);
    return exactlyOne(await load(this.#core, "one", input.ast, named, options), input.ast) as ResultOf<Q>;
  }

  async first<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q> | null> {
    const input = inputOf("first", queryable);
    const { named, options } = splitArgs<ReadOptions>("first", input.names, args, READ_OPTION_KEYS);
    return (await first(this.#core, input, named, options)) as ResultOf<Q> | null;
  }

  async get<S extends AnySchema>(
    schema: S,
    id: PrimaryKeyOf<S>,
    options?: ReadOptions,
  ): Promise<Row<S> | null> {
    const query = byKey(checkSchema("get", schema), id);
    const checked = checkReadOptions<ReadOptions>("get", options, READ_OPTION_KEYS);
    return single(await load(this.#core, "get", query.ast, undefined, checked), query.ast) as Row<S> | null;
  }

  async getOrThrow<S extends AnySchema>(
    schema: S,
    id: PrimaryKeyOf<S>,
    options?: ReadOptions,
  ): Promise<Row<S>> {
    const query = byKey(checkSchema("getOrThrow", schema), id);
    const checked = checkReadOptions<ReadOptions>("getOrThrow", options, READ_OPTION_KEYS);
    return exactlyOne(await load(this.#core, "get", query.ast, undefined, checked), query.ast) as Row<S>;
  }

  async getBy<Q extends Queryable>(
    queryable: Q,
    clauses: ClausesOf<Q>,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q> | null> {
    const input = byClauses(inputOf("getBy", queryable), clauses, "getBy");
    const { named, options } = splitArgs<ReadOptions>("getBy", input.names, args, READ_OPTION_KEYS);
    return single(
      await load(this.#core, "getBy", input.ast, named, options),
      input.ast,
    ) as ResultOf<Q> | null;
  }

  async getByOrThrow<Q extends Queryable>(
    queryable: Q,
    clauses: ClausesOf<Q>,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q>> {
    const input = byClauses(inputOf("getByOrThrow", queryable), clauses, "getByOrThrow");
    const { named, options } = splitArgs<ReadOptions>("getByOrThrow", input.names, args, READ_OPTION_KEYS);
    return exactlyOne(await load(this.#core, "getBy", input.ast, named, options), input.ast) as ResultOf<Q>;
  }

  async exists<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<boolean> {
    const input = inputOf("exists", queryable);
    const { named, options } = splitArgs<ReadOptions>("exists", input.names, args, READ_OPTION_KEYS);
    return exists(this.#core, input, named, options);
  }

  async count<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<number> {
    const input = inputOf("count", queryable);
    const { named, options } = splitArgs<ReadOptions>("count", input.names, args, READ_OPTION_KEYS);
    return (await aggregate(this.#core, input, "count", undefined, named, options)) as number;
  }

  aggregate<Q extends Queryable>(
    queryable: Q,
    fn: "count",
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<number>;
  aggregate<Q extends Queryable, F extends RootColumn<Q>>(
    queryable: Q,
    fn: "count",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<number>;
  aggregate<Q extends Queryable, F extends NumericColumn<Q>>(
    queryable: Q,
    fn: "sum",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<SumOf<RootValue<Q, F>>>;
  aggregate<Q extends Queryable, F extends NumericColumn<Q>>(
    queryable: Q,
    fn: "avg",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<AvgOf<RootValue<Q, F>>>;
  aggregate<Q extends Queryable, F extends RootColumn<Q>>(
    queryable: Q,
    fn: "min" | "max",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<NonNullable<RootValue<Q, F>> | null>;
  async aggregate(
    queryable: Queryable,
    fn: AggregateFunction,
    ...rest: readonly unknown[]
  ): Promise<unknown> {
    const input = inputOf("aggregate", queryable);
    const field = typeof rest[0] === "string" ? rest[0] : undefined;
    const args = field === undefined ? rest : rest.slice(1);
    const { named, options } = splitArgs<ReadOptions>("aggregate", input.names, args, READ_OPTION_KEYS);
    return aggregate(this.#core, input, fn, field, named, options);
  }

  stream<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgs<Q, StreamReadOptions>
  ): AsyncIterable<ResultOf<Q>> {
    const input = inputOf("stream", queryable);
    const { named, options } = splitArgs<StreamReadOptions>("stream", input.names, args, STREAM_OPTION_KEYS);
    return stream(this.#core, input, named, options) as AsyncIterable<ResultOf<Q>>;
  }

  reload<R extends object>(rows: readonly R[], options?: ReadOptions): Promise<(R | null)[]>;
  reload<R extends object>(row: R, options?: ReadOptions): Promise<R | null>;
  async reload(rows: unknown, options?: ReadOptions): Promise<unknown> {
    const checked = checkReadOptions<ReadOptions>("reload", options, READ_OPTION_KEYS);
    if (Array.isArray(rows)) return reload(this.#core, rows, checked, false);
    const [fresh] = await reload(this.#core, [rows], checked, false);
    return fresh;
  }

  reloadOrThrow<R extends object>(rows: readonly R[], options?: ReadOptions): Promise<R[]>;
  reloadOrThrow<R extends object>(row: R, options?: ReadOptions): Promise<R>;
  async reloadOrThrow(rows: unknown, options?: ReadOptions): Promise<unknown> {
    const checked = checkReadOptions<ReadOptions>("reloadOrThrow", options, READ_OPTION_KEYS);
    if (Array.isArray(rows)) return reload(this.#core, rows, checked, true);
    const [fresh] = await reload(this.#core, [rows], checked, true);
    return fresh;
  }

  toSql<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, SqlOptions>): SqlAndParams {
    const input = inputOf("toSql", queryable);
    const { named, options } = splitArgs<ReadOptions>("toSql", input.names, args, SQL_OPTION_KEYS);
    return toSql(this.#core, input, named, options);
  }

  explain<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgsWith<Q, ExplainReadOptions & { readonly format: "json" }>
  ): Promise<unknown>;
  explain<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ExplainReadOptions>): Promise<string>;
  async explain(queryable: Queryable, ...args: readonly unknown[]): Promise<unknown> {
    const input = inputOf("explain", queryable);
    const { named, options } = splitArgs<ExplainReadOptions>(
      "explain",
      input.names,
      args,
      EXPLAIN_OPTION_KEYS,
    );
    return explain(this.#core, input, named, options);
  }

  async raw<X extends Expr<unknown, SomeParams>>(statement: X, ...args: RawArgs<X>): Promise<RawRows> {
    if (!isFragment(statement)) {
      throw new QueryError(
        `repo.raw() takes a fragment: repo.raw(fragment\`select …\`). It was given ${typeof statement === "string" ? "a string, which would put text into the SQL unchecked" : "something else"}; values go into the template as interpolations, where they are bound.`,
      );
    }
    const names: string[] = [];
    for (const node of statement.named) if (!names.includes(node.name)) names.push(node.name);
    const { named, options } = splitArgs<ReadOptions>("raw", names, args, READ_OPTION_KEYS);
    return raw(this.#core, statement, named, options);
  }

  on(event: "query", listener: (event: RepoQueryEvent) => void): () => void;
  on(event: "connect" | "disconnect" | "poolExhausted", listener: (event: PoolEvent) => void): () => void;
  on(event: string, listener: (event: never) => void): () => void {
    if (event === "query") return this.#core.hub.on(listener as (event: RepoQueryEvent) => void);
    if (POOL_EVENTS.includes(event)) {
      return this.#core.adapter.on(event as "connect", listener as (event: PoolEvent) => void);
    }
    throw new TypeError(
      `repo.on(${JSON.stringify(event)}): unknown event. The events are "query", "connect", "disconnect" and "poolExhausted".`,
    );
  }

  ping(): Promise<void> {
    return this.#core.adapter.ping();
  }

  poolStats(): PoolStats {
    return this.#core.adapter.poolStats();
  }

  planCacheStats(): PlanCacheStats {
    return this.#core.adapter.planCacheStats();
  }

  close(): Promise<void> {
    this.#core.hub.close();
    return this.#core.adapter.close();
  }
}

function checkSchema(method: string, schema: unknown): AnySchema {
  if (!isSchema(schema)) {
    throw new TypeError(`repo.${method}() takes a schema class first: repo.${method}(User, id).`);
  }
  return schema;
}
