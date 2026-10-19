/**
 * `sameShape(a, b)`: whether two AST nodes have the same structure, so that one compiled
 * plan serves both. It is how the plan cache confirms a hit found by the `shape` hash,
 * which can collide.
 *
 * It compares what `shape` hashes (`contracts/query.ts`, "Shape") and is stricter in two
 * places: a parameter's type and a source's schema metadata are compared by **identity**
 * (the hash only sees a type's name and a schema's name), because a plan holds the type's
 * conversion and the schema's metadata. It ignores what the hash ignores: parameter
 * values, list lengths, select constants and the queries of preloads.
 *
 * @module
 */
import type {
  CteNode,
  ExprNode,
  FragmentNode,
  OrderNode,
  PreloadNode,
  QueryAst,
  QueryNode,
  SelectShape,
  WindowNode,
} from "../contracts/query.js";
import { registeredEmitter } from "./registry.js";

/**
 * Whether `a` and `b` have the same structure: equal everywhere except in parameter
 * values, list lengths, select constants and preload queries.
 *
 * @example
 * ```ts
 * sameShape(from(User, "u").where(({ u }) => u.id.eq(1)).ast, from(User, "u").where(({ u }) => u.id.eq(2)).ast); // true
 * ```
 */
export function sameShape(a: QueryNode, b: QueryNode): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "column": {
      const o = b as typeof a;
      return a.binding === o.binding && a.column === o.column;
    }
    case "param":
    case "list": {
      const o = b as typeof a;
      return a.type === o.type && a.redact === o.redact;
    }
    case "namedParam": {
      const o = b as typeof a;
      return a.name === o.name && a.type === o.type && a.redact === o.redact;
    }
    case "literal":
      return a.value === (b as typeof a).value;
    case "unary": {
      const o = b as typeof a;
      return a.op === o.op && sameShape(a.operand, o.operand);
    }
    case "binary": {
      const o = b as typeof a;
      return a.op === o.op && sameShape(a.left, o.left) && sameShape(a.right, o.right);
    }
    case "between": {
      const o = b as typeof a;
      return sameShape(a.expr, o.expr) && sameShape(a.low, o.low) && sameShape(a.high, o.high);
    }
    case "nary": {
      const o = b as typeof a;
      return a.op === o.op && sameList(a.args, o.args);
    }
    case "fn": {
      const o = b as typeof a;
      return a.name === o.name && sameList(a.args, o.args);
    }
    case "aggregate": {
      const o = b as typeof a;
      return (
        a.name === o.name &&
        a.distinct === o.distinct &&
        sameList(a.args, o.args) &&
        sameOptional(a.filter, o.filter) &&
        sameOver(a.over, o.over)
      );
    }
    case "window": {
      const o = b as typeof a;
      return sameWindow(a, o);
    }
    case "ident":
      return a.name === (b as typeof a).name;
    case "fragment":
      return sameFragment(a, b as typeof a);
    case "cast": {
      const o = b as typeof a;
      return a.type === o.type && sameShape(a.expr, o.expr);
    }
    case "case": {
      const o = b as typeof a;
      if (a.whens.length !== o.whens.length || !sameOptional(a.else, o.else)) return false;
      for (let i = 0; i < a.whens.length; i++) {
        const x = a.whens[i] as (typeof a.whens)[number];
        const y = o.whens[i] as (typeof a.whens)[number];
        if (!sameShape(x.when, y.when) || !sameShape(x.result, y.result)) return false;
      }
      return true;
    }
    case "jsonPath": {
      const o = b as typeof a;
      return a.asText === o.asText && sameShape(a.expr, o.expr) && sameList(a.path, o.path);
    }
    case "subquery":
    case "exists":
      return sameQuery(a.query, (b as typeof a).query);
    case "tuple":
      return sameList(a.items, (b as typeof a).items);
    case "selectedAs": {
      const o = b as typeof a;
      return a.name === o.name && sameOptional(a.expr, o.expr);
    }
    case "star":
      return true;
    case "order":
      return sameOrder(a, b as typeof a);
    case "table": {
      const o = b as typeof a;
      return a.source === o.source && a.meta === o.meta && a.schema === o.schema && a.alias === o.alias;
    }
    case "cteSource": {
      const o = b as typeof a;
      return a.name === o.name && a.meta === o.meta && a.alias === o.alias;
    }
    case "subquerySource": {
      const o = b as typeof a;
      return a.alias === o.alias && sameQuery(a.query, o.query);
    }
    case "values": {
      const o = b as typeof a;
      if (a.alias !== o.alias || !sameStrings(a.columns, o.columns) || a.rows.length !== o.rows.length)
        return false;
      for (let i = 0; i < a.rows.length; i++) {
        if (!sameList(a.rows[i] as readonly ExprNode[], o.rows[i] as readonly ExprNode[])) return false;
      }
      return true;
    }
    case "fragmentSource": {
      const o = b as typeof a;
      return a.alias === o.alias && sameStrings(a.columns, o.columns) && sameFragment(a.fragment, o.fragment);
    }
    case "join": {
      const o = b as typeof a;
      return a.type === o.type && sameShape(a.source, o.source) && sameOptional(a.on, o.on);
    }
    case "bool": {
      const o = b as typeof a;
      return a.op === o.op && sameShape(a.expr, o.expr);
    }
    case "select":
      return sameSelect(a.shape, (b as typeof a).shape);
    case "distinct":
      return sameList(a.on, (b as typeof a).on);
    case "lock": {
      const o = b as typeof a;
      if (typeof a.clause === "string" || typeof o.clause === "string") return a.clause === o.clause;
      return sameFragment(a.clause, o.clause);
    }
    case "combination": {
      const o = b as typeof a;
      return a.op === o.op && a.all === o.all && sameQuery(a.query, o.query);
    }
    case "cte":
      return sameCte(a, b as typeof a);
    case "windowDef": {
      const o = b as typeof a;
      return a.name === o.name && sameWindow(a.spec, o.spec);
    }
    case "preload":
      return samePreload(a, b as typeof a);
    case "update": {
      const o = b as typeof a;
      return a.field === o.field && a.column === o.column && sameShape(a.value, o.value);
    }
    case "query":
      return sameQuery(a, b as typeof a);
    default: {
      const kind = (a as { kind: unknown }).kind;
      const emitter = typeof kind === "string" ? registeredEmitter(kind) : undefined;
      return emitter?.sameShape(a as never, b as never) === true;
    }
  }
}

function sameOptional(a: QueryNode | undefined, b: QueryNode | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return sameShape(a, b);
}

function sameList(a: readonly QueryNode[], b: readonly QueryNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameShape(a[i] as QueryNode, b[i] as QueryNode)) return false;
  return true;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameFragment(a: FragmentNode, b: FragmentNode): boolean {
  return sameStrings(a.strings, b.strings) && sameList(a.args, b.args);
}

function sameOver(a: WindowNode | string | undefined, b: WindowNode | string | undefined): boolean {
  if (a === undefined || b === undefined || typeof a === "string" || typeof b === "string") return a === b;
  return sameWindow(a, b);
}

function sameWindow(a: WindowNode, b: WindowNode): boolean {
  return (
    sameList(a.partitionBy, b.partitionBy) && sameList(a.orderBy, b.orderBy) && sameOptional(a.frame, b.frame)
  );
}

function sameOrder(a: OrderNode, b: OrderNode): boolean {
  return a.direction === b.direction && a.nulls === b.nulls && sameShape(a.expr, b.expr);
}

function sameCte(a: CteNode, b: CteNode): boolean {
  return (
    a.name === b.name &&
    a.operation === b.operation &&
    a.recursive === b.recursive &&
    a.materialized === b.materialized &&
    sameShape(a.query, b.query)
  );
}

function samePreload(a: PreloadNode, b: PreloadNode): boolean {
  // The preload's own query is a separate statement: not part of this plan.
  return a.assoc === b.assoc && a.from === b.from && sameList(a.nested, b.nested);
}

function sameSelect(a: SelectShape, b: SelectShape): boolean {
  if (a === b) return true;
  switch (a.kind) {
    case "expr":
      return b.kind === "expr" && a.type === b.type && sameShape(a.expr, b.expr);
    case "binding":
      return b.kind === "binding" && a.binding === b.binding && a.meta === b.meta;
    case "constant":
      // The value is `constants[index]`, outside the plan; the index is where it sits.
      return b.kind === "constant" && a.index === b.index;
    case "object": {
      if (b.kind !== "object" || !sameStrings(a.keys, b.keys) || a.values.length !== b.values.length)
        return false;
      for (let i = 0; i < a.values.length; i++) {
        if (!sameSelect(a.values[i] as SelectShape, b.values[i] as SelectShape)) return false;
      }
      return true;
    }
    case "tuple": {
      if (b.kind !== "tuple" || a.items.length !== b.items.length) return false;
      for (let i = 0; i < a.items.length; i++) {
        if (!sameSelect(a.items[i] as SelectShape, b.items[i] as SelectShape)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

function sameQuery(a: QueryAst, b: QueryAst): boolean {
  if (a === b) return true;
  return (
    a.shape === b.shape &&
    a.schema === b.schema &&
    sameShape(a.from, b.from) &&
    sameList(a.joins, b.joins) &&
    sameList(a.wheres, b.wheres) &&
    sameOptional(a.select, b.select) &&
    sameOptional(a.distinct, b.distinct) &&
    sameList(a.groupBys, b.groupBys) &&
    sameList(a.havings, b.havings) &&
    sameList(a.orderBys, b.orderBys) &&
    sameOptional(a.limit, b.limit) &&
    sameOptional(a.offset, b.offset) &&
    sameOptional(a.lock, b.lock) &&
    sameList(a.combinations, b.combinations) &&
    sameList(a.ctes, b.ctes) &&
    sameList(a.windows, b.windows) &&
    sameList(a.preloads, b.preloads) &&
    sameList(a.updates, b.updates) &&
    sameList(a.hints, b.hints)
  );
}
