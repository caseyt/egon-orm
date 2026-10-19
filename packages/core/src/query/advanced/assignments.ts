/**
 * The assignments of a bulk update, `.set({ … })` or `.set(({ p }) => ({ … }))`, and the
 * `RETURNING` list of an update or delete, `.returning(…)`.
 *
 * A value is a plain value, bound as a parameter with the field's type (and redacted when
 * the field is), or an expression (`p.views.add(1)`, `p.tagList.append("x")`). The
 * builder runs `repo.updateAll` and `repo.deleteAll` queries through the same AST as a
 * select: `set` fills `QueryAst.updates`, `returning` fills `QueryAst.select`.
 *
 * This module is imported by the query builder, so it does not import the builder.
 *
 * @module
 */
import type { ExprNode, SelectNode, UpdateNode } from "../../contracts/query.js";
import type { SchemaMeta } from "../../contracts/schema.js";
import { QueryError } from "../../errors.js";
import { HASH_SEED, hashInt, hashString } from "../../internal/hash.js";
import { isPlainObject } from "../../internal/plain-object.js";
import { isExpr, isNullOperand, toOperand } from "../expr.js";
import { checkNoWindows } from "./windows.js";

const UPDATE_SEED = hashString(HASH_SEED, "update");

/**
 * The select nodes made by `.returning(…)`. A query whose select is one of them may be
 * given `.set(…)`; one with a select made by `.select(…)` may not, since it would be
 * written as `RETURNING` without saying so.
 *
 * @example
 * ```ts
 * RETURNING_SELECTS.has(query.ast.select); // true after returning(…)
 * ```
 */
export const RETURNING_SELECTS: WeakSet<SelectNode> = new WeakSet();

/**
 * The shape of an assignment, from the shape its value already carries (as `shapeOf`
 * defines it).
 *
 * @example
 * ```ts
 * updateShape("views", "views", valueShape);
 * ```
 */
export function updateShape(field: string, column: string, valueShape: number): number {
  return hashInt(hashString(hashString(UPDATE_SEED, field), column), valueShape);
}

/** A bound value. */
type BoundLeaf = Extract<ExprNode, { readonly kind: "param" | "namedParam" }>;

/**
 * The bound values a value is made of when nothing but bound values makes it (a
 * parameter, `NULL`, or a `CASE` or `coalesce` of those, at any depth); `undefined` when
 * something in it gives it a type in SQL (a column, an operator, a function).
 */
function boundLeaves(node: ExprNode, out: BoundLeaf[]): BoundLeaf[] | undefined {
  switch (node.kind) {
    case "param":
    case "namedParam":
      out.push(node);
      return out;
    case "literal":
      return node.value === null ? out : undefined;
    case "case":
      for (const branch of node.whens) if (boundLeaves(branch.result, out) === undefined) return undefined;
      return node.else === undefined ? out : boundLeaves(node.else, out);
    case "fn":
      if (node.name !== "coalesce") return undefined;
      for (const arg of node.args) if (boundLeaves(arg, out) === undefined) return undefined;
      return out;
    default:
      return undefined;
  }
}

/**
 * Whether a value assigned by `set` is made only of bound values and `NULL`, none of which
 * has a type (owner decision, option A; review rounds 1 to 3): `val(x)` without a type, or a
 * `CASE` or `coalesce` of such values or of `NULL`s only. The database types a bare
 * parameter from the column, but not a `CASE` or a `coalesce`, which it reads as text and
 * refuses for any column that is not text (an integer, a uuid, a date, a decimal). The types
 * cannot tell a bare `val("x")` from such a `CASE`, nor a text column from a uuid one, so
 * one rule holds in both: such a value is refused for every field. A plain value (bound
 * with the field's type), a typed `val(x, t.uuid())`, or a `CASE` with one typed branch is
 * the way. A bare `NULL` (`lit(null)`) stays allowed: the column types it.
 */
function untypedValue(node: ExprNode): boolean {
  const leaves = boundLeaves(node, []);
  if (leaves === undefined) return false;
  for (const leaf of leaves) if (leaf.type !== undefined) return false;
  // A bare NULL is typed by the column; anything else made only of untyped values is not.
  return leaves.length > 0 || node.kind !== "literal";
}

/** The assignments a `set` call adds. */
export interface BuiltAssignments {
  /** Every assignment of the query after the call, in the order fields were first set. */
  readonly nodes: readonly UpdateNode[];
  /** The shapes of {@link nodes}, in order. */
  readonly shapes: readonly number[];
  /** Whether the call replaced a field an earlier call set. */
  readonly replaced: boolean;
}

/**
 * The assignments of a query after `set(values)`: one per key, a field of `meta` that is
 * a column. A key set before is replaced in its place (later keys win).
 *
 * @example
 * ```ts
 * assignments({ published: true }, meta(Post), [], []);
 * ```
 *
 * @throws QueryError when `values` is not an object of at least one key, a key is not a
 * column of the schema, or a value is `undefined`, or `null` for a field that is not nullable.
 */
export function assignments(
  values: unknown,
  meta: SchemaMeta,
  existing: readonly UpdateNode[],
  existingShapes: readonly number[],
): BuiltAssignments {
  if (typeof values !== "object" || values === null || !isPlainObject(values) || isExpr(values)) {
    throw new QueryError(
      "set() takes an object of field values, or a callback that returns one: set({ published: true }), set(({ p }) => ({ views: p.views.add(1) })).",
    );
  }
  const keys = Object.keys(values);
  if (keys.length === 0) throw new QueryError("set() was given no field. Set at least one.");
  const nodes = existing.slice();
  const shapes = existingShapes.slice();
  let replaced = false;
  for (const key of keys) {
    const field = meta.fieldsByName.get(key);
    if (field === undefined || field.virtual) {
      const columns = meta.persisted.map((f) => f.name);
      throw new QueryError(
        `set({ ${key} }): ${meta.name} has no ${field === undefined ? "field" : "column for the virtual field"} "${key}". Its columns are: ${columns.join(", ")}.`,
      );
    }
    const value = (values as Record<string, unknown>)[key];
    if (value === undefined) {
      throw new QueryError(
        `set({ ${key}: undefined }): undefined is not a value. Leave the key out, or pass null to store NULL.`,
      );
    }
    if (!field.nullable && (value === null || (isExpr(value) && isNullOperand(value)))) {
      throw new QueryError(`set({ ${key}: null }): ${meta.name}.${key} is not nullable.`);
    }
    const operand = toOperand(value, field.type, field.redact, "set", false, true);
    checkNoWindows("set", operand.node);
    if (untypedValue(operand.node)) {
      throw new QueryError(
        `set({ ${key} }) was given a value with no type (val() without a type, or a CASE or coalesce of such values or of NULLs only). Nothing in the SQL types it, and the database would read it as text: pass the plain value, or give it a type, val(value, t.uuid()).`,
      );
    }
    const node: UpdateNode = { kind: "update", field: key, column: field.column, value: operand.node };
    const shape = updateShape(key, field.column, operand.shape);
    const at = nodes.findIndex((existingNode) => existingNode.field === key);
    if (at === -1) {
      nodes.push(node);
      shapes.push(shape);
    } else {
      nodes[at] = node;
      shapes[at] = shape;
      replaced = true;
    }
  }
  return { nodes, shapes, replaced };
}
