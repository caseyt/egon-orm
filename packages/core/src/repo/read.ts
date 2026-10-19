/**
 * The read operations of the repo, as functions over a {@link ReadCore}: the adapter,
 * the executor statements run on, the defaults, and the telemetry hub.
 *
 * ## The pipeline of `all`
 *
 * normalise the queryable to a query AST, compile it (`adapter.compile`, which finds the
 * plan in the adapter's plan cache), bind its parameters (`bindParams`), execute, decode
 * every row with the plan's decoder (built once and kept on the plan), then hand the rows
 * to {@link afterDecode} when the query preloads associations. The array returned is a
 * fresh one, of fresh rows.
 *
 * One `await` per `all` (`executor.execute`), plus one for {@link afterDecode} when the
 * query has preloads. No options object is allocated when the call passes none and
 * nobody listens to `query` events.
 *
 * ## Rewritten queries
 *
 * `first`, `exists`, `count` and `aggregate` run a query derived from the one given. The
 * derived AST is built from the original's parts (its `params` and `shape` recomputed
 * from them, as the AST contract asks of hand-built queries) and cached per original AST,
 * so a query defined once is rewritten once.
 *
 * @module
 */
import type { DatabaseAdapter } from "../adapter/adapter.js";
import { bindParams } from "../compiler/bind.js";
import type {
  CompiledQuery,
  ExecuteOptions,
  Executor,
  OutputPlan,
  ParamSlot,
  QueryEvent,
  RawResult,
  StreamOptions,
} from "../contracts/adapter.js";
import type {
  ExprNode,
  FragmentNode,
  QueryAst,
  SelectNode,
  SourceNode,
  SubquerySourceNode,
  TableSourceNode,
} from "../contracts/query.js";
import type { AnySchema, FieldMeta, SchemaMeta } from "../contracts/schema.js";
import { ROW } from "../contracts/schema.js";
import { MultipleResultsError, NoResultsError, QueryError } from "../errors.js";
import { isPlainObject } from "../internal/plain-object.js";
import { collectParams, literalNode, paramNode, shapeOf } from "../query/ast.js";
import { bindingOf } from "../query/bindings.js";
import { AS_SOURCE, from, type Query, render, type SourceParts } from "../query/builder.js";
import { type AnyExpr, Col, isExpr } from "../query/expr.js";
import { and, avg, count, max, min, or, sum } from "../query/functions.js";
import { selectNode } from "../query/select.js";
import { isRow, isSchema } from "../schema/guards.js";
import { meta } from "../schema/schema.js";
import { integerType } from "../types/index.js";
import { decodeRows, decoderFor } from "./hydrate.js";
import {
  DEFAULT_STREAM_BATCH_SIZE,
  type ExplainReadOptions,
  namedParamsOf,
  type ReadOptions,
  type RepoOperation,
  type RepoQueryEvent,
  type StreamReadOptions,
} from "./options.js";

const now = (): number => performance.now();

const NONE: readonly never[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * One repo call that is being reported: handed to the adapter as the execution's
 * `context`, so that the adapter's event for that statement finds its way back to the
 * call that ran it, even when executions overlap. The repo then reports it once, with
 * what only it knows (the operation, the table, the decoding time, the caller's context).
 */
export class Call {
  /** The adapter's event for this call's statement, once it has arrived. */
  event: QueryEvent | undefined;

  constructor(
    readonly hub: QueryHub,
    readonly operation: RepoOperation,
    readonly source: string | undefined,
    readonly context: Readonly<Record<string, unknown>> | undefined,
  ) {
    this.event = undefined;
  }
}

/** Calls one listener, isolating the statement from it: a listener's error is rethrown on a later microtask. */
function notify(listener: (event: RepoQueryEvent) => void, event: RepoQueryEvent): void {
  try {
    listener(event);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

/**
 * The `query` listeners of one repo (and of the transaction-scoped repos made from it).
 * It listens to the adapter only while it has listeners of its own, so that a repo nobody
 * listens to costs the adapter nothing; it subscribes with `{ params: true }` when the
 * repo logs parameters.
 */
export class QueryHub {
  /** Whether anyone listens: read before anything is measured or allocated. */
  listening = false;
  #listeners: readonly ((event: RepoQueryEvent) => void)[] = NONE;
  #unsubscribe: (() => void) | undefined = undefined;
  readonly #adapter: DatabaseAdapter;
  readonly #params: boolean;

  constructor(adapter: DatabaseAdapter, params: boolean) {
    this.#adapter = adapter;
    this.#params = params;
  }

  /** Subscribes; returns the function that unsubscribes (idempotent). */
  on(listener: (event: RepoQueryEvent) => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError('repo.on("query", listener): the listener must be a function.');
    }
    // Wrapped, so that the same function subscribed twice is two subscriptions.
    const entry = (event: RepoQueryEvent): void => listener(event);
    this.#set([...this.#listeners, entry]);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#set(this.#listeners.filter((other) => other !== entry));
    };
  }

  /** Stops listening to the adapter. */
  close(): void {
    this.#set(NONE);
  }

  #set(listeners: readonly ((event: RepoQueryEvent) => void)[]): void {
    this.#listeners = listeners;
    const listening = listeners.length > 0;
    if (listening && this.#unsubscribe === undefined) {
      this.#unsubscribe = this.#adapter.on(
        "query",
        this.#receive,
        this.#params ? { params: true } : undefined,
      );
    } else if (!listening && this.#unsubscribe !== undefined) {
      this.#unsubscribe();
      this.#unsubscribe = undefined;
    }
    this.listening = listening;
  }

  /** The adapter's listener: keeps the event of a statement this repo ran on its call. */
  readonly #receive = (event: QueryEvent): void => {
    const call = event.context;
    if (call instanceof Call && call.hub === this) call.event = event;
  };

  /**
   * Reports a call: its statement's event with the repo's facts added. `error` is the
   * call's failure, when it failed after the statement (a value that could not be
   * decoded); otherwise the statement's own. A call whose statement produced no event (it
   * never ran) is not reported.
   */
  emit(call: Call, decodeMs: number, error: unknown): void {
    const event = call.event;
    if (event === undefined) return;
    call.event = undefined;
    const listeners = this.#listeners;
    const report: RepoQueryEvent = {
      sql: event.sql,
      paramCount: event.paramCount,
      durationMs: event.durationMs,
      queueMs: event.queueMs,
      rowCount: event.rowCount,
      error: error === undefined ? event.error : error,
      params: event.params,
      context: call.context,
      operation: call.operation,
      source: call.source,
      decodeMs,
    };
    for (const listener of listeners) notify(listener, report);
  }
}

// ---------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------

/**
 * What every read operation needs. A transaction-scoped repo (step 16) shares the
 * adapter, the defaults and the hub of its root repo, and has its own executor (the
 * transaction's connection).
 */
export class ReadCore {
  constructor(
    readonly adapter: DatabaseAdapter,
    /** Where statements run: the adapter (any pooled connection) or one connection. */
    public executor: Executor,
    /** The repo's default database schema. */
    readonly schema: string | undefined,
    readonly codegen: boolean,
    readonly hub: QueryHub,
  ) {}
}

/** What the repo keeps per compiled plan, besides its decoder (which is on the plan). */
interface PlanInfo {
  /** The execution options used when a call passes none and nobody listens: the slots only. */
  readonly bare: ExecuteOptions;
  /** Whether a row of the output carries preloads, which {@link afterDecode} completes. */
  readonly preloads: boolean;
  /** The names of the plan's named slots. */
  readonly names: ReadonlySet<string>;
}

const planInfos = new WeakMap<CompiledQuery, PlanInfo>();

function hasPreloads(plan: OutputPlan | undefined): boolean {
  if (plan === undefined) return false;
  switch (plan.kind) {
    case "row":
      return plan.preloads.length > 0;
    case "object":
      return plan.values.some(hasPreloads);
    case "tuple":
      return plan.items.some(hasPreloads);
    default:
      return false;
  }
}

function infoOf(plan: CompiledQuery): PlanInfo {
  let info = planInfos.get(plan);
  if (info === undefined) {
    const names = new Set<string>();
    for (const slot of plan.slots) if (slot.kind === "named") names.add(slot.name);
    const bare: CallOptions = {
      signal: undefined,
      timeoutMs: undefined,
      slots: plan.slots,
      context: undefined,
      batchSize: undefined,
    };
    info = { bare: bare as ExecuteOptions, preloads: hasPreloads(plan.output), names };
    planInfos.set(plan, info);
  }
  return info;
}

/** The execution options of one call, in one shape. */
interface CallOptions {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  readonly slots: readonly ParamSlot[];
  readonly context: Call | undefined;
  readonly batchSize: number | undefined;
}

function executeOptions(
  plan: CompiledQuery,
  info: PlanInfo,
  options: ReadOptions | undefined,
  call: Call | undefined,
  batchSize: number | undefined,
): ExecuteOptions {
  if (options === undefined && call === undefined && batchSize === undefined) return info.bare;
  const shaped: CallOptions = {
    signal: options?.signal,
    timeoutMs: options?.timeoutMs,
    slots: plan.slots,
    context: call,
    batchSize,
  };
  return shaped as StreamOptions;
}

// ---------------------------------------------------------------------------
// Queryables
// ---------------------------------------------------------------------------

/** A query as a read operation sees it. */
export interface QueryInput {
  readonly ast: QueryAst;
  /** The named parameters the query needs (its preload callbacks' included). */
  readonly names: readonly string[];
  /** The builder query, when there is one (a schema class gives `from(Schema, alias)`). */
  readonly query: Query<unknown, unknown, never, string> | undefined;
}

/** The alias of the root binding of `repo.all(Schema)`: the table's name. */
function rootAlias(schemaMeta: SchemaMeta): string {
  const source = schemaMeta.source as string;
  return source.startsWith("$") ? "t" : source;
}

/** `from(Schema, <table name>)`, for a read of a schema class. */
export function rootQuery(schema: AnySchema): Query<unknown, unknown, never, string> {
  const schemaMeta = meta(schema);
  if (schemaMeta.source === null) {
    throw new QueryError(
      `${schemaMeta.name} is an embedded schema: it is stored inside its parent's row and has no table to read.`,
    );
  }
  return from(schema, rootAlias(schemaMeta)) as unknown as Query<unknown, unknown, never, string>;
}

function isQueryLike(value: unknown): value is { readonly ast: QueryAst } {
  if (typeof value !== "object" || value === null) return false;
  const ast = (value as { readonly ast?: unknown }).ast;
  return typeof ast === "object" && ast !== null && (ast as { readonly kind?: unknown }).kind === "query";
}

/**
 * Normalises what a read method was given: a schema class reads all of its rows, a query
 * is used as it is.
 *
 * @throws TypeError when `queryable` is neither.
 */
export function inputOf(method: string, queryable: unknown): QueryInput {
  if (isSchema(queryable)) {
    const query = rootQuery(queryable);
    return { ast: query.ast, names: NONE, query };
  }
  if (isQueryLike(queryable)) {
    const query = typeof (queryable as { where?: unknown }).where === "function" ? queryable : undefined;
    return {
      ast: queryable.ast,
      names: namedParamsOf(queryable),
      query: query as Query<unknown, unknown, never, string> | undefined,
    };
  }
  throw new TypeError(
    `repo.${method}() takes a schema class or a query: repo.${method}(User) or repo.${method}(from(User, "u")…).`,
  );
}

/** The table a query reads from, for telemetry. */
function sourceOf(ast: QueryAst): string | undefined {
  return ast.from.kind === "table" ? ast.from.source : undefined;
}

function constantsOf(ast: QueryAst): readonly unknown[] {
  return ast.select === undefined ? NONE : ast.select.constants;
}

function schemaFor(core: ReadCore, options: ReadOptions | undefined): string | undefined {
  const schema = options?.schema;
  return schema === undefined ? core.schema : schema;
}

/**
 * Binds the parameters of a plan compiled from a query **derived** from the one the
 * caller gave (`first`, `exists`, `count`, …). The caller's named values are checked
 * against the original query's names; only those the derived plan uses are bound (a name
 * used only in a clause the derivation dropped, an `orderBy`, has no slot).
 */
function bindDerived(
  plan: CompiledQuery,
  info: PlanInfo,
  ast: QueryAst,
  named: Readonly<Record<string, unknown>> | undefined,
  original: readonly string[],
): unknown[] {
  if (named === undefined) return bindParams(plan.slots, ast.params);
  const used: Record<string, unknown> = {};
  const extra: string[] = [];
  for (const name in named) {
    if (!Object.hasOwn(named, name)) continue;
    if (!original.includes(name)) extra.push(name);
    else if (info.names.has(name)) used[name] = named[name];
  }
  if (extra.length > 0) {
    throw new QueryError(
      `The query has no named parameter${extra.length > 1 ? "s" : ""} ${extra.map((name) => `"${name}"`).join(", ")}; it takes ${original.map((name) => `"${name}"`).join(", ")}.`,
    );
  }
  for (const name of original) {
    if (!Object.hasOwn(named, name) || named[name] === undefined) {
      throw new QueryError(`The query needs the named parameter "${name}", which was not given a value.`);
    }
  }
  return bindParams(plan.slots, ast.params, used);
}

// ---------------------------------------------------------------------------
// Running a statement
// ---------------------------------------------------------------------------

/**
 * Executes a compiled statement and turns its result into `T` with `finish`, reporting
 * the call to the repo's `query` listeners (the time `finish` took is `decodeMs`).
 */
async function run<T>(
  core: ReadCore,
  operation: RepoOperation,
  source: string | undefined,
  plan: CompiledQuery,
  info: PlanInfo,
  values: readonly unknown[],
  options: ReadOptions | undefined,
  finish: (result: RawResult) => T,
): Promise<T> {
  const hub = core.hub;
  if (!hub.listening) {
    const result = await core.executor.execute(
      plan.sql,
      values,
      executeOptions(plan, info, options, undefined, undefined),
    );
    return finish(result);
  }
  const call = new Call(hub, operation, source, options?.context);
  let result: RawResult;
  try {
    result = await core.executor.execute(
      plan.sql,
      values,
      executeOptions(plan, info, options, call, undefined),
    );
  } catch (error) {
    hub.emit(call, 0, undefined);
    throw error;
  }
  const start = now();
  let value: T;
  try {
    value = finish(result);
  } catch (error) {
    hub.emit(call, now() - start, error);
    throw error;
  }
  hub.emit(call, now() - start, undefined);
  return value;
}

/** What {@link afterDecode} receives besides the rows and the plan. */
export interface AfterDecodeContext {
  readonly core: ReadCore;
  /** The AST that was executed. */
  readonly ast: QueryAst;
  readonly named: Readonly<Record<string, unknown>> | undefined;
  readonly options: ReadOptions | undefined;
}

/**
 * The stage after decoding, for queries that preload associations: it merges the parents
 * of join preloads and runs the queries of separate preloads (step 14 implements it). It
 * is called only when a row of the plan's output carries preloads.
 *
 * @throws QueryError until preloading is implemented.
 */
export async function afterDecode(
  _rows: unknown[],
  _plan: CompiledQuery,
  _context: AfterDecodeContext,
): Promise<unknown[]> {
  throw new QueryError(
    "This query preloads associations, which this version of egon-orm cannot run yet. Run the association's query separately, for now.",
  );
}

/** Runs a query and returns its decoded rows: the pipeline of `all`. */
export async function load(
  core: ReadCore,
  operation: RepoOperation,
  ast: QueryAst,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
  source: string | undefined = sourceOf(ast),
): Promise<unknown[]> {
  const adapter = core.adapter;
  const plan = adapter.compile(ast, "all", schemaFor(core, options));
  const info = infoOf(plan);
  const values = bindParams(plan.slots, ast.params, named);
  const decoder = decoderFor(plan, adapter, core.codegen);
  const constants = constantsOf(ast);
  const rows = await run(core, operation, source, plan, info, values, options, (result) =>
    decodeRows(result.rows, decoder, constants),
  );
  return info.preloads ? afterDecode(rows, plan, { core, ast, named, options }) : rows;
}

/** Runs a query derived from `original` and returns its decoded rows. */
async function loadDerived(
  core: ReadCore,
  operation: RepoOperation,
  ast: QueryAst,
  input: QueryInput,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
): Promise<unknown[]> {
  const adapter = core.adapter;
  const plan = adapter.compile(ast, "all", schemaFor(core, options));
  const info = infoOf(plan);
  const values = bindDerived(plan, info, ast, named, input.names);
  const decoder = decoderFor(plan, adapter, core.codegen);
  const constants = constantsOf(ast);
  const rows = await run(core, operation, sourceOf(input.ast), plan, info, values, options, (result) =>
    decodeRows(result.rows, decoder, constants),
  );
  return info.preloads ? afterDecode(rows, plan, { core, ast, named, options }) : rows;
}

/** At most one row: `null` for none, {@link MultipleResultsError} for more. */
export function single(rows: readonly unknown[], ast: QueryAst): unknown {
  if (rows.length > 1) throw new MultipleResultsError({ count: rows.length, query: render(ast) });
  return rows.length === 0 ? null : rows[0];
}

/** Exactly one row: {@link NoResultsError} for none, {@link MultipleResultsError} for more. */
export function exactlyOne(rows: readonly unknown[], ast: QueryAst): unknown {
  if (rows.length === 0) throw new NoResultsError({ query: render(ast) });
  return single(rows, ast);
}

// ---------------------------------------------------------------------------
// Derived queries
// ---------------------------------------------------------------------------

/** The parts of a query AST a derivation replaces; everything else is kept. */
interface Changes {
  readonly from?: SourceNode;
  readonly select?: SelectNode | undefined;
  readonly distinct?: undefined;
  readonly orderBys?: readonly never[];
  readonly limit?: ExprNode | undefined;
  readonly preloads?: readonly never[];
}

/** A copy of `ast` with `changes`, its `params`, `listLengths` and `shape` recomputed. */
function derive(ast: QueryAst, changes: Changes): QueryAst {
  const has = (key: keyof Changes): boolean => Object.hasOwn(changes, key);
  const draft: QueryAst = {
    kind: "query",
    from: changes.from ?? ast.from,
    joins: ast.joins,
    wheres: ast.wheres,
    select: has("select") ? changes.select : ast.select,
    distinct: has("distinct") ? undefined : ast.distinct,
    groupBys: ast.groupBys,
    havings: ast.havings,
    orderBys: changes.orderBys ?? ast.orderBys,
    limit: has("limit") ? changes.limit : ast.limit,
    offset: ast.offset,
    lock: ast.lock,
    combinations: ast.combinations,
    ctes: ast.ctes,
    windows: ast.windows,
    preloads: changes.preloads ?? ast.preloads,
    updates: ast.updates,
    schema: ast.schema,
    hints: ast.hints,
    params: NONE,
    listLengths: NONE,
    shape: 0,
  };
  return finalize(draft);
}

/** Computes `params`, `listLengths` and `shape` of a hand-built AST. */
function finalize(draft: QueryAst): QueryAst {
  const params: unknown[] = [];
  const lists: number[] = [];
  collectParams(draft, params, lists);
  return {
    kind: "query",
    from: draft.from,
    joins: draft.joins,
    wheres: draft.wheres,
    select: draft.select,
    distinct: draft.distinct,
    groupBys: draft.groupBys,
    havings: draft.havings,
    orderBys: draft.orderBys,
    limit: draft.limit,
    offset: draft.offset,
    lock: draft.lock,
    combinations: draft.combinations,
    ctes: draft.ctes,
    windows: draft.windows,
    preloads: draft.preloads,
    updates: draft.updates,
    schema: draft.schema,
    hints: draft.hints,
    params,
    listLengths: lists,
    shape: shapeOf(draft),
  };
}

/** The alias of the subquery a derivation wraps a query in. */
const WRAPPED = "s";

/** `SELECT … FROM (inner) AS "s"`, with `select` and `limit`. */
function wrap(inner: QueryAst, select: SelectNode, limit: ExprNode | undefined): QueryAst {
  const from: SubquerySourceNode = { kind: "subquerySource", query: inner, alias: WRAPPED };
  return finalize({
    kind: "query",
    from,
    joins: NONE,
    wheres: NONE,
    select,
    distinct: undefined,
    groupBys: NONE,
    havings: NONE,
    orderBys: NONE,
    limit,
    offset: undefined,
    lock: undefined,
    combinations: NONE,
    ctes: NONE,
    windows: NONE,
    preloads: NONE,
    updates: NONE,
    schema: undefined,
    hints: NONE,
    params: NONE,
    listLengths: NONE,
    shape: 0,
  });
}

const INTEGER = integerType();

/** A `LIMIT 1`; a bound parameter, like every limit. */
const limitOne = (): ExprNode => paramNode(1, INTEGER, false);

/** `SELECT 1`. */
const SELECT_ONE: SelectNode = selectNode({ kind: "expr", expr: literalNode(1), type: undefined }, NONE);

/** Derived ASTs, per original AST and derivation. */
const derived = new WeakMap<QueryAst, Map<string, QueryAst>>();

function cached(ast: QueryAst, key: string, make: () => QueryAst): QueryAst {
  let byKey = derived.get(ast);
  if (byKey === undefined) {
    byKey = new Map();
    derived.set(ast, byKey);
  }
  let result = byKey.get(key);
  if (result === undefined) {
    result = make();
    byKey.set(key, result);
  }
  return result;
}

/** The query of `first`: the same query with `LIMIT 1` (replacing its own limit). */
export function firstAst(ast: QueryAst): QueryAst {
  return cached(ast, "first", () => derive(ast, { limit: limitOne() }));
}

/**
 * The query of `exists`: `SELECT 1 … LIMIT 1` without the select, order, distinct and
 * preloads. A query with a limit or a set operation is wrapped instead
 * (`SELECT 1 FROM (q) AS "s" LIMIT 1`): replacing its limit, or the select of the
 * branches of an `INTERSECT` or `EXCEPT`, would change which rows it has.
 */
export function existsAst(ast: QueryAst): QueryAst {
  return cached(ast, "exists", () =>
    ast.limit !== undefined || ast.combinations.length > 0
      ? wrap(derive(ast, { preloads: NONE }), SELECT_ONE, limitOne())
      : derive(ast, {
          select: SELECT_ONE,
          distinct: undefined,
          orderBys: NONE,
          preloads: NONE,
          limit: limitOne(),
        }),
  );
}

/** The aggregate functions of `repo.aggregate`. */
export type AggregateFunction = "count" | "sum" | "avg" | "min" | "max";

const AGGREGATES: readonly AggregateFunction[] = ["count", "sum", "avg", "min", "max"];

/** Whether an aggregate over the query must be computed over its rows as a subquery. */
function needsWrapping(ast: QueryAst): boolean {
  return (
    ast.limit !== undefined ||
    ast.offset !== undefined ||
    ast.distinct !== undefined ||
    ast.combinations.length > 0 ||
    ast.groupBys.length > 0 ||
    ast.havings.length > 0
  );
}

/** The schema metadata of the root binding of a query, for an aggregate over one of its fields. */
function rootMeta(ast: QueryAst): SchemaMeta | undefined {
  const root = ast.from;
  return root.kind === "table" || root.kind === "cteSource" ? root.meta : undefined;
}

function aggregateExpr(fn: AggregateFunction, column: Col<unknown> | undefined): AnyExpr {
  if (column === undefined) return count() as AnyExpr;
  switch (fn) {
    case "count":
      return count(column) as AnyExpr;
    case "sum":
      return sum(column as never) as AnyExpr;
    case "avg":
      return avg(column as never) as AnyExpr;
    case "min":
      return min(column) as AnyExpr;
    case "max":
      return max(column) as AnyExpr;
  }
}

function selectOf(expr: AnyExpr): SelectNode {
  return selectNode({ kind: "expr", expr: expr.node, type: expr.type }, NONE);
}

/**
 * The query of `aggregate(fn, field)`: the query's select replaced by the aggregate, its
 * order and preloads dropped. A query whose rows the aggregate must see as they are (one
 * with a limit, an offset, `distinct`, a set operation, a `groupBy` or a `having`) is
 * wrapped: `SELECT count(*) FROM (q) AS "s"`.
 *
 * @throws QueryError when `fn` is unknown, a function other than `count` has no field, the
 * field is not a column of the query's root binding, or a wrapped query does not select
 * the field.
 */
export function aggregateAst(ast: QueryAst, fn: AggregateFunction, field: string | undefined): QueryAst {
  if (!AGGREGATES.includes(fn)) {
    throw new QueryError(
      `repo.aggregate() was given the function ${JSON.stringify(fn)}; it takes "count", "sum", "avg", "min" or "max".`,
    );
  }
  if (field === undefined && fn !== "count") {
    throw new QueryError(
      `repo.aggregate(query, "${fn}") needs the field to aggregate: repo.aggregate(query, "${fn}", "views").`,
    );
  }
  return cached(ast, field === undefined ? fn : `${fn}:${field}`, () => {
    const wrapped = needsWrapping(ast);
    const fieldMeta = field === undefined ? undefined : rootField(ast, field);
    if (!wrapped) {
      const column = fieldMeta === undefined ? undefined : new Col<unknown>(ast.from.alias, fieldMeta);
      return derive(ast, { select: selectOf(aggregateExpr(fn, column)), orderBys: NONE, preloads: NONE });
    }
    const inner = derive(ast, { preloads: NONE });
    const column =
      fieldMeta === undefined ? undefined : new Col<unknown>(WRAPPED, wrappedColumn(ast, fieldMeta));
    return wrap(inner, selectOf(aggregateExpr(fn, column)), undefined);
  });
}

function rootField(ast: QueryAst, field: string): FieldMeta {
  const schemaMeta = rootMeta(ast);
  if (schemaMeta === undefined) {
    throw new QueryError(
      `repo.aggregate() over the field "${field}" needs a query whose root binding is a schema; this one reads ${ast.from.kind === "subquerySource" ? "a subquery" : `a ${ast.from.kind} source`}.`,
    );
  }
  const found = schemaMeta.fieldsByName.get(field);
  if (found === undefined || found.virtual) {
    const names = schemaMeta.persisted.map((each) => each.name).join(", ");
    throw new QueryError(
      `repo.aggregate(): ${schemaMeta.name} has no column "${field}"${found === undefined ? "" : " (it is a virtual field)"}. Its columns are: ${names}.`,
    );
  }
  return found;
}

/**
 * The column of `field` in a wrapped query's output: its column name when the query
 * selects whole rows of its root, the key when it selects an object with that key.
 */
function wrappedColumn(ast: QueryAst, field: FieldMeta): FieldMeta {
  const select = ast.select;
  if (select === undefined) return field;
  const shape = select.shape;
  if (shape.kind === "binding" && shape.binding === ast.from.alias) return field;
  if (shape.kind === "object") {
    const index = shape.keys.indexOf(field.name);
    if (index >= 0 && shape.values[index]?.kind === "expr") return { ...field, column: field.name };
  }
  throw new QueryError(
    `repo.aggregate() over "${field.name}": this query is aggregated as a subquery (it has a limit, an offset, distinct, a set operation, a groupBy or a having), so it must select "${field.name}": select whole rows of its root binding, or an object with the key "${field.name}".`,
  );
}

// ---------------------------------------------------------------------------
// The read operations
// ---------------------------------------------------------------------------

/** `repo.first`: the first row of the query with `LIMIT 1`, or `null`. */
export async function first(
  core: ReadCore,
  input: QueryInput,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
): Promise<unknown> {
  const rows = await loadDerived(core, "first", firstAst(input.ast), input, named, options);
  return rows.length === 0 ? null : rows[0];
}

/** `repo.exists`. */
export async function exists(
  core: ReadCore,
  input: QueryInput,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
): Promise<boolean> {
  const ast = existsAst(input.ast);
  const plan = core.adapter.compile(ast, "all", schemaFor(core, options));
  const info = infoOf(plan);
  const values = bindDerived(plan, info, ast, named, input.names);
  return run(
    core,
    "exists",
    sourceOf(input.ast),
    plan,
    info,
    values,
    options,
    (result) => result.rows.length > 0,
  );
}

/** `repo.aggregate` and `repo.count`. */
export async function aggregate(
  core: ReadCore,
  input: QueryInput,
  fn: AggregateFunction,
  field: string | undefined,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
): Promise<unknown> {
  const rows = await loadDerived(
    core,
    "aggregate",
    aggregateAst(input.ast, fn, field),
    input,
    named,
    options,
  );
  return rows.length === 0 ? null : rows[0];
}

/** The query of `get(Schema, id)`. */
export function byKey(schema: AnySchema, id: unknown): Query<unknown, unknown, never, string> {
  const schemaMeta = meta(schema);
  const key = schemaMeta.primaryKey;
  if (key.length === 0) {
    throw new QueryError(
      `repo.get(${schemaMeta.name}, id): ${schemaMeta.name} has no primary key, so it cannot be read by id. Use repo.getBy(${schemaMeta.name}, { … }) instead.`,
    );
  }
  if (id === undefined || id === null) {
    throw new QueryError(
      `repo.get(${schemaMeta.name}, ${String(id)}): the id is ${String(id)}. This is almost always a missing value upstream (an unparsed route parameter, a field that was never set); check it before reading.`,
    );
  }
  const query = rootQuery(schema);
  if (key.length === 1) {
    const field = key[0] as FieldMeta;
    if (typeof id === "object" && isPlainObject(id)) {
      throw new QueryError(
        `repo.get(${schemaMeta.name}, id): the primary key of ${schemaMeta.name} is the single field "${field.name}", so the id is its value, not an object.`,
      );
    }
    return query.where({ [field.name]: id } as never) as Query<unknown, unknown, never, string>;
  }
  const names = key.map((field) => field.name);
  const expected = `{ ${names.map((name) => `${name}: …`).join(", ")} }`;
  if (typeof id !== "object" || !isPlainObject(id)) {
    throw new QueryError(
      `repo.get(${schemaMeta.name}, id): ${schemaMeta.name} has a composite primary key, so the id is an object of its fields: ${expected}.`,
    );
  }
  const given = id as Readonly<Record<string, unknown>>;
  const clauses: Record<string, unknown> = {};
  for (const name of names) {
    const value = Object.hasOwn(given, name) ? given[name] : undefined;
    if (value === undefined || value === null) {
      throw new QueryError(
        `repo.get(${schemaMeta.name}, id): the id has no value for the key field "${name}" (it is ${String(value)}). The id is ${expected}.`,
      );
    }
    clauses[name] = value;
  }
  for (const name of Object.keys(given)) {
    if (!names.includes(name)) {
      throw new QueryError(
        `repo.get(${schemaMeta.name}, id): "${name}" is not a field of the primary key of ${schemaMeta.name}. The id is ${expected}.`,
      );
    }
  }
  return query.where(clauses as never) as Query<unknown, unknown, never, string>;
}

/** The query of `getBy(queryable, clauses)`. */
export function byClauses(input: QueryInput, clauses: unknown, method: string): QueryInput {
  if (input.query === undefined) {
    throw new QueryError(
      `repo.${method}() adds its clauses with the query's where(); this query object has no where() method. Pass a query built with from(), or a schema class.`,
    );
  }
  if (typeof clauses !== "object" || clauses === null || !isPlainObject(clauses)) {
    throw new QueryError(
      `repo.${method}() takes an object of field values: repo.${method}(User, { email: "ada@example.com" }).`,
    );
  }
  const query = input.query.where(clauses as never) as Query<unknown, unknown, never, string>;
  return { ast: query.ast, names: input.names, query };
}

/** `repo.stream`: decodes lazily, row by row; leaving the loop early closes the cursor. */
export async function* stream(
  core: ReadCore,
  input: QueryInput,
  named: Readonly<Record<string, unknown>> | undefined,
  options: StreamReadOptions | undefined,
): AsyncGenerator<unknown, void, undefined> {
  const ast = input.ast;
  const adapter = core.adapter;
  const plan = adapter.compile(ast, "all", schemaFor(core, options));
  const info = infoOf(plan);
  if (info.preloads) {
    throw new QueryError(
      "repo.stream() cannot preload associations: the rows are yielded one at a time, before their associations could be loaded. Stream the parents without preload, or read them in batches with repo.all(query.limit(n).offset(…)) and preload each batch.",
    );
  }
  const values = bindParams(plan.slots, ast.params, named);
  const decoder = decoderFor(plan, adapter, core.codegen);
  const constants = constantsOf(ast);
  const batchSize = options?.batchSize ?? DEFAULT_STREAM_BATCH_SIZE;
  const hub = core.hub;
  const call = hub.listening ? new Call(hub, "stream", sourceOf(ast), options?.context) : undefined;
  const rows = core.executor.stream(plan.sql, values, executeOptions(plan, info, options, call, batchSize));
  if (call === undefined) {
    for await (const row of rows) yield decoder(row, constants);
    return;
  }
  let decodeMs = 0;
  let failure: unknown;
  try {
    for await (const row of rows) {
      const start = now();
      let value: unknown;
      try {
        value = decoder(row, constants);
      } finally {
        decodeMs += now() - start;
      }
      yield value;
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // The adapter reported the stream when it ended, just before this.
    hub.emit(call, decodeMs, failure);
  }
}

/** `repo.toSql`: the SQL and the parameters as they would be sent. */
export function toSql(
  core: ReadCore,
  input: QueryInput,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
): { readonly sql: string; readonly params: unknown[] } {
  const plan = core.adapter.compile(input.ast, "all", schemaFor(core, options));
  return { sql: plan.sql, params: bindParams(plan.slots, input.ast.params, named) };
}

/** `repo.explain`: the database's plan, as text or (format `"json"`) as the parsed structure. */
export async function explain(
  core: ReadCore,
  input: QueryInput,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ExplainReadOptions | undefined,
): Promise<unknown> {
  const ast = input.ast;
  const format = options?.format;
  const analyze = options?.analyze;
  const explainOptions = {
    ...(analyze === undefined ? {} : { analyze }),
    ...(format === undefined ? {} : { format }),
  };
  const plan = core.adapter.compileExplain(ast, "all", schemaFor(core, options), explainOptions);
  const info = infoOf(plan);
  const values = bindParams(plan.slots, ast.params, named);
  return run(core, "explain", sourceOf(ast), plan, info, values, options, (result) => {
    const cells = result.rows.map((row) => Object.values(row)[0]);
    if (format === "json") {
      const cell = cells[0];
      return typeof cell === "string" ? JSON.parse(cell) : cell;
    }
    return cells.map((cell) => (typeof cell === "string" ? cell : JSON.stringify(cell))).join("\n");
  });
}

/** What `repo.raw` returns: the rows exactly as the driver gave them. */
export interface RawRows {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
}

/** Whether `value` is an expression made by the `fragment` tag. */
export function isFragment(value: unknown): value is AnyExpr & { readonly node: FragmentNode } {
  return isExpr(value) && value.node.kind === "fragment";
}

/** `repo.raw(fragment)`. */
export async function raw(
  core: ReadCore,
  statement: AnyExpr & { readonly node: FragmentNode },
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
): Promise<RawRows> {
  const plan = core.adapter.compileFragment(statement.node);
  const info = infoOf(plan);
  const values = bindParams(plan.slots, statement.params, named);
  return run(core, "raw", undefined, plan, info, values, options, (result) => ({
    rows: result.rows,
    rowCount: result.rowCount,
  }));
}

// ---------------------------------------------------------------------------
// reload
// ---------------------------------------------------------------------------

/** A table source with a database schema of its own: how `reload` reads a row where it was read. */
class RowSource {
  constructor(
    readonly schema: AnySchema,
    readonly schemaMeta: SchemaMeta,
    readonly databaseSchema: string,
  ) {}

  [AS_SOURCE](alias: string): SourceParts {
    const node: TableSourceNode = {
      kind: "table",
      source: this.schemaMeta.source as string,
      meta: this.schemaMeta,
      schema: this.databaseSchema,
      alias,
    };
    return {
      node,
      binding: bindingOf(this.schemaMeta, this.schema, alias),
      meta: this.schemaMeta,
      params: NONE,
      lists: NONE,
      named: NONE,
    };
  }
}

/** A value that identifies one primary key, for matching reloaded rows to the given ones. */
function keyOf(row: Readonly<Record<string, unknown>>, key: readonly FieldMeta[]): unknown {
  if (key.length === 1) return normalizeKey(row[(key[0] as FieldMeta).name]);
  let out = "";
  for (const field of key) {
    const value = normalizeKey(row[field.name]);
    out += `${typeof value}:${String(value)}\u0000`;
  }
  return out;
}

function normalizeKey(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

/** The schema class of a row: the class its prototype belongs to. */
function schemaOfRow(row: object): AnySchema | undefined {
  const owner = (Object.getPrototypeOf(row) as { readonly constructor?: unknown } | null)?.constructor;
  return isSchema(owner) ? owner : undefined;
}

/**
 * `repo.reload`: a fresh copy of each row, read where it was read (its `RowMeta.schema`
 * is the source's database schema), `null` for a row that is gone. Rows of one schema and
 * database schema are read with one query; the result keeps the order of the input.
 *
 * @throws TypeError when an element is not a loaded row.
 * @throws QueryError when its schema has no primary key or a key field is `null`.
 * @throws NoResultsError when `strict` and a row is gone.
 */
export async function reload(
  core: ReadCore,
  rows: readonly unknown[],
  options: ReadOptions | undefined,
  strict: boolean,
): Promise<unknown[]> {
  interface Group {
    readonly schema: AnySchema;
    readonly schemaMeta: SchemaMeta;
    readonly databaseSchema: string | undefined;
    readonly indexes: number[];
  }
  const groups = new Map<SchemaMeta, Map<string | undefined, Group>>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const schema = typeof row === "object" && row !== null && isRow(row) ? schemaOfRow(row) : undefined;
    if (schema === undefined) {
      throw new TypeError(
        `repo.reload() takes rows read from the database (or an array of them); ${rows.length === 1 ? "it was given" : `element ${i} is`} ${row === null ? "null" : typeof row === "object" ? "a plain object" : typeof row}.`,
      );
    }
    const schemaMeta = meta(schema);
    if (schemaMeta.primaryKey.length === 0) {
      throw new QueryError(
        `repo.reload(): ${schemaMeta.name} has no primary key, so its rows cannot be found again.`,
      );
    }
    const databaseSchema = (row as { readonly [ROW]: { readonly schema: string | undefined } })[ROW].schema;
    let bySchema = groups.get(schemaMeta);
    if (bySchema === undefined) {
      bySchema = new Map();
      groups.set(schemaMeta, bySchema);
    }
    let group = bySchema.get(databaseSchema);
    if (group === undefined) {
      group = { schema, schemaMeta, databaseSchema, indexes: [] };
      bySchema.set(databaseSchema, group);
    }
    group.indexes.push(i);
  }
  const out = new Array<unknown>(rows.length).fill(null);
  for (const bySchema of groups.values()) {
    for (const group of bySchema.values()) {
      const given = group.indexes.map((index) => rows[index] as Readonly<Record<string, unknown>>);
      const query = reloadQuery(group.schema, group.schemaMeta, group.databaseSchema, given);
      const found = await load(core, "reload", query.ast, undefined, options);
      const key = group.schemaMeta.primaryKey;
      const byKey = new Map<unknown, unknown>();
      for (const each of found) byKey.set(keyOf(each as Readonly<Record<string, unknown>>, key), each);
      for (let i = 0; i < given.length; i++) {
        const fresh = byKey.get(keyOf(given[i] as Readonly<Record<string, unknown>>, key));
        if (fresh === undefined && strict) throw new NoResultsError({ query: render(query.ast) });
        out[group.indexes[i] as number] = fresh ?? null;
      }
    }
  }
  return out;
}

function reloadQuery(
  schema: AnySchema,
  schemaMeta: SchemaMeta,
  databaseSchema: string | undefined,
  rows: readonly Readonly<Record<string, unknown>>[],
): Query<unknown, unknown, never, string> {
  const alias = rootAlias(schemaMeta);
  const base =
    databaseSchema === undefined
      ? rootQuery(schema)
      : (from(new RowSource(schema, schemaMeta, databaseSchema) as never, alias) as unknown as Query<
          unknown,
          unknown,
          never,
          string
        >);
  const key = schemaMeta.primaryKey;
  for (const row of rows) {
    for (const field of key) {
      const value = row[field.name];
      if (value === null || value === undefined) {
        throw new QueryError(
          `repo.reload(): a row of ${schemaMeta.name} has no value for its key field "${field.name}", so it cannot be found again.`,
        );
      }
    }
  }
  return base.where((bindings: unknown) => {
    const columns = (bindings as Readonly<Record<string, Readonly<Record<string, Col<unknown>>>>>)[
      alias
    ] as Readonly<Record<string, Col<unknown>>>;
    if (key.length === 1) {
      const field = key[0] as FieldMeta;
      return (columns[field.name] as Col<unknown>).in(rows.map((row) => row[field.name]) as never) as never;
    }
    const matches = rows.map((row) =>
      and(...key.map((field) => (columns[field.name] as Col<unknown>).eq(row[field.name] as never))),
    );
    return (matches.length === 1 ? matches[0] : or(...matches)) as never;
  }) as Query<unknown, unknown, never, string>;
}
