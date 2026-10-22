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
import type { PreloadMarker, RowMarker } from "../contracts/schema.js";

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** What `JSON.stringify` leaves out of an object and writes as `null` in an array. */
type Dropped = undefined | symbol | ((...args: never[]) => unknown);

/**
 * How a value is mapped: `"value"` as `JSON.stringify` maps it, `"field"` as a row's
 * `toJSON` maps the value of a field (a `bigint` becomes a decimal string and bytes a
 * base64 string, at any depth, where `JSON.stringify` would throw or write an object).
 */
type Mode = "value" | "field";

// The types below keep their nesting shallow: each level of a value is one conditional
// type (`JsonOf`), and a row reads its fields' flags and values from the builders'
// `"~field"` member, not by inferring against `FieldBuilder` (whose methods return
// builders, which TypeScript would compare level by level). Deeper nesting made
// `JsonReturn` of an ordinary handler hit "Type instantiation is excessively deep"
// (TS2589), depending on what had been checked before it.

type JsonOf<T, M extends Mode> = unknown extends T
  ? unknown
  : T extends string | number | boolean | null
    ? T
    : T extends object
      ? "~fields" extends keyof T
        ? JsonRowOf<T>
        : JsonObjectOf<T, M>
      : T extends bigint
        ? M extends "field"
          ? string
          : never
        : undefined;

/** A row: what its own `toJSON` returns, when its class defines one, else its fields and preloads. */
type JsonRowOf<T> = "toJSON" extends keyof T
  ? JsonOf<ReturnOf<T[keyof T & "toJSON"]>, "value">
  : JsonRow<T, RowFieldsOf<T>>;

/** An object that is not a row: a value with `toJSON`, a function, bytes, an array, or a plain object. */
type JsonObjectOf<T, M extends Mode> = T extends { toJSON(...args: never[]): infer R }
  ? JsonOf<R, M>
  : T extends (...args: never[]) => unknown
    ? undefined
    : T extends Uint8Array
      ? M extends "field"
        ? string
        : Record<string, number>
      : T extends readonly unknown[]
        ? { -readonly [K in keyof T]: JsonElement<T[K], M> }
        : JsonObject<T, M>;

type ReturnOf<F> = F extends (...args: never[]) => infer R ? R : never;

/** An array element: what is dropped from an object is `null` in an array. */
type JsonElement<T, M extends Mode> = T extends Dropped ? null : JsonOf<T, M>;

/** The keys `JSON.stringify` always writes: string keys whose value is never dropped. */
type AlwaysKeys<T> = {
  [K in keyof T]-?: K extends symbol | "~preloaded"
    ? never
    : [Extract<T[K], Dropped>] extends [never]
      ? object extends Pick<T, K>
        ? never
        : K
      : never;
}[keyof T];

/** The keys `JSON.stringify` writes only sometimes: optional, or with a value it may drop. */
type SometimesKeys<T> = {
  [K in keyof T]-?: K extends symbol | "~preloaded"
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

/** What a field builder's type-only `"~field"` member records: its value type and flags. */
type FieldInfo<B> = B extends { readonly "~field"?: infer I } ? NonNullable<I> : never;

/** Whether a field builder is in JSON: `"always"` for a persisted one, `"maybe"` for a virtual one, `"no"`. */
type InJson<B> =
  FieldInfo<B> extends { readonly flags: infer G }
    ? G extends { readonly json: true }
      ? G extends { readonly virtual: true }
        ? "maybe"
        : "always"
      : "no"
    : "no";

type FieldValue<B> = FieldInfo<B> extends { readonly type: infer V } ? V : never;

type RowFieldsOf<R> = R extends RowMarker<infer F> ? F : never;

/** The preloaded associations a row type records; `unknown` (no keys) for none. */
type PreloadedOf<R> = "~preloaded" extends keyof R
  ? R extends PreloadMarker<infer P>
    ? P
    : unknown
  : unknown;

/**
 * The JSON of a row of type `R` with fields `F`: what its `toJSON()` returns. The fields
 * whose `json` flag is true, each mapped as a field value (a virtual one is optional, being
 * unset on a row that was read); then the associations the row type says were preloaded.
 * Getters and methods are left out.
 */
type JsonRow<R, F> = Simplify<
  {
    -readonly [K in keyof F as InJson<F[K]> extends "always" ? K : never]: JsonOf<FieldValue<F[K]>, "field">;
  } & {
    -readonly [K in keyof F as InJson<F[K]> extends "maybe" ? K : never]?: JsonOf<
      Exclude<FieldValue<F[K]>, undefined>,
      "field"
    >;
  } & { -readonly [K in keyof PreloadedOf<R> & keyof R]: JsonOf<R[K], "value"> }
>;

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
 * What a promise of `T` resolves to, one level deep (a promise never resolves to a
 * promise). It is not the built-in `Awaited`: `Json<Awaited<…>>` of a loaded row can exceed
 * TypeScript's instantiation depth ("Type instantiation is excessively deep", TS2589),
 * depending on what was checked before.
 */
type Resolved<T> = T extends Promise<infer V> ? V : T extends PromiseLike<infer V> ? V : T;

/**
 * The JSON of what function `F` resolves to: `Json` of its return type, unwrapped from a
 * promise. Name the type of a route handler's or a server action's response from the
 * function itself, with the preloads it makes.
 *
 * `null` stays: a function that may find nothing has `| null` in its type. Use the
 * `...OrThrow` reads, or `NonNullable`, in a handler that answers a miss with 404.
 *
 * @example
 * ```ts
 * async function loadPost(id: number) {
 *   return repo.getByOrThrow(from(Post, "p").preload("author"), { id });
 * }
 * type PostResponse = JsonReturn<typeof loadPost>; // { id: number; …; author: { … } }
 * ```
 */
export type JsonReturn<F extends (...args: never[]) => unknown> = F extends (...args: never[]) => infer R
  ? Json<Resolved<R>>
  : never;
