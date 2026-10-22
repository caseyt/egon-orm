/**
 * The types of nested changes: the names `castAssoc`, `castEmbed`, `putAssoc` and
 * `putEmbed` take, their options and values, and the type of a relation's change in
 * `changeset.changes`.
 *
 * @module
 */
import type { AnySchema, Assoc, AssocKeys, AssocKind, FieldsOf, Row } from "../../contracts/schema.js";
import type { Changeset } from "../changeset.js";
import type { ChangesetSource, FieldName, FieldValues, SchemalessTarget } from "../types.js";

/** The mark of a changeset typed from a row alone (see `RowSchema`): its class is not known. */
interface FromRow {
  readonly "~fromRow": true;
}

/** The field builders of a changeset source. */
type SourceFields<S> = S extends SchemalessTarget<infer F, infer _D> ? F : FieldsOf<S>;

/** What an embed field's builder records: the embedded schema and `"one"` or `"many"`. */
type EmbedInfo<B> = B extends { readonly "~embed"?: infer I }
  ? "~embed" extends keyof B
    ? NonNullable<I>
    : never
  : never;

/**
 * A changeset of `T` of either kind, as a `with` function may return it.
 *
 * @example
 * ```ts
 * const child: AnyChildChangeset<typeof Comment> = Comment.changeset(Comment, { body: "Hi" });
 * ```
 */
export type AnyChildChangeset<T> =
  | Changeset<T & ChangesetSource, true>
  | Changeset<T & ChangesetSource, false>
  | Changeset<T & ChangesetSource, boolean>;

/**
 * The function that makes the changeset of one child: called with the existing row (an
 * update) or the target class (a new record), the item's params, and its position in the
 * list (0 for a to-one value).
 *
 * @example
 * ```ts
 * const withComment: WithFunction<typeof Comment> = (comment, params) => cast(comment, params, ["body"]);
 * ```
 */
export type WithFunction<T extends AnySchema> = (
  target: Row<T> | T,
  params: Readonly<Record<string, unknown>>,
  index: number,
) => AnyChildChangeset<T>;

/** `true` when `T` has a static `changeset` function that a nested cast can call as its default `with`. */
type HasChangeset<T> = T extends {
  readonly changeset: (target: never, params: never, index: number) => infer R;
}
  ? R extends Changeset<infer _S, boolean>
    ? true
    : false
  : false;

/**
 * The options of `castAssoc` and `castEmbed`.
 *
 * - `with`: the child's changeset function; it defaults to the target's static
 *   `changeset` method (and is required when there is none).
 * - `required`: adds `can't be blank` when the result is empty (`null`, or no items).
 *
 * @example
 * ```ts
 * cast(post, params, ["title"]).castAssoc("comments", { with: Comment.changeset, required: true });
 * ```
 */
export interface CastNestedOptions<T extends AnySchema = AnySchema> {
  readonly with?: WithFunction<T>;
  readonly required?: boolean;
}

/**
 * The options of a nested cast whose target the types do not know (a changeset made from
 * a row alone): `with` takes any function of a target and an item.
 *
 * @example
 * ```ts
 * const options: LooseNestedOptions = { with: (comment, item) => Comment.changeset(comment, item) };
 * ```
 */
export interface LooseNestedOptions {
  with?(target: never, params: Readonly<Record<string, unknown>>, index: number): unknown;
  readonly required?: boolean;
}

/**
 * The options argument of a nested cast: optional when the target has a static
 * `changeset`, required (with `with`) otherwise; loose when the types do not know the target.
 *
 * @example
 * ```ts
 * type Args = CastNestedArgs<typeof Comment>; // [options?: CastNestedOptions<typeof Comment>]
 * ```
 */
export type CastNestedArgs<T> = [T] extends [never]
  ? [options?: LooseNestedOptions]
  : T extends AnySchema
    ? HasChangeset<T> extends true
      ? [options?: CastNestedOptions<T>]
      : [options: CastNestedOptions<T> & { readonly with: WithFunction<T> }]
    : never;

// ---------------------------------------------------------------------------
// Names and targets
// ---------------------------------------------------------------------------

/** Whether the associations of `S` are known to the types. */
type KnowsAssocs<S> =
  string extends FieldName<S> ? false : S extends FromRow ? false : S extends AnySchema ? true : false;

/**
 * The target class of association `K` of `S`, or `never` when the types do not know it
 * (a changeset made from a row alone).
 *
 * @example
 * ```ts
 * type T = AssocTarget<typeof Post, "comments">; // typeof Comment
 * ```
 */
export type AssocTarget<S, K> =
  KnowsAssocs<S> extends true
    ? K extends keyof S
      ? S[K] extends Assoc<AssocKind, infer T extends AnySchema>
        ? T
        : never
      : never
    : never;

/**
 * The kind of association `K` of `S`.
 *
 * @example
 * ```ts
 * type Kind = AssocKindOf<typeof Post, "comments">; // "hasMany"
 * ```
 */
export type AssocKindOf<S, K> = K extends keyof S
  ? S[K] extends Assoc<infer Kind, unknown>
    ? Kind
    : never
  : never;

/**
 * The names `castEmbed` and `putEmbed` take: the embed fields of `S`; any field name when
 * the types cannot tell (a changeset made from a row alone).
 *
 * @example
 * ```ts
 * type Names = EmbedName<typeof User>; // "address" | "phones"
 * ```
 */
export type EmbedName<S> =
  string extends FieldName<S>
    ? string
    : S extends FromRow
      ? FieldName<S>
      : { [K in FieldName<S>]: [EmbedInfo<SourceFields<S>[K]>] extends [never] ? never : K }[FieldName<S>];

/**
 * The embedded schema class of embed field `K` of `S`, or `never` when the types do not
 * know it.
 *
 * @example
 * ```ts
 * type E = EmbedTarget<typeof User, "address">; // typeof Address
 * ```
 */
export type EmbedTarget<S, K> = K extends keyof SourceFields<S>
  ? SchemaOfInfo<EmbedInfo<SourceFields<S>[K]>>
  : never;

/** The schema of an embed's info; `never` for `never` (not an embed). */
type SchemaOfInfo<I> = [I] extends [never]
  ? never
  : I extends { readonly schema: infer E extends AnySchema }
    ? E
    : never;

/**
 * Whether embed field `K` of `S` holds a list (`t.embedMany`).
 *
 * @example
 * ```ts
 * type Many = EmbedMany<typeof User, "phones">; // true
 * ```
 */
export type EmbedMany<S, K> = K extends keyof SourceFields<S>
  ? ManyOfInfo<EmbedInfo<SourceFields<S>[K]>>
  : false;

type ManyOfInfo<I> = [I] extends [never] ? false : I extends { readonly cardinality: "many" } ? true : false;

// ---------------------------------------------------------------------------
// Values given to put
// ---------------------------------------------------------------------------

/**
 * A plain object given to `putAssoc` for one record of `T`: some of its fields, and
 * values for its own associations (put on the child in turn). The check is structural: a
 * row of another schema whose fields overlap passes it, and is refused when the method runs.
 *
 * @example
 * ```ts
 * const comment: PutObject<typeof Comment> = { body: "Nice" };
 * ```
 */
export type PutObject<T extends AnySchema> = Partial<FieldValues<T>> & {
  readonly [A in AssocKeys<T>]?: PutAssocValue<T, A>;
} & { readonly length?: never };

/**
 * One record given to `putAssoc` or `putEmbed`: a row (kept as it is), a changeset (a new
 * record is inserted, a loaded one updated), or a plain object of fields (a new record,
 * or an update of the existing child with the same primary key).
 *
 * @example
 * ```ts
 * const items: PutItem<typeof Tag>[] = [newsTag, change(Tag, { name: "fresh" }), { name: "plain" }];
 * ```
 */
export type PutItem<T extends AnySchema> = Row<T> | AnyChildChangeset<T> | PutObject<T>;

/**
 * What `putAssoc(name, value)` takes for association `K` of `S`: a list of
 * {@link PutItem}s for `hasMany` and `manyToMany`, one or `null` for the others; anything
 * when the types do not know the association.
 *
 * @example
 * ```ts
 * const tags: PutAssocValue<typeof Post, "tags"> = [newsTag, sportTag];
 * ```
 */
export type PutAssocValue<S, K> = [AssocTarget<S, K>] extends [never]
  ? unknown
  : AssocKindOf<S, K> extends "hasMany" | "manyToMany"
    ? readonly PutItem<AssocTarget<S, K>>[]
    : PutItem<AssocTarget<S, K>> | null;

/**
 * What `putEmbed(name, value)` takes for embed field `K` of `S`: a list for
 * `t.embedMany`, one value or `null` for `t.embedOne`; anything when the types do not
 * know the embed.
 *
 * @example
 * ```ts
 * const address: PutEmbedValue<typeof User, "address"> = { street: "Storgata 1", city: "Oslo" };
 * ```
 */
export type PutEmbedValue<S, K> = [EmbedTarget<S, K>] extends [never]
  ? unknown
  : EmbedMany<S, K> extends true
    ? readonly PutItem<EmbedTarget<S, K>>[]
    : PutItem<EmbedTarget<S, K>> | null;

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/**
 * The change of field `K` of `S` in `changeset.changes`: for an embed field, the child
 * changeset (or `null`) or the list of them; for any other field, its value.
 *
 * An embed field's change is also typed as the field's value. It never holds one (embed
 * fields change only through `castEmbed` and `putEmbed`), but a changeset made from a row
 * alone, whose types cannot tell an embed from another field, must still fit where a
 * changeset of the class is expected.
 *
 * @example
 * ```ts
 * type Address = FieldChange<typeof User, "address">; // Changeset<typeof Address, boolean> | Address | null
 * ```
 */
export type FieldChange<S, K extends keyof FieldValues<S>> = [EmbedTarget<S, K>] extends [never]
  ? FieldValues<S>[K]
  :
      | FieldValues<S>[K]
      | (EmbedMany<S, K> extends true
          ? readonly Changeset<EmbedTarget<S, K>, boolean>[]
          : Changeset<EmbedTarget<S, K>, boolean> | null);

/**
 * The change of association `K` of `S` in `changeset.changes`: the child changeset (or
 * `null`) of a to-one association, the list of them for a to-many one.
 *
 * @example
 * ```ts
 * type Comments = AssocChange<typeof Post, "comments">; // readonly Changeset<typeof Comment, boolean>[]
 * ```
 */
export type AssocChange<S, K> =
  AssocKindOf<S, K> extends "hasMany" | "manyToMany"
    ? readonly Changeset<AssocTarget<S, K>, boolean>[]
    : Changeset<AssocTarget<S, K>, boolean> | null;

/** The association changes of `S`; `{}`-free when the types do not know its associations. */
export type AssocChanges<S> =
  KnowsAssocs<S> extends true ? { readonly [K in AssocKeys<S>]?: AssocChange<S, K> } : unknown;
