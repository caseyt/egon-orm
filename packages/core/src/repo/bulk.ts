/**
 * The bulk writes of the repo: `insertAll`, `updateAll` and `deleteAll`. They take no
 * changeset and run no validation.
 *
 * ## insertAll
 *
 * The rows are plain objects of field values; a value may also be an expression (a
 * `fragment`, `now()`, a named parameter `param(name, type)` filled from the
 * `placeholders` option) or a query (a subquery that selects one value). Each row gets
 * its fields' defaults and generated values (one instant for every timestamp of the
 * call), and every row is written with the same column list: a field a row leaves out is
 * written as `DEFAULT`, so the database default applies. The rows are sent in chunks that
 * stay under the dialect's parameter limit (`insertChunks`), inside one transaction when
 * there is more than one chunk. A query in place of the rows is `INSERT … SELECT`: its
 * select names the fields, by key.
 *
 * ## updateAll and deleteAll
 *
 * A query compiled as an `UPDATE` (with its `.set(...)` assignments) or a `DELETE`. Both
 * return the number of rows written and, when the query declares `.returning(...)`, the
 * rows it returned.
 *
 * @module
 */

import { bindParams } from "../compiler/bind.js";
import { insertChunks } from "../compiler/write.js";
import type {
  CompiledQuery,
  Connection,
  Executor,
  InsertCell,
  InsertSource,
  OnConflict,
  RawResult,
} from "../contracts/adapter.js";
import type { ExprNode, NamedParamNode, QueryAst } from "../contracts/query.js";
import type { AnySchema, FieldMeta, FieldNames, InsertShape, SchemaMeta } from "../contracts/schema.js";
import { DatabaseError, QueryError } from "../errors.js";
import { isPlainObject } from "../internal/plain-object.js";
import { collectParams, subqueryNode } from "../query/ast.js";
import type { Expr, SomeParams } from "../query/expr.js";
import { isExpr } from "../query/expr.js";
import { isSchema } from "../schema/guards.js";
import { meta } from "../schema/schema.js";
import { decodeRows, decoderFor } from "./hydrate.js";
import {
  checkReadOptions,
  READ_OPTION_KEYS,
  type ReadOptions,
  type SplitArgs,
  splitArgs,
} from "./options.js";
import { inputOf, type ReadCore } from "./read.js";
import {
  conflictOption,
  deadlineOf,
  type OnConflictOption,
  persistedField,
  returningOption,
  runWrite,
  writeTable,
} from "./write.js";

const NONE: readonly never[] = Object.freeze([]);
const hasOwn = Object.hasOwn;
const now = (): number => performance.now();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One row of `insertAll`: the fields a new record needs (as `InsertShape` has them), each
 * given as a value, an expression of that type, or a query that selects one value.
 *
 * @example
 * ```ts
 * const row: InsertAllRow<typeof Post> = { authorId: 1, title: "Hello", publishedAt: now() };
 * ```
 */
export type InsertAllRow<S extends AnySchema> = {
  [K in keyof InsertShape<S>]: InsertShape<S>[K] | Expr<InsertShape<S>[K], SomeParams> | QueryLikeValue;
};

/** A query used as one value of `insertAll`: it must select a single value. */
interface QueryLikeValue {
  readonly ast: QueryAst;
}

/**
 * The options of `repo.insertAll`.
 *
 * - `returning`: `true` returns every row inserted as a row of the schema; a list of
 *   field names returns plain objects of those fields. Without it, `rows` is `null`.
 * - `onConflict`: as for `repo.insert`. With `"nothing"`, `count` leaves the skipped rows out.
 * - `placeholders`: the values of the named parameters (`param("now", t.timestamp())`)
 *   used in the rows or in the source query, each bound once per statement.
 *
 * @example
 * ```ts
 * const options: InsertAllOptions<typeof Post> = { returning: ["id"], placeholders: { now: new Date() } };
 * ```
 */
export interface InsertAllOptions<S extends AnySchema = AnySchema> extends ReadOptions {
  readonly returning?: true | readonly FieldNames<S>[] | undefined;
  readonly onConflict?: OnConflictOption<S> | undefined;
  readonly placeholders?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * What a bulk write returns: how many rows it wrote, and the rows it returned (`null`
 * when it was not asked to return any).
 *
 * @example
 * ```ts
 * const { count, rows }: BulkResult<{ id: number }> = await repo.deleteAll(stale.returning(({ p }) => ({ id: p.id })));
 * ```
 */
export interface BulkResult<R> {
  readonly count: number;
  readonly rows: R[] | null;
}

export const INSERT_ALL_OPTION_KEYS: readonly string[] = Object.freeze([
  ...READ_OPTION_KEYS,
  "returning",
  "onConflict",
  "placeholders",
]);

// ---------------------------------------------------------------------------
// Transactions and budgets
// ---------------------------------------------------------------------------

/**
 * A connection from the pool within the call's budget: the wait counts against
 * `timeoutMs`, and the call's signal stops it. A connection that arrives after the call
 * gave up is returned to the pool.
 *
 * @throws DatabaseError with the code `"timeout"` or `"aborted"`.
 */
async function acquireWithin(
  core: ReadCore,
  options: ReadOptions | undefined,
  deadline: number | undefined,
): Promise<Connection> {
  const signal = options?.signal;
  if (signal?.aborted === true) {
    throw new DatabaseError("The write was not run: its AbortSignal had fired.", { code: "aborted" });
  }
  const pending = core.adapter.acquire();
  if (signal === undefined && deadline === undefined) return pending;
  return new Promise<Connection>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const giveUp = (error: DatabaseError): void => {
      if (settled) return;
      done();
      reject(error);
    };
    const onAbort = (): void =>
      giveUp(
        new DatabaseError(
          "The write was not run: its AbortSignal fired while it waited for a free connection.",
          {
            code: "aborted",
          },
        ),
      );
    if (deadline !== undefined) {
      timer = setTimeout(
        () =>
          giveUp(
            new DatabaseError(
              `The write was not run: it waited longer than its timeoutMs (${options?.timeoutMs} ms) for a free connection.`,
              { code: "timeout" },
            ),
          ),
        Math.max(0, deadline - now()),
      );
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (connection) => {
        if (settled) {
          void connection.release();
          return;
        }
        done();
        resolve(connection);
      },
      (error: unknown) => {
        if (settled) return;
        done();
        reject(error);
      },
    );
  });
}

/**
 * Runs `work` on one executor inside a transaction: the call's own (begin, commit,
 * rollback on failure) when the repo runs on the pool, or the executor it already has
 * (a transaction's connection), whose transaction the work joins.
 */
async function inTransaction<T>(
  core: ReadCore,
  options: ReadOptions | undefined,
  deadline: number | undefined,
  work: (executor: Executor) => Promise<T>,
): Promise<T> {
  if (core.executor !== core.adapter) return work(core.executor);
  const connection = await acquireWithin(core, options, deadline);
  let value: T;
  try {
    await connection.begin();
    value = await work(connection);
    await connection.commit();
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      await connection.destroy();
      throw error;
    }
    await connection.release();
    throw error;
  }
  await connection.release();
  return value;
}

// ---------------------------------------------------------------------------
// insertAll
// ---------------------------------------------------------------------------

/** One prepared row: its cells and the values they bind, and how many placeholders they take. */
interface PreparedRow {
  readonly cells: readonly InsertCell[];
  readonly values: readonly unknown[];
  readonly params: number;
}

const VALUE_CELL: InsertCell = Object.freeze({ kind: "value" });
const DEFAULT_CELL: InsertCell = Object.freeze({ kind: "default" });

/** What decodes the rows an insertAll returned. */
interface Returning {
  readonly schemaMeta: SchemaMeta;
  /** `true`: whole rows of the schema; `false`: plain objects of the fields asked for; `undefined`: none. */
  readonly whole: boolean | undefined;
}

interface Chunked {
  readonly count: number;
  readonly rows: unknown[] | null;
}

function decodeInserted(result: RawResult, plan: CompiledQuery, core: ReadCore, back: Returning): Chunked {
  if (back.whole === undefined || plan.output === undefined) return { count: result.rowCount, rows: null };
  const objects = decodeRows(result.rows, decoderFor(plan, core.adapter, core.codegen), NONE);
  if (!back.whole) return { count: result.rowCount, rows: objects };
  const schemaMeta = back.schemaMeta;
  const rowMeta = schemaMeta.rowMeta("loaded", plan.schema);
  const rows: unknown[] = [];
  for (const object of objects as readonly Readonly<Record<string, unknown>>[]) {
    const values: unknown[] = [];
    for (const field of schemaMeta.persisted) values.push(object[field.name]);
    rows.push(schemaMeta.create(values, rowMeta));
  }
  return { count: result.rowCount, rows };
}

function isQueryLike(value: unknown): value is QueryLikeValue {
  if (typeof value !== "object" || value === null) return false;
  const ast = (value as { readonly ast?: unknown }).ast;
  return typeof ast === "object" && ast !== null && (ast as { readonly kind?: unknown }).kind === "query";
}

/**
 * The cell for one given value, appending what it binds to `values`; returns how many
 * placeholders it takes. A plain value is bound with the column's type; so is an
 * expression that is just an untyped value (`val(x)`), since the column types it.
 */
function cellOf(
  value: unknown,
  values: unknown[],
  names: NamedParamNode[],
): { readonly cell: InsertCell; readonly params: number } {
  if (isExpr(value)) {
    const node = value.node as ExprNode;
    if (node.kind === "param" && node.type === undefined) {
      values.push(node.value);
      return { cell: VALUE_CELL, params: 1 };
    }
    if (node.kind === "namedParam") {
      names.push(node);
      return { cell: { kind: "placeholder", name: node.name }, params: 1 };
    }
    return { cell: { kind: "expr", expr: node }, params: bindExpr(node, values, names) };
  }
  if (isQueryLike(value)) {
    const node = subqueryNode(value.ast);
    return { cell: { kind: "expr", expr: node }, params: bindExpr(node, values, names) };
  }
  values.push(value);
  return { cell: VALUE_CELL, params: 1 };
}

/** Appends an expression cell's values; returns how many placeholders it may take (lists counted whole). */
function bindExpr(node: ExprNode, values: unknown[], names: NamedParamNode[]): number {
  const own: unknown[] = [];
  const lists: number[] = [];
  const named: NamedParamNode[] = [];
  collectParams(node, own, lists, named);
  for (const value of own) values.push(value);
  for (const each of named) names.push(each);
  let params = own.length + named.length;
  for (const length of lists) params += Math.max(0, length - 1);
  return params;
}

/** Sizes of chunks of `rows` (each with its placeholder count) such that none exceeds `maxParams`. */
function chunkByParams(rows: readonly PreparedRow[], maxParams: number, extra: number): number[] {
  const sizes: number[] = [];
  let size = 0;
  let params = extra;
  for (const row of rows) {
    if (size > 0 && params + row.params > maxParams) {
      sizes.push(size);
      size = 0;
      params = extra;
    }
    size++;
    params += row.params;
  }
  if (size > 0) sizes.push(size);
  return sizes;
}

/**
 * Checks the `placeholders` option against the named parameters the statement uses: every
 * one used needs a value, and every value given must be used.
 *
 * @throws QueryError otherwise.
 */
function checkPlaceholders(
  placeholders: Readonly<Record<string, unknown>> | undefined,
  used: readonly NamedParamNode[],
): void {
  const names = new Set(used.map((node) => node.name));
  const given = placeholders === undefined ? [] : Object.keys(placeholders);
  const unknown = given.filter((name) => !names.has(name));
  if (unknown.length > 0) {
    throw new QueryError(
      `repo.insertAll(): placeholders ${unknown.map((name) => `"${name}"`).join(", ")} ${unknown.length > 1 ? "are" : "is"} not used by any row; ${names.size === 0 ? "the rows use none" : `the rows use ${[...names].map((name) => `"${name}"`).join(", ")}`}. Use one in a row as param("${unknown[0]}", type).`,
    );
  }
  const missing = [...names].filter((name) => placeholders === undefined || placeholders[name] === undefined);
  if (missing.length > 0) {
    throw new QueryError(
      `repo.insertAll(): the rows use the named parameter${missing.length > 1 ? "s" : ""} ${missing.map((name) => `"${name}"`).join(", ")}; give ${missing.length > 1 ? "their values" : "its value"} in the placeholders option.`,
    );
  }
}

/** The named values a plan uses, out of the `placeholders` option. */
function usedPlaceholders(
  plan: CompiledQuery,
  placeholders: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (placeholders === undefined) return undefined;
  const used: Record<string, unknown> = {};
  let any = false;
  for (const slot of plan.slots) {
    if (slot.kind === "named" && hasOwn(placeholders, slot.name)) {
      used[slot.name] = placeholders[slot.name];
      any = true;
    }
  }
  return any ? used : undefined;
}

/** The checked options of insertAll. */
interface InsertAllSettings {
  readonly options: ReadOptions | undefined;
  readonly returning: readonly FieldMeta[] | true | undefined;
  readonly onConflict: OnConflict | undefined;
  readonly conflictParams: readonly unknown[];
  readonly placeholders: Readonly<Record<string, unknown>> | undefined;
}

function insertAllSettings(schemaMeta: SchemaMeta, options: unknown): InsertAllSettings {
  const checked = checkReadOptions<ReadOptions>("insertAll", options, INSERT_ALL_OPTION_KEYS);
  const given = (checked ?? {}) as Readonly<Record<string, unknown>>;
  const conflict = conflictOption(schemaMeta, given.onConflict, "insertAll");
  const placeholders = given.placeholders;
  if (
    placeholders !== undefined &&
    (typeof placeholders !== "object" || placeholders === null || !isPlainObject(placeholders))
  ) {
    throw new TypeError(
      "repo.insertAll(): placeholders must be an object of named values, such as { now: new Date() }.",
    );
  }
  return {
    options: checked,
    returning: returningOption(schemaMeta, given.returning, "insertAll"),
    onConflict: conflict.onConflict,
    conflictParams: conflict.params,
    placeholders: placeholders as Readonly<Record<string, unknown>> | undefined,
  };
}

/**
 * `repo.insertAll(Schema, rows | query, options)`.
 *
 * @throws TypeError, QueryError for misuse; ConstraintError and DatabaseError from the database.
 */
export async function insertAll(
  core: ReadCore,
  schema: unknown,
  source: unknown,
  options: unknown,
): Promise<BulkResult<unknown>> {
  if (!isSchema(schema)) {
    throw new TypeError("repo.insertAll() takes a schema class first: repo.insertAll(User, rows).");
  }
  const schemaMeta = meta(schema as AnySchema);
  const table = writeTable(schemaMeta);
  const settings = insertAllSettings(schemaMeta, options);
  const returning: readonly FieldMeta[] =
    settings.returning === undefined
      ? NONE
      : settings.returning === true
        ? schemaMeta.persisted
        : settings.returning;
  const back: Returning = {
    schemaMeta,
    whole: settings.returning === undefined ? undefined : settings.returning === true,
  };
  const databaseSchema = settings.options?.schema ?? schemaMeta.schema ?? core.schema;
  if (isQueryLike(source))
    return insertFromQuery(core, schemaMeta, source.ast, settings, returning, back, databaseSchema);
  if (!Array.isArray(source)) {
    throw new TypeError(
      "repo.insertAll(Schema, rows): rows is an array of objects of field values, or a query (INSERT … SELECT).",
    );
  }
  if (source.length === 0) return { count: 0, rows: back.whole === undefined ? null : [] };

  // The columns: every field a row gives, and every field with a default or a generated value.
  const persisted = schemaMeta.persisted;
  const used: boolean[] = persisted.map(
    (field) => field.default !== undefined || field.autogenerate !== undefined,
  );
  for (let r = 0; r < source.length; r++) {
    const row: unknown = source[r];
    if (typeof row !== "object" || row === null || !isPlainObject(row)) {
      throw new TypeError(`repo.insertAll(): row ${r} is not a plain object of field values.`);
    }
    for (const key of Object.keys(row)) {
      if ((row as Readonly<Record<string, unknown>>)[key] === undefined) continue;
      const field = persistedField(schemaMeta, key, `repo.insertAll(): row ${r}`);
      if (field.writable === "never") {
        throw new QueryError(
          `repo.insertAll(): row ${r} gives a value for ${schemaMeta.name}.${field.name}, which the database owns (writable: "never").`,
        );
      }
      used[persisted.indexOf(field)] = true;
    }
  }
  const columns: FieldMeta[] = [];
  const positions: number[] = [];
  for (let i = 0; i < persisted.length; i++) {
    const field = persisted[i] as FieldMeta;
    if (used[i] === true && field.writable !== "never") {
      columns.push(field);
      positions.push(i);
    }
  }

  // The cells of every row, with its values; one instant for every timestamp of the call.
  const stamps: unknown[] = [];
  const names: NamedParamNode[] = [];
  const prepared: PreparedRow[] = [];
  let plain = true;
  for (const given of source as readonly Readonly<Record<string, unknown>>[]) {
    const cells: InsertCell[] = [];
    const values: unknown[] = [];
    let params = 0;
    for (let c = 0; c < columns.length; c++) {
      const field = columns[c] as FieldMeta;
      const index = positions[c] as number;
      let value = hasOwn(given, field.name) ? given[field.name] : undefined;
      if (value === undefined) {
        const fallback = field.default;
        if (fallback !== undefined) value = fallback.kind === "value" ? fallback.value : fallback.fn();
        else if (field.autogenerate !== undefined) value = generate(table.shares, field, index, stamps);
      }
      if (value === undefined) {
        cells.push(DEFAULT_CELL);
        plain = false;
        continue;
      }
      const cell = cellOf(value, values, names);
      if (cell.cell !== VALUE_CELL) plain = false;
      cells.push(cell.cell);
      params += cell.params;
    }
    prepared.push({ cells, values, params });
  }
  checkPlaceholders(settings.placeholders, names);

  const maxParams = core.adapter.capabilities.maxParams;
  const extra = settings.conflictParams.length;
  const sizes = plain
    ? insertChunks(prepared.length, columns.length, maxParams - extra)
    : chunkByParams(prepared, maxParams, extra);
  const deadline = sizes.length > 1 ? deadlineOf(settings.options) : undefined;
  const run = async (executor: Executor): Promise<BulkResult<unknown>> => {
    let count = 0;
    const rows: unknown[] | null = back.whole === undefined ? null : [];
    let start = 0;
    for (const size of sizes) {
      const chunk = prepared.slice(start, start + size);
      start += size;
      const insertSource: InsertSource = plain
        ? { kind: "values", rows: size }
        : { kind: "cells", rows: chunk.map((row) => row.cells) };
      const plan = core.adapter.compileInsert(
        schemaMeta,
        columns,
        { source: insertSource, returning, onConflict: settings.onConflict },
        databaseSchema,
      );
      const values: unknown[] = [];
      for (const row of chunk) for (const value of row.values) values.push(value);
      for (const value of settings.conflictParams) values.push(value);
      const bound = bindParams(plan.slots, values, usedPlaceholders(plan, settings.placeholders));
      const done = await runWrite(
        core,
        executor,
        "insertAll",
        schemaMeta.source as string,
        plan,
        bound,
        settings.options,
        deadline,
        decodeInserted,
        back,
      );
      count += done.count;
      if (rows !== null && done.rows !== null) for (const row of done.rows) rows.push(row);
    }
    return { count, rows };
  };
  return sizes.length > 1 ? inTransaction(core, settings.options, deadline, run) : run(core.executor);
}

/**
 * The value of a generated field for one row. A timestamp is generated once per call and
 * shared by every row and by the timestamps of the same generator (`createdAt` and
 * `updatedAt`); anything else (a uuid) is generated per row.
 */
function generate(shares: readonly number[], field: FieldMeta, index: number, stamps: unknown[]): unknown {
  const generator = (field.autogenerate as NonNullable<FieldMeta["autogenerate"]>).fn;
  const kind = field.type.db.kind;
  if (kind !== "timestamp" && kind !== "timestamptz") return generator();
  const share = shares[index] as number;
  if (stamps[share] === undefined) stamps[share] = generator();
  return stamps[share];
}

/** `INSERT INTO table (fields of the select) SELECT …`. */
async function insertFromQuery(
  core: ReadCore,
  schemaMeta: SchemaMeta,
  ast: QueryAst,
  settings: InsertAllSettings,
  returning: readonly FieldMeta[],
  back: Returning,
  databaseSchema: string | undefined,
): Promise<BulkResult<unknown>> {
  const shape = ast.select?.shape;
  if (shape === undefined || shape.kind !== "object") {
    throw new QueryError(
      `repo.insertAll(${schemaMeta.name}, query): the query must select an object whose keys are the fields to fill, such as .select(({ u }) => ({ email: u.email, name: u.name })).`,
    );
  }
  const columns = shape.keys.map((key) => {
    const field = persistedField(
      schemaMeta,
      key,
      `repo.insertAll(${schemaMeta.name}, query): the select's key`,
    );
    if (field.writable === "never") {
      throw new QueryError(
        `repo.insertAll(): the query selects ${schemaMeta.name}.${field.name}, which the database owns (writable: "never").`,
      );
    }
    return field;
  });
  const plan = core.adapter.compileInsert(
    schemaMeta,
    columns,
    { source: { kind: "query", query: ast }, returning, onConflict: settings.onConflict },
    databaseSchema,
  );
  const values: unknown[] = [...ast.params, ...settings.conflictParams];
  const bound = bindParams(plan.slots, values, settings.placeholders);
  const done = await runWrite(
    core,
    core.executor,
    "insertAll",
    schemaMeta.source as string,
    plan,
    bound,
    settings.options,
    undefined,
    decodeInserted,
    back,
  );
  return { count: done.count, rows: done.rows };
}

// ---------------------------------------------------------------------------
// updateAll and deleteAll
// ---------------------------------------------------------------------------

function decodeModified(
  result: RawResult,
  plan: CompiledQuery,
  core: ReadCore,
  ast: QueryAst,
): BulkResult<unknown> {
  if (plan.output === undefined) return { count: result.rowCount, rows: null };
  const constants = ast.select === undefined ? NONE : ast.select.constants;
  return {
    count: result.rowCount,
    rows: decodeRows(result.rows, decoderFor(plan, core.adapter, core.codegen), constants),
  };
}

/**
 * `repo.updateAll(query, params?, options?)` and `repo.deleteAll(queryable, params?, options?)`.
 *
 * @throws TypeError, QueryError for misuse (an `updateAll` query without `.set(...)`).
 */
export async function modifyAll(
  core: ReadCore,
  operation: "updateAll" | "deleteAll",
  queryable: unknown,
  args: readonly unknown[],
): Promise<BulkResult<unknown>> {
  if (operation === "updateAll" && isSchema(queryable)) {
    throw new QueryError(
      'repo.updateAll() takes a query with .set(...): repo.updateAll(from(Post, "p").where(…).set({ published: true })).',
    );
  }
  const input = inputOf(operation, queryable);
  const ast = input.ast;
  if (operation === "updateAll" && ast.updates.length === 0) {
    throw new QueryError(
      'repo.updateAll() needs a query with .set(...), the values to write: repo.updateAll(from(Post, "p").where(…).set({ published: true })).',
    );
  }
  const split: SplitArgs<ReadOptions> = splitArgs<ReadOptions>(
    operation,
    input.names,
    args,
    READ_OPTION_KEYS,
  );
  const options = split.options;
  const schema = options?.schema ?? core.schema;
  const plan = core.adapter.compile(ast, operation, schema);
  const values = bindParams(plan.slots, ast.params, split.named);
  const source = ast.from.kind === "table" ? ast.from.source : undefined;
  return runWrite(
    core,
    core.executor,
    operation,
    source,
    plan,
    values,
    options,
    undefined,
    decodeModified,
    ast,
  );
}
