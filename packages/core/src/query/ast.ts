/**
 * The query AST: one constructor per expression node, the canonical walk that collects a
 * tree's parameter values ({@link collectParams}) and the structural hash ({@link shapeOf}).
 *
 * The node interfaces themselves are the contract in `contracts/query.ts`; this module
 * re-exports them so that the query modules have one place to import from. Every node is
 * a plain object literal whose properties are assigned in the order its interface declares
 * them (rule 4 of the contract), which is why nodes should be made with these
 * constructors rather than written out by hand.
 *
 * ## The SQL each expression node stands for
 *
 * | Node | SQL |
 * |---|---|
 * | `column` | `"u"."created_at"` |
 * | `param` | `$1`: one bound value |
 * | `namedParam` | `$1`, its value supplied by name at execution |
 * | `list` | `= ANY($1)` (one array parameter), or `IN ($1, $2, …)` where the dialect expands lists |
 * | `literal` | `NULL`, `TRUE`, `FALSE` or a finite number, written into the text |
 * | `unary` | `NOT x`, `-x`, `x IS NULL`, `x IS NOT NULL` |
 * | `binary` | `x = y`, `x <> y`, `x < y`, `x LIKE y`, `x \|\| y`, `x + y`, `x @> y`, `y = ANY(x)` (`has`), … |
 * | `between` | `x BETWEEN low AND high` |
 * | `nary` | `a AND b AND …`, `a OR b OR …` |
 * | `fn` | `lower(x)`, `coalesce(a, b)`, `now()`, `array_append(a, x)`: a name from {@link FUNCTION_NAMES} |
 * | `aggregate` | `count(DISTINCT x) FILTER (WHERE c) OVER (…)`: a name from {@link AGGREGATE_NAMES} |
 * | `ident` | `"search_vector"`: a validated, quoted identifier inside a fragment |
 * | `fragment` | the static strings of a `fragment` template, with its interpolations |
 * | `cast` | `CAST(x AS integer)` |
 * | `case` | `CASE WHEN c THEN v … ELSE e END` |
 * | `jsonPath` | `x #> path` / `x #>> path` (`->` / `->>` per key where the dialect has no path operator) |
 * | `subquery` | `(SELECT …)` |
 * | `exists` | `EXISTS (SELECT …)` |
 * | `tuple` | `(a, b)` |
 * | `selectedAs` | `x AS "name"` in the select list, `"name"` in `GROUP BY` / `ORDER BY` |
 * | `star` | `*`, as in `count(*)` |
 * | `order` | `x DESC NULLS LAST` |
 * | `window` | `PARTITION BY … ORDER BY … [frame]` |
 *
 * @module
 */
import type {
  AggregateNode,
  BetweenNode,
  BinaryNode,
  BinaryOp,
  CaseNode,
  CastNode,
  ColumnNode,
  ExistsNode,
  ExprNode,
  FnNode,
  FragmentNode,
  IdentNode,
  JsonPathNode,
  ListNode,
  LiteralNode,
  NamedParamNode,
  NaryNode,
  OrderNode,
  ParamNode,
  QueryAst,
  QueryNode,
  SelectedAsNode,
  SelectShape,
  StarNode,
  SubqueryNode,
  TupleNode,
  UnaryNode,
  UnaryOp,
  WindowNode,
} from "../contracts/query.js";
import type { AnyFieldType } from "../contracts/type.js";
import { QueryError } from "../errors.js";
import { HASH_SEED, hashInt, hashString } from "../internal/hash.js";
import { OUTER_REFS } from "./advanced/outer-refs.js";

export type {
  AggregateNode,
  BetweenNode,
  BinaryNode,
  BinaryOp,
  BoolNode,
  CaseNode,
  CastNode,
  ClauseNode,
  ColumnNode,
  CombinationNode,
  CteNode,
  CteSourceNode,
  DistinctNode,
  ExistsNode,
  ExprKind,
  ExprNode,
  FnNode,
  FragmentNode,
  FragmentSourceNode,
  IdentNode,
  JoinNode,
  JoinType,
  JsonPathNode,
  ListNode,
  LiteralNode,
  LockNode,
  NamedParamNode,
  NaryNode,
  OrderNode,
  ParamNode,
  PreloadNode,
  QueryAst,
  QueryNode,
  QueryOperation,
  SelectedAsNode,
  SelectNode,
  SelectShape,
  SourceNode,
  StarNode,
  SubqueryNode,
  SubquerySourceNode,
  TableSourceNode,
  TupleNode,
  UnaryNode,
  UnaryOp,
  UpdateNode,
  ValuesSourceNode,
  WindowDefNode,
  WindowNode,
} from "../contracts/query.js";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * What a dynamic identifier must match: `fragment.ident(name)` checks it when the node is
 * made, and the compiler quotes it.
 *
 * @example
 * ```ts
 * IDENTIFIER.test("search_vector"); // true
 * IDENTIFIER.test("name; drop table users"); // false
 * ```
 */
export const IDENTIFIER: RegExp = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * The names an expression puts in a {@link FnNode}. Each is a key of the compiler's
 * function table, not SQL text: `arrayAppend` is `array_append` on Postgres.
 *
 * | Name | SQL (Postgres) |
 * |---|---|
 * | `lower`, `upper` | `lower(x)`, `upper(x)` |
 * | `coalesce` | `coalesce(a, b, …)` |
 * | `now` | `now()` |
 * | `arrayAppend`, `arrayRemove` | `array_append(a, x)`, `array_remove(a, x)` |
 *
 * @example
 * ```ts
 * FUNCTION_NAMES.includes("coalesce"); // true
 * ```
 */
export const FUNCTION_NAMES = ["lower", "upper", "coalesce", "now", "arrayAppend", "arrayRemove"] as const;

/**
 * The names an expression puts in an {@link AggregateNode}, keys of the compiler's
 * aggregate table: `count`, `sum`, `avg`, `min`, `max`, `arrayAgg` (`array_agg`),
 * `jsonAgg` (`json_agg`) and `stringAgg` (`string_agg`).
 *
 * @example
 * ```ts
 * AGGREGATE_NAMES.includes("stringAgg"); // true
 * ```
 */
export const AGGREGATE_NAMES = [
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "arrayAgg",
  "jsonAgg",
  "stringAgg",
] as const;

/**
 * A name from {@link FUNCTION_NAMES}.
 *
 * @example
 * ```ts
 * const name: FunctionName = "lower";
 * ```
 */
export type FunctionName = (typeof FUNCTION_NAMES)[number];

/**
 * A name from {@link AGGREGATE_NAMES}.
 *
 * @example
 * ```ts
 * const name: AggregateName = "count";
 * ```
 */
export type AggregateName = (typeof AGGREGATE_NAMES)[number];

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * `"u"."created_at"`.
 *
 * @example
 * ```ts
 * columnNode("u", "createdAt", "created_at");
 * ```
 */
export function columnNode(binding: string, field: string, column: string): ColumnNode {
  return { kind: "column", binding, field, column };
}

/**
 * `$1`: a bound value, dumped with `type` when there is one.
 *
 * @example
 * ```ts
 * paramNode(18, integerType(), false);
 * ```
 */
export function paramNode(value: unknown, type: AnyFieldType | undefined, redact: boolean): ParamNode {
  return { kind: "param", value, type, redact };
}

/**
 * `$1`, supplied by name at execution.
 *
 * @example
 * ```ts
 * namedParamNode("minAge", integerType(), false);
 * ```
 */
export function namedParamNode(
  name: string,
  type: AnyFieldType | undefined,
  redact: boolean,
): NamedParamNode {
  return { kind: "namedParam", name, type, redact };
}

/**
 * `= ANY($1)` or `IN ($1, $2, …)`: one bound array. `type` is the element type.
 *
 * @example
 * ```ts
 * listNode(["admin", "member"], undefined, false);
 * ```
 */
export function listNode(
  value: readonly unknown[],
  type: AnyFieldType | undefined,
  redact: boolean,
): ListNode {
  return { kind: "list", value, type, redact };
}

/**
 * `NULL`, `TRUE`, `FALSE` or a number, written into the SQL text.
 *
 * @example
 * ```ts
 * literalNode(true);
 * ```
 *
 * @throws QueryError when `value` is not `null`, a boolean or a finite number.
 */
export function literalNode(value: null | boolean | number): LiteralNode {
  if (!isLiteral(value)) {
    throw new QueryError(
      "query.litValue",
      "lit() takes true, false, null or a finite number, which are written into the SQL.",
    );
  }
  return { kind: "literal", value };
}

function isLiteral(value: unknown): value is null | boolean | number {
  return (
    value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * `NOT x`, `-x`, `x IS NULL`, `x IS NOT NULL`.
 *
 * @example
 * ```ts
 * unaryNode("isNull", columnNode("u", "name", "name"));
 * ```
 */
export function unaryNode(op: UnaryOp, operand: ExprNode): UnaryNode {
  return { kind: "unary", op, operand };
}

/**
 * `left <op> right`.
 *
 * @example
 * ```ts
 * binaryNode("gte", columnNode("u", "age", "age"), paramNode(18, undefined, false));
 * ```
 */
export function binaryNode(op: BinaryOp, left: ExprNode, right: ExprNode): BinaryNode {
  return { kind: "binary", op, left, right };
}

/**
 * `expr BETWEEN low AND high`.
 *
 * @example
 * ```ts
 * betweenNode(columnNode("u", "age", "age"), paramNode(18, undefined, false), paramNode(65, undefined, false));
 * ```
 */
export function betweenNode(expr: ExprNode, low: ExprNode, high: ExprNode): BetweenNode {
  return { kind: "between", expr, low, high };
}

/**
 * `a AND b AND …` or `a OR b OR …`.
 *
 * @example
 * ```ts
 * naryNode("and", [a, b]);
 * ```
 */
export function naryNode(op: "and" | "or", args: readonly ExprNode[]): NaryNode {
  return { kind: "nary", op, args };
}

/**
 * `name(args…)`, `name` from the compiler's function table.
 *
 * @example
 * ```ts
 * fnNode("lower", [columnNode("u", "email", "email")]);
 * ```
 */
export function fnNode(name: string, args: readonly ExprNode[]): FnNode {
  return { kind: "fn", name, args };
}

/**
 * `name([DISTINCT] args…) [FILTER (WHERE filter)] [OVER over]`.
 *
 * @example
 * ```ts
 * aggregateNode("count", [STAR], false, undefined, undefined);
 * ```
 */
export function aggregateNode(
  name: string,
  args: readonly ExprNode[],
  distinct: boolean,
  filter: ExprNode | undefined,
  over: WindowNode | string | undefined,
): AggregateNode {
  return { kind: "aggregate", name, args, distinct, filter, over };
}

/**
 * `PARTITION BY … ORDER BY … [frame]`.
 *
 * @example
 * ```ts
 * windowNode([columnNode("p", "authorId", "author_id")], [], undefined);
 * ```
 */
export function windowNode(
  partitionBy: readonly ExprNode[],
  orderBy: readonly OrderNode[],
  frame: FragmentNode | undefined,
): WindowNode {
  return { kind: "window", partitionBy, orderBy, frame };
}

/**
 * A quoted identifier inside a fragment.
 *
 * @example
 * ```ts
 * identNode("search_vector");
 * ```
 *
 * @throws QueryError when `name` does not match {@link IDENTIFIER}.
 */
export function identNode(name: string): IdentNode {
  if (typeof name !== "string" || !IDENTIFIER.test(name)) {
    throw new QueryError("query.identName", "fragment.ident() takes an identifier.");
  }
  return { kind: "ident", name };
}

/**
 * Raw SQL from a `fragment` template: `strings` around `args`.
 *
 * @example
 * ```ts
 * fragmentNode(["lower(", ")"], [columnNode("u", "email", "email")]);
 * ```
 */
export function fragmentNode(strings: readonly string[], args: readonly ExprNode[]): FragmentNode {
  return { kind: "fragment", strings, args };
}

/**
 * `CAST(expr AS type)`.
 *
 * @example
 * ```ts
 * castNode(columnNode("u", "age", "age"), stringType());
 * ```
 */
export function castNode(expr: ExprNode, type: AnyFieldType): CastNode {
  return { kind: "cast", expr, type };
}

/**
 * One `WHEN when THEN result` of a {@link CaseNode}.
 *
 * @example
 * ```ts
 * const branch: CaseBranch = { when: isMinor, result: minor };
 * ```
 */
export interface CaseBranch {
  readonly when: ExprNode;
  readonly result: ExprNode;
}

/**
 * `CASE WHEN … THEN … [ELSE …] END`.
 *
 * @example
 * ```ts
 * caseNode([{ when: isMinor, result: minor }], adult);
 * ```
 */
export function caseNode(whens: readonly CaseBranch[], otherwise: ExprNode | undefined): CaseNode {
  return { kind: "case", whens, else: otherwise };
}

/**
 * `expr #> path` (`asText` false) or `expr #>> path` (`asText` true).
 *
 * @example
 * ```ts
 * jsonPathNode(columnNode("u", "settings", "settings"), [paramNode("theme", undefined, false)], true);
 * ```
 */
export function jsonPathNode(expr: ExprNode, path: readonly ExprNode[], asText: boolean): JsonPathNode {
  return { kind: "jsonPath", expr, path, asText };
}

/**
 * `(SELECT …)`.
 *
 * @example
 * ```ts
 * subqueryNode(ast);
 * ```
 */
export function subqueryNode(query: QueryAst): SubqueryNode {
  return { kind: "subquery", query };
}

/**
 * `EXISTS (SELECT …)`.
 *
 * @example
 * ```ts
 * existsNode(ast);
 * ```
 */
export function existsNode(query: QueryAst): ExistsNode {
  return { kind: "exists", query };
}

/**
 * `(a, b, …)`.
 *
 * @example
 * ```ts
 * tupleNode([columnNode("p", "authorId", "author_id"), columnNode("p", "id", "id")]);
 * ```
 */
export function tupleNode(items: readonly ExprNode[]): TupleNode {
  return { kind: "tuple", items };
}

/**
 * `expr AS "name"`, or with no `expr` a reference to that name.
 *
 * @example
 * ```ts
 * selectedAsNode("total", undefined);
 * ```
 */
export function selectedAsNode(name: string, expr: ExprNode | undefined): SelectedAsNode {
  return { kind: "selectedAs", name, expr };
}

/**
 * `*`. One shared node: it has no properties to vary.
 *
 * @example
 * ```ts
 * aggregateNode("count", [STAR], false, undefined, undefined);
 * ```
 */
export const STAR: StarNode = { kind: "star" };

/**
 * `expr ASC|DESC [NULLS FIRST|LAST]`.
 *
 * @example
 * ```ts
 * orderNode(columnNode("u", "createdAt", "created_at"), "desc", "last");
 * ```
 */
export function orderNode(
  expr: ExprNode,
  direction: "asc" | "desc",
  nulls: "first" | "last" | undefined,
): OrderNode {
  return { kind: "order", expr, direction, nulls };
}

// ---------------------------------------------------------------------------
// Parameter collection
// ---------------------------------------------------------------------------

/**
 * Appends the bound values of `node` to `out` in **canonical order**: depth first, the
 * properties of each node in the order its interface declares them, arrays in index order
 * (contract `contracts/query.ts`, "Parameter order"). A {@link ParamNode} and a
 * {@link ListNode} contribute their `value`; a {@link ListNode} also appends its length to
 * `lists`, and a {@link NamedParamNode} itself goes to `named`, when those arrays are
 * given. A nested query contributes its params where it sits; `QueryAst.preloads` is
 * skipped (a preload's query is a separate statement), and so is a
 * {@link PreloadNode} given directly.
 *
 * This is the definition the builders' incremental `params` and an expression's own
 * `params` must agree with: `ast.params` equals what this collects from `ast`.
 *
 * @example
 * ```ts
 * const params: unknown[] = [];
 * const lists: number[] = [];
 * collectParams(ast, params, lists);
 * ```
 */
export function collectParams(
  node: QueryNode,
  out: unknown[],
  lists?: number[],
  named?: NamedParamNode[],
): void {
  switch (node.kind) {
    case "namedParam":
      named?.push(node);
      return;
    case "column":
    case "literal":
    case "ident":
    case "star":
    case "table":
    case "cteSource":
    case "preload":
      return;
    case "param":
      out.push(node.value);
      return;
    case "list":
      out.push(node.value);
      lists?.push(node.value.length);
      return;
    case "unary":
      collectParams(node.operand, out, lists, named);
      return;
    case "binary":
      collectParams(node.left, out, lists, named);
      collectParams(node.right, out, lists, named);
      return;
    case "between":
      collectParams(node.expr, out, lists, named);
      collectParams(node.low, out, lists, named);
      collectParams(node.high, out, lists, named);
      return;
    case "nary":
    case "fn":
    case "fragment":
      collectAll(node.args, out, lists, named);
      return;
    case "aggregate":
      collectAll(node.args, out, lists, named);
      if (node.filter !== undefined) collectParams(node.filter, out, lists, named);
      if (node.over !== undefined && typeof node.over !== "string")
        collectParams(node.over, out, lists, named);
      return;
    case "window":
      collectAll(node.partitionBy, out, lists, named);
      collectAll(node.orderBy, out, lists, named);
      if (node.frame !== undefined) collectParams(node.frame, out, lists, named);
      return;
    case "cast":
    case "order":
      collectParams(node.expr, out, lists, named);
      return;
    case "case":
      for (const branch of node.whens) {
        collectParams(branch.when, out, lists, named);
        collectParams(branch.result, out, lists, named);
      }
      if (node.else !== undefined) collectParams(node.else, out, lists, named);
      return;
    case "jsonPath":
      collectParams(node.expr, out, lists, named);
      collectAll(node.path, out, lists, named);
      return;
    case "subquery":
    case "exists":
    case "subquerySource":
    case "combination":
    case "cte":
      collectParams(node.query, out, lists, named);
      return;
    case "tuple":
      collectAll(node.items, out, lists, named);
      return;
    case "selectedAs":
      if (node.expr !== undefined) collectParams(node.expr, out, lists, named);
      return;
    case "values":
      for (const row of node.rows) collectAll(row, out, lists, named);
      return;
    case "fragmentSource":
      collectParams(node.fragment, out, lists, named);
      return;
    case "join":
      collectParams(node.source, out, lists, named);
      if (node.on !== undefined) collectParams(node.on, out, lists, named);
      return;
    case "bool":
      collectParams(node.expr, out, lists, named);
      return;
    case "select":
      collectSelect(node.shape, out, lists, named);
      return;
    case "distinct":
      collectAll(node.on, out, lists, named);
      return;
    case "lock":
      if (typeof node.clause !== "string") collectParams(node.clause, out, lists, named);
      return;
    case "windowDef":
      collectParams(node.spec, out, lists, named);
      return;
    case "update":
      collectParams(node.value, out, lists, named);
      return;
    case "query":
      collectQuery(node, out, lists, named);
      return;
  }
}

function collectAll(
  nodes: readonly QueryNode[],
  out: unknown[],
  lists: number[] | undefined,
  named: NamedParamNode[] | undefined,
): void {
  for (const node of nodes) collectParams(node, out, lists, named);
}

function collectSelect(
  shape: SelectShape,
  out: unknown[],
  lists: number[] | undefined,
  named: NamedParamNode[] | undefined,
): void {
  switch (shape.kind) {
    case "expr":
      collectParams(shape.expr, out, lists, named);
      return;
    case "binding":
    case "constant":
      return;
    case "object":
      for (const value of shape.values) collectSelect(value, out, lists, named);
      return;
    case "tuple":
      for (const item of shape.items) collectSelect(item, out, lists, named);
      return;
  }
}

function collectQuery(
  ast: QueryAst,
  out: unknown[],
  lists: number[] | undefined,
  named: NamedParamNode[] | undefined,
): void {
  collectParams(ast.from, out, lists, named);
  collectAll(ast.joins, out, lists, named);
  collectAll(ast.wheres, out, lists, named);
  if (ast.select !== undefined) collectParams(ast.select, out, lists, named);
  if (ast.distinct !== undefined) collectParams(ast.distinct, out, lists, named);
  collectAll(ast.groupBys, out, lists, named);
  collectAll(ast.havings, out, lists, named);
  collectAll(ast.orderBys, out, lists, named);
  if (ast.limit !== undefined) collectParams(ast.limit, out, lists, named);
  if (ast.offset !== undefined) collectParams(ast.offset, out, lists, named);
  if (ast.lock !== undefined) collectParams(ast.lock, out, lists, named);
  collectAll(ast.combinations, out, lists, named);
  collectAll(ast.ctes, out, lists, named);
  collectAll(ast.windows, out, lists, named);
  // preloads: skipped, a preload's query is a separate statement with its own params.
  collectAll(ast.updates, out, lists, named);
  collectAll(ast.hints, out, lists, named);
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------
//
// Every function below returns a 32-bit hash of structure only. The expression layer
// (expr.ts) builds the same hashes incrementally from the hashes of the operands, and
// `shapeOf` builds them by walking a tree; both go through these functions, so they agree
// by construction (and a property test checks it).

/** One seed per node kind, so that kinds with equal children still hash apart. */
const KIND: Readonly<Record<QueryNode["kind"], number>> = {
  column: /* @__PURE__ */ seed("column"),
  param: /* @__PURE__ */ seed("param"),
  namedParam: /* @__PURE__ */ seed("namedParam"),
  list: /* @__PURE__ */ seed("list"),
  literal: /* @__PURE__ */ seed("literal"),
  unary: /* @__PURE__ */ seed("unary"),
  binary: /* @__PURE__ */ seed("binary"),
  between: /* @__PURE__ */ seed("between"),
  nary: /* @__PURE__ */ seed("nary"),
  fn: /* @__PURE__ */ seed("fn"),
  aggregate: /* @__PURE__ */ seed("aggregate"),
  ident: /* @__PURE__ */ seed("ident"),
  fragment: /* @__PURE__ */ seed("fragment"),
  cast: /* @__PURE__ */ seed("cast"),
  case: /* @__PURE__ */ seed("case"),
  jsonPath: /* @__PURE__ */ seed("jsonPath"),
  subquery: /* @__PURE__ */ seed("subquery"),
  exists: /* @__PURE__ */ seed("exists"),
  tuple: /* @__PURE__ */ seed("tuple"),
  selectedAs: /* @__PURE__ */ seed("selectedAs"),
  star: /* @__PURE__ */ seed("star"),
  order: /* @__PURE__ */ seed("order"),
  window: /* @__PURE__ */ seed("window"),
  table: /* @__PURE__ */ seed("table"),
  cteSource: /* @__PURE__ */ seed("cteSource"),
  subquerySource: /* @__PURE__ */ seed("subquerySource"),
  values: /* @__PURE__ */ seed("values"),
  fragmentSource: /* @__PURE__ */ seed("fragmentSource"),
  join: /* @__PURE__ */ seed("join"),
  bool: /* @__PURE__ */ seed("bool"),
  select: /* @__PURE__ */ seed("select"),
  distinct: /* @__PURE__ */ seed("distinct"),
  lock: /* @__PURE__ */ seed("lock"),
  combination: /* @__PURE__ */ seed("combination"),
  cte: /* @__PURE__ */ seed("cte"),
  windowDef: /* @__PURE__ */ seed("windowDef"),
  preload: /* @__PURE__ */ seed("preload"),
  update: /* @__PURE__ */ seed("update"),
  query: /* @__PURE__ */ seed("query"),
};

function seed(kind: string): number {
  return hashString(HASH_SEED, kind);
}

/**
 * `hashString(kindSeed, name)` for an operator or function name, remembered: expressions
 * are built on a hot path, and the names come from small fixed sets. One table per kind
 * seed, so that the same name under two kinds is two entries.
 */
const seeds = /* @__PURE__ */ new Map<number, Map<string, number>>();

function seedOf(kindSeed: number, name: string): number {
  let table = seeds.get(kindSeed);
  if (table === undefined) {
    table = new Map();
    seeds.set(kindSeed, table);
  }
  let seed = table.get(name);
  if (seed === undefined) {
    seed = hashString(kindSeed, name);
    // Function names are open-ended (a later step may add its own); keep the table bounded.
    if (table.size < 256) table.set(name, seed);
  }
  return seed;
}

/** What an absent optional part contributes. A present one is tagged first, so no hash can pass for "absent". */
const ABSENT = 0;
const PRESENT = 1;

/**
 * Mixes the shape of an optional part into `hash`: a tag, then the part's shape.
 *
 * @example
 * ```ts
 * const hash = optionalShape(HASH_SEED, filter === undefined ? undefined : shapeOf(filter));
 * ```
 */
export function optionalShape(hash: number, shape: number | undefined): number {
  return shape === undefined ? hashInt(hash, ABSENT) : hashInt(hashInt(hash, PRESENT), shape);
}

/** Mixes an optional string (a database schema, a preload's `from`). */
function optionalString(hash: number, value: string | undefined): number {
  return value === undefined ? hashInt(hash, ABSENT) : hashString(hashInt(hash, PRESENT), value);
}

/** Mixes a parameter's type: its name. Two types with one name are told apart by the plan cache's structural check. */
function typeShape(hash: number, type: AnyFieldType | undefined): number {
  return type === undefined ? hashInt(hash, ABSENT) : hashString(hashInt(hash, PRESENT), type.name);
}

/**
 * The shape of a column: its binding and its column name.
 *
 * @example
 * ```ts
 * shapeOfColumn("u", "created_at");
 * ```
 */
export function shapeOfColumn(binding: string, column: string): number {
  return hashString(hashString(KIND.column, binding), column);
}

/**
 * The shape of a column made by `outerRef(alias, Schema)`: the column's, and the schema
 * name it expects, so that it never shares a plan with a column that skips that check.
 *
 * @example
 * ```ts
 * shapeOfOuterRef(shapeOfColumn("u", "id"), "User");
 * ```
 */
export function shapeOfOuterRef(columnShape: number, schemaName: string): number {
  return hashString(hashString(columnShape, "outerRef"), schemaName);
}

/**
 * The shape of a bound value: its type and its `redact` flag, never its value.
 *
 * @example
 * ```ts
 * shapeOfParam(integerType(), false) === shapeOf(paramNode(18, integerType(), false)); // true
 * ```
 */
export function shapeOfParam(type: AnyFieldType | undefined, redact: boolean): number {
  return hashInt(typeShape(KIND.param, type), redact ? 1 : 0);
}

/**
 * The shape of a named parameter: its name, type and `redact` flag.
 *
 * @example
 * ```ts
 * shapeOfNamedParam("minAge", integerType(), false);
 * ```
 */
export function shapeOfNamedParam(name: string, type: AnyFieldType | undefined, redact: boolean): number {
  return hashInt(typeShape(hashString(KIND.namedParam, name), type), redact ? 1 : 0);
}

/**
 * The shape of a bound list: its element type and `redact` flag, never its values or length.
 *
 * @example
 * ```ts
 * shapeOfList(integerType(), false);
 * ```
 */
export function shapeOfList(type: AnyFieldType | undefined, redact: boolean): number {
  return hashInt(typeShape(KIND.list, type), redact ? 1 : 0);
}

/**
 * The shape of an inlined literal, which includes its value: it is SQL text.
 *
 * @example
 * ```ts
 * shapeOfLiteral(true) !== shapeOfLiteral(false); // true
 * ```
 */
export function shapeOfLiteral(value: null | boolean | number): number {
  if (value === null) return hashInt(KIND.literal, 0);
  if (typeof value === "boolean") return hashInt(KIND.literal, value ? 2 : 1);
  return hashString(hashInt(KIND.literal, 3), String(value));
}

/**
 * The shape of a unary operation, from its operand's shape.
 *
 * @example
 * ```ts
 * shapeOfUnary("isNull", nameShape);
 * ```
 */
export function shapeOfUnary(op: UnaryOp, operand: number): number {
  return hashInt(seedOf(KIND.unary, op), operand);
}

/**
 * The shape of a binary operation, from its operands' shapes.
 *
 * @example
 * ```ts
 * shapeOfBinary("gte", ageShape, shapeOfParam(integerType(), false));
 * ```
 */
export function shapeOfBinary(op: BinaryOp, left: number, right: number): number {
  return hashInt(hashInt(seedOf(KIND.binary, op), left), right);
}

/**
 * The shape of `expr BETWEEN low AND high`.
 *
 * @example
 * ```ts
 * shapeOfBetween(ageShape, lowShape, highShape);
 * ```
 */
export function shapeOfBetween(expr: number, low: number, high: number): number {
  return hashInt(hashInt(hashInt(KIND.between, expr), low), high);
}

/**
 * The shape of an `and`/`or` with no arguments yet. Each argument is then folded in with
 * {@link foldShape}, so appending one to an existing `and` is one more fold.
 *
 * @example
 * ```ts
 * const shape = foldShape(foldShape(startNary("and"), a), b);
 * ```
 */
export function startNary(op: "and" | "or"): number {
  return seedOf(KIND.nary, op);
}

/**
 * The shape of a function call with no arguments yet; fold the arguments in with {@link foldShape}.
 *
 * @example
 * ```ts
 * const shape = foldShape(startFn("lower"), emailShape);
 * ```
 */
export function startFn(name: string): number {
  return seedOf(KIND.fn, name);
}

/**
 * The shape of a tuple with no items yet; fold the items in with {@link foldShape}.
 *
 * @example
 * ```ts
 * const shape = foldShape(foldShape(startTuple(), a), b);
 * ```
 */
export function startTuple(): number {
  return KIND.tuple;
}

/**
 * Folds one more shape into a running hash: an argument of an `and`, a `fn` or a tuple, or
 * one element of a list of clauses.
 *
 * @example
 * ```ts
 * const wheres = foldShape(foldShape(HASH_SEED, firstWhere), secondWhere);
 * ```
 */
export function foldShape(hash: number, shape: number): number {
  return hashInt(hash, shape);
}

/**
 * The shape of an aggregate call from the shapes of its parts. `over` is the shape of an
 * inline window, or the name of a named one.
 *
 * @example
 * ```ts
 * shapeOfAggregate("count", [shapeOf(STAR)], false, undefined, undefined);
 * ```
 */
export function shapeOfAggregate(
  name: string,
  args: readonly number[],
  distinct: boolean,
  filter: number | undefined,
  over: number | string | undefined,
): number {
  let hash = hashInt(hashString(KIND.aggregate, name), args.length);
  for (const arg of args) hash = hashInt(hash, arg);
  hash = optionalShape(hashInt(hash, distinct ? 1 : 0), filter);
  if (typeof over === "string") return hashString(hashInt(hash, 2), over);
  return optionalShape(hash, over);
}

/**
 * The shape of a cast: its operand and the target type's name.
 *
 * @example
 * ```ts
 * shapeOfCast(ageShape, stringType());
 * ```
 */
export function shapeOfCast(expr: number, type: AnyFieldType): number {
  return hashString(hashInt(KIND.cast, expr), type.name);
}

/**
 * The shape of a `CASE` with its `WHEN` branches folded in and no `ELSE` yet; finish it
 * with {@link endCase}.
 *
 * @example
 * ```ts
 * const shape = endCase(caseBranch(startCase(), whenShape, thenShape), elseShape);
 * ```
 */
export function startCase(): number {
  return KIND.case;
}

/**
 * Folds one `WHEN … THEN …` into the shape of a `CASE`.
 *
 * @example
 * ```ts
 * caseBranch(startCase(), whenShape, thenShape);
 * ```
 */
export function caseBranch(hash: number, when: number, then: number): number {
  return hashInt(hashInt(hash, when), then);
}

/**
 * Finishes the shape of a `CASE` with its optional `ELSE`.
 *
 * @example
 * ```ts
 * endCase(branches, undefined);
 * ```
 */
export function endCase(hash: number, otherwise: number | undefined): number {
  return optionalShape(hash, otherwise);
}

/**
 * The shape of a JSON path from the shapes of the value and of each key.
 *
 * @example
 * ```ts
 * shapeOfJsonPath(settingsShape, [shapeOfParam(undefined, false)], true);
 * ```
 */
export function shapeOfJsonPath(expr: number, path: readonly number[], asText: boolean): number {
  let hash = hashInt(hashInt(KIND.jsonPath, expr), path.length);
  for (const key of path) hash = hashInt(hash, key);
  return hashInt(hash, asText ? 1 : 0);
}

/**
 * The shape of an identifier.
 *
 * @example
 * ```ts
 * shapeOfIdent("search_vector");
 * ```
 */
export function shapeOfIdent(name: string): number {
  return hashString(KIND.ident, name);
}

/** Hashes of a fragment's static strings, per strings array (a template's is the same object at every call). */
const stringsHashes = /* @__PURE__ */ new WeakMap<readonly string[], number>();

function stringsShape(strings: readonly string[]): number {
  let hash = stringsHashes.get(strings);
  if (hash === undefined) {
    hash = hashInt(HASH_SEED, strings.length);
    for (const text of strings) hash = hashString(hash, text);
    stringsHashes.set(strings, hash);
  }
  return hash;
}

/**
 * The shape of a fragment: its static strings (hashed once per template) and its arguments.
 *
 * @example
 * ```ts
 * shapeOfFragment(["lower(", ")"], [emailShape]);
 * ```
 */
export function shapeOfFragment(strings: readonly string[], args: readonly number[]): number {
  let hash = hashInt(KIND.fragment, stringsShape(strings));
  for (const arg of args) hash = hashInt(hash, arg);
  return hash;
}

/**
 * The shape of `EXISTS (…)` or `(…)` from the shape of the query inside.
 *
 * @example
 * ```ts
 * shapeOfSubquery("exists", ast.shape);
 * ```
 */
export function shapeOfSubquery(kind: "subquery" | "exists", query: number): number {
  return hashInt(KIND[kind], query);
}

/**
 * The shape of an order item.
 *
 * @example
 * ```ts
 * shapeOfOrder(createdAtShape, "desc", "last");
 * ```
 */
export function shapeOfOrder(
  expr: number,
  direction: "asc" | "desc",
  nulls: "first" | "last" | undefined,
): number {
  return optionalString(hashString(hashInt(KIND.order, expr), direction), nulls);
}

/** A list of shapes, with its length first: for a list that other properties follow. */
function listShape(hash: number, nodes: readonly QueryNode[]): number {
  let h = hashInt(hash, nodes.length);
  for (const node of nodes) h = hashInt(h, shapeOf(node));
  return h;
}

/** A list of strings (column names), with its length first. */
function stringsListShape(hash: number, values: readonly string[]): number {
  let h = hashInt(hash, values.length);
  for (const value of values) h = hashString(h, value);
  return h;
}

/**
 * Folds every node of a top-level list of a query (`wheres`, `joins`, …) into a hash
 * starting from {@link HASH_SEED}. Adding a clause is one more {@link foldShape}.
 *
 * @example
 * ```ts
 * clauseListShape(ast.wheres) === foldShape(clauseListShape(ast.wheres.slice(0, -1)), shapeOf(ast.wheres.at(-1))); // true
 * ```
 */
export function clauseListShape(nodes: readonly QueryNode[]): number {
  let hash = HASH_SEED;
  for (const node of nodes) hash = hashInt(hash, shapeOf(node));
  return hash;
}

/**
 * The shape of a schema's metadata as it enters a hash: its name and declared database schema.
 */
function metaShape(
  hash: number,
  meta: { readonly name: string; readonly schema: string | undefined } | undefined,
): number {
  if (meta === undefined) return hashInt(hash, ABSENT);
  return optionalString(hashString(hashInt(hash, PRESENT), meta.name), meta.schema);
}

/**
 * The structural hash of any node of the query AST (and of a whole {@link QueryAst}),
 * computed by walking it. It is the definition of `shape` in `contracts/query.ts`: kinds,
 * operators, function names, identifiers, schemas, literal values, and the type and
 * `redact` flag of every parameter contribute; parameter values, list lengths, select
 * constants and the queries of preloads do not.
 *
 * Expressions carry the same hash, built incrementally (`expr.shape === shapeOf(expr.node)`),
 * and so must a built query (`ast.shape === shapeOf(ast)`).
 *
 * @example
 * ```ts
 * shapeOf(binaryNode("eq", id, paramNode(1, undefined, false))) ===
 *   shapeOf(binaryNode("eq", id, paramNode(2, undefined, false))); // true
 * ```
 */
export function shapeOf(node: QueryNode): number {
  switch (node.kind) {
    case "column": {
      const shape = shapeOfColumn(node.binding, node.column);
      const outer = OUTER_REFS.get(node);
      return outer === undefined ? shape : shapeOfOuterRef(shape, outer.name);
    }
    case "param":
      return shapeOfParam(node.type, node.redact);
    case "namedParam":
      return shapeOfNamedParam(node.name, node.type, node.redact);
    case "list":
      return shapeOfList(node.type, node.redact);
    case "literal":
      return shapeOfLiteral(node.value);
    case "unary":
      return shapeOfUnary(node.op, shapeOf(node.operand));
    case "binary":
      return shapeOfBinary(node.op, shapeOf(node.left), shapeOf(node.right));
    case "between":
      return shapeOfBetween(shapeOf(node.expr), shapeOf(node.low), shapeOf(node.high));
    case "nary":
      return foldAll(startNary(node.op), node.args);
    case "fn":
      return foldAll(startFn(node.name), node.args);
    case "tuple":
      return foldAll(startTuple(), node.items);
    case "aggregate":
      return shapeOfAggregate(
        node.name,
        node.args.map(shapeOf),
        node.distinct,
        node.filter === undefined ? undefined : shapeOf(node.filter),
        node.over === undefined || typeof node.over === "string" ? node.over : shapeOf(node.over),
      );
    case "window": {
      const head = listShape(listShape(KIND.window, node.partitionBy), node.orderBy);
      return optionalShape(head, node.frame === undefined ? undefined : shapeOf(node.frame));
    }
    case "ident":
      return shapeOfIdent(node.name);
    case "fragment":
      return shapeOfFragment(node.strings, node.args.map(shapeOf));
    case "cast":
      return shapeOfCast(shapeOf(node.expr), node.type);
    case "case": {
      let hash = startCase();
      for (const branch of node.whens) hash = caseBranch(hash, shapeOf(branch.when), shapeOf(branch.result));
      return endCase(hash, node.else === undefined ? undefined : shapeOf(node.else));
    }
    case "jsonPath":
      return shapeOfJsonPath(shapeOf(node.expr), node.path.map(shapeOf), node.asText);
    case "subquery":
    case "exists":
      return shapeOfSubquery(node.kind, shapeOf(node.query));
    case "selectedAs":
      return optionalShape(
        hashString(KIND.selectedAs, node.name),
        node.expr === undefined ? undefined : shapeOf(node.expr),
      );
    case "star":
      return KIND.star;
    case "order":
      return shapeOfOrder(shapeOf(node.expr), node.direction, node.nulls);
    case "table":
      return hashString(
        optionalString(metaShape(hashString(KIND.table, node.source), node.meta), node.schema),
        node.alias,
      );
    case "cteSource":
      return hashString(metaShape(hashString(KIND.cteSource, node.name), node.meta), node.alias);
    case "subquerySource":
      return hashString(hashInt(KIND.subquerySource, shapeOf(node.query)), node.alias);
    case "values": {
      let hash = hashInt(stringsListShape(KIND.values, node.columns), node.rows.length);
      for (const row of node.rows) hash = listShape(hash, row);
      return hashString(hash, node.alias);
    }
    case "fragmentSource":
      return hashString(
        stringsListShape(hashInt(KIND.fragmentSource, shapeOf(node.fragment)), node.columns),
        node.alias,
      );
    case "join":
      return optionalShape(
        hashInt(hashString(KIND.join, node.type), shapeOf(node.source)),
        node.on === undefined ? undefined : shapeOf(node.on),
      );
    case "bool":
      return hashInt(hashString(KIND.bool, node.op), shapeOf(node.expr));
    case "select":
      return hashInt(KIND.select, shapeOfSelect(node.shape));
    case "distinct":
      return listShape(KIND.distinct, node.on);
    case "lock":
      return typeof node.clause === "string"
        ? hashString(hashInt(KIND.lock, 0), node.clause)
        : hashInt(hashInt(KIND.lock, 1), shapeOf(node.clause));
    case "combination":
      return hashInt(hashInt(hashString(KIND.combination, node.op), node.all ? 1 : 0), shapeOf(node.query));
    case "cte":
      return hashInt(
        hashInt(
          hashString(hashInt(hashString(KIND.cte, node.name), shapeOf(node.query)), node.operation),
          node.recursive ? 1 : 0,
        ),
        node.materialized === undefined ? 0 : node.materialized ? 2 : 1,
      );
    case "windowDef":
      return hashInt(hashString(KIND.windowDef, node.name), shapeOf(node.spec));
    case "preload":
      // The preload's query is a separate statement with its own shape: left out.
      return listShape(optionalString(hashString(KIND.preload, node.assoc), node.from), node.nested);
    case "update":
      return hashInt(hashString(hashString(KIND.update, node.field), node.column), shapeOf(node.value));
    case "query":
      return combineQueryShape(queryPropertyShapes(node));
  }
}

function foldAll(hash: number, nodes: readonly ExprNode[]): number {
  let h = hash;
  for (const node of nodes) h = hashInt(h, shapeOf(node));
  return h;
}

/**
 * The shape of a select's output tree. The values of `constant` leaves never contribute;
 * a whole binding contributes its alias and its schema's name and declared database schema.
 *
 * @example
 * ```ts
 * shapeOfSelect({ kind: "expr", expr: id, type: undefined });
 * ```
 */
export function shapeOfSelect(shape: SelectShape): number {
  switch (shape.kind) {
    case "expr":
      return typeShape(hashInt(hashString(HASH_SEED, "expr"), shapeOf(shape.expr)), shape.type);
    case "binding":
      return metaShape(hashString(hashString(HASH_SEED, "binding"), shape.binding), shape.meta);
    case "constant":
      return hashString(HASH_SEED, "constant");
    case "object": {
      let hash = stringsListShape(hashString(HASH_SEED, "object"), shape.keys);
      for (const value of shape.values) hash = hashInt(hash, shapeOfSelect(value));
      return hash;
    }
    case "tuple": {
      let hash = hashInt(hashString(HASH_SEED, "tupleShape"), shape.items.length);
      for (const item of shape.items) hash = hashInt(hash, shapeOfSelect(item));
      return hash;
    }
  }
}

/**
 * The names of the properties of {@link QueryAst} that contribute to its shape, in
 * declaration order. `params`, `listLengths` and `shape` itself do not.
 *
 * @example
 * ```ts
 * QUERY_SHAPE_PROPERTIES[0]; // "from"
 * ```
 */
export const QUERY_SHAPE_PROPERTIES = [
  "from",
  "joins",
  "wheres",
  "select",
  "distinct",
  "groupBys",
  "havings",
  "orderBys",
  "limit",
  "offset",
  "lock",
  "combinations",
  "ctes",
  "windows",
  "preloads",
  "updates",
  "schema",
  "hints",
] as const;

/**
 * The shape of each property of a query, in {@link QUERY_SHAPE_PROPERTIES} order: a list
 * is {@link clauseListShape}, an optional node {@link optionalShape} over `HASH_SEED`,
 * and `schema` an optional string. A builder keeps these and extends the one a method
 * changes; {@link combineQueryShape} turns them into `QueryAst.shape`.
 *
 * @example
 * ```ts
 * combineQueryShape(queryPropertyShapes(ast)) === shapeOf(ast); // true
 * ```
 */
export function queryPropertyShapes(ast: QueryAst): number[] {
  return [
    shapeOf(ast.from),
    clauseListShape(ast.joins),
    clauseListShape(ast.wheres),
    optionalNodeShape(ast.select),
    optionalNodeShape(ast.distinct),
    clauseListShape(ast.groupBys),
    clauseListShape(ast.havings),
    clauseListShape(ast.orderBys),
    optionalNodeShape(ast.limit),
    optionalNodeShape(ast.offset),
    optionalNodeShape(ast.lock),
    clauseListShape(ast.combinations),
    clauseListShape(ast.ctes),
    clauseListShape(ast.windows),
    clauseListShape(ast.preloads),
    clauseListShape(ast.updates),
    optionalString(HASH_SEED, ast.schema),
    clauseListShape(ast.hints),
  ];
}

/**
 * The shape of an optional top-level property of a query (`select`, `limit`, …).
 *
 * @example
 * ```ts
 * optionalNodeShape(ast.limit);
 * ```
 */
export function optionalNodeShape(node: QueryNode | undefined): number {
  return optionalShape(HASH_SEED, node === undefined ? undefined : shapeOf(node));
}

/**
 * Combines the per-property shapes of a query, in {@link QUERY_SHAPE_PROPERTIES} order,
 * into `QueryAst.shape`: one fold per property.
 *
 * @example
 * ```ts
 * const shape = combineQueryShape(propertyShapes);
 * ```
 */
export function combineQueryShape(propertyShapes: readonly number[]): number {
  let hash = KIND.query;
  for (const shape of propertyShapes) hash = hashInt(hash, shape);
  return hash;
}
