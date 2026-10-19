// Helpers for the step 09 unit tests. Imported by tests only.
import { bindParams, type NamedValues } from "../../compiler/bind.js";
import { createCompiler } from "../../compiler/compiler.js";
import { postgresDialect } from "../../compiler/dialect.js";
import type { QueryOperation } from "../../contracts/query.js";
import { collectParams, shapeOf } from "../ast.js";
import type { QueryLike } from "../builder.js";

/** A query compiled for Postgres: its SQL and bound parameters. */
export function compiled(
  query: QueryLike,
  operation: QueryOperation = "all",
  named?: NamedValues,
): { readonly sql: string; readonly params: readonly unknown[] } {
  const plan = createCompiler(postgresDialect).compile(query.ast, operation, undefined);
  return { sql: plan.sql, params: bindParams(plan.slots, query.ast.params, named) };
}

/** Whether a built query's cached `params`, `listLengths` and `shape` agree with a walk of its AST. */
export function canonical(query: QueryLike): boolean {
  const params: unknown[] = [];
  const lists: number[] = [];
  collectParams(query.ast, params, lists);
  return (
    JSON.stringify(params) === JSON.stringify(query.ast.params) &&
    JSON.stringify(lists) === JSON.stringify(query.ast.listLengths) &&
    shapeOf(query.ast) === query.ast.shape
  );
}
