/**
 * Queries over associations: how the rows of an association are found from the keys of
 * their parents. {@link assoc} is the public helper; {@link routeOf} is what the repo's
 * preloads build their statements from.
 *
 * ## Routes
 *
 * An association is read as a query rooted at its target, under the association's name as
 * alias. Its **route** says how that query reaches the parents' keys:
 *
 * - `belongsTo`, `hasOne`, `hasMany` (direct): the target holds the key. The children
 *   are the target rows whose `relatedKey` fields are among the parents' `ownerKey`
 *   values, and each child carries that value itself.
 * - `manyToMany`: the join table is joined to the target, and the parent's key is its
 *   owner column, selected beside each row.
 * - has-through: the chain of associations is joined backwards from the target, one join
 *   per step (two for a many-to-many step), and the parent's key is the column of the
 *   first step that points at the owner, selected beside each row.
 *
 * Every association's own `where` (and a many-to-many's `joinWhere`) is part of the
 * route, so it always applies. A route is computed once per association and cached.
 *
 * @module
 */
import type { ExprNode, JoinNode, QueryAst, TableSourceNode } from "../contracts/query.js";
import type {
  AnySchema,
  AssocKeys,
  AssocMeta,
  FieldMeta,
  LoadedUnchecked,
  Row,
  SchemaMeta,
} from "../contracts/schema.js";
import { ROW } from "../contracts/schema.js";
import type { AnyFieldType } from "../contracts/type.js";
import { QueryError } from "../errors.js";
import { isRow, isSchema } from "../schema/guards.js";
import { meta } from "../schema/schema.js";
import { binaryNode, collectParams, columnNode, naryNode, shapeOf, shapeOfColumn } from "./ast.js";
import { from, type PreloadQuery } from "./builder.js";
import { type AnyExpr, Col, Expr, NONE } from "./expr.js";
import { and, or } from "./functions.js";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** One direct or many-to-many association on a has-through chain, from `from` to `to`. */
interface Step {
  readonly assoc: AssocMeta;
  readonly from: SchemaMeta;
  readonly to: SchemaMeta;
}

/**
 * How the rows of one association are found from their parents' keys. See the module
 * documentation.
 *
 * @example
 * ```ts
 * const route: AssocRoute = routeOf(meta(Post), "tags");
 * route.joins.length; // 1: the join table
 * ```
 */
export interface AssocRoute {
  /** The association. */
  readonly assoc: AssocMeta;
  /** The schema that declares it. */
  readonly owner: SchemaMeta;
  /** The target schema class and its metadata. */
  readonly target: AnySchema;
  readonly targetMeta: SchemaMeta;
  /** The alias the target is read under: the association's name. */
  readonly alias: string;
  /** `"many"` for `hasMany` and `manyToMany`, `"one"` otherwise. */
  readonly cardinality: "one" | "many";
  /** The owner's fields whose values select the children. */
  readonly ownerFields: readonly FieldMeta[];
  /**
   * For a direct association: the target's fields that hold the owner's key, which every
   * child carries. `undefined` when the key is selected beside the row (many-to-many and
   * has-through).
   */
  readonly childFields: readonly FieldMeta[] | undefined;
  /** The joins after the target that reach the owner's key; empty for a direct association. */
  readonly joins: readonly JoinNode[];
  /** The expressions holding the owner's key, in the query rooted at the target. */
  readonly keys: readonly ExprNode[];
  /** The conditions every read of the association applies: the `where` of each association on the way. */
  readonly filters: readonly ExprNode[];
  /** Whether one target row can be reached along several paths from one parent (a has-through chain). */
  readonly mayRepeat: boolean;
}

const routes = new WeakMap<AssocMeta, AssocRoute>();

/**
 * The route of association `name` of `ownerMeta`, computed once and cached.
 *
 * @example
 * ```ts
 * const route = routeOf(meta(User), "posts");
 * route.childFields?.map((field) => field.name); // ["authorId"]
 * ```
 *
 * @throws QueryError when the schema has no such association.
 */
export function routeOf(ownerMeta: SchemaMeta, name: string): AssocRoute {
  const assoc = ownerMeta.assocs().get(name);
  if (assoc === undefined) {
    const known = [...ownerMeta.assocs().keys()];
    throw new QueryError(
      `${ownerMeta.name} has no association "${name}". Its associations are: ${known.length === 0 ? "none" : known.join(", ")}.`,
    );
  }
  let route = routes.get(assoc);
  if (route === undefined) {
    route = buildRoute(ownerMeta, assoc);
    routes.set(assoc, route);
  }
  return route;
}

function stepsOf(ownerMeta: SchemaMeta, assoc: AssocMeta): Step[] {
  if (assoc.through === undefined) return [{ assoc, from: ownerMeta, to: meta(assoc.target()) }];
  const steps: Step[] = [];
  let current = ownerMeta;
  for (const name of assoc.through) {
    const next = current.assocs().get(name) as AssocMeta;
    for (const step of stepsOf(current, next)) steps.push(step);
    current = meta(next.target());
  }
  return steps;
}

function fieldsOf(schemaMeta: SchemaMeta, names: readonly string[]): FieldMeta[] {
  return names.map((name) => schemaMeta.fieldsByName.get(name) as FieldMeta);
}

/** A column of a table that has no schema (a join table given by name). */
function rawColumn(alias: string, column: string, type: AnyFieldType | undefined): AnyExpr {
  return new Expr(
    columnNode(alias, column, column),
    type,
    false,
    NONE,
    NONE,
    NONE,
    shapeOfColumn(alias, column),
  );
}

/** One condition of an association's `where`: a value is equality, `null` is `IS NULL`, an array is `IN`. */
function condition(column: AnyExpr, value: unknown): ExprNode {
  if (value === null) return column.isNull().node;
  const kind = column.type?.db.kind ?? "";
  if (Array.isArray(value) && kind !== "array" && kind !== "json" && kind !== "jsonb") {
    return column.in(value as never).node;
  }
  return column.eq(value as never).node;
}

function targetFilters(alias: string, schemaMeta: SchemaMeta, where: AssocMeta["where"]): ExprNode[] {
  if (where === undefined) return [];
  return Object.keys(where).map((key) =>
    condition(new Col<unknown>(alias, schemaMeta.fieldsByName.get(key) as FieldMeta), where[key]),
  );
}

function and2(parts: readonly ExprNode[]): ExprNode {
  return parts.length === 1 ? (parts[0] as ExprNode) : naryNode("and", parts);
}

function tableOf(schemaMeta: SchemaMeta, alias: string): TableSourceNode {
  return { kind: "table", source: schemaMeta.source as string, meta: schemaMeta, schema: undefined, alias };
}

function buildRoute(ownerMeta: SchemaMeta, assoc: AssocMeta): AssocRoute {
  const target = assoc.target();
  const targetMeta = meta(target);
  const alias = assoc.name;
  const cardinality = assoc.kind === "hasMany" || assoc.kind === "manyToMany" ? "many" : "one";
  const steps = stepsOf(ownerMeta, assoc);
  const first = steps[0] as Step;
  const ownerFields = fieldsOf(ownerMeta, first.assoc.ownerKey);
  if (steps.length === 1 && assoc.kind !== "manyToMany") {
    const childFields = fieldsOf(targetMeta, assoc.relatedKey);
    return {
      assoc,
      owner: ownerMeta,
      target,
      targetMeta,
      alias,
      cardinality,
      ownerFields,
      childFields,
      joins: NONE,
      keys: childFields.map((field) => columnNode(alias, field.name, field.column)),
      filters: targetFilters(alias, targetMeta, assoc.where),
      mayRepeat: false,
    };
  }
  // Joined backwards from the target: step k connects the rows of step k - 1 (joined
  // under an alias of their own) with those of step k (already in the query).
  const joins: JoinNode[] = [];
  const filters: ExprNode[] = [];
  let keys: ExprNode[] = [];
  let toAlias = alias;
  for (let k = steps.length - 1; k >= 0; k--) {
    const step = steps[k] as Step;
    const fromAlias = k === 0 ? undefined : `$${alias}__via${k}`;
    for (const node of targetFilters(toAlias, step.to, step.assoc.where)) filters.push(node);
    // The expressions, on the side already in the query, that equal the `from` rows' ownerKey.
    let ownerSide: AnyExpr[];
    if (step.assoc.kind === "manyToMany") {
      const through = step.assoc.joinThrough as NonNullable<AssocMeta["joinThrough"]>;
      const [ownerJoin, targetJoin] = step.assoc.joinKeys as NonNullable<AssocMeta["joinKeys"]>;
      const joinAlias = `$${alias}__join${k}`;
      const joinMeta = through.model === undefined ? undefined : meta(through.model());
      const columnType = (column: string, fallback: FieldMeta): AnyFieldType | undefined =>
        joinMeta?.persisted.find((field) => field.column === column)?.type ?? fallback.type;
      const targetKey = step.to.fieldsByName.get(targetJoin.field) as FieldMeta;
      const ownerKey = step.from.fieldsByName.get(ownerJoin.field) as FieldMeta;
      const on: ExprNode[] = [
        binaryNode(
          "eq",
          rawColumn(joinAlias, targetJoin.column, columnType(targetJoin.column, targetKey)).node,
          columnNode(toAlias, targetKey.name, targetKey.column),
        ),
      ];
      const joinWhere = step.assoc.joinWhere;
      if (joinWhere !== undefined) {
        for (const column of Object.keys(joinWhere)) {
          const type = joinMeta?.persisted.find((field) => field.column === column)?.type;
          on.push(condition(rawColumn(joinAlias, column, type), joinWhere[column]));
        }
      }
      joins.push({
        kind: "join",
        type: "inner",
        source:
          joinMeta === undefined
            ? {
                kind: "table",
                source: through.source,
                meta: undefined,
                schema: through.schema,
                alias: joinAlias,
              }
            : tableOf(joinMeta, joinAlias),
        on: and2(on),
      });
      ownerSide = [rawColumn(joinAlias, ownerJoin.column, columnType(ownerJoin.column, ownerKey))];
    } else {
      ownerSide = fieldsOf(step.to, step.assoc.relatedKey).map((field) => new Col<unknown>(toAlias, field));
    }
    if (fromAlias === undefined) {
      keys = ownerSide.map((expr) => expr.node);
    } else {
      const fromKeys = fieldsOf(step.from, step.assoc.ownerKey);
      joins.push({
        kind: "join",
        type: "inner",
        source: tableOf(step.from, fromAlias),
        on: and2(
          ownerSide.map((expr, i) =>
            binaryNode(
              "eq",
              expr.node,
              columnNode(fromAlias, (fromKeys[i] as FieldMeta).name, (fromKeys[i] as FieldMeta).column),
            ),
          ),
        ),
      });
      toAlias = fromAlias;
    }
  }
  return {
    assoc,
    owner: ownerMeta,
    target,
    targetMeta,
    alias,
    cardinality,
    ownerFields,
    childFields: undefined,
    joins,
    keys,
    filters,
    mayRepeat: steps
      .slice(1)
      .some((step) => step.assoc.kind === "belongsTo" || step.assoc.kind === "manyToMany"),
  };
}

// ---------------------------------------------------------------------------
// Building query ASTs
// ---------------------------------------------------------------------------

/**
 * A copy of `base` with the given properties replaced, its `params`, `listLengths` and
 * `shape` recomputed (as the AST contract asks of hand-built queries).
 *
 * @example
 * ```ts
 * const limited = rebuild(query.ast, { limit: undefined });
 * ```
 */
export function rebuild(base: QueryAst, changes: Partial<QueryAst>): QueryAst {
  const has = (key: keyof QueryAst): boolean => Object.hasOwn(changes, key);
  const pick = <K extends keyof QueryAst>(key: K): QueryAst[K] =>
    has(key) ? (changes[key] as QueryAst[K]) : base[key];
  const draft: QueryAst = {
    kind: "query",
    from: pick("from"),
    joins: pick("joins"),
    wheres: pick("wheres"),
    select: pick("select"),
    distinct: pick("distinct"),
    groupBys: pick("groupBys"),
    havings: pick("havings"),
    orderBys: pick("orderBys"),
    limit: pick("limit"),
    offset: pick("offset"),
    lock: pick("lock"),
    combinations: pick("combinations"),
    ctes: pick("ctes"),
    windows: pick("windows"),
    preloads: pick("preloads"),
    updates: pick("updates"),
    schema: pick("schema"),
    hints: pick("hints"),
    params: NONE,
    listLengths: NONE,
    shape: 0,
  };
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

// ---------------------------------------------------------------------------
// assoc() and isLoaded()
// ---------------------------------------------------------------------------

/**
 * The schema class of a row: the class its prototype belongs to.
 *
 * @example
 * ```ts
 * schemaOfRow(user); // User
 * ```
 */
export function schemaOfRow(row: object): AnySchema | undefined {
  const owner = (Object.getPrototypeOf(row) as { readonly constructor?: unknown } | null)?.constructor;
  return isSchema(owner) ? owner : undefined;
}

/**
 * Checks that every element of `rows` is a row of `schema`, for `method`.
 *
 * @example
 * ```ts
 * checkRows("repo.preload()", User, users);
 * ```
 *
 * @throws TypeError when an element is not a row read from the database.
 * @throws QueryError when an element is a row of another schema.
 */
export function checkRows(method: string, schema: AnySchema, rows: readonly unknown[]): readonly object[] {
  const schemaMeta = meta(schema);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row !== "object" || row === null || !isRow(row)) {
      throw new TypeError(
        `${method} takes rows read from the database; ${rows.length === 1 ? "it was given" : `element ${i} is`} ${row === null ? "null" : typeof row === "object" ? "a plain object" : typeof row}.`,
      );
    }
    const own = schemaOfRow(row);
    if (own === undefined || meta(own) !== schemaMeta) {
      throw new QueryError(
        `${method} was given rows of ${schemaMeta.name}, but ${rows.length === 1 ? "the row" : `element ${i}`} is a row of ${own === undefined ? "no schema" : meta(own).name}. Rows of different schemas are preloaded in separate calls.`,
      );
    }
  }
  return rows as readonly object[];
}

/**
 * A query for the rows of association `name` of one parent or several: rooted at the
 * association's target, under the association's name as its alias, and filtered by the
 * parents' keys (and by the association's own `where`). It is an ordinary query: add
 * clauses, select, preload, and run it with any read.
 *
 * The schema class comes first because a row's type does not say which class it is an
 * instance of, and so which associations it has.
 *
 * @example
 * ```ts
 * const drafts = await repo.all(
 *   assoc(User, user, "posts").where(({ posts }) => posts.published.eq(false)),
 * );
 * const comments = await repo.all(assoc(Post, posts, "comments")); // the comments of every post
 * ```
 *
 * @throws TypeError when a parent is not a row read from the database.
 * @throws QueryError when a parent is a row of another schema, the schema has no such
 * association, or the association's target has no single-field primary key where one is
 * needed (a many-to-many or has-through association).
 */
export function assoc<S extends AnySchema, const K extends AssocKeys<S>>(
  schema: S,
  parents: Row<S> | readonly Row<S>[],
  name: K,
): PreloadQuery<S, K> {
  if (!isSchema(schema)) {
    throw new TypeError(
      'assoc() takes the schema class first, then a row or an array of rows, then the association: assoc(User, user, "posts").',
    );
  }
  const list = checkRows("assoc()", schema, Array.isArray(parents) ? parents : [parents]);
  const route = routeOf(meta(schema), name);
  const keys = keyTuples(list, route.ownerFields);
  const base = from(route.target, route.alias) as unknown as {
    where(fn: (bindings: Readonly<Record<string, Readonly<Record<string, AnyExpr>>>>) => AnyExpr): unknown;
  };
  if (route.childFields !== undefined) {
    const fields = route.childFields;
    return base.where((bindings) => {
      const binding = bindings[route.alias] as Readonly<Record<string, AnyExpr>>;
      const columns = fields.map((field) => binding[field.name] as AnyExpr);
      if (columns.length === 1) {
        return (columns[0] as AnyExpr).in(keys.map((key) => key[0]) as never) as AnyExpr;
      }
      if (keys.length === 0) return (columns[0] as AnyExpr).in([] as never) as AnyExpr;
      return or(
        ...keys.map((key) => and(...(columns.map((column, i) => column.eq(key[i] as never)) as never))),
      ) as AnyExpr;
    }) as PreloadQuery<S, K>;
  }
  // Many-to-many and has-through: the target's key is among those the parents reach. (A
  // many-to-many's target always has a single-field key; a has-through's may not.)
  const targetKey = route.targetMeta.primaryKey;
  if (targetKey.length !== 1) {
    throw new QueryError(
      `assoc(${meta(schema).name}, …, "${name}"): ${route.targetMeta.name} needs a primary key of exactly one field to be found through a has-through chain.`,
    );
  }
  const key = targetKey[0] as FieldMeta;
  const ownerField = route.ownerFields[0] as FieldMeta;
  const reached = (
    from(schema, "owner") as unknown as {
      where(fn: (bindings: Readonly<Record<string, Readonly<Record<string, AnyExpr>>>>) => AnyExpr): {
        joinAssoc(
          start: string,
          assoc: string,
          alias: string,
        ): {
          select(
            fn: (bindings: Readonly<Record<string, Readonly<Record<string, AnyExpr>>>>) => AnyExpr,
          ): unknown;
        };
      };
    }
  )
    .where(
      (bindings) =>
        ((bindings.owner as Readonly<Record<string, AnyExpr>>)[ownerField.name] as AnyExpr).in(
          keys.map((each) => each[0]) as never,
        ) as AnyExpr,
    )
    .joinAssoc("owner", name, "target")
    .select((bindings) => bindings.target?.[key.name] as AnyExpr);
  return base.where(
    (bindings) =>
      ((bindings[route.alias] as Readonly<Record<string, AnyExpr>>)[key.name] as AnyExpr).in(
        reached as never,
      ) as AnyExpr,
  ) as PreloadQuery<S, K>;
}

/** The distinct, complete key tuples of `rows` over `fields` (a tuple with a `null` part is left out). */
function keyTuples(rows: readonly object[], fields: readonly FieldMeta[]): unknown[][] {
  const index = new KeyIndex<true>(fields.map((field) => field.type));
  const out: unknown[][] = [];
  for (const row of rows) {
    const tuple = fields.map((field) => (row as Record<string, unknown>)[field.name]);
    if (tuple.some((value) => value === null || value === undefined)) continue;
    if (index.get(tuple) !== undefined) continue;
    index.set(tuple, true);
    out.push(tuple);
  }
  return out;
}

/**
 * Whether association `name` is loaded on `row`: a type guard that narrows the row to one
 * with the association, as a preload attaches it (an array, a row or `null`).
 *
 * @example
 * ```ts
 * if (isLoaded(User, user, "posts")) {
 *   user.posts.length; // typed
 * }
 * ```
 *
 * @throws QueryError when the schema has no association `name`.
 */
export function isLoaded<S extends AnySchema, R extends Row<S>, const K extends AssocKeys<S>>(
  schema: S,
  row: R,
  name: K,
): row is R & LoadedUnchecked<S, K> {
  routeOf(meta(schema), name);
  return typeof row === "object" && row !== null && ROW in row && Object.hasOwn(row, name);
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** The kinds whose values are compared as JavaScript primitives (`===`). */
const PRIMITIVE_KINDS: ReadonlySet<string> = new Set([
  "integer",
  "bigint",
  "float",
  "boolean",
  "text",
  "uuid",
]);
/** The kinds held in a `Date`, compared by their time. */
const DATE_KINDS: ReadonlySet<string> = new Set(["date", "timestamp", "timestamptz", "time"]);

/**
 * A map from key tuples to values. A key part of a type whose values are primitives is
 * looked up in a `Map`; a `Date` by its time; any other value (bytes, decimals, custom
 * types) is compared with its type's `equal`, in a list.
 *
 * @example
 * ```ts
 * const index = new KeyIndex<string>([integerType()]);
 * index.set([1], "one");
 * index.get([1]); // "one"
 * ```
 */
export class KeyIndex<V> {
  readonly #types: readonly AnyFieldType[];
  readonly #root: Level = newLevel();

  constructor(types: readonly AnyFieldType[]) {
    this.#types = types;
  }

  /** The value stored for `key`, or `undefined`. */
  get(key: readonly unknown[]): V | undefined {
    let level: Level | undefined = this.#root;
    for (let i = 0; i < key.length; i++) {
      const next: unknown = lookup(level, this.#types[i] as AnyFieldType, key[i], false);
      if (next === undefined) return undefined;
      if (i === key.length - 1) return next as V;
      level = next as Level;
    }
    return undefined;
  }

  /** Stores `value` for `key`. */
  set(key: readonly unknown[], value: V): void {
    let level = this.#root;
    for (let i = 0; i < key.length - 1; i++) {
      level = lookup(level, this.#types[i] as AnyFieldType, key[i], true) as Level;
    }
    store(level, this.#types[key.length - 1] as AnyFieldType, key[key.length - 1], value);
  }
}

interface Level {
  readonly map: Map<unknown, unknown>;
  readonly others: [unknown, unknown][];
}

function newLevel(): Level {
  return { map: new Map(), others: [] };
}

function primitiveOf(type: AnyFieldType, value: unknown): { readonly found: boolean; readonly key: unknown } {
  const kind = type.db.kind;
  if (PRIMITIVE_KINDS.has(kind) && typeof value !== "object") return { found: true, key: value };
  if (DATE_KINDS.has(kind) && value instanceof Date) return { found: true, key: value.getTime() };
  if (typeof value !== "object" && kind !== "decimal" && kind !== "custom")
    return { found: true, key: value };
  return { found: false, key: undefined };
}

function lookup(level: Level, type: AnyFieldType, value: unknown, create: boolean): unknown {
  const primitive = primitiveOf(type, value);
  if (primitive.found) {
    let next = level.map.get(primitive.key);
    if (next === undefined && create) {
      next = newLevel();
      level.map.set(primitive.key, next);
    }
    return next;
  }
  for (const [other, next] of level.others) if (type.equal(other, value)) return next;
  if (!create) return undefined;
  const next = newLevel();
  level.others.push([value, next]);
  return next;
}

function store(level: Level, type: AnyFieldType, value: unknown, stored: unknown): void {
  const primitive = primitiveOf(type, value);
  if (primitive.found) {
    level.map.set(primitive.key, stored);
    return;
  }
  for (const entry of level.others) {
    if (type.equal(entry[0], value)) {
      entry[1] = stored;
      return;
    }
  }
  level.others.push([value, stored]);
}
