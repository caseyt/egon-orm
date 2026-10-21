/**
 * The key that leads from a row to its schema's metadata, shared by the modules that read
 * it (`schema.ts`, `json.ts`).
 *
 * @module
 */

/**
 * The key under which a schema's prototype holds its metadata, so that a row leads to it.
 * Registered with `Symbol.for`, so two installed copies of the package agree on it.
 *
 * @example
 * ```ts
 * const metadata = (row as { readonly [MODEL]: unknown })[MODEL];
 * ```
 */
export const MODEL: unique symbol = Symbol.for("egon.model");
