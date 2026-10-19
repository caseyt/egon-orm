/**
 * Row values, `(a, b)`, compared as a whole: `tuple(p.createdAt, p.id).lt(tuple(cursor.createdAt, cursor.id))`,
 * the condition of keyset pagination. Rows compare position by position, the first
 * difference deciding.
 *
 * @module
 */
import type { BinaryOp, ExprNode, NamedParamNode } from "../../contracts/query.js";
import { QueryError } from "../../errors.js";
import { booleanType } from "../../types/index.js";
import { binaryNode, foldShape, shapeOfBinary, startTuple, tupleNode } from "../ast.js";
import {
  type AnyExpr,
  type CompatibleParams,
  Expr,
  isExpr,
  join,
  joinNamed,
  type MergeParams,
  NONE,
  type NoParams,
  type ParamsOfAll,
  toOperand,
  type ValueOf,
} from "../expr.js";

const BOOLEAN = booleanType();

/** A plain value's type widened to its primitive: `tuple(cursor, 10)` holds a `number`, not `10`. */
type Widen<V> = V extends string
  ? string
  : V extends number
    ? number
    : V extends bigint
      ? bigint
      : V extends boolean
        ? boolean
        : V;

/** Each value of a row, or `null`: what the other side of a comparison may hold at each position. */
type Operands<V extends readonly unknown[]> = { readonly [K in keyof V]: V[K] | null };

/**
 * A row value: `(a, b, …)`. Its items are expressions or plain values; a plain value is
 * bound with the type of the expression at the same position of the other row.
 *
 * @example
 * ```ts
 * const cursor: Tuple<[Date, number]> = tuple(p.createdAt, p.id);
 * ```
 */
export class Tuple<V extends readonly unknown[], P = NoParams> {
  /** Type information only; there is no such property at run time. */
  declare readonly "~tuple": { readonly values: V; readonly params: (params: P) => void };
  /** The items as given: expressions and plain values. */
  readonly items: readonly unknown[];

  /**
   * Internal: rows are made by {@link tuple}.
   *
   * @example
   * ```ts
   * new Tuple([p.createdAt, p.id]);
   * ```
   */
  constructor(items: readonly unknown[]) {
    this.items = items;
  }

  /**
   * `(a, b) = (x, y)`.
   *
   * @example
   * ```ts
   * tuple(m.orgId, m.userId).eq(tuple(orgId, userId));
   * ```
   *
   * @throws QueryError as {@link Tuple.lt}.
   */
  eq<V2 extends Operands<V>, P2>(
    other: Tuple<V2, P2> & CompatibleParams<P, P2>,
  ): Expr<boolean, MergeParams<P, P2>> {
    return compare("eq", this, other) as never;
  }

  /**
   * `(a, b) <> (x, y)`.
   *
   * @example
   * ```ts
   * tuple(m.orgId, m.userId).neq(tuple(orgId, userId));
   * ```
   *
   * @throws QueryError as {@link Tuple.lt}.
   */
  neq<V2 extends Operands<V>, P2>(
    other: Tuple<V2, P2> & CompatibleParams<P, P2>,
  ): Expr<boolean, MergeParams<P, P2>> {
    return compare("neq", this, other) as never;
  }

  /**
   * `(a, b) < (x, y)`: `a < x`, or `a = x` and `b < y`.
   *
   * @example
   * ```ts
   * tuple(p.createdAt, p.id).lt(tuple(cursor.createdAt, cursor.id));
   * ```
   *
   * @throws QueryError when the rows have different lengths, a value is `null` or
   * `undefined`, or neither row gives a position a type (two plain values).
   */
  lt<V2 extends Operands<V>, P2>(
    other: Tuple<V2, P2> & CompatibleParams<P, P2>,
  ): Expr<boolean, MergeParams<P, P2>> {
    return compare("lt", this, other) as never;
  }

  /**
   * `(a, b) <= (x, y)`.
   *
   * @example
   * ```ts
   * tuple(p.createdAt, p.id).lte(tuple(cursor.createdAt, cursor.id));
   * ```
   *
   * @throws QueryError as {@link Tuple.lt}.
   */
  lte<V2 extends Operands<V>, P2>(
    other: Tuple<V2, P2> & CompatibleParams<P, P2>,
  ): Expr<boolean, MergeParams<P, P2>> {
    return compare("lte", this, other) as never;
  }

  /**
   * `(a, b) > (x, y)`.
   *
   * @example
   * ```ts
   * tuple(p.createdAt, p.id).gt(tuple(cursor.createdAt, cursor.id));
   * ```
   *
   * @throws QueryError as {@link Tuple.lt}.
   */
  gt<V2 extends Operands<V>, P2>(
    other: Tuple<V2, P2> & CompatibleParams<P, P2>,
  ): Expr<boolean, MergeParams<P, P2>> {
    return compare("gt", this, other) as never;
  }

  /**
   * `(a, b) >= (x, y)`.
   *
   * @example
   * ```ts
   * tuple(p.createdAt, p.id).gte(tuple(cursor.createdAt, cursor.id));
   * ```
   *
   * @throws QueryError as {@link Tuple.lt}.
   */
  gte<V2 extends Operands<V>, P2>(
    other: Tuple<V2, P2> & CompatibleParams<P, P2>,
  ): Expr<boolean, MergeParams<P, P2>> {
    return compare("gte", this, other) as never;
  }
}

/**
 * A row value for a row comparison: `tuple(p.createdAt, p.id)`. Items are expressions or
 * plain values (bound with the type of the other row's expression at that position).
 *
 * @example
 * ```ts
 * from(Post, "p")
 *   .where(({ p }) => tuple(p.createdAt, p.id).lt(tuple(cursor.createdAt, cursor.id)))
 *   .orderBy(({ p }) => [p.createdAt.desc(), p.id.desc()])
 *   .limit(20);
 * ```
 *
 * @throws QueryError when given no item, or an item that is `undefined`.
 */
export function tuple<const A extends readonly [unknown, ...unknown[]]>(
  ...items: A
): Tuple<{ -readonly [K in keyof A]: Widen<ValueOf<A[K]>> }, ParamsOfAll<A>> {
  if (items.length === 0) throw new QueryError("tuple() needs at least one item.");
  for (const item of items) {
    if (item === undefined) throw new QueryError("tuple() was given undefined, which is not a value.");
  }
  return new Tuple(items.slice()) as never;
}

/** Whether nothing gives an expression a type in the SQL: an untyped bound value or `NULL`. */
function untyped(expr: AnyExpr): boolean {
  const node = expr.node;
  return (
    ((node.kind === "param" || node.kind === "namedParam" || node.kind === "list") &&
      node.type === undefined) ||
    (node.kind === "literal" && node.value === null)
  );
}

function compare(op: BinaryOp, left: { readonly items: readonly unknown[] }, right: unknown): AnyExpr {
  if (!(right instanceof Tuple)) {
    throw new QueryError(`${op}() on a tuple takes another tuple: tuple(a, b).${op}(tuple(x, y)).`);
  }
  const a = left.items;
  const b = right.items as readonly unknown[];
  if (a.length !== b.length) {
    throw new QueryError(
      `${op}(): the rows have ${a.length} and ${b.length} items; rows compare position by position, so they need as many.`,
    );
  }
  const leftItems: AnyExpr[] = [];
  const rightItems: AnyExpr[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    const xTyped = isExpr(x) && !untyped(x);
    const yTyped = isExpr(y) && !untyped(y);
    if (!xTyped && !yTyped) {
      throw new QueryError(
        `${op}(): position ${i + 1} of the rows has no type on either side, so the database would compare it as text. Put a column there, or give one value a type: val(value, t.integer()).`,
      );
    }
    const lx = isExpr(x) ? x : undefined;
    const ry = isExpr(y) ? y : undefined;
    leftItems.push(toOperand(x, ry?.type, ry?.redact ?? false, op, true));
    rightItems.push(toOperand(y, lx?.type, lx?.redact ?? false, op, true));
  }
  const leftRow = row(leftItems);
  const rightRow = row(rightItems);
  return new Expr(
    binaryNode(op, leftRow.node, rightRow.node),
    BOOLEAN,
    false,
    join(leftRow.params, rightRow.params),
    join(leftRow.lists, rightRow.lists),
    joinNamed(leftRow.named, rightRow.named),
    shapeOfBinary(op, leftRow.shape, rightRow.shape),
  );
}

interface Row {
  readonly node: ExprNode;
  readonly params: readonly unknown[];
  readonly lists: readonly number[];
  readonly named: readonly NamedParamNode[];
  readonly shape: number;
}

function row(items: readonly AnyExpr[]): Row {
  const nodes: ExprNode[] = [];
  let params: readonly unknown[] = NONE;
  let lists: readonly number[] = NONE;
  let named: readonly NamedParamNode[] = NONE;
  let shape = startTuple();
  for (const item of items) {
    nodes.push(item.node);
    params = join(params, item.params);
    lists = join(lists, item.lists);
    named = joinNamed(named, item.named);
    shape = foldShape(shape, item.shape);
  }
  return { node: tupleNode(nodes), params, lists, named, shape };
}
