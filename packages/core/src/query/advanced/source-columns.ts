/**
 * The columns a `subquery(q)` or `cte(name, shape)` source exposes, recorded per source
 * node. The source wrappers (`sources.ts`) write them; the compiler reads them to check a
 * `cte(name, query)` reference against the query given to `withCte`. This module imports
 * only types, so the compiler can read it.
 *
 * @module
 */
import type { SourceNode } from "../../contracts/query.js";
import type { AnySchema, SchemaMeta } from "../../contracts/schema.js";
import type { AnyFieldType } from "../../contracts/type.js";

/**
 * One column of a source that returns objects: its key, its output name, how values
 * compared with it are bound.
 *
 * @example
 * ```ts
 * const column: SourceColumn = { key: "n", column: "n", type: undefined, redact: false };
 * ```
 */
export interface SourceColumn {
  readonly key: string;
  readonly column: string;
  readonly type: AnyFieldType | undefined;
  readonly redact: boolean;
}

/**
 * What a query exposes as a source.
 *
 * @example
 * ```ts
 * const columns: SourceColumns = { kind: "row", meta: meta(User), schema: User };
 * ```
 */
export type SourceColumns =
  | { readonly kind: "row"; readonly meta: SchemaMeta; readonly schema: AnySchema }
  | { readonly kind: "object"; readonly columns: readonly SourceColumn[] };

/**
 * The columns of every source node a wrapper made.
 *
 * @example
 * ```ts
 * SOURCE_COLUMNS.get(query.ast.from)?.kind; // "object" for from(subquery(counts), "c")
 * ```
 */
export const SOURCE_COLUMNS: WeakMap<SourceNode, SourceColumns> = new WeakMap();
