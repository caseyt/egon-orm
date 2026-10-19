/**
 * What `subquery(q)` and `cte(name, shape)` have in common: the columns a query exposes
 * when another query reads it as a source, and the binding the callbacks of that query
 * receive.
 *
 * A source exposes one of two things:
 *
 * - **whole rows of a schema**, when the query selects nothing (its root's rows) or a whole
 *   binding. The binding is the schema's binding, so its columns are the schema's
 *   (`r.authorId`), and selecting it whole gives rows of the schema.
 * - **an object of values**, when the query selects an object of expressions. The binding
 *   has one column per key (`r.n`), typed like the selected value.
 *
 * Anything else (one bare value, nested objects, arrays) cannot be read as a source, and
 * is refused with a `QueryError` when the wrapper is made.
 *
 * The compiler names the output columns of a query read as a source so that this works: a
 * whole row by its column names, an object by its keys (`compiler/plan.ts`).
 *
 * @module
 */
import type { ExprNode, NamedParamNode, QueryAst, SourceNode } from "../../contracts/query.js";
import type { AnySchema, Row, SchemaMeta } from "../../contracts/schema.js";
import type { AnyFieldType } from "../../contracts/type.js";
import { QueryError } from "../../errors.js";
import { meta } from "../../schema/schema.js";
import { columnNode, shapeOfColumn } from "../ast.js";
import { type Binding, bindingOf } from "../bindings.js";
import {
  AS_SOURCE,
  type QueryLike,
  type QueryResult,
  type SourceOperand,
  type SourceParts,
} from "../builder.js";
import { Expr, NONE, type NoParams } from "../expr.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `T`, or `T | null` when `N` is `true`. */
type Nullify<T, N extends boolean> = [N] extends [true] ? T | null : T;

/**
 * The binding of a source that returns objects of values (a subquery or CTE whose query
 * selects an object of expressions): one expression per key, typed like the selected
 * value, nullable everywhere when `N` is `true` (the optional side of an outer join).
 * Selecting it whole gives the object of its values.
 *
 * @example
 * ```ts
 * from(subquery(postCounts), "c").where(({ c }) => c.n.gt(5)); // c: SubqueryBinding<{ authorId: number; n: number }>
 * ```
 */
export type SubqueryBinding<C, N extends boolean = false> = {
  readonly [K in keyof C]: Expr<Nullify<C[K], N>, NoParams>;
} & {
  /** Type information only: what selecting the binding whole gives. */
  readonly "~binding": { readonly row: { [K in keyof C]: Nullify<C[K], N> }; readonly nullable: false };
  /** Type information only: the binding on the optional side of an outer join. */
  readonly "~nullable": SubqueryBinding<C, true>;
};

/** Whether `A` and `B` are each assignable to the other. */
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The schema whose whole rows a query with bindings `B` returns as `R`, or `never`. */
type WholeSchemaOf<B, R> = {
  [K in keyof B]: B[K] extends {
    readonly $schema: infer S extends AnySchema;
    readonly "~binding": { readonly row: infer Rw; readonly nullable: false };
  }
    ? SameType<Rw, R> extends true
      ? S
      : never
    : never;
}[keyof B];

/** The schema a query's rows are whole rows of, or `never`. */
type RowSchemaOf<Q extends QueryLike> = WholeSchemaOf<Q["~query"]["bindings"], QueryResult<Q>>;

/** The values a non-schema source exposes: the query's result, when it is an object that is not an array or a date. */
type ObjectResult<R> = [R] extends [readonly unknown[] | Date | Uint8Array]
  ? never
  : [R] extends [object]
    ? [null] extends [R]
      ? never
      : R
    : never;

/**
 * The binding a query gives as a source: the schema's binding when it returns whole rows of
 * one, else a {@link SubqueryBinding} of the object it selects; `never` when it can be
 * neither.
 *
 * @example
 * ```ts
 * type B = SourceBindingOf<typeof postCounts>; // SubqueryBinding<{ authorId: number; n: number }>
 * ```
 */
export type SourceBindingOf<Q extends QueryLike> = [RowSchemaOf<Q>] extends [never]
  ? [ObjectResult<QueryResult<Q>>] extends [never]
    ? never
    : SubqueryBinding<ObjectResult<QueryResult<Q>>>
  : Binding<RowSchemaOf<Q>>;

/**
 * The row a query over the source returns when it selects nothing: a row of the schema, or
 * the object of values.
 *
 * @example
 * ```ts
 * type R = SourceRowOf<typeof postCounts>; // { authorId: number; n: number }
 * ```
 */
export type SourceRowOf<Q extends QueryLike> = [RowSchemaOf<Q>] extends [never]
  ? ObjectResult<QueryResult<Q>>
  : Row<RowSchemaOf<Q>>;

/**
 * Refuses, at compile time, a query that cannot be read as a source: one that selects
 * neither whole rows of a schema nor an object.
 *
 * @example
 * ```ts
 * declare function subquery<Q extends QueryLike>(query: Q & SourceCheck<Q>): unknown;
 * ```
 */
export type SourceCheck<Q extends QueryLike> = [SourceBindingOf<Q>] extends [never]
  ? {
      readonly "~error": "a query read as a source must select an object of expressions, or whole rows of a schema";
    }
  : unknown;

/**
 * A source made by `subquery(q)` or `cte(name, shape)`: what `from` and the joins take. `Bd`
 * is the binding the callbacks receive, `Rw` the row of a query over it that selects
 * nothing, `P` the named parameters it brings.
 *
 * @example
 * ```ts
 * const counts: Source<SubqueryBinding<{ n: number }>, { n: number }, NoParams> = subquery(postCounts);
 * ```
 */
export type Source<Bd, Rw, P> = SourceOperand<Bd, Rw, P>;

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** One column of a source that returns objects: its key, its output name, how values compared with it are bound. */
export interface SourceColumn {
  readonly key: string;
  readonly column: string;
  readonly type: AnyFieldType | undefined;
  readonly redact: boolean;
}

/**
 * What a query exposes as a source.
 *
 * @example
 * ```ts
 * const columns: SourceColumns = { kind: "row", meta: meta(User), schema: User };
 * ```
 */
export type SourceColumns =
  | { readonly kind: "row"; readonly meta: SchemaMeta; readonly schema: AnySchema }
  | { readonly kind: "object"; readonly columns: readonly SourceColumn[] };

/** The columns of every source node a wrapper made, so that a query over it can be read as a source again. */
const SOURCE_COLUMNS = new WeakMap<SourceNode, SourceColumns>();

/**
 * What a query that a `Query` object wraps exposes as a source, read from its AST and
 * its bindings.
 *
 * @example
 * ```ts
 * sourceColumns(postCounts, "subquery").kind; // "object"
 * ```
 *
 * @throws QueryError when the query selects something that cannot be read as a source,
 * or has preloads or `set(…)` assignments.
 */
export function sourceColumns(
  query: { readonly ast: QueryAst; schemaOf(alias: string): AnySchema | undefined },
  method: string,
): SourceColumns {
  const ast = query.ast;
  if (ast.preloads.length > 0) {
    throw new QueryError(
      `${method}(): the query has preloads, which a query read as a source cannot run: exclude("preload") first.`,
    );
  }
  if (ast.updates.length > 0) {
    throw new QueryError(
      `${method}(): the query has set(…) assignments, an update; only a query that reads can be a source.`,
    );
  }
  const select = ast.select;
  if (select === undefined) {
    const schema = query.schemaOf(ast.from.alias);
    if (schema !== undefined) return { kind: "row", meta: meta(schema), schema };
    const inner = SOURCE_COLUMNS.get(ast.from);
    if (inner !== undefined) return inner;
    throw refused(method, "the rows of a source that has no schema");
  }
  const shape = select.shape;
  if (shape.kind === "binding") {
    const schema = query.schemaOf(shape.binding);
    if (schema === undefined)
      throw refused(method, `the binding "${shape.binding}", which has no schema class`);
    return { kind: "row", meta: shape.meta, schema };
  }
  if (shape.kind !== "object") {
    throw refused(
      method,
      shape.kind === "expr" ? "one value" : shape.kind === "tuple" ? "an array" : "a plain value",
    );
  }
  const columns: SourceColumn[] = [];
  for (let i = 0; i < shape.keys.length; i++) {
    const key = shape.keys[i] as string;
    const value = shape.values[i] as (typeof shape.values)[number];
    if (value.kind !== "expr") {
      throw refused(
        method,
        `an object whose key "${key}" holds ${value.kind === "binding" ? "a whole binding" : value.kind === "constant" ? "a plain value" : "a nested object or array"}`,
      );
    }
    const expr = value.expr;
    const column = expr.kind === "selectedAs" && expr.expr !== undefined ? expr.name : key;
    columns.push({ key, column, type: value.type, redact: redactedValue(expr, ast) });
  }
  return { kind: "object", columns };
}

function refused(method: string, what: string): QueryError {
  return new QueryError(
    `${method}() reads a query as a source, so the query must select an object of expressions or whole rows of a schema; it selects ${what}.`,
  );
}

/** The aggregates whose value is not made of their argument's values. */
const COUNTING: ReadonlySet<string> = new Set([
  "count",
  "rowNumber",
  "rank",
  "denseRank",
  "percentRank",
  "cumeDist",
  "ntile",
]);
/** The functions and operators whose value is made of their arguments' values. */
const VALUE_FUNCTIONS: ReadonlySet<string> = new Set([
  "lower",
  "upper",
  "coalesce",
  "arrayAppend",
  "arrayRemove",
]);
const VALUE_OPERATORS: ReadonlySet<string> = new Set(["add", "sub", "mul", "div", "mod", "concat"]);

/**
 * Whether a selected value carries a redacted field's values, so that values compared with
 * the source's column are hidden from logs too: a redacted column (of a table, or of a
 * source that is redacted itself), a redacted parameter, or one of those under a
 * value-preserving function, operator or aggregate.
 */
function redactedValue(node: ExprNode, ast: QueryAst): boolean {
  switch (node.kind) {
    case "column":
      return redactedColumn(ast, node.binding, node.field, node.column);
    case "param":
    case "namedParam":
      return node.redact;
    case "cast":
    case "jsonPath":
      return redactedValue(node.expr, ast);
    case "unary":
      return node.op === "neg" && redactedValue(node.operand, ast);
    case "fn":
      return VALUE_FUNCTIONS.has(node.name) && node.args.some((arg) => redactedValue(arg, ast));
    case "binary":
      return (
        VALUE_OPERATORS.has(node.op) && (redactedValue(node.left, ast) || redactedValue(node.right, ast))
      );
    case "aggregate":
      return !COUNTING.has(node.name) && node.args[0] !== undefined && redactedValue(node.args[0], ast);
    case "case":
      return (
        node.whens.some((branch) => redactedValue(branch.result, ast)) ||
        (node.else !== undefined && redactedValue(node.else, ast))
      );
    case "selectedAs":
      return node.expr !== undefined && redactedValue(node.expr, ast);
    default:
      return false;
  }
}

function redactedColumn(ast: QueryAst, alias: string, field: string, column: string): boolean {
  let source: SourceNode | undefined;
  if (ast.from.alias === alias) source = ast.from;
  else for (const join of ast.joins) if (join.source.alias === alias) source = join.source;
  if (source === undefined) return false;
  const known = source.kind === "table" ? source.meta : undefined;
  if (known !== undefined) return known.fieldsByName.get(field)?.redact === true;
  const columns = SOURCE_COLUMNS.get(source);
  if (columns === undefined) return false;
  if (columns.kind === "row") return columns.meta.fieldsByName.get(field)?.redact === true;
  return columns.columns.some((entry) => entry.column === column && entry.redact);
}

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

/**
 * The source wrapper behind `subquery(q)` and `cte(name, shape)`: for each alias it is
 * used under, the source node, the binding, and the parameters it brings.
 *
 * @example
 * ```ts
 * new SourceWrapper((alias) => ({ kind: "cteSource", name: "tree", meta: undefined, alias }), columns, NONE, NONE, NONE);
 * ```
 */
export class SourceWrapper<Bd, Rw, P> implements Source<Bd, Rw, P> {
  /** Type information only; there is no such property at run time. */
  declare readonly "~source": {
    readonly binding: Bd;
    readonly row: Rw;
    readonly params: (params: P) => void;
  };
  readonly #node: (alias: string) => SourceNode;
  readonly #columns: SourceColumns;
  readonly #params: readonly unknown[];
  readonly #lists: readonly number[];
  readonly #named: readonly NamedParamNode[];
  /** The bindings of an object source, one per alias. */
  readonly #bindings = new Map<string, object>();

  /**
   * Internal: made by `subquery` and `cte`.
   *
   * @example
   * ```ts
   * new SourceWrapper(node, columns, ast.params, ast.listLengths, query.named);
   * ```
   */
  constructor(
    node: (alias: string) => SourceNode,
    columns: SourceColumns,
    params: readonly unknown[],
    lists: readonly number[],
    named: readonly NamedParamNode[],
  ) {
    this.#node = node;
    this.#columns = columns;
    this.#params = params;
    this.#lists = lists;
    this.#named = named;
  }

  /**
   * The parts of this source under `alias`, for `from` and the joins.
   *
   * @example
   * ```ts
   * subquery(postCounts)[AS_SOURCE]("c").node.kind; // "subquerySource"
   * ```
   */
  [AS_SOURCE](alias: string): SourceParts {
    const node = this.#node(alias);
    const columns = this.#columns;
    SOURCE_COLUMNS.set(node, columns);
    return {
      node,
      binding:
        columns.kind === "row" ? bindingOf(columns.meta, columns.schema, alias) : this.#objectBinding(alias),
      meta: columns.kind === "row" ? columns.meta : undefined,
      params: this.#params,
      lists: this.#lists,
      named: this.#named,
    };
  }

  /** The binding of an object source under `alias`: one column expression per key, frozen and kept. */
  #objectBinding(alias: string): object {
    let binding = this.#bindings.get(alias);
    if (binding === undefined) {
      const built: Record<string, unknown> = {};
      const columns = (this.#columns as Extract<SourceColumns, { kind: "object" }>).columns;
      for (const column of columns) {
        built[column.key] = new Expr(
          columnNode(alias, column.key, column.column),
          column.type,
          column.redact,
          NONE,
          NONE,
          NONE,
          shapeOfColumn(alias, column.column),
        );
      }
      binding = Object.freeze(built);
      this.#bindings.set(alias, binding);
    }
    return binding;
  }
}
