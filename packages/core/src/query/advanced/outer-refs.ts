/**
 * The columns made by `outerRef(alias, Schema)`, with the schema the caller said the outer
 * binding has, so that the compiler can check it: the alias must belong to a query around
 * the one that uses it (not to that query itself), and bind that schema.
 *
 * Kept beside the nodes, not on them: `ColumnNode` is a contract shape. This module
 * imports nothing, so the compiler can read it.
 *
 * @module
 */
import type { ColumnNode } from "../../contracts/query.js";
import type { SchemaMeta } from "../../contracts/schema.js";

/**
 * The schema each `outerRef` column expects its binding to have.
 *
 * @example
 * ```ts
 * OUTER_REFS.get(outerRef("u", User).id.node as ColumnNode); // meta(User)
 * ```
 */
export const OUTER_REFS: WeakMap<ColumnNode, SchemaMeta> = new WeakMap();
