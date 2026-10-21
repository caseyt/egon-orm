/**
 * `Json<T>` and `JsonReturn<F>`: the types of what a client receives. Type-only: this
 * module adds nothing to a bundle.
 *
 * A row's JSON is read from the type-only markers on row types (`RowMarker` and
 * `PreloadMarker` in `contracts/schema.ts`): the fields whose `json` flag is true, mapped
 * as `toJSON` maps them (`./json.ts`), and exactly the preloaded associations. Anything
 * else follows `JSON.stringify`.
 *
 * @module
 */
import type { FieldFlagsOf, FieldValueOf } from "../contracts/schema.js";

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** What `JSON.stringify` leaves out of an object and writes as `null` in an array. */
type Dropped = undefined | symbol | ((...args: never[]) => unknown);

/**
 * How a value is mapped: `"value"` as `JSON.stringify` maps it, `"field"` as a row's
 * `toJSON` maps the value of a field (a `bigint` becomes a decimal string and bytes a
 * base64 string, at any depth, where `JSON.stringify` would throw or write an object).
 */
type Mode = "value" | "field";

type JsonOf<T, M extends Mode> = unknown extends T
  ? unknown
  : T extends string | number | boolean | null
    ? T
    : T extends bigint
      ? M extends "field"
        ? string
        : never
      : T extends Dropped
        ? undefined
        : T extends object
          ? "~fields" extends keyof T
            ? T extends { toJSON(...args: never[]): infer R }
              ? JsonOf<R, "value">
              : JsonRow<T>
            : JsonObjectLike<T, M>
          : never;

/** An object that is not a row: its `toJSON`'s result, bytes, an array, or its own properties. */
type JsonObjectLike<T, M extends Mode> = T extends { toJSON(...args: never[]): infer R }
  ? JsonOf<R, M>
  : T extends Uint8Array
    ? M extends "field"
      ? string
      : Record<string, number>
    : T extends readonly unknown[]
      ? { -readonly [K in keyof T]: JsonElement<T[K], M> }
      : JsonObject<T, M>;

/** An array element: what is dropped from an object is `null` in an array. */
type JsonElement<T, M extends Mode> = T extends Dropped ? null : JsonOf<T, M>;

/** The keys `JSON.stringify` always writes: string keys whose value is never dropped. */
type AlwaysKeys<T> = {
  [K in keyof T]-?: K extends symbol
    ? never
    : [Extract<T[K], Dropped>] extends [never]
      ? object extends Pick<T, K>
        ? never
        : K
      : never;
}[keyof T];

/** The keys `JSON.stringify` writes only sometimes: optional, or with a value it may drop. */
type SometimesKeys<T> = {
  [K in keyof T]-?: K extends symbol
    ? never
    : [Exclude<T[K], Dropped>] extends [never]
      ? never
      : [Extract<T[K], Dropped>] extends [never]
        ? object extends Pick<T, K>
          ? K
          : never
        : K;
}[keyof T];

type JsonObject<T, M extends Mode> = Simplify<
  { -readonly [K in AlwaysKeys<T>]: JsonOf<T[K], M> } & {
    -readonly [K in SometimesKeys<T>]?: JsonOf<Exclude<T[K], Dropped>, M>;
  }
>;

type FieldsOfRow<R> = R extends { readonly "~fields"?: infer F } ? NonNullable<F> : never;

/** Whether a field with flags `G` is in JSON: `"always"` for a persisted one, `"maybe"` for a virtual one, `"no"`. */
type InJson<G> = G extends { readonly json: true }
  ? G extends { readonly virtual: true }
    ? "maybe"
    : "always"
  : "no";

/** The fields of `F` that are in JSON, in declaration order; a virtual one is optional, being unset on a loaded row. */
type JsonFields<F> = {
  -readonly [K in keyof F as InJson<FieldFlagsOf<F[K]>> extends "always" ? K : never]: JsonOf<
    FieldValueOf<F[K]>,
    "field"
  >;
} & {
  -readonly [K in keyof F as InJson<FieldFlagsOf<F[K]>> extends "maybe" ? K : never]?: JsonOf<
    Exclude<FieldValueOf<F[K]>, undefined>,
    "field"
  >;
};

type PreloadedOf<R> = "~preloaded" extends keyof R
  ? R extends { readonly "~preloaded"?: infer P }
    ? NonNullable<P>
    : never
  : never;

/** The preloaded associations of row type `R`, as they are in its JSON. */
type PreloadedJson<R> = [PreloadedOf<R>] extends [never]
  ? unknown
  : { -readonly [K in keyof PreloadedOf<R> & keyof R]: JsonOf<R[K], "value"> };

/**
 * The JSON of a row of type `R`: what its `toJSON()` returns. The fields whose `json` flag
 * is true, each mapped as a field value; then the associations the row type says were
 * preloaded. Getters and methods are left out.
 */
type JsonRow<R> = Simplify<JsonFields<FieldsOfRow<R>> & PreloadedJson<R>>;

/**
 * The type of `T` once it has been through `JSON.stringify` and `JSON.parse`: what a
 * client receives.
 *
 * - A row (`Json<User>`, `Json<Loaded<typeof Post, "author">>`) is what its `toJSON()`
 *   returns: the fields that are in JSON (not redacted; not virtual unless declared
 *   `.virtual({ json: true })`), a `Date` as a `string`, a `bigint` as a decimal `string`,
 *   bytes as a base64 `string`, embeds mapped field by field, and exactly the preloaded
 *   associations, recursively. Getters and methods are left out. A nullable `belongsTo`
 *   stays `| null`.
 * - Anything else follows `JSON.stringify`: a value with `toJSON` is `Json` of what that
 *   returns (a `Date` is a `string`); `undefined`, functions and symbols are left out of
 *   objects and are `null` in arrays; a plain `bigint` is `never`, because
 *   `JSON.stringify` throws on it. Objects and arrays are mapped recursively, so
 *   `Json<{ post: Loaded<…>; related: Post[] }>` works.
 *
 * It is a type only: it adds nothing to a bundle.
 *
 * @example
 * ```ts
 * type UserJson = Json<User>; // { id: number; email: string; createdAt: string; … }
 * type PostJson = Json<Loaded<typeof Post, { author: true; comments: "author" }>>;
 *
 * const res = await fetch("/api/users/1");
 * const user = (await res.json()) as Json<User>;
 * ```
 */
export type Json<T> = JsonOf<T, "value">;

/**
 * The JSON of what function `F` resolves to: `Json<Awaited<ReturnType<F>>>`. Name the
 * type of a route handler's or a server action's response from the function itself, with
 * the preloads it makes.
 *
 * `null` stays: a function that may find nothing has `| null` in its type. Use the
 * `...OrThrow` reads, or `NonNullable`, in a handler that answers a miss with 404.
 *
 * @example
 * ```ts
 * async function loadPost(id: number) {
 *   return repo.getOrThrow(from(Post, "p").preload("author"), id);
 * }
 * type PostResponse = JsonReturn<typeof loadPost>; // { id: number; …; author: { … } }
 * ```
 */
export type JsonReturn<F extends (...args: never[]) => unknown> = Json<Awaited<ReturnType<F>>>;
