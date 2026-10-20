/**
 * The SQL emitter: turns a `QueryAst` into SQL text and the recipe for its parameter array
 * (`ParamSlot`s), in one pass over the tree, for any dialect described by a
 * {@link SqlDialect} table.
 *
 * ## Rules (ADR 0003)
 *
 * 1. SQL text comes from this module's code and the dialect's tables, from the static
 *    strings of a `fragment`, and from a `custom` type's `sql` that matches
 *    `CUSTOM_SQL_TYPE`. Operators, functions, aggregates, join kinds, sort directions and
 *    lock clauses are looked up in tables; a name that is not there is refused.
 * 2. A value becomes SQL only as a placeholder: emitting a `param`, `list` or `namedParam`
 *    writes the placeholder and appends its slot in the same call ({@link placeholder}), so
 *    the slots are in placeholder order by construction.
 * 3. Every identifier goes through {@link quoteIdentifier}.
 * 4. Parentheses are added here, by operator precedence ({@link PRECEDENCE}).
 *
 * ## Parameter numbering
 *
 * A slot refers to a value by its position in `QueryAst.params`, which is in canonical
 * order (a depth-first walk in interface declaration order). SQL does not write clauses
 * in that order (the select list comes before `FROM`, a CTE before everything), so the
 * emitter keeps a running canonical index and, before writing each clause, sets it to the
 * position where that clause's values start, computed from how many values the clauses
 * before it (in canonical order) hold. Text is always written in text order; only the
 * index jumps.
 *
 * @module
 */
import type { Adapter, CompiledQuery, OutputPlan, ParamSlot, ToDb } from "../contracts/adapter.js";
import type {
  AggregateNode,
  BinaryNode,
  BinaryOp,
  BoolNode,
  ColumnNode,
  CteNode,
  ExprNode,
  FragmentNode,
  JoinNode,
  JoinType,
  ListNode,
  OrderNode,
  QueryAst,
  QueryNode,
  QueryOperation,
  SourceNode,
  UnaryOp,
  WindowNode,
} from "../contracts/query.js";
import type { AnyFieldType, DbType } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import { QueryError } from "../errors.js";
import { OUTER_REFS } from "../query/advanced/outer-refs.js";
import { collectParams, IDENTIFIER } from "../query/ast.js";
import { resolveCodec } from "../types/codec.js";
import { hidesValues } from "../types/embed.js";
import {
  LOCK_CLAUSES,
  lookup,
  quoteIdentifier,
  type SqlDialect,
  sqlTypeName,
  type TableOperator,
  unsupported,
} from "./dialect.js";
import {
  type AliasMode,
  bindSources,
  cteEntry,
  isHidden,
  mergeProvenance,
  newScope,
  planSelect,
  resolveBinding,
  type Scope,
  type SelectItem,
  sourceScope,
} from "./plan.js";
import { type EmitApi, PRECEDENCE, registeredEmitter } from "./registry.js";
import { sameShape } from "./same-shape.js";
import { textOnly, untypedArithmetic, untypedValue } from "./untyped.js";

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

/**
 * How a table operator binds. Every operator above the comparisons groups to the left
 * (`a - b - c` is `(a - b) - c`); comparisons do not group at all.
 */
interface OperatorSpec {
  readonly precedence: number;
}

const OPERATORS: Readonly<Record<TableOperator, OperatorSpec>> = Object.freeze({
  eq: { precedence: PRECEDENCE.comparison },
  neq: { precedence: PRECEDENCE.comparison },
  gt: { precedence: PRECEDENCE.comparison },
  gte: { precedence: PRECEDENCE.comparison },
  lt: { precedence: PRECEDENCE.comparison },
  lte: { precedence: PRECEDENCE.comparison },
  isDistinctFrom: { precedence: PRECEDENCE.is },
  like: { precedence: PRECEDENCE.like },
  notLike: { precedence: PRECEDENCE.like },
  ilike: { precedence: PRECEDENCE.like },
  add: { precedence: PRECEDENCE.additive },
  sub: { precedence: PRECEDENCE.additive },
  mul: { precedence: PRECEDENCE.multiplicative },
  div: { precedence: PRECEDENCE.multiplicative },
  mod: { precedence: PRECEDENCE.multiplicative },
  concat: { precedence: PRECEDENCE.other },
  contains: { precedence: PRECEDENCE.other },
  containedBy: { precedence: PRECEDENCE.other },
  overlaps: { precedence: PRECEDENCE.other },
});

const UNARY_PRECEDENCE: Readonly<Record<UnaryOp, number>> = Object.freeze({
  not: PRECEDENCE.not,
  neg: PRECEDENCE.unary,
  isNull: PRECEDENCE.is,
  isNotNull: PRECEDENCE.is,
});

const JOIN_KEYWORDS: Readonly<Record<JoinType, string>> = Object.freeze({
  inner: "inner join",
  left: "left join",
  right: "right join",
  full: "full join",
  cross: "cross join",
  innerLateral: "inner join lateral",
  leftLateral: "left join lateral",
});

const DIRECTIONS: Readonly<Record<string, string>> = Object.freeze({ asc: "asc", desc: "desc" });
const NULLS: Readonly<Record<string, string>> = Object.freeze({ first: "nulls first", last: "nulls last" });
const SET_OPERATIONS: Readonly<Record<string, string>> = Object.freeze({
  union: "union",
  intersect: "intersect",
  except: "except",
});

/** Comparisons and the operators that bind like them take operands at least this strong, for readability. */
const COMPARISON_OPERAND = PRECEDENCE.other;

function tableOperator(op: BinaryOp): OperatorSpec | undefined {
  return typeof op === "string" && Object.hasOwn(OPERATORS, op) ? OPERATORS[op as TableOperator] : undefined;
}

/**
 * The precedence of the SQL an expression node is written as.
 *
 * @example
 * ```ts
 * precedenceOf(postgresDialect, binaryNode("add", a, b)); // PRECEDENCE.additive
 * ```
 */
export function precedenceOf(dialect: SqlDialect, node: ExprNode): number {
  switch (node.kind) {
    case "literal":
      return typeof node.value === "number" && (node.value < 0 || Object.is(node.value, -0))
        ? PRECEDENCE.unary
        : PRECEDENCE.atom;
    case "unary":
      return Object.hasOwn(UNARY_PRECEDENCE, node.op) ? UNARY_PRECEDENCE[node.op] : PRECEDENCE.atom;
    case "binary":
      if (node.op === "in" || node.op === "notIn") {
        if (node.right.kind === "list") {
          return dialect.capabilities.arrayParams ? PRECEDENCE.comparison : PRECEDENCE.like;
        }
        return node.right.kind === "subquery" ? PRECEDENCE.like : PRECEDENCE.comparison;
      }
      if (node.op === "has") return PRECEDENCE.comparison;
      // Written as concat(a, b) and not (a <=> b) where the dialect says so.
      if (node.op === "concat" && dialect.concat === "function") return PRECEDENCE.atom;
      if (node.op === "isDistinctFrom" && dialect.distinctFrom === "nullSafeEqual") return PRECEDENCE.not;
      return tableOperator(node.op)?.precedence ?? PRECEDENCE.atom;
    case "between":
      return PRECEDENCE.like;
    case "nary":
      if (node.args.length === 0) return PRECEDENCE.atom;
      if (node.args.length === 1) return precedenceOf(dialect, node.args[0] as ExprNode);
      return node.op === "and" ? PRECEDENCE.and : PRECEDENCE.or;
    case "fragment":
      return PRECEDENCE.fragment;
    case "jsonPath":
      return dialect.jsonPath === "pathFunctions" ? PRECEDENCE.atom : PRECEDENCE.other;
    case "selectedAs":
      return node.expr === undefined ? PRECEDENCE.atom : precedenceOf(dialect, node.expr);
    default: {
      const custom = registeredEmitter(node.kind);
      return custom === undefined ? PRECEDENCE.atom : custom.precedence;
    }
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Where the driver conversions of a type come from: the adapter's `typeOverrides`.
 *
 * @example
 * ```ts
 * const codecs: CodecSource = { typeOverrides: () => undefined };
 * ```
 */
export type CodecSource = Pick<Adapter, "typeOverrides">;

/** The state of one statement being written. */
interface Ctx {
  readonly dialect: SqlDialect;
  readonly codecs: CodecSource;
  readonly slots: ParamSlot[];
  /** The canonical position, in the statement's parameter array, of the next value. */
  index: number;
}

/** The query being written: its names and its database schema. */
interface Frame {
  readonly scope: Scope;
  /** The query's database schema: its own, else the nearest enclosing query's, else the argument. */
  readonly schema: string | undefined;
  /** The output names of the query's select list, once planned: what `selectedAs("name")` may refer to. */
  outputs: ReadonlySet<string> | undefined;
  /** A binding whose columns are written without it (the target in SQLite's RETURNING). */
  readonly bare: string | undefined;
}

/**
 * Starts a statement.
 *
 * @example
 * ```ts
 * const ctx = newContext(postgresDialect, { typeOverrides: () => undefined });
 * ```
 */
export function newContext(dialect: SqlDialect, codecs: CodecSource): EmitContext {
  return { dialect, codecs, slots: [], index: 0 };
}

/**
 * The state of one statement being written, as `write.ts` sees it.
 *
 * @example
 * ```ts
 * declare const ctx: EmitContext;
 * ctx.slots.length;
 * ```
 */
export type EmitContext = Ctx;

function toDbOf(ctx: Ctx, type: AnyFieldType | undefined): ToDb | undefined {
  if (type === undefined) return undefined;
  const toDb = resolveCodec(type, ctx.codecs).toDb;
  return toDb === IDENTITY ? undefined : toDb;
}

/**
 * Appends `slot` and returns the placeholder for it: the only way the emitter writes a value.
 *
 * @example
 * ```ts
 * placeholder(ctx, { kind: "inline", index: 0, toDb: undefined, redact: false }); // "$1"
 * ```
 */
export function placeholder(ctx: EmitContext, slot: ParamSlot): string {
  ctx.slots.push(slot);
  return ctx.dialect.placeholder === "numbered" ? `$${ctx.slots.length}` : "?";
}

/**
 * Writes the placeholder of one value at canonical position `ctx.index`, and moves past it.
 *
 * @example
 * ```ts
 * inlineValue(ctx, field.type, field.redact); // "$1"
 * ```
 */
export function inlineValue(ctx: EmitContext, type: AnyFieldType | undefined, redact: boolean): string {
  const index = ctx.index;
  ctx.index = index + 1;
  // An embed holding a redacted field is redacted as a whole value.
  return placeholder(ctx, {
    kind: "inline",
    index,
    toDb: toDbOf(ctx, type),
    redact: redact || hidesValues(type),
  });
}

/**
 * Writes the placeholder of a value supplied by name at execution.
 *
 * @example
 * ```ts
 * namedValue(ctx, "minAge", integerType, false); // "$2"
 * ```
 */
export function namedValue(
  ctx: EmitContext,
  name: string,
  type: AnyFieldType | undefined,
  redact: boolean,
): string {
  if (typeof name !== "string" || name === "") throw new QueryError("A named parameter has no name.");
  return placeholder(ctx, {
    kind: "named",
    name,
    toDb: toDbOf(ctx, type),
    redact: redact || hidesValues(type),
  });
}

/**
 * `$1` for one bound array, or `?, ?, ?` for an expanded one (without the parentheses).
 * With `textWhere`, an untyped list that only text may fill (see {@link textOnly}).
 */
function listValue(ctx: Ctx, node: ListNode, textWhere?: string): string {
  const index = ctx.index;
  ctx.index = index + 1;
  let toDb = toDbOf(ctx, node.type);
  if (textWhere !== undefined) {
    for (const element of node.value) {
      if (element !== null && typeof element !== "string") throw untypedValue(textWhere, element);
    }
    toDb = textOnly(textWhere);
  }
  if (ctx.dialect.capabilities.arrayParams) {
    return placeholder(ctx, { kind: "list", index, toDb, redact: node.redact });
  }
  let text = "";
  for (let element = 0; element < node.value.length; element++) {
    if (element > 0) text += ", ";
    text += placeholder(ctx, { kind: "element", index, element, toDb, redact: node.redact });
  }
  return text;
}

/** How many values (entries of `params`) a node holds. */
function valuesIn(node: QueryNode | undefined): number {
  if (node === undefined) return 0;
  const out: unknown[] = [];
  collectParams(node, out);
  return out.length;
}

function valuesInAll(nodes: readonly QueryNode[]): number {
  let n = 0;
  for (const node of nodes) n += valuesIn(node);
  return n;
}

/** Runs `write` with the canonical index set to `index` (where the values it writes start). */
function at<T>(ctx: Ctx, index: number, write: () => T): T {
  ctx.index = index;
  return write();
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/**
 * Writes `node`, in parentheses when its precedence is below `minPrecedence`.
 *
 * @example
 * ```ts
 * operand(ctx, frame, binaryNode("add", a, b), PRECEDENCE.multiplicative); // '("a" + "b")'
 * ```
 */
function operand(ctx: Ctx, frame: Frame, node: ExprNode, minPrecedence: number): string {
  const text = expr(ctx, frame, node);
  return precedenceOf(ctx.dialect, node) < minPrecedence ? `(${text})` : text;
}

function list(ctx: Ctx, frame: Frame, nodes: readonly ExprNode[], minPrecedence: number): string {
  let text = "";
  for (let i = 0; i < nodes.length; i++) {
    if (i > 0) text += ", ";
    text += operand(ctx, frame, nodes[i] as ExprNode, minPrecedence);
  }
  return text;
}

function quote(ctx: Ctx, name: string): string {
  if (typeof name !== "string") throw new QueryError("An identifier is not a string.");
  return quoteIdentifier(ctx.dialect, name);
}

function literal(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new QueryError(
    "A literal holds something other than true, false, null or a finite number; only those are written into the SQL.",
  );
}

function expr(ctx: Ctx, frame: Frame, node: ExprNode): string {
  switch (node.kind) {
    case "column":
      checkColumn(frame.scope, node);
      if (frame.bare === node.binding) return quote(ctx, node.column);
      return `${quote(ctx, node.binding)}.${quote(ctx, node.column)}`;
    case "param":
      return inlineValue(ctx, node.type, node.redact);
    case "namedParam":
      return namedValue(ctx, node.name, node.type, node.redact);
    case "list":
      if (!ctx.dialect.capabilities.arrayParams) {
        throw new QueryError(
          `A list of values outside in() needs array parameters, which ${ctx.dialect.name} does not have.`,
        );
      }
      return listValue(ctx, node);
    case "literal":
      return literal(node.value);
    case "unary":
      return unary(ctx, frame, node.op, node.operand);
    case "binary":
      return binary(ctx, frame, node);
    case "between": {
      if (noSqlType(node.expr) && noSqlType(node.low) && noSqlType(node.high)) {
        // Only bound values: the SQL has no type for them unless it is written (see binary).
        const where = "a comparison of values without a type (between())";
        const typed = !hasNoType(node.expr) || !hasNoType(node.low) || !hasNoType(node.high);
        const type = firstType(node.expr) ?? firstType(node.low) ?? firstType(node.high);
        return `${boundOperand(ctx, frame, node.expr, where, typed, type)} between ${boundOperand(ctx, frame, node.low, where, typed, type)} and ${boundOperand(ctx, frame, node.high, where, typed, type)}`;
      }
      // A CASE or coalesce of bound values among them takes its type from a column operand.
      const context =
        columnType(frame, node.expr) ?? columnType(frame, node.low) ?? columnType(frame, node.high);
      const range = (item: ExprNode) =>
        isBoundCompound(item)
          ? typedCompound(ctx, frame, item, context)
          : operand(ctx, frame, item, COMPARISON_OPERAND);
      return `${range(node.expr)} between ${range(node.low)} and ${range(node.high)}`;
    }
    case "nary":
      return nary(ctx, frame, node.op, node.args);
    case "fn": {
      if (node.args.length === 0) {
        const fixed = lookup(ctx.dialect.niladic, node.name);
        if (fixed !== undefined) return fixed;
      }
      const name = lookup(ctx.dialect.functions, node.name);
      if (name === undefined) {
        throw new QueryError(
          `The function "${String(node.name)}" is not in the ${ctx.dialect.name} function table.`,
        );
      }
      return `${name}(${list(ctx, frame, node.args, PRECEDENCE.fragment)})`;
    }
    case "aggregate":
      return aggregate(ctx, frame, node);
    case "ident":
      if (typeof node.name !== "string" || !IDENTIFIER.test(node.name)) {
        throw new QueryError(
          "fragment.ident() holds a name that is not an identifier, so it was not written.",
        );
      }
      return quote(ctx, node.name);
    case "fragment":
      return fragment(ctx, frame, node);
    case "cast":
      return `cast(${operand(ctx, frame, node.expr, PRECEDENCE.fragment)} as ${typeName(ctx, node.type)})`;
    case "case":
      return caseExpr(ctx, frame, node, undefined, false);
    case "jsonPath":
      return jsonPath(ctx, frame, node.expr, node.path, node.asText);
    case "subquery":
      return `(${nestedQuery(ctx, frame, node.query)})`;
    case "exists":
      return `exists (${query(ctx, node.query, frame.scope, frame.schema, "all", "exists", undefined).sql})`;
    case "tuple":
      if (node.items.length === 0) throw new QueryError("A tuple has no items.");
      return node.items.length === 1 && ctx.dialect.singleTuple === "row"
        ? `row(${list(ctx, frame, node.items, PRECEDENCE.fragment)})`
        : `(${list(ctx, frame, node.items, PRECEDENCE.fragment)})`;
    case "selectedAs":
      if (node.expr !== undefined) return expr(ctx, frame, node.expr);
      if (frame.outputs !== undefined && !frame.outputs.has(node.name)) {
        throw new QueryError(
          `selectedAs("${String(node.name)}") refers to a selected value of that name, and the query selects none. Name one in the select: selectedAs(expr, "${String(node.name)}").`,
        );
      }
      return quote(ctx, node.name);
    case "star":
      return "*";
    default:
      return custom(ctx, frame, node);
  }
}

/**
 * Checks that a column's binding is in scope. A column made by `outerRef(alias, Schema)`
 * must also resolve to a query around the one using it (not to a binding of that query,
 * which would shadow the outer one) whose binding is of that schema.
 */
function checkColumn(scope: Scope, node: ColumnNode): void {
  const alias = String(node.binding);
  const found = resolveBinding(scope, node.binding);
  if (found === undefined) {
    throw new QueryError(
      isHidden(scope, node.binding)
        ? `The column ${alias}.${String(node.field)} is read by a subquery in FROM or a join from a binding of the same query, "${alias}". That needs a lateral join, which is not supported yet: move the condition to the join's on, or use the subquery in where with exists() or in().`
        : `The column ${alias}.${String(node.field)} refers to the binding "${alias}", which the query does not have.`,
    );
  }
  const required = OUTER_REFS.get(node);
  if (required === undefined) return;
  if (found.own) {
    throw new QueryError(
      `outerRef("${alias}", ${required.name}) refers to the binding "${alias}" of an outer query, but the query using it has its own binding "${alias}", which would be read instead. Give one of them another alias.`,
    );
  }
  if (found.entry.meta !== required) {
    throw new QueryError(
      `outerRef("${alias}", ${required.name}) expects the outer binding "${alias}" to be ${required.name}, but it is ${found.entry.meta === undefined ? "a source with no schema" : found.entry.meta.name}.`,
    );
  }
}

/** The output names of a select list. */
function outputNames(items: readonly SelectItem[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const item of items) names.add(item.alias);
  return names;
}

function custom(ctx: Ctx, frame: Frame, node: never): string {
  const kind = (node as { kind: unknown }).kind;
  const emitter = typeof kind === "string" ? registeredEmitter(kind) : undefined;
  if (emitter === undefined) throw new QueryError(`Unknown expression node kind "${String(kind)}".`);
  const api: EmitApi = {
    dialect: ctx.dialect,
    expr: (inner, minPrecedence) => operand(ctx, frame, inner, minPrecedence),
    query: (ast) => nestedQuery(ctx, frame, ast),
    quote: (name) => quote(ctx, name),
  };
  return emitter.emit(node, api);
}

function typeName(ctx: Ctx, type: AnyFieldType): string {
  return sqlTypeName(ctx.dialect, dbTypeOf(type));
}

/** The database type of a field type, checked: a hand-built tree may hold anything. */
function dbTypeOf(type: AnyFieldType): DbType {
  if (typeof type !== "object" || type === null || typeof type.db !== "object" || type.db === null) {
    throw new QueryError("A cast has no column type to cast to.");
  }
  return type.db;
}

function unary(ctx: Ctx, frame: Frame, op: UnaryOp, inner: ExprNode): string {
  switch (op) {
    case "not":
      return `not ${operand(ctx, frame, inner, PRECEDENCE.atom)}`;
    case "neg":
      // `-$1` names no type for the database to choose a minus by: a typed value is cast,
      // and a value without one is refused (as in binary()).
      if (noSqlType(inner)) {
        if (hasNoType(inner)) throw untypedArithmetic("neg");
        return `-${selectedValue(ctx, frame, inner, "arithmetic", true)}`;
      }
      return `-${operand(ctx, frame, inner, PRECEDENCE.atom)}`;
    case "isNull":
      return `${operand(ctx, frame, inner, COMPARISON_OPERAND)} is null`;
    case "isNotNull":
      return `${operand(ctx, frame, inner, COMPARISON_OPERAND)} is not null`;
    default:
      throw new QueryError(`Unknown unary operator "${String(op)}".`);
  }
}

function binary(ctx: Ctx, frame: Frame, node: BinaryNode): string {
  const { op, left, right } = node;
  if (op === "in" || op === "notIn") return inExpr(ctx, frame, op === "in", left, right);
  if (op === "has") {
    if (!ctx.dialect.capabilities.arrays) throw unsupported(ctx.dialect, "has() (array membership)");
    // `element = any(array)`: the right operand is written first, so its values come after
    // the left operand's in canonical order.
    const start = ctx.index;
    const element = at(ctx, start + valuesIn(left), () => operand(ctx, frame, right, COMPARISON_OPERAND));
    const end = ctx.index;
    const array = at(ctx, start, () => operand(ctx, frame, left, PRECEDENCE.fragment));
    ctx.index = end;
    return `${element} = any(${array})`;
  }
  const spec = tableOperator(op);
  if (spec === undefined) throw new QueryError(`Unknown operator "${String(op)}".`);
  if (op === "ilike" && !ctx.dialect.capabilities.ilike && !ctx.dialect.ilikeAsLike) {
    throw unsupported(ctx.dialect, "ILIKE");
  }
  if (
    (op === "contains" || op === "containedBy" || op === "overlaps") &&
    !ctx.dialect.capabilities.arrays &&
    !ctx.dialect.capabilities.jsonb
  ) {
    throw unsupported(ctx.dialect, `The ${op}() operator`);
  }
  const sql = ctx.dialect.operators[op as TableOperator];
  const comparison = COMPARISONS.has(op);
  const typesOperands = comparison || ARITHMETIC.has(op);
  if (typesOperands && noSqlType(left) && noSqlType(right)) {
    // Only bound values on both sides: the database knows no type for either unless it is
    // written. It compares two placeholders as text, and cannot choose an arithmetic
    // operator for them at all. A typed value is cast to its type, which types the other
    // side. With no type on either side, a comparison may only compare text, and
    // arithmetic is refused (text has no arithmetic).
    const typed = !hasNoType(left) || !hasNoType(right);
    if (!comparison && !typed) throw untypedArithmetic(op);
    const where = `a comparison of two values without a type (${op}())`;
    const type = firstType(left) ?? firstType(right);
    const l = boundOperand(ctx, frame, left, where, typed, type);
    return infix(ctx, op, sql, l, boundOperand(ctx, frame, right, where, typed, type));
  }
  const p = spec.precedence;
  const leftMin = p <= PRECEDENCE.like ? COMPARISON_OPERAND : p;
  const rightMin = p <= PRECEDENCE.like ? COMPARISON_OPERAND : p + 1;
  if (!typesOperands) {
    const l = operand(ctx, frame, left, leftMin);
    return infix(ctx, op, sql, l, operand(ctx, frame, right, rightMin));
  }
  // A CASE or coalesce of bound values beside an expression that has a type: written as
  // it is, the database reads it as text (see typedCompound). In arithmetic, a typed value
  // keeps its type unless a column is on the other side (see typedArithmeticValue).
  const context = comparison ? columnType(frame, isBoundCompound(left) ? right : left) : undefined;
  const l = isBoundCompound(left)
    ? typedCompound(ctx, frame, left, context)
    : comparison
      ? operand(ctx, frame, left, leftMin)
      : typedArithmeticValue(ctx, frame, left, right, leftMin);
  const r = isBoundCompound(right)
    ? typedCompound(ctx, frame, right, context)
    : comparison
      ? operand(ctx, frame, right, rightMin)
      : typedArithmeticValue(ctx, frame, right, left, rightMin);
  return infix(ctx, op, sql, l, r);
}

/** The three `LIKE` operators, after whose pattern the dialect may add an `ESCAPE` clause. */
const LIKES: ReadonlySet<string> = new Set(["like", "notLike", "ilike"]);

/**
 * Writes a table operator between its two written operands, in the dialect's form:
 * `concat(l, r)` and `not (l <=> r)` where the dialect has no infix form, `LIKE` for
 * `ilike` where it is lowered, and the dialect's escape clause after a `LIKE` pattern.
 */
function infix(ctx: Ctx, op: BinaryOp, sql: string, l: string, r: string): string {
  const dialect = ctx.dialect;
  if (op === "concat" && dialect.concat === "function") return `concat(${l}, ${r})`;
  if (op === "isDistinctFrom" && dialect.distinctFrom === "nullSafeEqual") return `not (${l} <=> ${r})`;
  if (LIKES.has(op)) {
    const keyword = op === "ilike" && !dialect.capabilities.ilike ? "like" : sql;
    return `${l} ${keyword} ${r}${dialect.likeEscape}`;
  }
  return `${l} ${sql} ${r}`;
}

/**
 * An operand of arithmetic whose other operand is not a bound value. A typed value is
 * cast to its type unless the other operand is a column: written bare, it would take the
 * type of the other side (`$1 / (cast($2 as integer) + …)` reads a float as an integer).
 * Beside a column it is left to the column, as before (status note 10, Known gaps).
 */
function typedArithmeticValue(ctx: Ctx, frame: Frame, node: ExprNode, other: ExprNode, min: number): string {
  if (
    (node.kind === "param" || node.kind === "namedParam") &&
    node.type !== undefined &&
    other.kind !== "column"
  ) {
    return `cast(${expr(ctx, frame, node)} as ${typeName(ctx, node.type)})`;
  }
  return operand(ctx, frame, node, min);
}

/**
 * One operand of an operator whose operands are all bound values. A `CASE` or `coalesce`
 * with no typed value in it is cast to `type`, the type of the first typed value among the
 * operands: that value is the type context, and the database would read the `CASE` as text
 * otherwise. Anything else is written as {@link selectedValue} writes it.
 */
function boundOperand(
  ctx: Ctx,
  frame: Frame,
  node: ExprNode,
  where: string,
  typed: boolean,
  type: DbType | undefined,
): string {
  if (type !== undefined && isBoundCompound(node) && hasNoType(node)) {
    return `cast(${expr(ctx, frame, node)} as ${sqlTypeName(ctx.dialect, type)})`;
  }
  return selectedValue(ctx, frame, node, where, typed);
}

/**
 * The database type of the first typed value in `node`: a typed parameter or list, or one
 * among the results of a `CASE` or the arguments of a `coalesce`, at any depth.
 * `undefined` when it has none.
 */
function firstType(node: ExprNode): DbType | undefined {
  if (node.kind === "param" || node.kind === "namedParam" || node.kind === "list") {
    return node.type === undefined ? undefined : dbTypeOf(node.type);
  }
  if (node.kind === "case") {
    for (const branch of node.whens) {
      const type = firstType(branch.result);
      if (type !== undefined) return type;
    }
    return node.else === undefined ? undefined : firstType(node.else);
  }
  if (node.kind === "fn" && node.name === "coalesce") {
    for (const arg of node.args) {
      const type = firstType(arg);
      if (type !== undefined) return type;
    }
  }
  return undefined;
}

function inExpr(ctx: Ctx, frame: Frame, positive: boolean, left: ExprNode, right: ExprNode): string {
  if (right.kind === "list" && noSqlType(left)) {
    // Only bound values: as in binary(), a typed value is cast, and with no type on either
    // side only text may be compared.
    const where = `a comparison of values without a type (${positive ? "in" : "notIn"}())`;
    const typed = !hasNoType(left) || right.type !== undefined;
    const textWhere = typed ? undefined : where;
    if (right.value.length === 0 && !ctx.dialect.capabilities.arrayParams) {
      ctx.index += valuesIn(left) + 1;
      return positive ? "false" : "true";
    }
    const subject = boundOperand(ctx, frame, left, where, typed, firstType(left) ?? firstType(right));
    if (ctx.dialect.capabilities.arrayParams) {
      const list = listValue(ctx, right, textWhere);
      return positive ? `${subject} = any(${list})` : `${subject} <> all(${list})`;
    }
    return `${subject} ${positive ? "in" : "not in"} (${listValue(ctx, right, textWhere)})`;
  }
  if (right.kind === "list") {
    if (ctx.dialect.capabilities.arrayParams) {
      const subject = operand(ctx, frame, left, COMPARISON_OPERAND);
      return positive
        ? `${subject} = any(${listValue(ctx, right)})`
        : `${subject} <> all(${listValue(ctx, right)})`;
    }
    if (right.value.length === 0) {
      // An empty expanded list has no SQL form: `x IN ()` is a syntax error. The answer
      // does not depend on `x`, so it is skipped (its values keep their positions).
      ctx.index += valuesIn(left) + 1;
      return positive ? "false" : "true";
    }
    const subject = operand(ctx, frame, left, COMPARISON_OPERAND);
    return `${subject} ${positive ? "in" : "not in"} (${listValue(ctx, right)})`;
  }
  if (right.kind === "subquery") {
    const subject = operand(ctx, frame, left, COMPARISON_OPERAND);
    return `${subject} ${positive ? "in" : "not in"} (${nestedQuery(ctx, frame, right.query)})`;
  }
  if (!ctx.dialect.capabilities.arrays) throw unsupported(ctx.dialect, "in() with an array expression");
  // A CASE or coalesce of bound values takes its type from a column on the other side: an
  // array of the subject column's type, or the element type of an array column.
  const subject = isBoundCompound(left)
    ? typedCompound(ctx, frame, left, elementType(columnType(frame, right)))
    : operand(ctx, frame, left, COMPARISON_OPERAND);
  const subjectType = columnType(frame, left);
  const array = isBoundCompound(right)
    ? typedCompound(
        ctx,
        frame,
        right,
        subjectType === undefined ? undefined : { kind: "array", of: subjectType },
      )
    : operand(ctx, frame, right, PRECEDENCE.fragment);
  return positive ? `${subject} = any(${array})` : `${subject} <> all(${array})`;
}

function nary(ctx: Ctx, frame: Frame, op: "and" | "or", args: readonly ExprNode[]): string {
  if (op !== "and" && op !== "or") throw new QueryError(`Unknown boolean operator "${String(op)}".`);
  if (args.length === 0) return op === "and" ? "true" : "false";
  if (args.length === 1) return expr(ctx, frame, args[0] as ExprNode);
  // An `and` inside an `or` gets parentheses although it binds tighter: `(a and b) or c`.
  const min = op === "and" ? PRECEDENCE.and : PRECEDENCE.not;
  const separator = op === "and" ? " and " : " or ";
  let text = "";
  for (let i = 0; i < args.length; i++) {
    if (i > 0) text += separator;
    text += operand(ctx, frame, args[i] as ExprNode, min);
  }
  return text;
}

function aggregate(ctx: Ctx, frame: Frame, node: AggregateNode): string {
  const name = lookup(ctx.dialect.aggregates, node.name);
  if (name === undefined) {
    throw new QueryError(
      `The aggregate "${String(node.name)}" is not in the ${ctx.dialect.name} aggregate table.`,
    );
  }
  let text = `${name}(${node.distinct ? "distinct " : ""}${list(ctx, frame, node.args, PRECEDENCE.fragment)})`;
  if (node.filter !== undefined) {
    if (!ctx.dialect.capabilities.aggregateFilter) {
      throw unsupported(ctx.dialect, "FILTER (WHERE …) on an aggregate");
    }
    text += ` filter (where ${expr(ctx, frame, node.filter)})`;
  }
  const over = node.over;
  if (typeof over === "string") text += ` over ${windowName(ctx, over)}`;
  else if (over !== undefined) text += ` over (${windowSpec(ctx, frame, over)})`;
  return text;
}

function windowName(ctx: Ctx, name: string): string {
  if (typeof name !== "string" || !IDENTIFIER.test(name)) {
    throw new QueryError("A window name is not an identifier, so it was not written.");
  }
  return quote(ctx, name);
}

function windowSpec(ctx: Ctx, frame: Frame, node: WindowNode): string {
  const parts: string[] = [];
  if (node.partitionBy.length > 0)
    parts.push(`partition by ${list(ctx, frame, node.partitionBy, PRECEDENCE.fragment)}`);
  if (node.orderBy.length > 0) parts.push(`order by ${orderList(ctx, frame, node.orderBy)}`);
  if (node.frame !== undefined) parts.push(fragment(ctx, frame, node.frame));
  return parts.join(" ");
}

function orderList(ctx: Ctx, frame: Frame, nodes: readonly OrderNode[]): string {
  let text = "";
  for (let i = 0; i < nodes.length; i++) {
    if (i > 0) text += ", ";
    text += orderItem(ctx, frame, nodes[i] as OrderNode, undefined);
  }
  return text;
}

function orderItem(ctx: Ctx, frame: Frame, node: OrderNode, written: string | undefined): string {
  const direction = lookup(DIRECTIONS, node.direction);
  if (direction === undefined) throw new QueryError(`Unknown sort direction "${String(node.direction)}".`);
  let text = `${written ?? operand(ctx, frame, node.expr, PRECEDENCE.fragment)} ${direction}`;
  if (node.nulls !== undefined) {
    const nulls = lookup(NULLS, node.nulls);
    if (nulls === undefined) throw new QueryError(`Unknown nulls order "${String(node.nulls)}".`);
    if (!ctx.dialect.capabilities.nullsOrder) throw unsupported(ctx.dialect, "NULLS FIRST / NULLS LAST");
    text += ` ${nulls}`;
  }
  return text;
}

/**
 * Writes a fragment: its static strings as they are, its arguments as expressions (in
 * parentheses unless they are atoms, since the surrounding text is unknown).
 *
 * @example
 * ```ts
 * fragment(ctx, frame, fragmentNode(["lower(", ")"], [email])); // 'lower("u"."email")'
 * ```
 */
function fragment(ctx: Ctx, frame: Frame, node: FragmentNode): string {
  const { strings, args } = node;
  if (!Array.isArray(strings) || strings.length !== args.length + 1) {
    throw new QueryError("A fragment must have exactly one more string than it has arguments.");
  }
  let text = fragmentString(strings[0]);
  for (let i = 0; i < args.length; i++) {
    const arg = fragmentArg(ctx, frame, args[i] as ExprNode);
    const next = fragmentString(strings[i + 1]);
    // Keep a placeholder a token of its own: `$1` next to a word character or `$` would
    // read as another placeholder (`$10`), an identifier (`a$1`) or a dollar quote (`$$1`).
    text += separated(text, arg) + arg + (endsWithNumber(arg) && startsWord(next) ? " " : "") + next;
  }
  return text;
}

/**
 * One argument of a fragment. The text around it is unknown, so it is parenthesised unless
 * it is an atom, and a parameter with a type is cast to it: nothing else tells the
 * database what the placeholder holds (`generate_series($1, $2)` is ambiguous).
 */
function fragmentArg(ctx: Ctx, frame: Frame, node: ExprNode): string {
  if ((node.kind === "param" || node.kind === "namedParam") && node.type !== undefined) {
    return `cast(${expr(ctx, frame, node)} as ${typeName(ctx, node.type)})`;
  }
  return operand(ctx, frame, node, PRECEDENCE.atom);
}

function fragmentString(value: unknown): string {
  if (typeof value !== "string") throw new QueryError("A fragment's strings must be strings.");
  return value;
}

const WORD = /[A-Za-z0-9_$]/;

function separated(before: string, arg: string): string {
  return arg.startsWith("$") && before.length > 0 && WORD.test(before.charAt(before.length - 1)) ? " " : "";
}

function endsWithNumber(text: string): boolean {
  const last = text.charCodeAt(text.length - 1);
  return last >= 48 && last <= 57;
}

function startsWord(text: string): boolean {
  return text.length > 0 && WORD.test(text.charAt(0));
}

/**
 * `CASE … END`. In a select list (`selected`), a bare value among the results is cast to
 * its type, as a selected value is.
 */
function caseExpr(
  ctx: Ctx,
  frame: Frame,
  node: ExprNode & { kind: "case" },
  selected: string | undefined,
  typedBySibling: boolean,
): string {
  if (node.whens.length === 0) throw new QueryError("A CASE has no WHEN branch.");
  const where = selected === undefined ? undefined : `a result of a CASE in ${selected}`;
  // A result with a SQL type (a column, an expression, a typed value) types the others, as
  // a coalesce's arguments do: a bare value or NULL beside it is left to it, and a nested
  // CASE or coalesce with no typed value is cast to the first typed value's type, or else to
  // a column result's (see boundOperand).
  let typed = typedBySibling;
  let type: DbType | undefined;
  if (where !== undefined) {
    type = firstType(node);
    for (const branch of node.whens) {
      if (!noSqlType(branch.result) || !hasNoType(branch.result)) typed = true;
      if (type === undefined) type = columnType(frame, branch.result);
    }
    if (node.else !== undefined) {
      if (!noSqlType(node.else) || !hasNoType(node.else)) typed = true;
      if (type === undefined) type = columnType(frame, node.else);
    }
  }
  const result = (value: ExprNode) =>
    where === undefined ? expr(ctx, frame, value) : boundOperand(ctx, frame, value, where, typed, type);
  let text = "case";
  for (const branch of node.whens) {
    text += ` when ${expr(ctx, frame, branch.when)} then ${result(branch.result)}`;
  }
  if (node.else !== undefined) text += ` else ${result(node.else)}`;
  return `${text} end`;
}

/**
 * An expression in a place where nothing around it types it: a select list, a `RETURNING`
 * list, a values cell. A bare parameter is cast to its type, since the database cannot
 * tell what type a placeholder there has. A parameter without a type is allowed only for a
 * string or `null` (cast to the dialect's text type, which is right for them); any other
 * value is refused, here when the plan is made and again whenever the plan is bound with
 * other values (owner decision of 2026-10-15).
 */
function selectedValue(
  ctx: Ctx,
  frame: Frame,
  node: ExprNode,
  where: string,
  typedBySibling = false,
): string {
  if (node.kind === "param" || node.kind === "namedParam") {
    if (node.type !== undefined) return `cast(${expr(ctx, frame, node)} as ${typeName(ctx, node.type)})`;
    // Beside a value that is cast to its type (a CASE branch, a coalesce argument, the
    // other side of a comparison), the database gives this one the same type.
    if (typedBySibling) return expr(ctx, frame, node);
    return `cast(${textOnlyValue(ctx, node, where)} as ${ctx.dialect.types.text})`;
  }
  if (node.kind === "case") return caseExpr(ctx, frame, node, where, typedBySibling);
  // A coalesce of bound values only (at any depth) has no type in the SQL unless one is
  // written: its typed arguments are cast, and without any, only text is allowed.
  if (node.kind === "fn" && node.name === "coalesce" && node.args.length > 0 && node.args.every(noSqlType)) {
    const name = lookup(ctx.dialect.functions, node.name) as string;
    const typed = typedBySibling || !node.args.every(hasNoType);
    // An argument that is a CASE or coalesce with no typed value takes the type of the
    // first typed argument: the database would read it as text otherwise.
    const type = firstType(node);
    let args = "";
    for (let i = 0; i < node.args.length; i++) {
      args += `${i > 0 ? ", " : ""}${boundOperand(ctx, frame, node.args[i] as ExprNode, `coalesce() in ${where}`, typed, type)}`;
    }
    return `${name}(${args})`;
  }
  return expr(ctx, frame, node);
}

/**
 * The placeholder of an untyped value in a place where only text may go: a value that is
 * not a string or `null` is refused now, and on every later execution by the slot's
 * `toDb` (the plan is shared by queries with other values).
 */
function textOnlyValue(ctx: Ctx, node: ExprNode & { kind: "param" | "namedParam" }, where: string): string {
  if (node.kind === "namedParam") {
    if (typeof node.name !== "string" || node.name === "")
      throw new QueryError("A named parameter has no name.");
    return placeholder(ctx, { kind: "named", name: node.name, toDb: textOnly(where), redact: node.redact });
  }
  if (node.value !== null && typeof node.value !== "string") throw untypedValue(where, node.value);
  const index = ctx.index;
  ctx.index = index + 1;
  return placeholder(ctx, { kind: "inline", index, toDb: textOnly(where), redact: node.redact });
}

/** The operators that compare their operands: with neither typed, the database compares text. */
const COMPARISONS: ReadonlySet<string> = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "isDistinctFrom",
  "like",
  "notLike",
  "ilike",
]);

/** The arithmetic operators: with no typed operand, the database cannot choose one. */
const ARITHMETIC: ReadonlySet<string> = new Set(["add", "sub", "mul", "div", "mod"]);

/**
 * Whether `node` is a `CASE` or a `coalesce` made only of bound values and `NULL`s (see
 * {@link noSqlType}). The database reads one as text, whatever its placeholders hold.
 */
function isBoundCompound(node: ExprNode): boolean {
  return (node.kind === "case" || node.kind === "fn") && noSqlType(node);
}

/**
 * A `CASE` or `coalesce` of bound values only (see {@link isBoundCompound}) beside an
 * operand that has a type. Its typed values are cast to their types, which types the
 * rest. With no typed value in it, it is cast to `context`, the type of the column on the
 * other side: the column is the type context, as it is for a bare value (owner decision,
 * 2026-10-19). With neither, it is written as it is.
 */
function typedCompound(ctx: Ctx, frame: Frame, node: ExprNode, context: DbType | undefined): string {
  if (!hasNoType(node)) return selectedValue(ctx, frame, node, "an operand with a type", true);
  const text = expr(ctx, frame, node);
  return context === undefined ? text : `cast(${text} as ${sqlTypeName(ctx.dialect, context)})`;
}

/**
 * The database type of a column of a schema's field, when `node` is one: what a value
 * compared with it is cast to. `undefined` for anything else, and for a column of a
 * source with no schema.
 */
function columnType(frame: Frame, node: ExprNode): DbType | undefined {
  if (node.kind !== "column") return undefined;
  const field = resolveBinding(frame.scope, node.binding)?.entry.meta?.fieldsByName.get(node.field);
  return field !== undefined && field.column === node.column ? field.type.db : undefined;
}

/** The element type of an array type; `undefined` for any other. */
function elementType(type: DbType | undefined): DbType | undefined {
  return type?.kind === "array" ? type.of : undefined;
}

/**
 * Whether `node` is made of bound values only, so that the SQL itself says nothing of its
 * type: a parameter or list (typed in the AST or not), `NULL`, or a `CASE` or `coalesce`
 * of those, at any depth. Its type exists only if the emitter writes it (a cast).
 */
function noSqlType(node: ExprNode): boolean {
  switch (node.kind) {
    case "param":
    case "namedParam":
    case "list":
      return true;
    case "literal":
      return node.value === null;
    case "case":
      return (
        node.whens.every((branch) => noSqlType(branch.result)) &&
        (node.else === undefined || noSqlType(node.else))
      );
    case "fn":
      return node.name === "coalesce" && node.args.length > 0 && node.args.every(noSqlType);
    default:
      return false;
  }
}

/**
 * Whether nothing in `node` gives its value a type: an untyped parameter or list, `NULL`,
 * or a `CASE` or `coalesce` made only of those, at any depth. Called only on nodes for
 * which {@link noSqlType} holds, so a node is one of those kinds.
 */
function hasNoType(node: ExprNode): boolean {
  if (node.kind === "param" || node.kind === "namedParam" || node.kind === "list")
    return node.type === undefined;
  if (node.kind === "case") {
    return (
      node.whens.every((branch) => hasNoType(branch.result)) &&
      (node.else === undefined || hasNoType(node.else))
    );
  }
  // A coalesce (the one function noSqlType admits), or NULL.
  return node.kind !== "fn" || node.args.every(hasNoType);
}

function jsonPath(
  ctx: Ctx,
  frame: Frame,
  value: ExprNode,
  path: readonly ExprNode[],
  asText: boolean,
): string {
  if (path.length === 0) throw new QueryError("A JSON path has no keys.");
  const style = ctx.dialect.jsonPath;
  if (style === "pathFunctions") {
    const extracted = `json_extract(${operand(ctx, frame, value, PRECEDENCE.fragment)}, ${pathText(ctx, path)})`;
    return asText ? `json_unquote(${extracted})` : extracted;
  }
  const subject = operand(ctx, frame, value, PRECEDENCE.other);
  if (style === "pathOperators") return `${subject} ${asText ? "->>" : "->"} ${pathText(ctx, path)}`;
  if (style === "pathArray") {
    return `${subject} ${asText ? "#>>" : "#>"} array[${list(ctx, frame, path, PRECEDENCE.fragment)}]`;
  }
  let text = subject;
  for (let i = 0; i < path.length; i++) {
    const last = i === path.length - 1;
    text += ` ${last && asText ? "->>" : "->"} ${operand(ctx, frame, path[i] as ExprNode, PRECEDENCE.atom)}`;
  }
  return text;
}

/**
 * A JSON path as text built at execution from bound steps: `'$'` followed by one
 * placeholder per key, joined as the dialect concatenates text (`('$' || ? || ?)` or
 * `concat('$', ?, ?)`). Each key is bound through {@link jsonPathStep}, so the path is
 * made of values only.
 *
 * @throws QueryError when a key is not a bound value.
 */
function pathText(ctx: Ctx, path: readonly ExprNode[]): string {
  const steps: string[] = ["'$'"];
  for (const key of path) {
    if (key.kind === "param") {
      const index = ctx.index;
      ctx.index = index + 1;
      steps.push(placeholder(ctx, { kind: "inline", index, toDb: jsonPathStep, redact: key.redact }));
    } else if (key.kind === "namedParam") {
      if (typeof key.name !== "string" || key.name === "")
        throw new QueryError("A named parameter has no name.");
      steps.push(placeholder(ctx, { kind: "named", name: key.name, toDb: jsonPathStep, redact: key.redact }));
    } else {
      throw new QueryError(
        `A key of a JSON path on ${ctx.dialect.name} must be a value (a string or a whole number), not an expression.`,
      );
    }
  }
  return ctx.dialect.concat === "function" ? `concat(${steps.join(", ")})` : `(${steps.join(" || ")})`;
}

/**
 * Turns one key of a JSON path into its step of the path text: `."name"` for a string,
 * `[n]` for a whole number from 0. A name holding `"` or `\` is refused: the two
 * databases that take path text do not read escapes in it alike.
 *
 * @example
 * ```ts
 * jsonPathStep("theme"); // '."theme"'
 * jsonPathStep(0); // "[0]"
 * ```
 *
 * @throws QueryError for any other value.
 */
export function jsonPathStep(key: unknown): string {
  if (typeof key === "string") {
    if (key.includes('"') || key.includes("\\")) {
      throw new QueryError(
        "A key of a JSON path holds a double quote or a backslash, which this database cannot read in a path.",
      );
    }
    return `."${key}"`;
  }
  if (typeof key === "number" && Number.isSafeInteger(key) && key >= 0) return `[${key}]`;
  if (typeof key === "bigint" && key >= 0n) return `[${key}]`;
  throw new QueryError("A key of a JSON path is a string or a whole number from 0.");
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** What writing one query produced. */
interface Written {
  readonly sql: string;
  readonly output: OutputPlan | undefined;
  /** The resolved database schema of the root (or target) table; `undefined` when the root is not a table. */
  readonly rootSchema: string | undefined;
}

// Canonical positions of the top-level properties of a query (QueryAst declaration order;
// preloads are skipped by the parameter walk).
const FROM = 0;
const JOINS = 1;
const WHERES = 2;
const SELECT = 3;
const DISTINCT = 4;
const GROUP_BYS = 5;
const HAVINGS = 6;
const ORDER_BYS = 7;
const LIMIT = 8;
const OFFSET = 9;
const LOCK = 10;
const COMBINATIONS = 11;
const CTES = 12;
const WINDOWS = 13;
const UPDATES = 14;
const HINTS = 15;
const PROPERTIES = 16;

/** Where the values of each top-level property of `ast` start in canonical order, from `base`. */
function starts(ast: QueryAst, base: number): number[] {
  const counts = [
    valuesIn(ast.from),
    valuesInAll(ast.joins),
    valuesInAll(ast.wheres),
    valuesIn(ast.select),
    valuesIn(ast.distinct),
    valuesInAll(ast.groupBys),
    valuesInAll(ast.havings),
    valuesInAll(ast.orderBys),
    valuesIn(ast.limit),
    valuesIn(ast.offset),
    valuesIn(ast.lock),
    valuesInAll(ast.combinations),
    valuesInAll(ast.ctes),
    valuesInAll(ast.windows),
    valuesInAll(ast.updates),
    valuesInAll(ast.hints),
  ];
  const out: number[] = new Array(PROPERTIES + 1);
  let position = base;
  for (let i = 0; i < PROPERTIES; i++) {
    out[i] = position;
    position += counts[i] as number;
  }
  out[PROPERTIES] = position;
  if (position - base !== ast.params.length) {
    throw new QueryError(
      `The query's params hold ${ast.params.length} values, but its parameter nodes hold ${position - base}. Build queries with from(), or compute params with collectParams.`,
    );
  }
  return out;
}

/**
 * Writes a whole query as `operation` and returns its SQL, output plan and root schema.
 *
 * @example
 * ```ts
 * const ctx = newContext(postgresDialect, codecs);
 * const written = emitStatement(ctx, ast, "all", undefined);
 * ```
 *
 * @throws QueryError when the query is invalid or uses a feature the dialect lacks.
 */
export function emitStatement(
  ctx: EmitContext,
  ast: QueryAst,
  operation: QueryOperation,
  schema: string | undefined,
): Written {
  if (typeof ast !== "object" || ast === null || ast.kind !== "query") {
    throw new QueryError('compile() takes a query: from(User, "u")….');
  }
  return query(ctx, ast, undefined, schema, operation, "statement", undefined);
}

function nestedQuery(ctx: Ctx, frame: Frame, ast: QueryAst): string {
  return query(ctx, ast, frame.scope, frame.schema, "all", "statement", undefined).sql;
}

function query(
  ctx: Ctx,
  ast: QueryAst,
  parent: Scope | undefined,
  inherited: string | undefined,
  operation: QueryOperation,
  mode: AliasMode,
  onMain: ((output: OutputPlan | undefined) => void) | undefined,
): Written {
  const base = ctx.index;
  const start = starts(ast, base);
  const frame: Frame = {
    scope: newScope(parent),
    schema: ast.schema ?? inherited,
    outputs: undefined,
    bare: undefined,
  };
  if (operation !== "all" && operation !== "updateAll" && operation !== "deleteAll") {
    throw new QueryError(`Unknown query operation "${String(operation)}".`);
  }
  if (operation === "all" && ast.updates.length > 0) {
    throw new QueryError("The query has set(…) assignments; run it with updateAll.");
  }
  const withClause =
    ast.ctes.length === 0 ? "" : at(ctx, start[CTES] as number, () => ctes(ctx, frame, ast.ctes));
  bindSources(frame.scope, ast, frame.schema);
  const planned = planSelect(ast, frame.scope, operation, mode);
  frame.outputs = outputNames(planned.items);
  onMain?.(planned.output);
  const root = frame.scope.bindings.get(ast.from.alias);
  const rootSchema = root?.table === true ? root.schema : undefined;
  let written: { sql: string; output: OutputPlan | undefined };
  if (operation === "all") written = select(ctx, frame, ast, start, planned.items, planned.output, mode);
  else written = { sql: modify(ctx, frame, ast, start, planned.items, operation), output: planned.output };
  ctx.index = start[PROPERTIES] as number;
  return { sql: withClause + written.sql, output: written.output, rootSchema };
}

function ctes(ctx: Ctx, frame: Frame, nodes: readonly CteNode[]): string {
  let recursive = false;
  let text = "";
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as CteNode;
    if (node.recursive) recursive = true;
    const entry = cteEntry(frame.scope, node);
    let body: string;
    if (node.query.kind === "query") {
      const written = query(
        ctx,
        node.query,
        frame.scope,
        frame.schema,
        node.operation,
        "source",
        (output) => {
          entry.output = output;
        },
      );
      entry.output = written.output;
      body = written.sql;
    } else {
      if (node.operation !== "all")
        throw new QueryError(`The CTE "${node.name}" has a fragment body, which can only be read.`);
      body = fragment(ctx, frame, node.query);
    }
    frame.scope.ctes.set(node.name, entry);
    let materialized = "";
    if (node.materialized !== undefined) {
      if (!ctx.dialect.capabilities.cteMaterialized) throw unsupported(ctx.dialect, "MATERIALIZED on a CTE");
      materialized = node.materialized ? "materialized " : "not materialized ";
    }
    text += `${i > 0 ? ", " : ""}${quote(ctx, node.name)} as ${materialized}(${body})`;
  }
  return `with ${recursive ? "recursive " : ""}${text} `;
}

function select(
  ctx: Ctx,
  frame: Frame,
  ast: QueryAst,
  start: number[],
  items: readonly SelectItem[],
  output: OutputPlan | undefined,
  mode: AliasMode,
): { sql: string; output: OutputPlan | undefined } {
  let sql = "select ";
  if (ast.distinct !== undefined) {
    const on = ast.distinct.on;
    if (on.length === 0) sql += "distinct ";
    else {
      if (!ctx.dialect.capabilities.distinctOn) throw unsupported(ctx.dialect, "DISTINCT ON");
      sql += `distinct on (${at(ctx, start[DISTINCT] as number, () => list(ctx, frame, on, PRECEDENCE.fragment))}) `;
    }
  }
  sql += at(ctx, start[SELECT] as number, () => selectList(ctx, frame, items));
  sql += ` from ${at(ctx, start[FROM] as number, () => source(ctx, frame, ast.from))}`;
  if (ast.hints.length > 0) {
    sql += at(ctx, start[HINTS] as number, () => {
      let text = "";
      for (const hint of ast.hints) text += ` ${fragment(ctx, frame, hint)}`;
      return text;
    });
  }
  sql += at(ctx, start[JOINS] as number, () => joins(ctx, frame, ast.joins));
  if (ast.wheres.length > 0)
    sql += ` where ${at(ctx, start[WHERES] as number, () => bools(ctx, frame, ast.wheres))}`;
  if (ast.groupBys.length > 0) {
    sql += ` group by ${at(ctx, start[GROUP_BYS] as number, () => list(ctx, frame, ast.groupBys, PRECEDENCE.fragment))}`;
  }
  if (ast.havings.length > 0)
    sql += ` having ${at(ctx, start[HAVINGS] as number, () => bools(ctx, frame, ast.havings))}`;
  if (ast.windows.length > 0) {
    sql += at(ctx, start[WINDOWS] as number, () => {
      let text = " window ";
      for (let i = 0; i < ast.windows.length; i++) {
        const node = ast.windows[i] as (typeof ast.windows)[number];
        text += `${i > 0 ? ", " : ""}${windowName(ctx, node.name)} as (${windowSpec(ctx, frame, node.spec)})`;
      }
      return text;
    });
  }
  let result = output;
  if (ast.combinations.length > 0) {
    if (ast.lock !== undefined)
      throw new QueryError("A row lock cannot be combined with union(), intersect() or except().");
    ctx.index = start[COMBINATIONS] as number;
    const parenthesized = ctx.dialect.setOperand === "parenthesized";
    let loose = false;
    for (const combination of ast.combinations) {
      const op = lookup(SET_OPERATIONS, combination.op);
      if (op === undefined) throw new QueryError(`Unknown set operation "${String(combination.op)}".`);
      // Each set operation applies to everything before it. INTERSECT binds tighter than
      // UNION and EXCEPT in SQL, so what comes before it is grouped when it holds those.
      // A database that takes no parentheses here (SQLite) applies them left to right.
      if (op === "intersect" && loose && parenthesized) sql = `(${sql})`;
      if (op !== "intersect") loose = true;
      const branch = query(ctx, combination.query, frame.scope, frame.schema, "all", mode, undefined);
      result = mergeProvenance(result, branch.output);
      const operand = parenthesized ? `(${branch.sql})` : `select * from (${branch.sql})`;
      sql += ` ${op}${combination.all ? " all" : ""} ${operand}`;
    }
  }
  if (ast.orderBys.length > 0) {
    sql += ` order by ${at(ctx, start[ORDER_BYS] as number, () =>
      ast.combinations.length > 0
        ? combinedOrder(ctx, frame, ast.orderBys, items)
        : orderList(ctx, frame, ast.orderBys),
    )}`;
  }
  if (!ctx.dialect.capabilities.limitExpressions) {
    for (const bound of [ast.limit, ast.offset]) {
      if (
        bound !== undefined &&
        bound.kind !== "param" &&
        bound.kind !== "namedParam" &&
        bound.kind !== "literal"
      ) {
        throw unsupported(ctx.dialect, "A limit or offset that is an expression (not a value)");
      }
    }
  }
  if (ast.limit !== undefined) {
    const limit = ast.limit;
    sql += ` limit ${at(ctx, start[LIMIT] as number, () => operand(ctx, frame, limit, PRECEDENCE.fragment))}`;
  }
  if (ast.offset !== undefined) {
    const offset = ast.offset;
    const unlimited = ctx.dialect.offsetWithoutLimit;
    if (ast.limit === undefined && unlimited !== undefined) sql += ` limit ${unlimited}`;
    sql += ` offset ${at(ctx, start[OFFSET] as number, () => operand(ctx, frame, offset, PRECEDENCE.fragment))}`;
  }
  if (ast.lock !== undefined) {
    const lock = ast.lock;
    sql += at(ctx, start[LOCK] as number, () => lockClause(ctx, frame, lock.clause));
  }
  return { sql, output: result };
}

function selectList(ctx: Ctx, frame: Frame, items: readonly SelectItem[]): string {
  if (items.length === 0) return "1";
  let text = "";
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as SelectItem;
    if (i > 0) text += ", ";
    text +=
      item.kind === "expr"
        ? `${selectedValue(ctx, frame, item.expr, "the select list")} as ${quote(ctx, item.alias)}`
        : `${item.binding === frame.bare ? "" : `${quote(ctx, item.binding)}.`}${quote(ctx, item.column)} as ${quote(ctx, item.alias)}`;
  }
  return text;
}

/**
 * The `ORDER BY` of a set operation sorts the combined rows, so it can only name output
 * columns: each order item must be one of the selected expressions, and is written as its
 * output alias.
 */
function combinedOrder(
  ctx: Ctx,
  frame: Frame,
  nodes: readonly OrderNode[],
  items: readonly SelectItem[],
): string {
  let text = "";
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as OrderNode;
    const alias = outputAliasOf(node.expr, items);
    if (alias === undefined) {
      throw new QueryError(
        "orderBy() on a query combined with union(), intersect() or except() sorts the combined rows, so it can only use expressions the query selects.",
      );
    }
    // The order expression is not written; its values are skipped.
    ctx.index += valuesIn(node.expr);
    text += `${i > 0 ? ", " : ""}${orderItem(ctx, frame, node, quote(ctx, alias))}`;
  }
  return text;
}

function outputAliasOf(node: ExprNode, items: readonly SelectItem[]): string | undefined {
  if (node.kind === "selectedAs" && node.expr === undefined) {
    return items.some((item) => item.alias === node.name) ? node.name : undefined;
  }
  // Matched by structure only: the plan is shared by every query of this shape, whatever
  // its values, so the alias it picks must not depend on them.
  let found: string | undefined;
  for (const item of items) {
    const same =
      item.kind === "column"
        ? node.kind === "column" && node.binding === item.binding && node.column === item.column
        : item.expr === node || sameShape(item.expr, node);
    if (!same) continue;
    if (found !== undefined) {
      throw new QueryError(
        "orderBy() on a query combined with union(), intersect() or except() names an expression the query selects more than once (the same expression with other values counts as the same). Name the one to sort by with selectedAs(…) and order by that name.",
      );
    }
    found = item.alias;
  }
  return found;
}

function lockClause(ctx: Ctx, frame: Frame, clause: string | FragmentNode): string {
  if (typeof clause === "string") {
    // A dialect that ignores locks (SQLite: one writer) writes nothing for any clause
    // lock() can produce, whatever its capabilities list, and still refuses other strings.
    if (ctx.dialect.ignoresLocks && LOCK_CLAUSES.includes(clause)) return "";
    const sql = ctx.dialect.capabilities.lockModes.includes(clause)
      ? lookup(ctx.dialect.locks, clause)
      : undefined;
    if (sql === undefined) {
      throw new QueryError(
        `The lock clause "${clause}" is not one ${ctx.dialect.name} accepts as a string; use a fragment.`,
      );
    }
    return ` ${sql}`;
  }
  if (clause?.kind !== "fragment") throw new QueryError("A lock is a lock clause or a fragment.");
  // Not written at all where locks are ignored: writing it would add slots without placeholders.
  return ctx.dialect.ignoresLocks ? "" : ` ${fragment(ctx, frame, clause)}`;
}

/** Folds `where`/`having` entries into one condition: `where(a).where(b).orWhere(c)` is `(a and b) or c`. */
function bools(ctx: Ctx, frame: Frame, nodes: readonly BoolNode[]): string {
  return expr(ctx, frame, foldBools(nodes));
}

function foldBools(nodes: readonly BoolNode[]): ExprNode {
  let acc = (nodes[0] as BoolNode).expr;
  let args: ExprNode[] | undefined;
  let accOp: "and" | "or" | undefined;
  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i] as BoolNode;
    if (node.op !== "and" && node.op !== "or")
      throw new QueryError(`Unknown boolean operator "${String(node.op)}".`);
    if (args !== undefined && accOp === node.op) {
      args.push(node.expr);
    } else {
      args = [acc, node.expr];
      accOp = node.op;
      acc = { kind: "nary", op: node.op, args };
    }
  }
  return acc;
}

function source(ctx: Ctx, frame: Frame, node: SourceNode, lateral = false): string {
  const alias = quote(ctx, node.alias);
  switch (node.kind) {
    case "table": {
      const entry = frame.scope.bindings.get(node.alias);
      const schema = entry?.schema;
      const table = quote(ctx, node.source);
      return `${schema === undefined ? table : `${quote(ctx, schema)}.${table}`} as ${alias}`;
    }
    case "cteSource":
      return `${quote(ctx, node.name)} as ${alias}`;
    case "subquerySource":
      return `(${query(ctx, node.query, lateral ? frame.scope : sourceScope(frame.scope), frame.schema, "all", "source", undefined).sql}) as ${alias}`;
    case "values": {
      if (node.rows.length === 0) throw new QueryError(`The values source "${node.alias}" has no rows.`);
      const style = ctx.dialect.valuesSource;
      let text = "(values ";
      for (let r = 0; r < node.rows.length; r++) {
        const row = node.rows[r] as readonly ExprNode[];
        if (row.length !== node.columns.length) {
          throw new QueryError(
            `Row ${r} of the values source "${node.alias}" does not have one value per column.`,
          );
        }
        // A cell is typed by nothing around it, so its parameters are cast as in a select list.
        let cells = "";
        for (let c = 0; c < row.length; c++)
          cells += `${c > 0 ? ", " : ""}${selectedValue(ctx, frame, row[c] as ExprNode, "a values list")}`;
        text += `${r > 0 ? ", " : ""}${style === "valuesRow" ? "row" : ""}(${cells})`;
      }
      if (style === "valuesSelect") {
        // SQLite takes no column list after the alias; its values name their columns column1, column2, ….
        let names = "";
        for (let c = 0; c < node.columns.length; c++) {
          names += `${c > 0 ? ", " : ""}${quote(ctx, `column${c + 1}`)} as ${quote(ctx, node.columns[c] as string)}`;
        }
        return `(select ${names} from ${text})) as ${alias}`;
      }
      return `${text}) as ${alias} (${node.columns.map((column) => quote(ctx, column)).join(", ")})`;
    }
    case "fragmentSource": {
      const text = `${fragment(ctx, frame, node.fragment)} as ${alias}`;
      return node.columns.length === 0
        ? text
        : `${text} (${node.columns.map((column) => quote(ctx, column)).join(", ")})`;
    }
  }
}

function joins(ctx: Ctx, frame: Frame, nodes: readonly JoinNode[]): string {
  let text = "";
  for (const node of nodes) {
    const keyword = lookup(JOIN_KEYWORDS, node.type);
    if (keyword === undefined) throw new QueryError(`Unknown join kind "${String(node.type)}".`);
    if (node.type === "full" && !ctx.dialect.capabilities.fullJoin)
      throw unsupported(ctx.dialect, "FULL JOIN");
    if (
      (node.type === "innerLateral" || node.type === "leftLateral") &&
      !ctx.dialect.capabilities.lateralJoin
    ) {
      throw unsupported(ctx.dialect, "LATERAL JOIN");
    }
    const lateral = node.type === "innerLateral" || node.type === "leftLateral";
    text += ` ${keyword} ${source(ctx, frame, node.source, lateral)}`;
    if (node.type === "cross") {
      if (node.on !== undefined) throw new QueryError("A cross join has no condition.");
    } else {
      text += ` on ${node.on === undefined ? "true" : expr(ctx, frame, node.on)}`;
    }
  }
  return text;
}

/** `UPDATE … SET … [FROM …] [WHERE …] [RETURNING …]` and `DELETE FROM … [USING …] [WHERE …] [RETURNING …]`. */
function modify(
  ctx: Ctx,
  frame: Frame,
  ast: QueryAst,
  start: number[],
  items: readonly SelectItem[],
  operation: "updateAll" | "deleteAll",
): string {
  const verb = operation === "updateAll" ? "updateAll" : "deleteAll";
  const refuse = (clause: string): never => {
    throw new QueryError(`${verb} cannot run a query with ${clause}.`);
  };
  if (ast.distinct !== undefined) refuse("distinct()");
  if (ast.groupBys.length > 0) refuse("groupBy()");
  if (ast.havings.length > 0) refuse("having()");
  if (ast.orderBys.length > 0) refuse("orderBy()");
  if (ast.limit !== undefined) refuse("limit()");
  if (ast.offset !== undefined) refuse("offset()");
  if (ast.lock !== undefined) refuse("lock()");
  if (ast.combinations.length > 0) refuse("a set operation");
  if (ast.windows.length > 0) refuse("windows");
  if (ast.hints.length > 0) refuse("table hints");
  if (ast.from.kind !== "table") refuse("a root that is not a table");
  if (operation === "updateAll" && ast.updates.length === 0) {
    throw new QueryError("updateAll needs set(…) assignments.");
  }
  if (operation === "deleteAll" && ast.updates.length > 0) refuse("set(…) assignments");
  if (ast.joins.length > 0 && !ctx.dialect.capabilities.updateJoin) {
    throw unsupported(
      ctx.dialect,
      operation === "updateAll"
        ? "UPDATE … FROM (a join in updateAll)"
        : "DELETE … USING (a join in deleteAll)",
    );
  }
  if (items.length > 0 && !ctx.dialect.capabilities.returning) throw unsupported(ctx.dialect, "RETURNING");

  for (const node of ast.joins) {
    if (node.type !== "inner" && node.type !== "cross") {
      throw new QueryError(
        `${verb} can join only with join() or crossJoin(); a ${node.type} join has no meaning there.`,
      );
    }
  }
  const target = at(ctx, start[FROM] as number, () => source(ctx, frame, ast.from));
  // MySQL writes the joins as a join clause after the target, conditions included, and
  // names the target's columns with its alias in SET (a joined table may have the same).
  const joinClause = ast.joins.length > 0 && ctx.dialect.updateJoin === "joinClause";
  const joined = joinClause ? at(ctx, start[JOINS] as number, () => joins(ctx, frame, ast.joins)) : "";
  let sql: string;
  if (operation === "updateAll") {
    const owner = joinClause ? `${quote(ctx, ast.from.alias)}.` : "";
    sql = `update ${target}${joined} set ${at(ctx, start[UPDATES] as number, () => {
      let text = "";
      for (let i = 0; i < ast.updates.length; i++) {
        const node = ast.updates[i] as (typeof ast.updates)[number];
        text += `${i > 0 ? ", " : ""}${owner}${quote(ctx, node.column)} = ${expr(ctx, frame, node.value)}`;
      }
      return text;
    })}`;
  } else {
    sql = joinClause
      ? `delete ${quote(ctx, ast.from.alias)} from ${target}${joined}`
      : `delete from ${target}`;
  }
  // Joins become a FROM (UPDATE) or USING (DELETE) list, and their conditions part of WHERE.
  const conditions: string[] = [];
  if (ast.joins.length > 0 && !joinClause) {
    let joinStart = start[JOINS] as number;
    const sources: string[] = [];
    for (const node of ast.joins) {
      const sourceCount = valuesIn(node.source);
      sources.push(at(ctx, joinStart, () => source(ctx, frame, node.source)));
      if (node.on !== undefined) {
        const on = node.on;
        conditions.push(at(ctx, joinStart + sourceCount, () => operand(ctx, frame, on, PRECEDENCE.and)));
      }
      joinStart += sourceCount + valuesIn(node.on);
    }
    sql += `${operation === "updateAll" ? " from " : " using "}${sources.join(", ")}`;
  }
  if (ast.wheres.length > 0) {
    const condition = foldBools(ast.wheres);
    conditions.push(at(ctx, start[WHERES] as number, () => operand(ctx, frame, condition, PRECEDENCE.and)));
  }
  if (conditions.length > 0) sql += ` where ${conditions.join(" and ")}`;
  if (items.length > 0) {
    const returning: Frame =
      ctx.dialect.returningColumns === "bare" ? { ...frame, bare: ast.from.alias } : frame;
    sql += ` returning ${at(ctx, start[SELECT] as number, () => selectList(ctx, returning, items))}`;
  }
  return sql;
}

// ---------------------------------------------------------------------------
// Whole statements
// ---------------------------------------------------------------------------

/**
 * Finishes a statement: checks the parameter count against the dialect's limit and builds
 * the {@link CompiledQuery}.
 *
 * @example
 * ```ts
 * const plan = finish(ctx, sql, output, schema);
 * ```
 *
 * @throws QueryError when the statement has more placeholders than the dialect allows.
 */
export function finish(
  ctx: EmitContext,
  sql: string,
  output: OutputPlan | undefined,
  schema: string | undefined,
): CompiledQuery {
  if (ctx.slots.length > ctx.dialect.capabilities.maxParams) {
    throw new QueryError(
      `The statement has ${ctx.slots.length} parameters, more than the ${ctx.dialect.capabilities.maxParams} ${ctx.dialect.name} accepts. Split it into smaller statements.`,
    );
  }
  return { sql, slots: ctx.slots, output, schema, decoder: undefined };
}

/**
 * Writes a fragment as a whole statement (what `repo.raw` runs): its strings as written,
 * its values bound in canonical order.
 *
 * @example
 * ```ts
 * emitFragmentStatement(newContext(postgresDialect, codecs), node);
 * ```
 *
 * @throws QueryError when the fragment refers to a binding (a statement has none).
 */
export function emitFragmentStatement(ctx: EmitContext, node: FragmentNode): string {
  return fragment(
    ctx,
    { scope: newScope(undefined), schema: undefined, outputs: undefined, bare: undefined },
    node,
  );
}

/**
 * Writes an expression that belongs to no query (an insert cell, a conflict target) of a
 * row-level write, at the context's current canonical position. `schema` is the write's
 * `schema` argument: a query nested in the expression that sets no database schema of
 * its own inherits it, as the queries nested in a query inherit the `compile` argument.
 *
 * @example
 * ```ts
 * emitLooseExpr(ctx, fragmentNode(["lower(", ")"], [name]), "tenant_1");
 * ```
 */
export function emitLooseExpr(ctx: EmitContext, node: ExprNode, schema: string | undefined): string {
  return expr(ctx, { scope: newScope(undefined), schema, outputs: undefined, bare: undefined }, node);
}

/**
 * Writes a query that belongs to no statement of its own (`INSERT … SELECT`), with its
 * values starting at the context's current canonical position. `schema` is the write's
 * `schema` argument, inherited as {@link emitLooseExpr} does.
 *
 * @example
 * ```ts
 * emitLooseQuery(ctx, ast, "tenant_1");
 * ```
 */
export function emitLooseQuery(ctx: EmitContext, ast: QueryAst, schema: string | undefined): string {
  return query(ctx, ast, undefined, schema, "all", "statement", undefined).sql;
}
