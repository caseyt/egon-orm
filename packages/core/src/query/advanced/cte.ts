/**
 * `cte(name, shape)`: a common table expression of the query (declared with
 * `.withCte(name, query)`) as a source of `from` or a join, `"name" AS "alias"`.
 *
 * `shape` gives the binding its columns and types: a schema class, when the CTE returns
 * whole rows of it, or the CTE's own query. A recursive CTE's query reads the CTE before
 * it exists, so it names the schema: `cte("tree", Category)`.
 *
 * @module
 */
import type { AnySchema, Row } from "../../contracts/schema.js";
import { QueryError } from "../../errors.js";
import { isSchema } from "../../schema/guards.js";
import { meta } from "../../schema/schema.js";
import type { Binding } from "../bindings.js";
import { Query, type QueryLike } from "../builder.js";
import { NONE, type NoParams } from "../expr.js";
import {
  type Source,
  type SourceBindingOf,
  type SourceCheck,
  type SourceColumns,
  type SourceRowOf,
  SourceWrapper,
  sourceColumns,
} from "./sources.js";

/**
 * A CTE of the query as a source, typed by a schema class (its rows are whole rows of it)
 * or by the CTE's own query. The query that reads it declares it with `withCte(name, …)`.
 *
 * @example
 * ```ts
 * const roots = from(Category, "c").where(({ c }) => c.parentId.isNull());
 * const children = from(Category, "c").join(cte("tree", Category), "t", ({ c, t }) => c.parentId.eq(t.id));
 * from(cte("tree", Category), "t").withCte("tree", roots.unionAll(children), { recursive: true });
 * ```
 *
 * @throws QueryError when the name is empty, or `shape` is neither a schema class with a
 * table nor a query that can be read as a source.
 */
export function cte<S extends AnySchema>(name: string, shape: S): Source<Binding<S>, Row<S>, NoParams>;
export function cte<Q extends QueryLike>(
  name: string,
  shape: Q & SourceCheck<Q>,
): Source<SourceBindingOf<Q>, SourceRowOf<Q>, NoParams>;
export function cte(name: string, shape: unknown): Source<unknown, unknown, NoParams> {
  if (typeof name !== "string" || name === "") {
    throw new QueryError('cte() takes the name of a CTE first, a non-empty string: cte("tree", Category).');
  }
  let columns: SourceColumns;
  if (isSchema(shape)) {
    const schemaMeta = meta(shape);
    if (schemaMeta.source === null) {
      throw new QueryError(`cte("${name}", ${schemaMeta.name}): an embedded schema has no rows of its own.`);
    }
    columns = { kind: "row", meta: schemaMeta, schema: shape };
  } else if (shape instanceof Query) {
    columns = sourceColumns(shape, "cte");
  } else {
    throw new QueryError(
      `cte("${name}", shape) takes the schema class of its rows, cte("${name}", Category), or the CTE's query.`,
    );
  }
  const rows = columns.kind === "row" ? columns.meta : undefined;
  // The CTE's query, and so its parameters, belong to withCte(); the reference has none.
  return new SourceWrapper((alias) => ({ kind: "cteSource", name, meta: rows, alias }), columns, NONE, NONE, NONE);
}
