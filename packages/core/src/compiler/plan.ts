/**
 * The half of compiling a query that writes no SQL: which bindings a query has (its
 * scope), which database schema each table resolves to, and what the select list holds
 * and returns (the {@link OutputPlan}, with an output alias per column).
 *
 * The emitter (`emit.ts`) asks this module for the select list of every query it writes,
 * and asks it, before writing a query, for the output of each subquery or CTE the query
 * reads from: a binding over a subquery is read through the subquery's own output columns.
 *
 * ## Database schemas
 *
 * One function, {@link resolveTableSchema}, decides the database schema of a table source:
 * `source.schema ?? meta.schema ?? query schema`, where the query schema is the nearest
 * enclosing query's own (else the `schema` argument of `compile`), handed down as
 * `inherited`. Every `row` leaf of an output plan takes the resolved database schema of
 * the table its rows come from, and a leaf built from an inner leaf (a subquery or a CTE)
 * copies the inner leaf's ("Database schemas" on `Adapter` in `contracts/adapter.ts`).
 *
 * ## Output aliases
 *
 * A statement names its output columns `c0`, `c1`, … in select-list order (a
 * `selectedAs(…)` item keeps its own name). A query read as a **source** (a subquery in
 * `from` or a join, or a CTE body) names them so that the outer query can refer to them:
 * the columns of a whole row by their column names, the values of a top-level object by
 * their keys, anything else `c<position>`. Two output columns with one name are refused.
 *
 * @module
 */
import type { OutputPlan, OutputPreload } from "../contracts/adapter.js";
import type {
  CteNode,
  ExprNode,
  PreloadNode,
  QueryAst,
  QueryOperation,
  SelectShape,
  SourceNode,
} from "../contracts/query.js";
import type { SchemaMeta } from "../contracts/schema.js";
import { META } from "../contracts/schema.js";
import type { AnyFieldType } from "../contracts/type.js";
import { QueryError } from "../errors.js";

/**
 * A `row` leaf of an {@link OutputPlan}.
 *
 * @example
 * ```ts
 * declare const plan: OutputPlan;
 * const row: RowLeaf | undefined = plan.kind === "row" ? plan : undefined;
 * ```
 */
export type RowLeaf = Extract<OutputPlan, { readonly kind: "row" }>;

/**
 * How a query names its output columns: `"statement"` (`c0`, `c1`, …; also scalar and
 * `IN` subqueries) or `"source"` (names an outer query can refer to). `"exists"` names
 * them as a statement does, but a query with no select returns no columns at all
 * (`EXISTS (SELECT 1 …)`), since nothing reads them.
 *
 * @example
 * ```ts
 * const mode: AliasMode = "source";
 * ```
 */
export type AliasMode = "statement" | "source" | "exists";

/**
 * One binding of a query: what its alias stands for.
 *
 * @example
 * ```ts
 * declare const scope: Scope;
 * scope.bindings.get("u")?.table; // true for `from(User, "u")`
 * ```
 */
export interface BindingEntry {
  readonly alias: string;
  /** The schema of the rows the binding yields, when it has one. */
  readonly meta: SchemaMeta | undefined;
  /** The database schema its rows come from: a table's resolved one, an inner leaf's, else `meta.schema`. */
  readonly schema: string | undefined;
  /** For a subquery or CTE whose output is whole rows: that leaf, whose aliases are the binding's columns. */
  readonly inner: RowLeaf | undefined;
  /** Whether the binding is a table (its columns are the table's). */
  readonly table: boolean;
  /** On the optional side of an outer join (or its inner leaf is). */
  nullable: boolean;
}

/**
 * A common table expression visible to a query.
 *
 * @example
 * ```ts
 * declare const scope: Scope;
 * scope.ctes.get("tree")?.output;
 * ```
 */
export interface CteEntry {
  readonly name: string;
  /** What the CTE's body returns; `undefined` for a fragment body, or while a recursive body is being read. */
  output: OutputPlan | undefined;
}

/**
 * The names a query can refer to: its own bindings and CTEs, then those of the queries
 * around it.
 *
 * @example
 * ```ts
 * const scope = newScope(undefined);
 * ```
 */
export interface Scope {
  readonly parent: Scope | undefined;
  readonly bindings: Map<string, BindingEntry>;
  readonly ctes: Map<string, CteEntry>;
}

/**
 * An empty scope nested in `parent`.
 *
 * @example
 * ```ts
 * const inner = newScope(outer);
 * ```
 */
export function newScope(parent: Scope | undefined): Scope {
  return { parent, bindings: new Map(), ctes: new Map() };
}

/**
 * Whether `alias` names a binding of this query or of a query around it.
 *
 * @example
 * ```ts
 * hasBinding(scope, "u");
 * ```
 */
export function hasBinding(scope: Scope | undefined, alias: string): boolean {
  for (let s = scope; s !== undefined; s = s.parent) if (s.bindings.has(alias)) return true;
  return false;
}

/**
 * The CTE called `name`, visible from `scope`.
 *
 * @example
 * ```ts
 * findCte(scope, "tree");
 * ```
 */
export function findCte(scope: Scope | undefined, name: string): CteEntry | undefined {
  for (let s = scope; s !== undefined; s = s.parent) {
    const entry = s.ctes.get(name);
    if (entry !== undefined) return entry;
  }
  return undefined;
}

/**
 * The database schema a table source is read from (rule 1 of "Database schemas"): the
 * source's own, else the one its schema declares, else the query's (`querySchema`, which
 * is already the nearest enclosing query's or the `compile` argument).
 *
 * @example
 * ```ts
 * resolveTableSchema(undefined, userMeta, "tenant_1"); // userMeta.schema ?? "tenant_1"
 * ```
 */
export function resolveTableSchema(
  sourceSchema: string | undefined,
  meta: SchemaMeta | undefined,
  querySchema: string | undefined,
): string | undefined {
  return sourceSchema ?? meta?.schema ?? querySchema;
}

/**
 * What a query with a select list returns: the select items in order, and the output plan.
 *
 * @example
 * ```ts
 * const { items, output } = planSelect(ast, scope, "all", "statement");
 * ```
 */
export interface PlannedSelect {
  readonly items: readonly SelectItem[];
  readonly output: OutputPlan | undefined;
}

/**
 * One entry of a select list (or a `RETURNING` list): an expression, or a column of a
 * binding, and the output name it gets.
 *
 * @example
 * ```ts
 * const item: SelectItem = { kind: "column", binding: "u", column: "email", alias: "c1" };
 * ```
 */
export type SelectItem =
  | { readonly kind: "expr"; readonly expr: ExprNode; readonly alias: string }
  | { readonly kind: "column"; readonly binding: string; readonly column: string; readonly alias: string };

interface Planner {
  readonly mode: AliasMode;
  readonly scope: Scope;
  readonly items: SelectItem[];
  readonly names: Set<string>;
}

function addItem(p: Planner, item: SelectItem): void {
  if (p.names.has(item.alias)) {
    throw new QueryError(
      `The select list has two output columns named "${item.alias}". Give one of them another name.`,
    );
  }
  p.names.add(item.alias);
  p.items.push(item);
}

function positional(p: Planner): string {
  return `c${p.items.length}`;
}

/**
 * Registers the bindings of `ast` (its root and its joins) in `scope`, marks the ones on
 * the optional side of an outer join as nullable, and resolves the database schema of each
 * table. A subquery source is planned (not written) here, so that its binding knows its
 * output.
 *
 * @example
 * ```ts
 * const scope = newScope(undefined);
 * bindSources(scope, ast, "tenant_1");
 * ```
 *
 * @throws QueryError when an alias is used twice or a CTE source names no CTE.
 */
export function bindSources(scope: Scope, ast: QueryAst, querySchema: string | undefined): void {
  bindSource(scope, ast.from, false, querySchema);
  for (const join of ast.joins) {
    const type = join.type;
    if (type === "right" || type === "full") {
      for (const entry of scope.bindings.values()) entry.nullable = true;
    }
    bindSource(scope, join.source, type === "left" || type === "leftLateral" || type === "full", querySchema);
  }
}

function bindSource(
  scope: Scope,
  source: SourceNode,
  nullable: boolean,
  querySchema: string | undefined,
): void {
  const alias = source.alias;
  if (typeof alias !== "string" || alias === "") throw new QueryError("A source has no alias.");
  if (scope.bindings.has(alias)) {
    throw new QueryError(`The alias "${alias}" names two sources of one query; give each its own alias.`);
  }
  let entry: BindingEntry;
  switch (source.kind) {
    case "table":
      entry = {
        alias,
        meta: source.meta,
        schema: resolveTableSchema(source.schema, source.meta, querySchema),
        inner: undefined,
        table: true,
        nullable,
      };
      break;
    case "cteSource": {
      const cte = findCte(scope, source.name);
      if (cte === undefined) {
        throw new QueryError(
          `The source "${alias}" reads the CTE "${source.name}", which the query does not define.`,
        );
      }
      entry = innerEntry(alias, source.meta, cte.output, nullable, `the CTE "${source.name}"`);
      break;
    }
    case "subquerySource": {
      const planned = planQuery(source.query, scope, querySchema, "all", "source", undefined);
      entry = innerEntry(alias, undefined, planned.output, nullable, "its subquery");
      break;
    }
    case "values":
    case "fragmentSource":
      entry = { alias, meta: undefined, schema: undefined, inner: undefined, table: false, nullable };
      break;
    default:
      throw new QueryError(`Unknown source kind "${String((source as { kind: unknown }).kind)}".`);
  }
  scope.bindings.set(alias, entry);
}

function innerEntry(
  alias: string,
  declared: SchemaMeta | undefined,
  output: OutputPlan | undefined,
  nullable: boolean,
  what: string,
): BindingEntry {
  const inner = output?.kind === "row" ? output : undefined;
  if (inner !== undefined && declared !== undefined && inner.meta !== declared) {
    throw new QueryError(
      `The source "${alias}" is declared with the schema ${declared.name}, but ${what} selects rows of ${inner.meta.name}.`,
    );
  }
  const meta = declared ?? inner?.meta;
  return {
    alias,
    meta,
    schema: inner === undefined ? meta?.schema : inner.schema,
    inner,
    table: false,
    nullable: nullable || (inner?.nullable ?? false),
  };
}

/**
 * Registers the CTEs of `ast` in `scope`, planning each body (without writing it). A
 * recursive CTE is visible inside its own body, as the rows of the body's first branch.
 *
 * @example
 * ```ts
 * planCtes(scope, ast, undefined);
 * ```
 */
export function planCtes(scope: Scope, ast: QueryAst, querySchema: string | undefined): void {
  for (const cte of ast.ctes) {
    const entry = cteEntry(scope, cte);
    if (cte.query.kind === "query") {
      const planned = planQuery(cte.query, scope, querySchema, cte.operation, "source", (output) => {
        entry.output = output;
      });
      entry.output = planned.output;
    }
    scope.ctes.set(cte.name, entry);
  }
}

/**
 * A new entry for `cte`. A recursive CTE's entry is added to `scope` at once, since its
 * body refers to itself; any other is added by the caller once its body is read, so that
 * the body cannot see it. The caller sets `output`.
 *
 * @example
 * ```ts
 * const entry = cteEntry(scope, cte);
 * ```
 *
 * @throws QueryError when the name is used twice in one query.
 */
export function cteEntry(scope: Scope, cte: CteNode): CteEntry {
  if (typeof cte.name !== "string" || cte.name === "") throw new QueryError("A CTE has no name.");
  if (scope.ctes.has(cte.name)) {
    throw new QueryError(`The CTE name "${cte.name}" is used twice in one query.`);
  }
  const entry: CteEntry = { name: cte.name, output: undefined };
  if (cte.recursive) scope.ctes.set(cte.name, entry);
  return entry;
}

/**
 * Plans a whole query without writing it: its scope, select list and output, with the
 * output of its set-operation branches folded in (a row leaf keeps a database schema only
 * when every branch agrees on it). `onMain` is called with the output of the query itself,
 * before the branches are planned (a recursive CTE's rows are those of its first branch).
 *
 * @example
 * ```ts
 * const { output } = planQuery(ast, undefined, "tenant_1", "all", "statement", undefined);
 * ```
 */
export function planQuery(
  ast: QueryAst,
  parent: Scope | undefined,
  inherited: string | undefined,
  operation: QueryOperation,
  mode: AliasMode,
  onMain: ((output: OutputPlan | undefined) => void) | undefined,
): PlannedSelect & { readonly scope: Scope } {
  const querySchema = ast.schema ?? inherited;
  const scope = newScope(parent);
  planCtes(scope, ast, querySchema);
  bindSources(scope, ast, querySchema);
  const planned = planSelect(ast, scope, operation, mode);
  onMain?.(planned.output);
  let output = planned.output;
  for (const combination of ast.combinations) {
    const branch = planQuery(combination.query, scope, querySchema, "all", mode, undefined);
    output = mergeProvenance(output, branch.output);
  }
  return { scope, items: planned.items, output };
}

/**
 * The select list and output plan of `ast` (its `RETURNING` list for `updateAll` and
 * `deleteAll`). With no `select`, a query returns the whole rows of its root binding,
 * with its preloads; an update or delete returns nothing.
 *
 * @example
 * ```ts
 * planSelect(ast, scope, "all", "statement").items.length;
 * ```
 *
 * @throws QueryError when the select names an unknown binding, two output columns share a
 * name, or preloads are declared on a query that does not return its root rows.
 */
export function planSelect(
  ast: QueryAst,
  scope: Scope,
  operation: QueryOperation,
  mode: AliasMode,
): PlannedSelect {
  const p: Planner = { mode, scope, items: [], names: new Set() };
  const root = ast.from.alias;
  const select = ast.select;
  if (select === undefined) {
    if (operation !== "all" || mode === "exists") return { items: p.items, output: undefined };
    const entry = scope.bindings.get(root);
    if (entry?.meta === undefined) {
      throw new QueryError(
        `The query has no select, and its root binding "${root}" has no schema to read rows of. Add a select.`,
      );
    }
    return { items: p.items, output: rowLeaf(p, root, entry.meta, ast.preloads) };
  }
  const shape = select.shape;
  const preloadsHere = shape.kind === "binding" && shape.binding === root;
  if (ast.preloads.length > 0 && !preloadsHere) {
    throw new QueryError(
      "A query with preloads must return the whole rows of its root binding; its select returns something else.",
    );
  }
  const output = planShape(p, shape, preloadsHere ? ast.preloads : [], true);
  return { items: p.items, output };
}

function planShape(
  p: Planner,
  shape: SelectShape,
  preloads: readonly PreloadNode[],
  top: boolean,
): OutputPlan {
  switch (shape.kind) {
    case "expr":
      return planExpr(p, shape.expr, shape.type, undefined);
    case "binding":
      return rowLeaf(p, shape.binding, shape.meta, preloads);
    case "constant":
      return { kind: "constant", index: shape.index };
    case "object": {
      if (shape.keys.length !== shape.values.length) {
        throw new QueryError("A select object has a different number of keys and values.");
      }
      const values: OutputPlan[] = [];
      for (let i = 0; i < shape.values.length; i++) {
        const value = shape.values[i] as SelectShape;
        const key = top && p.mode === "source" && value.kind === "expr" ? shape.keys[i] : undefined;
        values.push(
          value.kind === "expr" ? planExpr(p, value.expr, value.type, key) : planShape(p, value, [], false),
        );
      }
      return { kind: "object", keys: shape.keys, values };
    }
    case "tuple": {
      const items: OutputPlan[] = [];
      for (const item of shape.items) items.push(planShape(p, item, [], false));
      return { kind: "tuple", items };
    }
    default:
      throw new QueryError(`Unknown select shape "${String((shape as { kind: unknown }).kind)}".`);
  }
}

function planExpr(
  p: Planner,
  expr: ExprNode,
  type: AnyFieldType | undefined,
  key: string | undefined,
): OutputPlan {
  let node = expr;
  let alias: string;
  if (expr.kind === "selectedAs") {
    if (expr.expr === undefined) {
      throw new QueryError(
        `selectedAs("${expr.name}") without an expression refers to a selected value; it cannot be selected itself.`,
      );
    }
    node = expr.expr;
    alias = expr.name;
  } else {
    alias = key ?? positional(p);
  }
  addItem(p, { kind: "expr", expr: node, alias });
  return { kind: "value", alias, type };
}

/**
 * The `row` leaf for the whole rows of binding `alias`, adding one select item per
 * persisted field and then the columns of its join preloads.
 */
function rowLeaf(p: Planner, alias: string, meta: SchemaMeta, preloads: readonly PreloadNode[]): RowLeaf {
  const entry = p.scope.bindings.get(alias);
  if (entry === undefined) {
    throw new QueryError(`The select returns the whole binding "${alias}", which the query does not have.`);
  }
  if (entry.meta !== meta) {
    throw new QueryError(
      `The select returns "${alias}" as rows of ${meta.name}, but that binding yields ${entry.meta === undefined ? "no schema's rows" : `rows of ${entry.meta.name}`}.`,
    );
  }
  const persisted = meta.persisted;
  const aliases: string[] = [];
  for (let i = 0; i < persisted.length; i++) {
    const field = persisted[i] as (typeof persisted)[number];
    const column = entry.inner === undefined ? field.column : (entry.inner.aliases[i] as string);
    const name = p.mode === "source" ? field.column : positional(p);
    addItem(p, { kind: "column", binding: alias, column, alias: name });
    aliases.push(name);
  }
  const key: string[] = [];
  for (const field of meta.primaryKey) key.push(aliases[persisted.indexOf(field)] as string);
  const children: OutputPreload[] = [];
  for (const preload of preloads) children.push(outputPreload(p, meta, preload));
  return {
    kind: "row",
    meta,
    aliases,
    key,
    schema: entry.schema,
    nullable: entry.nullable,
    preloads: children,
  };
}

function outputPreload(p: Planner, owner: SchemaMeta, node: PreloadNode): OutputPreload {
  const assoc = owner.assocs().get(node.assoc);
  if (assoc === undefined) {
    throw new QueryError(`${owner.name} has no association "${node.assoc}" to preload.`);
  }
  const cardinality = assoc.kind === "hasMany" || assoc.kind === "manyToMany" ? "many" : "one";
  if (node.from === undefined) return { assoc: node.assoc, cardinality, row: undefined };
  const target = assoc.target()[META];
  return { assoc: node.assoc, cardinality, row: rowLeaf(p, node.from, target, node.nested) };
}

/**
 * The output of a set operation: `main`'s, where a row leaf keeps its database schema only
 * if `branch` has the same one at the same place; otherwise the leaf takes its schema's
 * declared database schema (no single origin).
 *
 * @example
 * ```ts
 * mergeProvenance(mainOutput, branchOutput);
 * ```
 */
export function mergeProvenance(
  main: OutputPlan | undefined,
  branch: OutputPlan | undefined,
): OutputPlan | undefined {
  if (main === undefined || branch === undefined) return main;
  switch (main.kind) {
    case "row": {
      if (branch.kind !== "row" || branch.meta !== main.meta) return main;
      const preloads = mergePreloads(main.preloads, branch.preloads);
      if (branch.schema === main.schema && preloads === main.preloads) return main;
      return {
        kind: "row",
        meta: main.meta,
        aliases: main.aliases,
        key: main.key,
        schema: branch.schema === main.schema ? main.schema : main.meta.schema,
        nullable: main.nullable || branch.nullable,
        preloads,
      };
    }
    case "object": {
      if (branch.kind !== "object" || branch.values.length !== main.values.length) return main;
      return {
        kind: "object",
        keys: main.keys,
        values: main.values.map((value, i) => mergeProvenance(value, branch.values[i]) as OutputPlan),
      };
    }
    case "tuple": {
      if (branch.kind !== "tuple" || branch.items.length !== main.items.length) return main;
      return {
        kind: "tuple",
        items: main.items.map((item, i) => mergeProvenance(item, branch.items[i]) as OutputPlan),
      };
    }
    default:
      return main;
  }
}

function mergePreloads(
  main: readonly OutputPreload[],
  branch: readonly OutputPreload[],
): readonly OutputPreload[] {
  if (main.length === 0 || main.length !== branch.length) return main;
  let changed = false;
  const merged = main.map((preload, i) => {
    const other = branch[i] as OutputPreload;
    const row = mergeProvenance(preload.row, other.row);
    if (row === preload.row) return preload;
    changed = true;
    return { assoc: preload.assoc, cardinality: preload.cardinality, row };
  });
  return changed ? merged : main;
}
