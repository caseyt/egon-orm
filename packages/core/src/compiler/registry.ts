/**
 * The precedence table of the SQL emitter, and the registry through which a later step
 * teaches the emitter expression node kinds of its own (step 09).
 *
 * @module
 */
import type { ExprNode, QueryAst, QueryNode } from "../contracts/query.js";
import { QueryError } from "../errors.js";
import type { SqlDialect } from "./dialect.js";

/**
 * Binding strength of each kind of SQL expression, weakest first. An operand whose
 * precedence is below what its position needs is wrapped in parentheses.
 *
 * A fragment is the weakest of all (its text is unknown), so it is parenthesised whenever
 * it is an operand.
 *
 * @example
 * ```ts
 * PRECEDENCE.and < PRECEDENCE.comparison; // true
 * ```
 */
export const PRECEDENCE = Object.freeze({
  fragment: 0,
  or: 1,
  and: 2,
  not: 3,
  is: 4,
  comparison: 5,
  like: 6,
  other: 7,
  additive: 8,
  multiplicative: 9,
  unary: 10,
  atom: 11,
});

/**
 * What an extension's emitter may ask the emitter for, while writing one node.
 *
 * @example
 * ```ts
 * const emitLateralValues: NodeEmitter["emit"] = (node, api) => `lateral ${api.expr(node.inner, 0)}`;
 * ```
 */
export interface EmitApi {
  readonly dialect: SqlDialect;
  /** Writes an expression, in parentheses when its precedence is below `minPrecedence`. */
  expr(node: ExprNode, minPrecedence: number): string;
  /** Writes a nested query (without parentheses), with this query as its outer scope. */
  query(ast: QueryAst): string;
  /** Quotes an identifier. */
  quote(name: string): string;
}

/**
 * How to emit, rank and compare an expression node kind that this module does not know
 * (step 09 adds kinds this way). Its values must be visited by `collectParams` too.
 *
 * @example
 * ```ts
 * registerNodeEmitter("myNode", {
 *   precedence: PRECEDENCE.atom,
 *   emit: (node, api) => api.quote("x"),
 *   sameShape: () => true,
 * });
 * ```
 */
export interface NodeEmitter {
  readonly precedence: number;
  emit(node: never, api: EmitApi): string;
  /** Whether two nodes of this kind have the same structure (parameter values ignored). */
  sameShape(a: never, b: never): boolean;
}

const BUILT_IN_KINDS: ReadonlySet<string> = new Set<QueryNode["kind"]>([
  "column",
  "param",
  "namedParam",
  "list",
  "literal",
  "unary",
  "binary",
  "between",
  "nary",
  "fn",
  "aggregate",
  "ident",
  "fragment",
  "cast",
  "case",
  "jsonPath",
  "subquery",
  "exists",
  "tuple",
  "selectedAs",
  "star",
  "order",
  "window",
  "table",
  "cteSource",
  "subquerySource",
  "values",
  "fragmentSource",
  "join",
  "bool",
  "select",
  "distinct",
  "lock",
  "combination",
  "cte",
  "windowDef",
  "preload",
  "update",
  "query",
]);

const registry = new Map<string, NodeEmitter>();

/**
 * Teaches the emitter an expression node kind of its own.
 *
 * @example
 * ```ts
 * registerNodeEmitter("myNode", { precedence: PRECEDENCE.atom, emit: () => "true", sameShape: () => true });
 * ```
 *
 * @throws QueryError when `kind` is a built-in kind or is already registered.
 */
export function registerNodeEmitter(kind: string, emitter: NodeEmitter): void {
  if (BUILT_IN_KINDS.has(kind) || registry.has(kind)) {
    throw new QueryError(`The node kind "${kind}" already has an emitter.`);
  }
  registry.set(kind, emitter);
}

/**
 * The emitter registered for `kind`, if any.
 *
 * @example
 * ```ts
 * registeredEmitter("myNode")?.precedence;
 * ```
 */
export function registeredEmitter(kind: string): NodeEmitter | undefined {
  return registry.get(kind);
}
