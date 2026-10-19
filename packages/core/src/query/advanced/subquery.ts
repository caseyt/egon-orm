/**
 * Queries inside queries: `subquery(q)` as a source of `from` or a join, `scalar(q)` as a
 * single value, and `outerRef(alias, Schema)` to refer to a binding of the enclosing query
 * from a query built elsewhere. A query is also an operand of `in` and of `exists`
 * directly (`u.id.in(q)`, `exists(q)`).
 *
 * The inner query's parameters and named parameters become the outer query's, at the
 * place the inner query sits, so both share one plan per shape.
 *
 * @module
 */
import type { AnySchema, SchemaMeta } from "../../contracts/schema.js";
import { QueryError } from "../../errors.js";
import { isSchema } from "../../schema/guards.js";
import { meta } from "../../schema/schema.js";
import { columnNode, shapeOfColumn, shapeOfOuterRef } from "../ast.js";
import { type Binding, registerBinding } from "../bindings.js";
import { Query, type QueryLike, type QueryParams, type QueryResult } from "../builder.js";
import { type AnyExpr, Expr, NONE, subqueryOf } from "../expr.js";
import { OUTER_REFS } from "./outer-refs.js";
import {
  type RowSchemaOf,
  type Source,
  type SourceBindingOf,
  type SourceCheck,
  type SourceRowOf,
  SourceWrapper,
  sourceColumns,
} from "./sources.js";

/**
 * A query as a source, for `from` or a join: `(SELECT …) AS "alias"`. The binding exposes
 * what the query selects: its keys when it selects an object of expressions, the schema's
 * columns when it selects whole rows of one.
 *
 * @example
 * ```ts
 * const postCounts = from(Post, "p").groupBy(({ p }) => p.authorId).select(({ p }) => ({ authorId: p.authorId, n: count() }));
 * from(subquery(postCounts), "c").where(({ c }) => c.n.gt(5));
 * from(User, "u").join(subquery(postCounts), "c", ({ u, c }) => c.authorId.eq(u.id));
 * ```
 *
 * @throws QueryError when the argument is not a query, or the query selects anything but
 * an object of expressions or whole rows, or has preloads or `set(…)`.
 */
export function subquery<Q extends QueryLike>(
  query: Q & SourceCheck<Q>,
): Source<SourceBindingOf<Q>, SourceRowOf<Q>, QueryParams<Q>> {
  if (!(query instanceof Query)) {
    throw new QueryError('subquery() takes a query: subquery(from(Post, "p").select(…)).');
  }
  const ast = query.ast;
  const columns = sourceColumns(query, "subquery");
  return new SourceWrapper(
    (alias) => ({ kind: "subquerySource", query: ast, alias }),
    columns,
    ast.params,
    ast.listLengths,
    query.named,
  );
}

/** Whether a query result `R` is more than one value: an object of keys, or an array of a known length. */
type ManyValues<R> = unknown extends R
  ? false
  : [NonNullable<R>] extends [Date | Uint8Array]
    ? false
    : [NonNullable<R>] extends [readonly unknown[]]
      ? number extends NonNullable<R>["length"]
        ? false
        : true
      : [NonNullable<R>] extends [object]
        ? true
        : false;

/**
 * Refuses, at compile time, a query that does not select one value: whole rows, an object
 * or an array of values. (A selected JSON value whose type is an object is refused too: a
 * known limit, since its type cannot be told from an object of keys.)
 *
 * @example
 * ```ts
 * declare function scalar<Q extends QueryLike>(query: Q & ScalarCheck<Q>): unknown;
 * ```
 */
export type ScalarCheck<Q extends QueryLike> = [RowSchemaOf<Q>] extends [never]
  ? ManyValues<QueryResult<Q>> extends true
    ? { readonly "~error": "scalar() takes a query that selects one expression, not an object or an array" }
    : unknown
  : { readonly "~error": "scalar() takes a query that selects one expression, not whole rows" };

/**
 * A query as one value, `(SELECT …)`: its single selected expression, `null` when it
 * returns no row. It must return at most one row.
 *
 * @example
 * ```ts
 * from(User, "u").select(({ u }) => ({
 *   user: u,
 *   posts: scalar(from(Post, "p").where(({ p }) => p.authorId.eq(u.id)).select(() => count())),
 * }));
 * ```
 *
 * @throws QueryError when the argument is not a query, or the query does not select one
 * expression.
 */
export function scalar<Q extends QueryLike>(
  query: Q & ScalarCheck<Q>,
): Expr<QueryResult<Q> | null, QueryParams<Q>> {
  if (!(query instanceof Query)) {
    throw new QueryError(
      'scalar() takes a query that selects one value: scalar(from(Post, "p").select(() => count())).',
    );
  }
  const select = query.ast.select;
  if (select === undefined || select.shape.kind !== "expr") {
    throw new QueryError(
      "scalar() takes a query that selects one expression, such as select(() => count()); this query selects " +
        (select === undefined
          ? "whole rows."
          : `${select.shape.kind === "binding" ? "a whole binding" : `an ${select.shape.kind}`}.`),
    );
  }
  return subqueryOf(query, "scalar") as AnyExpr as never;
}

/** The bindings `outerRef` made, per schema and alias: built once, like a query's bindings. */
const OUTER_BINDINGS = new WeakMap<SchemaMeta, Map<string, object>>();

/**
 * The binding `alias` of the query a subquery is nested in, with the columns of `schema`:
 * for a query built where the outer binding is not in scope. The outer query must have a
 * binding of that schema under that alias; the compiler refuses a column of a binding no
 * query around it has.
 *
 * @example
 * ```ts
 * const byThisUser = from(Post, "p").where(({ p }) => p.authorId.eq(outerRef("u", User).id));
 * from(User, "u").where(() => exists(byThisUser));
 * ```
 *
 * @throws QueryError when the alias is not a non-empty string or `schema` is not a schema
 * class with a table.
 */
export function outerRef<S extends AnySchema>(alias: string, schema: S): Binding<S> {
  if (typeof alias !== "string" || alias === "") {
    throw new QueryError('outerRef() takes the alias of the outer binding first: outerRef("u", User).');
  }
  if (!isSchema(schema)) {
    throw new QueryError(
      `outerRef("${alias}", …) takes the schema class of that binding second: outerRef("${alias}", User).`,
    );
  }
  const schemaMeta = meta(schema);
  if (schemaMeta.source === null) {
    throw new QueryError(
      `outerRef("${alias}", ${schemaMeta.name}): an embedded schema has no table, so no query binds it.`,
    );
  }
  let byAlias = OUTER_BINDINGS.get(schemaMeta);
  if (byAlias === undefined) {
    byAlias = new Map();
    OUTER_BINDINGS.set(schemaMeta, byAlias);
  }
  let binding = byAlias.get(alias);
  if (binding === undefined) {
    const built: Record<string, unknown> = {};
    for (const field of schemaMeta.persisted) {
      const node = columnNode(alias, field.name, field.column);
      OUTER_REFS.set(node, schemaMeta);
      built[field.name] = new Expr(
        node,
        field.type,
        field.redact,
        NONE,
        NONE,
        NONE,
        shapeOfOuterRef(shapeOfColumn(alias, field.column), schemaMeta.name),
      );
    }
    built.$schema = schema;
    built.$alias = alias;
    binding = Object.freeze(built);
    registerBinding(binding, { alias, meta: schemaMeta });
    byAlias.set(alias, binding);
  }
  return binding as Binding<S>;
}
