/**
 * Bindings: the objects a clause callback receives, one per table of the query.
 * `from(User, "u")` gives the callbacks a binding `u` whose properties are the columns of
 * `User` (`u.email`, `u.age`), each a {@link Col}.
 *
 * A binding is built **once per (schema, alias)** and cached (decision D8): every query
 * over `User` as `"u"` hands its callbacks the same object, with the same columns. It is a
 * plain, frozen object of own data properties, with no `Proxy`.
 *
 * Whether a binding's columns can be `null` because of an outer join is a type-level
 * matter only ({@link Binding}'s `N`); the object is the same.
 *
 * @module
 */
import type { AnySchema, FieldFlagsOf, FieldNames, FieldsOf, Row, SchemaMeta } from "../contracts/schema.js";
import { Col } from "./expr.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The fields of schema `S` that are columns: every field but the virtual ones, which are
 * never read from or written to the database.
 *
 * @example
 * ```ts
 * type Columns = ColumnNames<typeof User>; // "id" | "email" | … (not "password")
 * ```
 */
export type ColumnNames<S> = {
  [K in FieldNames<S>]: FieldFlagsOf<FieldsOf<S>[K]> extends { readonly virtual: true } ? never : K;
}[FieldNames<S>];

/** `T`, or `T | null` when the binding is nullable (`N` is not `false`). */
type Nullify<T, N extends boolean> = [N] extends [false] ? T : T | null;

/**
 * The binding of schema `S` in a query: one {@link Col} per column, plus `$schema` (the
 * schema class) and `$alias`. `N` is `true` when an outer join makes the binding's rows
 * optional: every column is then nullable, and selecting the whole binding gives
 * `Row<S> | null`.
 *
 * `"~binding"` exists only in the type system; it is what a `select` reads to type a
 * whole binding.
 *
 * @example
 * ```ts
 * from(User, "u").where(({ u }) => u.age.gte(18)); // u: Binding<typeof User>
 * from(User, "u").leftJoin(Post, "p", ({ u, p }) => p.authorId.eq(u.id)); // p: Binding<typeof Post, true>
 * ```
 */
export type Binding<S extends AnySchema, N extends boolean = false> = {
  readonly [K in ColumnNames<S>]: Col<Nullify<K extends keyof Row<S> ? Row<S>[K] : never, N>>;
} & {
  /** The schema class the binding was made from. */
  readonly $schema: S;
  /** The binding's alias in the query. */
  readonly $alias: string;
  /** Type information only; there is no such property at run time. */
  readonly "~binding": { readonly row: Row<S>; readonly nullable: N };
};

/**
 * Something a query callback can take as a whole binding: any object that carries the
 * type-only `"~binding"` member (a {@link Binding}, or a source binding of step 09).
 *
 * @example
 * ```ts
 * function rowOf<X extends AnyBinding>(binding: X): X["~binding"]["row"] { … }
 * ```
 */
export interface AnyBinding {
  readonly "~binding": { readonly row: unknown; readonly nullable: boolean };
}

/**
 * The binding `X` made nullable, as an outer join on the other side makes it. A source
 * binding that says what it becomes (a type-only `"~nullable"` member, as the bindings of
 * `subquery(q)` have) becomes that.
 *
 * @example
 * ```ts
 * type P = NullableBinding<Binding<typeof Post>>; // Binding<typeof Post, true>
 * ```
 */
export type NullableBinding<X> = X extends { readonly $schema: infer S extends AnySchema }
  ? Binding<S, true>
  : X extends { readonly "~nullable": infer Nx }
    ? Nx
    : X extends { readonly "~binding": { readonly row: infer Rw } }
      ? Omit<X, "~binding"> & { readonly "~binding": { readonly row: Rw; readonly nullable: true } }
      : X;

/**
 * The schema class of a binding, `never` for a binding that has none.
 *
 * @example
 * ```ts
 * type S = SchemaOfBinding<Binding<typeof User>>; // typeof User
 * ```
 */
export type SchemaOfBinding<X> = X extends { readonly $schema: infer S extends AnySchema } ? S : never;

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * What the builder knows about a binding object beyond its columns: its alias and the
 * schema metadata it was made from.
 *
 * @example
 * ```ts
 * bindingInfo(bindingOf(meta(User), User, "u"))?.alias; // "u"
 * ```
 */
export interface BindingInfo {
  readonly alias: string;
  readonly meta: SchemaMeta | undefined;
}

/** Every binding object this module made, with its alias and metadata. */
const infos = /* @__PURE__ */ new WeakMap<object, BindingInfo>();

/** The bindings of each schema, by alias. Keyed by the metadata object, so it lives as long as the schema. */
const cache = /* @__PURE__ */ new WeakMap<SchemaMeta, Map<string, object>>();

/**
 * The binding of a schema under `alias`: built on the first call, then the same object
 * every time (decision D8). Its properties are one {@link Col} per persisted field, in
 * declaration order, then `$schema` and `$alias`. It is frozen: it is shared by every
 * query over this schema and alias.
 *
 * @example
 * ```ts
 * bindingOf(meta(User), User, "u") === bindingOf(meta(User), User, "u"); // true
 * ```
 */
export function bindingOf(schemaMeta: SchemaMeta, schema: AnySchema, alias: string): object {
  let byAlias = cache.get(schemaMeta);
  if (byAlias === undefined) {
    byAlias = new Map();
    cache.set(schemaMeta, byAlias);
  }
  let binding = byAlias.get(alias);
  if (binding === undefined) {
    const built: Record<string, unknown> = {};
    for (const field of schemaMeta.persisted) built[field.name] = new Col(alias, field);
    built.$schema = schema;
    built.$alias = alias;
    binding = Object.freeze(built);
    infos.set(binding, { alias, meta: schemaMeta });
    byAlias.set(alias, binding);
  }
  return binding;
}

/**
 * Registers a binding object that another module made (a source wrapper of step 09), so
 * that a `select` can recognise it as a whole binding.
 *
 * @example
 * ```ts
 * registerBinding(columns, { alias: "r", meta: undefined });
 * ```
 */
export function registerBinding(binding: object, info: BindingInfo): void {
  infos.set(binding, info);
}

/**
 * The alias and metadata of a binding object, `undefined` for anything else.
 *
 * @example
 * ```ts
 * bindingInfo({ id: 1 }); // undefined
 * ```
 */
export function bindingInfo(value: object): BindingInfo | undefined {
  return infos.get(value);
}
