/**
 * What a `select` callback may return, the result type it gives ({@link Sel}), and how
 * its return value becomes a {@link SelectNode}: the output tree that the compiler
 * flattens into a select list and the repo turns into a row decoder.
 *
 * The shapes are: an expression, a whole binding (its row), an object or an array of
 * those, nested to any depth, and plain values, which are returned as they are and never
 * sent to the database.
 *
 * @module
 */
import type { NamedParamNode, SelectNode, SelectShape } from "../contracts/query.js";
import { QueryError, rewrap } from "../errors.js";
import { isPlainObject } from "../internal/plain-object.js";
import { Tuple } from "./advanced/tuple.js";
import { collectParams } from "./ast.js";
import { bindingInfo } from "./bindings.js";
import { isExpr, isSubqueryOperand, joinNamed, NONE, OrderExpr } from "./expr.js";

/** Values a select returns as they are, which are not looked into. */
type Opaque = Date | Uint8Array | ((...args: never[]) => unknown);

/**
 * The result type of a select that returned `X`: an expression gives its value type, a
 * binding its row (`| null` when an outer join makes it optional), an object or array the
 * same structure of results, and anything else itself.
 *
 * @example
 * ```ts
 * type R = Sel<{ id: Col<number>; author: Binding<typeof User>; kind: string }>;
 * // { id: number; author: User; kind: string }
 * ```
 */
export type Sel<X> = X extends { readonly "~expr": { readonly type: infer T } }
  ? T
  : X extends { readonly "~binding": { readonly row: infer Rw; readonly nullable: infer N } }
    ? [N] extends [false]
      ? Rw
      : Rw | null
    : X extends Opaque
      ? X
      : X extends readonly unknown[]
        ? { -readonly [K in keyof X]: Sel<X[K]> }
        : X extends object
          ? { -readonly [K in keyof X]: Sel<X[K]> }
          : X;

/**
 * A `select` as the builder adds it: the node, and its parameters in canonical order.
 *
 * @example
 * ```ts
 * const built = buildSelect({ id: u.id }, "select");
 * built.node.shape.kind; // "object"
 * ```
 */
export interface BuiltSelect {
  readonly node: SelectNode;
  readonly params: readonly unknown[];
  readonly lists: readonly number[];
  readonly named: readonly NamedParamNode[];
}

interface Collector {
  params: unknown[];
  lists: number[];
  named: readonly NamedParamNode[];
  constants: unknown[];
}

/**
 * Turns what a select callback returned into a {@link SelectNode}, collecting the
 * parameters of its expressions in canonical order (the shape tree depth first, object
 * values in key order) and its plain values as constants.
 *
 * @example
 * ```ts
 * buildSelect([u.id, count(p.id)], "select").node.shape.kind; // "tuple"
 * ```
 *
 * @throws QueryError naming `clause` when the value holds something that cannot be
 * selected: an order item, a query, a function, a symbol, or a binding with no schema.
 */
export function buildSelect(value: unknown, clause: string): BuiltSelect {
  const collector: Collector = { params: [], lists: [], named: NONE, constants: [] };
  const shape = shapeOfValue(value, collector, clause, "");
  return {
    node: selectNode(shape, collector.constants.length === 0 ? NONE : collector.constants),
    params: collector.params.length === 0 ? NONE : collector.params,
    lists: collector.lists.length === 0 ? NONE : collector.lists,
    named: collector.named,
  };
}

/**
 * A {@link SelectNode}, its properties in contract order.
 *
 * @example
 * ```ts
 * selectNode({ kind: "constant", index: 0 }, ["user"]);
 * ```
 */
export function selectNode(shape: SelectShape, constants: readonly unknown[]): SelectNode {
  return { kind: "select", shape, constants };
}

function where(path: string): string {
  return path === "" ? "" : ` at "${path}"`;
}

function shapeOfValue(value: unknown, out: Collector, clause: string, path: string): SelectShape {
  if (isExpr(value)) {
    for (const param of value.params) out.params.push(param);
    for (const length of value.lists) out.lists.push(length);
    try {
      out.named = joinNamed(out.named, value.named);
    } catch (error) {
      // One name with two types among the select's own expressions: name the clause.
      if (error instanceof QueryError) throw rewrap(error, (short) => `${clause}(): ${short}`);
      throw error;
    }
    return { kind: "expr", expr: value.node, type: value.type };
  }
  if (typeof value === "object" && value !== null) {
    const info = bindingInfo(value);
    if (info !== undefined) {
      if (info.meta === undefined) {
        throw new QueryError(
          "query.selectBinding",
          `${clause}() was given the whole binding "${info.alias}"${where(path)}, which has no schema to read rows of.`,
        );
      }
      return { kind: "binding", binding: info.alias, meta: info.meta };
    }
    if (value instanceof OrderExpr) {
      throw new QueryError(
        "query.selectOrderItem",
        `${clause}() was given an order item (asc() or desc())${where(path)}.`,
      );
    }
    if (value instanceof Tuple) {
      throw new QueryError("query.selectTuple", `${clause}() was given a row value (tuple)${where(path)}.`);
    }
    if (isSubqueryOperand(value)) {
      throw new QueryError("query.selectQuery", `${clause}() was given a query${where(path)}.`);
    }
    if (Array.isArray(value)) {
      const items: SelectShape[] = [];
      for (let i = 0; i < value.length; i++) {
        items.push(shapeOfValue(value[i], out, clause, path === "" ? String(i) : `${path}.${i}`));
      }
      return { kind: "tuple", items };
    }
    if (isPlainObject(value)) {
      const keys: string[] = [];
      const values: SelectShape[] = [];
      for (const key of Object.keys(value)) {
        keys.push(key);
        values.push(
          shapeOfValue(
            (value as Record<string, unknown>)[key],
            out,
            clause,
            path === "" ? key : `${path}.${key}`,
          ),
        );
      }
      return { kind: "object", keys, values };
    }
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new QueryError(
      "query.selectValue",
      `${clause}() was given a ${typeof value}${where(path)}, which is not a value.`,
    );
  }
  out.constants.push(value);
  return { kind: "constant", index: out.constants.length - 1 };
}

/**
 * The select of `base` with the keys of `extra` added; a key that both have takes the new
 * value in the old position. Both must be object selects. The constants are those the
 * merged shape refers to, numbered as a select of that shape numbers them (a replaced
 * plain value is dropped), and the parameters are re-collected in canonical order.
 *
 * @example
 * ```ts
 * mergeSelects(base.node, buildSelect({ views: p.views }, "selectMerge").node);
 * ```
 */
export function mergeSelects(base: SelectNode, extra: SelectNode): BuiltSelect {
  // The builder checks both before it merges.
  const left = base.shape as Extract<SelectShape, { kind: "object" }>;
  const right = extra.shape as Extract<SelectShape, { kind: "object" }>;
  const offset = base.constants.length;
  const keys = left.keys.slice();
  const values = left.values.slice();
  for (let i = 0; i < right.keys.length; i++) {
    const key = right.keys[i] as string;
    const shape = renumber(right.values[i] as SelectShape, offset);
    const at = keys.indexOf(key);
    if (at === -1) {
      keys.push(key);
      values.push(shape);
    } else {
      values[at] = shape;
    }
  }
  // The constants both selects hold, then only those the merged shape still refers to,
  // numbered in the order a select of that shape would number them.
  const pool = extra.constants.length === 0 ? base.constants : [...base.constants, ...extra.constants];
  const constants: unknown[] = [];
  const shape = compact({ kind: "object", keys, values }, pool, constants);
  const node = selectNode(shape, constants.length === 0 ? NONE : constants);
  const params: unknown[] = [];
  const lists: number[] = [];
  const named: NamedParamNode[] = [];
  collectParams(node, params, lists, named);
  return {
    node,
    params: params.length === 0 ? NONE : params,
    lists: lists.length === 0 ? NONE : lists,
    named: named.length === 0 ? NONE : named,
  };
}

/** `shape` with its constants taken from `pool` and appended to `out`, renumbered in walk order. */
function compact(shape: SelectShape, pool: readonly unknown[], out: unknown[]): SelectShape {
  switch (shape.kind) {
    case "constant":
      out.push(pool[shape.index]);
      return { kind: "constant", index: out.length - 1 };
    case "object":
      return { kind: "object", keys: shape.keys, values: shape.values.map((v) => compact(v, pool, out)) };
    case "tuple":
      return { kind: "tuple", items: shape.items.map((v) => compact(v, pool, out)) };
    default:
      return shape;
  }
}

function renumber(shape: SelectShape, offset: number): SelectShape {
  if (offset === 0) return shape;
  switch (shape.kind) {
    case "constant":
      return { kind: "constant", index: shape.index + offset };
    case "object":
      return { kind: "object", keys: shape.keys, values: shape.values.map((v) => renumber(v, offset)) };
    case "tuple":
      return { kind: "tuple", items: shape.items.map((v) => renumber(v, offset)) };
    default:
      return shape;
  }
}
