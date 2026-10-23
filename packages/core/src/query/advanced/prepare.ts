/**
 * `prepare(q)`: a query whose compiled plan is kept on the query itself, for a query run
 * many times with different named parameters.
 *
 * A plan depends on the adapter that compiles it (its dialect and its driver conversions),
 * so {@link PreparedQuery.plan} makes it the first time it is asked for an adapter, and
 * keeps it: later calls for that adapter take it from the prepared query, without a lookup
 * in the adapter's plan cache. A plan holds no values, so one plan serves every set of
 * named parameters. (The repo does not call `plan` yet: it compiles a prepared query like
 * any other, and finds it in the adapter's plan cache by identity.)
 *
 * @module
 */
import type { Adapter, CompiledQuery } from "../../contracts/adapter.js";
import type { NamedParamNode, QueryAst, QueryOperation } from "../../contracts/query.js";
import { QueryError } from "../../errors.js";
import { Query, type QueryLike, type QueryParams, type QueryResult } from "../builder.js";

/** What compiles a prepared query: an adapter, or anything with its `compile`. */
type PlanSource = Pick<Adapter, "compile">;

/** What a prepared query keeps of the query it was made from. */
interface PreparedFrom {
  readonly ast: QueryAst;
  readonly named: readonly NamedParamNode[];
  namedParams(): readonly string[];
  toString(): string;
}

/** The plan kept for the first adapter, operation and database schema a prepared query runs with. */
interface Pinned {
  /** Held weakly: a prepared query defined at module level must not keep a closed adapter alive. */
  readonly source: WeakRef<PlanSource>;
  readonly operation: QueryOperation;
  readonly schema: string | undefined;
  readonly plan: CompiledQuery;
}

/**
 * A query prepared with {@link prepare}: what the repo runs like any other query, with its
 * compiled plan kept on it. `R` is the row type, `P` the named parameters each run needs.
 *
 * @example
 * ```ts
 * const byEmail: PreparedQuery<User, { email: string }> = prepare(
 *   from(User, "u").where(({ u }) => u.email.eq(param("email", t.string()))).limit(1),
 * );
 * ```
 */
export class PreparedQuery<R, P> implements QueryLike {
  /** Type information only; there is no such property at run time. */
  declare readonly "~query": {
    readonly bindings: unknown;
    readonly result: R;
    readonly params: (params: P) => void;
    readonly root: string;
  };
  /** The query as data. Public because every queryable carries it (`QueryLike`). */
  readonly ast: QueryAst;
  /**
   * The query that was prepared.
   *
   * @internal
   */
  readonly query: PreparedFrom;
  #pinned: Pinned | undefined;
  /** Plans for any other adapter, operation or database schema, made on first use. */
  #others: WeakMap<PlanSource, Map<string, CompiledQuery>> | undefined;

  /**
   * Internal: made by {@link prepare}.
   *
   * @example
   * ```ts
   * new PreparedQuery(query);
   * ```
   *
   * @internal
   */
  constructor(query: PreparedFrom) {
    this.query = query;
    this.ast = query.ast;
    this.#pinned = undefined;
    this.#others = undefined;
  }

  /**
   * The named parameters the query's AST uses, in canonical order with repeats.
   *
   * @example
   * ```ts
   * byEmail.named[0]?.name; // "email"
   * ```
   *
   * @internal
   */
  get named(): readonly NamedParamNode[] {
    return this.query.named;
  }

  /**
   * The names of every named parameter a run needs, its preloads' included, each once.
   *
   * @example
   * ```ts
   * byEmail.namedParams(); // ["email"]
   * ```
   */
  namedParams(): readonly string[] {
    return this.query.namedParams();
  }

  /**
   * The compiled plan for running the query with `source` (an adapter) as `operation` in
   * database schema `schema`: compiled the first time and kept on this object.
   *
   * @example
   * ```ts
   * const plan = byEmail.plan(adapter, "all", undefined);
   * ```
   *
   * @throws QueryError (from the adapter) when the query cannot be compiled.
   *
   * @internal
   */
  plan(
    source: PlanSource,
    operation: QueryOperation = "all",
    schema: string | undefined = undefined,
  ): CompiledQuery {
    const pinned = this.#pinned;
    if (
      pinned !== undefined &&
      pinned.source.deref() === source &&
      pinned.operation === operation &&
      pinned.schema === schema
    ) {
      return pinned.plan;
    }
    if (pinned === undefined) {
      const plan = source.compile(this.ast, operation, schema);
      this.#pinned = { source: new WeakRef(source), operation, schema, plan };
      return plan;
    }
    let bySource = this.#others;
    if (bySource === undefined) {
      bySource = new WeakMap();
      this.#others = bySource;
    }
    let plans = bySource.get(source);
    if (plans === undefined) {
      plans = new Map();
      bySource.set(source, plans);
    }
    const key = schema === undefined ? `${operation}:` : `${operation}:${schema}`;
    let plan = plans.get(key);
    if (plan === undefined) {
      plan = source.compile(this.ast, operation, schema);
      plans.set(key, plan);
    }
    return plan;
  }

  /**
   * A compact, SQL-like rendering of the query, without values.
   *
   * @example
   * ```ts
   * byEmail.toString(); // "from users as u where u.email = :email limit ?"
   * ```
   */
  toString(): string {
    return this.query.toString();
  }
}

/**
 * Marks a query that runs many times. Run it as any query, with its named parameters:
 * `repo.one(byEmail, { email })`. Today it compiles once per adapter and is then found in
 * the adapter's plan cache by identity, as any query kept in a variable is; skipping that
 * lookup as well is planned. Named parameters are what changes between runs; a value
 * written into the query is fixed.
 *
 * @example
 * ```ts
 * const byEmail = prepare(from(User, "u").where(({ u }) => u.email.eq(param("email", t.string()))).limit(1));
 * await repo.one(byEmail, { email });
 * ```
 *
 * @throws QueryError when the argument is not a query.
 */
export function prepare<Q extends QueryLike>(query: Q): PreparedQuery<QueryResult<Q>, QueryParams<Q>> {
  if (!(query instanceof Query)) {
    throw new QueryError("query.prepareQuery", "prepare() takes a query.");
  }
  return new PreparedQuery<QueryResult<Q>, QueryParams<Q>>(query);
}
