/**
 * The schema contract: runtime metadata (`FieldMeta`, `AssocMeta`, `SchemaMeta`, …) and
 * the type-level design that derives row, insert and preload types from a schema class.
 *
 * The type-level half is lifted from `docs/plan/spikes/schema-typing.ts`, the proof for
 * decision D1 (schemas are classes; associations are static thunks).
 *
 * Implemented by step 04 (`schema/`). Consumed by changesets (05, 06, 15), the query
 * builder (07, 08, 09), the compiler (10), the repo (12, 13, 14, 16) and migrations (18).
 *
 * @module
 */
import type { AnyFieldType } from "./type.js";

// ---------------------------------------------------------------------------
// Runtime metadata
// ---------------------------------------------------------------------------

/**
 * The key under which a schema class holds its {@link SchemaMeta}: `User[META]`.
 *
 * Created with `Symbol.for`, so two installed copies of the package agree on the key.
 *
 * **It must be an own data property** of the base class that `Schema()` returns (a plain
 * `static` value, not a getter), holding an object whose `fields` is an own data property
 * with a plain array of {@link FieldMeta} objects, whose `name` and `redact` are own data
 * properties too. Code that must not run anything belonging to the value it inspects
 * (the redaction-aware formatter in `internal/inspect.ts`) reads the metadata through
 * property descriptors; where it finds an accessor it cannot tell which fields are
 * redacted, and prints none of the row's values. Laziness belongs inside the metadata
 * (`assocs()` is a method), not in front of it.
 *
 * @example
 * ```ts
 * declare const User: AnySchema;
 * const source = User[META].source; // "users"
 * ```
 */
export const META: unique symbol = Symbol.for("egon.meta");

/**
 * The key under which a row holds its {@link RowMeta}: `user[ROW]`. It is the last own
 * property of every row and the only symbol-keyed one, so it never shows up in
 * `Object.keys`, `JSON.stringify` or `for…in`.
 *
 * @example
 * ```ts
 * declare const user: { readonly [ROW]: RowMeta };
 * if (user[ROW].state === "loaded") {
 *   // the row came from the database
 * }
 * ```
 */
export const ROW: unique symbol = Symbol.for("egon.row");

/**
 * Where a row stands relative to the database.
 *
 * - `"built"`: made in memory by the library and never persisted. User code cannot
 *   produce one: a schema class has no public constructor (decision D2).
 * - `"loaded"`: read from, or written to, the database.
 * - `"deleted"`: deleted through the repo.
 *
 * @example
 * ```ts
 * const state: RowState = "built";
 * ```
 */
export type RowState = "built" | "loaded" | "deleted";

/**
 * Per-row metadata, stored under {@link ROW}. One frozen object is shared by every row
 * with the same state, source and database schema, so a row costs one property, not one object.
 *
 * @example
 * ```ts
 * const loadedUser: RowMeta = { state: "loaded", source: "users", schema: undefined };
 * ```
 */
export interface RowMeta {
  readonly state: RowState;
  /** The table the row belongs to; `null` for a row of an embedded schema. */
  readonly source: string | null;
  /**
   * The database schema (a Postgres schema, a MySQL database) the row belongs to. For a loaded row
   * it is the database schema the row was read from or written to. For a **built** row
   * it is the database schema the schema declares (`SchemaMeta.schema`), `undefined`
   * when it declares none. A write without a per-call database schema goes to this database schema when it
   * is set (and to the repo default otherwise), so a row is inserted where a read of its
   * schema will look for it.
   */
  readonly schema: string | undefined;
}

/**
 * When a field may be written. `"insert"` means on insert only (never updated);
 * `"never"` means the database owns it.
 *
 * @example
 * ```ts
 * const mode: Writable = "insert";
 * ```
 */
export type Writable = "always" | "insert" | "never";

/**
 * Everything known about one field of a schema. Built once, when the schema class is
 * created; never mutated.
 *
 * @example
 * ```ts
 * declare const stringType: AnyFieldType;
 * const createdAt: FieldMeta = {
 *   name: "createdAt",
 *   column: "created_at",
 *   type: stringType,
 *   nullable: false,
 *   primaryKey: false,
 *   virtual: false,
 *   redact: false,
 *   json: true,
 *   writable: "always",
 *   dbGenerated: false,
 *   default: undefined,
 *   autogenerate: undefined,
 *   index: 3,
 * };
 * ```
 */
export interface FieldMeta {
  /** The property name on rows: `"createdAt"`. */
  readonly name: string;
  /** The column name in the database: `"created_at"`. Meaningless for a virtual field. */
  readonly column: string;
  readonly type: AnyFieldType;
  /** Whether `null` is a legal value. Fields are non-null unless declared `.nullable()` (decision D3). */
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  /** A virtual field is never read from or written to the database. */
  readonly virtual: boolean;
  /** A redacted field is hidden from inspect output, `toJSON` and logs. */
  readonly redact: boolean;
  /**
   * Whether `toJSON` includes the field. `true` by default; `.redact()` and `.virtual()`
   * make it `false`, and `.virtual({ json: true })` keeps it. A redacted field is never
   * in JSON.
   */
  readonly json: boolean;
  readonly writable: Writable;
  /** The database generates the value: include the column in `RETURNING` after a write. */
  readonly dbGenerated: boolean;
  /**
   * The value a new row starts with: a constant, or a function called for every new row
   * (so that rows do not share one mutable default).
   */
  readonly default:
    | undefined
    | { readonly kind: "value"; readonly value: unknown }
    | { readonly kind: "fn"; readonly fn: () => unknown };
  /** A client-side generator run by the repo at write time when the field is unset. */
  readonly autogenerate:
    | undefined
    | { readonly on: "insert" | "insertAndUpdate"; readonly fn: () => unknown };
  /** The position of this field in {@link SchemaMeta.fields}. */
  readonly index: number;
}

/**
 * The four association kinds.
 *
 * @example
 * ```ts
 * const kind: AssocKind = "hasMany";
 * ```
 */
export type AssocKind = "belongsTo" | "hasOne" | "hasMany" | "manyToMany";

/**
 * What happens to associated rows that a parent changeset no longer mentions (step 15).
 *
 * @example
 * ```ts
 * const onReplace: OnReplace = "delete";
 * ```
 */
export type OnReplace = "error" | "invalid" | "setNull" | "update" | "delete" | "deleteIfExists";

/**
 * The join table of a `manyToMany` association.
 *
 * @example
 * ```ts
 * const postsTags: JoinThroughMeta = { source: "posts_tags", schema: undefined, model: undefined };
 * ```
 */
export interface JoinThroughMeta {
  /** The join table's name. */
  readonly source: string;
  readonly schema: string | undefined;
  /** The join schema, when the association was declared with one instead of a table name. */
  readonly model: (() => AnySchema) | undefined;
}

/**
 * One side of a `manyToMany` join: a column of the join table and the field it references.
 *
 * @example
 * ```ts
 * // posts_tags.post_id references posts.id
 * const ownerSide: JoinKeyMeta = { column: "post_id", field: "id" };
 * ```
 */
export interface JoinKeyMeta {
  /** The column in the join table. */
  readonly column: string;
  /** The field it references: on the owner for the first pair, on the target for the second. */
  readonly field: string;
}

/**
 * One entry of an association's default preload order.
 *
 * @example
 * ```ts
 * const newestFirst: AssocOrderMeta = { field: "createdAt", direction: "desc" };
 * ```
 */
export interface AssocOrderMeta {
  /** A field name of the target schema. */
  readonly field: string;
  readonly direction: "asc" | "desc";
}

/**
 * Everything known about one association, resolved lazily: the target class may not exist
 * yet when the owner class is defined (decision D1), so {@link SchemaMeta.assocs} builds
 * these on its first call.
 *
 * Keys are **field names**, not column names, and are arrays so that composite keys work.
 * `ownerKey[i]` on the owner matches `relatedKey[i]` on the target:
 *
 * | Kind                | `ownerKey`                    | `relatedKey`                   |
 * |---------------------|-------------------------------|--------------------------------|
 * | `belongsTo`         | the foreign key (`authorId`)  | the referenced key (`id`)      |
 * | `hasOne`, `hasMany` | the referenced key (`id`)     | the foreign key (`authorId`)   |
 * | `manyToMany`        | the key `joinKeys[0]` points at | the key `joinKeys[1]` points at |
 *
 * For a has-through association (`through` set) the keys are empty: the chain is resolved
 * through the named associations.
 *
 * @example
 * ```ts
 * declare const Post: AnySchema;
 * declare const User: AnySchema;
 * const author: AssocMeta = {
 *   name: "author",
 *   kind: "belongsTo",
 *   owner: Post,
 *   target: () => User,
 *   ownerKey: ["authorId"],
 *   relatedKey: ["id"],
 *   joinThrough: undefined,
 *   joinKeys: undefined,
 *   through: undefined,
 *   onReplace: "error",
 *   where: undefined,
 *   joinWhere: undefined,
 *   orderBy: [],
 *   defaults: undefined,
 * };
 * ```
 */
export interface AssocMeta {
  /** The static member name on the owner class: `"posts"`. */
  readonly name: string;
  readonly kind: AssocKind;
  /** The schema class that declares the association. */
  readonly owner: AnySchema;
  /** The associated schema class. A method, so the class is looked up when needed. */
  target(): AnySchema;
  readonly ownerKey: readonly string[];
  readonly relatedKey: readonly string[];
  /** `manyToMany` only. */
  readonly joinThrough: JoinThroughMeta | undefined;
  /** `manyToMany` only: `[owner side, target side]`. */
  readonly joinKeys: readonly [JoinKeyMeta, JoinKeyMeta] | undefined;
  /** Has-through only: the association names to follow, starting from the owner. */
  readonly through: readonly string[] | undefined;
  readonly onReplace: OnReplace;
  /**
   * A filter on the target that is always applied, as field name to value: a value means
   * equality, `null` means `IS NULL`, an array means `IN`. Values are bound parameters.
   */
  readonly where: Readonly<Record<string, unknown>> | undefined;
  /** `manyToMany` only: the same kind of filter, on the join table's columns. */
  readonly joinWhere: Readonly<Record<string, unknown>> | undefined;
  /** The order preloaded rows come in when the preload has no query of its own. */
  readonly orderBy: readonly AssocOrderMeta[];
  /** Field values given to a target row that is built through this association (step 15). */
  readonly defaults: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Everything known about one embed. An embed is also a field (stored as `jsonb`), so it
 * appears in {@link SchemaMeta.fields} as well; this record adds what a plain field lacks.
 *
 * @example
 * ```ts
 * declare const Address: AnySchema;
 * const address: EmbedMeta = {
 *   name: "address",
 *   cardinality: "one",
 *   schema: () => Address,
 *   onReplace: "update",
 *   column: "address",
 * };
 * ```
 */
export interface EmbedMeta {
  /** The field name on the owner. */
  readonly name: string;
  readonly cardinality: "one" | "many";
  /** The embedded schema class. A method, so the class is looked up when needed. */
  schema(): AnySchema;
  readonly onReplace: OnReplace;
  /** The column that stores the embed. */
  readonly column: string;
}

/**
 * Everything derived from a schema definition, computed once and cached on the class
 * under {@link META}. Hot paths read these precomputed tables instead of deriving them
 * again per query or per row.
 *
 * @example
 * ```ts
 * function columnsOf(meta: SchemaMeta): string[] {
 *   return meta.persisted.map((field) => field.column);
 * }
 * ```
 */
export interface SchemaMeta {
  /** The class name, for error messages. */
  readonly name: string;
  /** The table name; `null` for an embedded schema. */
  readonly source: string | null;
  /** The database schema the schema declares. In a query it wins over the query's, the call's and the repo's. */
  readonly schema: string | undefined;
  /** Every field in declaration order. This order is the row shape: rows assign their properties in it. */
  readonly fields: readonly FieldMeta[];
  readonly fieldsByName: ReadonlyMap<string, FieldMeta>;
  /** The non-virtual fields, in declaration order: what `SELECT` reads and what {@link SchemaMeta.create} takes. */
  readonly persisted: readonly FieldMeta[];
  /** The primary-key fields, in declaration order. Empty for a schema without a primary key. */
  readonly primaryKey: readonly FieldMeta[];
  readonly embeds: readonly EmbedMeta[];
  /**
   * The associations by name. Resolved and validated on the first call, then cached. It
   * is a method because the classes an association points at may be defined later.
   *
   * @throws SchemaDefinitionError when an association is declared wrongly.
   */
  assocs(): ReadonlyMap<string, AssocMeta>;
  /**
   * The shared, frozen {@link RowMeta} for rows of this schema in `state`, read from or
   * written to `schema`. The same object is returned for the same arguments, so every row
   * of a result that comes from one table points at one object. `schema` is the database schema the
   * row's own table resolved to in the statement: for a decoded row, the `schema` of its
   * output-plan leaf; for the row returned by a row-level write, `CompiledQuery.schema`.
   * It may differ from {@link SchemaMeta.schema} (a per-source, per-call, per-query or
   * repo-level database schema). A built row is created with `rowMeta("built", meta.schema)`.
   */
  rowMeta(state: RowState, schema: string | undefined): RowMeta;
  /**
   * The generated row factory (decision D2): builds a row from the values of the
   * {@link SchemaMeta.persisted} fields, in that order, and stores `row` under {@link ROW}
   * (take it from {@link SchemaMeta.rowMeta}). It never runs a user constructor and never
   * applies defaults. Virtual fields start out `undefined`.
   */
  readonly create: (values: readonly unknown[], row: RowMeta) => object;
  /**
   * The row factory for rows that carry preloaded associations (step 14): like
   * {@link SchemaMeta.create}, and it also assigns `loaded[i]` to the property
   * `assocs[i]`, after the fields and in that order. One factory, and so one hidden class,
   * exists per distinct `assocs` list; asking again with an equal list returns the same
   * function.
   */
  createWith(
    assocs: readonly string[],
  ): (values: readonly unknown[], loaded: readonly unknown[], row: RowMeta) => object;
}

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

/**
 * The facts about a field that the type system tracks, as a record of booleans.
 *
 * - `nullable`: declared `.nullable()`.
 * - `defaulted`: has a value without the caller supplying one, through `.default()`,
 *   `.autogenerate()` or `.dbGenerated()`. Such a field is optional in {@link InsertShape}.
 * - `virtual`: declared `.virtual()`; excluded from {@link InsertShape}.
 * - `primaryKey`: declared `.primaryKey()`; drives {@link PrimaryKeyOf}.
 * - `json`: included in a row's JSON (`toJSON`, `Json<Row>`). `true` unless the field is
 *   redacted, or virtual without `{ json: true }`.
 *
 * @example
 * ```ts
 * type IdFlags = { nullable: false; defaulted: true; virtual: false; primaryKey: true; json: true };
 * const check: FieldFlags = {} as IdFlags;
 * ```
 */
export interface FieldFlags {
  readonly nullable: boolean;
  readonly defaulted: boolean;
  readonly virtual: boolean;
  readonly primaryKey: boolean;
  readonly json: boolean;
}

/**
 * The flags of a field with no modifier applied.
 *
 * @example
 * ```ts
 * declare const email: FieldBuilder<string, DefaultFieldFlags>;
 * ```
 */
export interface DefaultFieldFlags {
  readonly nullable: false;
  readonly defaulted: false;
  readonly virtual: false;
  readonly primaryKey: false;
  readonly json: true;
}

/**
 * `F` with the flag `K` set to `true`.
 *
 * @example
 * ```ts
 * type Flags = WithFlag<DefaultFieldFlags, "nullable">;
 * // { nullable: true; defaulted: false; virtual: false; primaryKey: false; json: true }
 * ```
 */
export type WithFlag<F extends FieldFlags, K extends keyof FieldFlags> = {
  readonly [P in keyof FieldFlags]: P extends K ? true : F[P];
};

/**
 * `F` with the flag `json` set to `false`: what `.redact()` and `.virtual()` do.
 *
 * @example
 * ```ts
 * type Flags = WithoutJson<DefaultFieldFlags>;
 * // { nullable: false; defaulted: false; virtual: false; primaryKey: false; json: false }
 * ```
 */
export type WithoutJson<F extends FieldFlags> = {
  readonly [P in keyof FieldFlags]: P extends "json" ? false : F[P];
};

/**
 * Options of `.virtual()`.
 *
 * @example
 * ```ts
 * const options: VirtualOptions = { json: true }; // a virtual field that toJSON includes
 * ```
 */
export interface VirtualOptions {
  /** `true` keeps the field in the row's JSON. Defaults to `false`: a virtual field is left out. */
  readonly json?: boolean;
}

/**
 * A field declaration: what `t.string()`, `t.integer()` and the rest return. `T` is the
 * type of the property on a row (it includes `null` once `.nullable()` was called) and `F`
 * records which modifiers were applied.
 *
 * Every modifier returns a new builder and leaves the receiver untouched.
 *
 * `"~field"` exists only in the type system (it is never set at runtime). It is what
 * {@link FieldValueOf} and {@link FieldFlagsOf} read.
 *
 * @example
 * ```ts
 * declare const t: { string(): FieldBuilder<string>; integer(): FieldBuilder<number> };
 *
 * const fields = {
 *   email: t.string(),
 *   name: t.string().nullable(),
 *   loginCount: t.integer().default(0),
 * };
 * type Name = FieldValueOf<(typeof fields)["name"]>; // string | null
 * ```
 */
export interface FieldBuilder<T, F extends FieldFlags = DefaultFieldFlags> {
  readonly "~field"?: { readonly type: T; readonly flags: F };
  /** Allows `null`: adds `| null` to the row type, and makes `null` the default. */
  nullable(): FieldBuilder<T | null, WithFlag<F, "nullable">>;
  /** The value a new record takes when its changeset sets none: a constant, or a function called per record. */
  default(value: T | (() => T)): FieldBuilder<T, WithFlag<F, "defaulted">>;
  /**
   * Makes the field part of the primary key (several fields form a composite key). The
   * value is one you supply, whatever the type; add `.dbGenerated()` for a serial or
   * identity column, or `.autogenerate()` for a value made in your process.
   */
  primaryKey(): FieldBuilder<T, WithFlag<F, "primaryKey">>;
  /** Generates the value client-side at insert when it is unset. */
  autogenerate(fn?: () => T): FieldBuilder<T, WithFlag<F, "defaulted">>;
  /**
   * Keeps the field out of the database: never selected, never written. A virtual field
   * is left out of the row's JSON too, unless declared `.virtual({ json: true })`; a
   * redacted one is left out whatever the options.
   */
  virtual(options?: { readonly json?: false }): FieldBuilder<T, WithoutJson<WithFlag<F, "virtual">>>;
  virtual(options: { readonly json: true }): FieldBuilder<T, WithFlag<F, "virtual">>;
  /** Overrides the column name (decision D4). */
  column(name: string): FieldBuilder<T, F>;
  /** Hides the value from inspect output, `toJSON` and logs. The field is never in JSON. */
  redact(): FieldBuilder<T, WithoutJson<F>>;
  /** Marks the value as generated by the database: it is read back after a write. */
  dbGenerated(): FieldBuilder<T, WithFlag<F, "defaulted">>;
  /** Restricts when the field may be written. */
  writable(mode: Writable): FieldBuilder<T, F>;
}

/**
 * A field builder of any type and flags.
 *
 * @example
 * ```ts
 * declare const email: FieldBuilder<string>;
 * const any: AnyFieldBuilder = email;
 * ```
 */
export type AnyFieldBuilder = FieldBuilder<unknown, FieldFlags>;

/**
 * The fields object passed to `Schema(source, fields)`.
 *
 * @example
 * ```ts
 * declare const t: { integer(): AnyFieldBuilder; string(): AnyFieldBuilder };
 * const fields: FieldsShape = { id: t.integer().primaryKey(), email: t.string() };
 * ```
 */
export type FieldsShape = Readonly<Record<string, AnyFieldBuilder>>;

/**
 * The row property type of a field builder.
 *
 * @example
 * ```ts
 * declare const name: FieldBuilder<string | null, WithFlag<DefaultFieldFlags, "nullable">>;
 * type Name = FieldValueOf<typeof name>; // string | null
 * ```
 */
export type FieldValueOf<B> = B extends FieldBuilder<infer T, infer _F> ? T : never;

/**
 * The flags of a field builder.
 *
 * @example
 * ```ts
 * declare const id: FieldBuilder<number, WithFlag<DefaultFieldFlags, "primaryKey">>;
 * type IsKey = FieldFlagsOf<typeof id>["primaryKey"]; // true
 * ```
 */
export type FieldFlagsOf<B> = B extends FieldBuilder<infer _T, infer F> ? F : never;

/**
 * The object type of a row with the fields `F`: one property per field, virtual fields
 * included, associations excluded.
 *
 * @example
 * ```ts
 * declare const fields: { id: FieldBuilder<number>; name: FieldBuilder<string | null> };
 * type UserRow = RowOf<typeof fields>; // { id: number; name: string | null }
 * ```
 */
export type RowOf<F> = { -readonly [K in keyof F]: FieldValueOf<F[K]> };

/**
 * What every row type has besides its fields and the class's own members: a type-only
 * marker that leads back to the fields' builders, so that `Json<User>` can tell the fields
 * from the getters and methods. It is declared only: nothing exists at run time, and no
 * row has the member.
 *
 * It is an optional method of a declared class, which a spread (`{ ...user }`) and a rest
 * (`const { email, ...rest } = user`) leave out of their types, as they leave out a
 * class's methods: a copy is a plain object, and `Json` of it follows `JSON.stringify`.
 *
 * (A row's `toJSON` is on the prototype at run time but is not part of the row type, so
 * that a class can define its own with any return type, and a plain object still fits
 * where a row of an embedded schema is expected.)
 *
 * @example
 * ```ts
 * type UserFields = ReturnType<NonNullable<User["~fields"]>>; // typeof User.fields
 * ```
 */
export declare abstract class RowMarker<F> {
  /** Type-only; never set at runtime. */
  "~fields"?(): F;
}

/**
 * The type-only marker of a {@link Loaded} row type: the preloaded associations as an
 * object type, `{ author: true; comments: true }`, so that a row with more preloads is
 * still assignable where fewer are expected, and two markers on one row merge into one.
 * It is never set at run time. (A property, not a method like {@link RowMarker}: the
 * types of two methods would not merge. A copy of a row keeps it in its type, but without
 * the `RowMarker` the copy is a plain object to `Json`, which ignores this key.)
 *
 * @example
 * ```ts
 * type Preloaded = NonNullable<Loaded<typeof Post, "author">["~preloaded"]>; // { readonly author: true }
 * ```
 */
export interface PreloadMarker<P> {
  /** Type-only; never set at runtime. */
  readonly "~preloaded"?: P;
}

/**
 * The static side that every schema class has: its metadata and its field builders.
 *
 * @example
 * ```ts
 * function sourceOf(schema: SchemaStatic): string | null {
 *   return schema[META].source;
 * }
 * ```
 */
export interface SchemaStatic<F extends FieldsShape = FieldsShape> {
  /** An own data property (see {@link META}), never an accessor. */
  readonly [META]: SchemaMeta;
  /** The field builders the class was defined with, for type inference and reflection. */
  readonly fields: F;
}

/**
 * What `Schema(source, fields)` returns: a base class to extend. Its instances are rows.
 *
 * There is **no public constructor** (decision D2): a row comes only from the database (a
 * query, or a successful write), and a new record is described by a changeset
 * (`cast(User, params, [...])`, `change(User, values)`). The construct signature exists so
 * that the class can be extended and so that {@link Row} can read its instance type; its
 * one parameter is `never`, which makes `new User()` and `new User({ … })` compile
 * errors. Rows are created by {@link SchemaMeta.create}, which runs no constructor.
 *
 * @example
 * ```ts
 * declare function Schema<const F extends FieldsShape>(source: string, fields: F): SchemaClass<F>;
 * declare const t: { integer(): FieldBuilder<number>; string(): FieldBuilder<string> };
 *
 * class User extends Schema("users", { id: t.integer().primaryKey().dbGenerated(), email: t.string() }) {
 *   get domain(): string {
 *     return this.email.split("@")[1] ?? "";
 *   }
 * }
 * declare const user: User; // from a query; never `new User()`
 * ```
 */
export type SchemaClass<F extends FieldsShape> = SchemaStatic<F> &
  (new (
    noPublicConstructor: never,
  ) => RowOf<F> & RowMarker<F>);

/**
 * Any schema class: the constraint for "a schema" in every generic signature.
 *
 * @example
 * ```ts
 * function tableName<S extends AnySchema>(schema: S): string | null {
 *   return schema[META].source;
 * }
 * ```
 */
export type AnySchema = SchemaStatic & (abstract new (...args: never[]) => object);

/**
 * The fields object of a schema class.
 *
 * @example
 * ```ts
 * declare const User: SchemaClass<{ id: FieldBuilder<number> }>;
 * type Fields = FieldsOf<typeof User>; // { id: FieldBuilder<number> }
 * ```
 */
export type FieldsOf<S> = S extends SchemaStatic<infer F> ? F : never;

/**
 * The field names of a schema class.
 *
 * @example
 * ```ts
 * declare const User: SchemaClass<{ id: FieldBuilder<number>; email: FieldBuilder<string> }>;
 * type Names = FieldNames<typeof User>; // "id" | "email"
 * ```
 */
export type FieldNames<S> = keyof FieldsOf<S> & string;

/**
 * The type of a row of schema `S`: an instance of the class. It has every field
 * (virtual ones included) and whatever getters and methods the class adds. Associations
 * are **not** properties of a plain row: reading one that was not preloaded is a compile
 * error. See {@link Loaded}.
 *
 * @example
 * ```ts
 * declare const User: SchemaClass<{ id: FieldBuilder<number>; email: FieldBuilder<string> }>;
 * type UserRow = Row<typeof User>; // { id: number; email: string }
 * ```
 */
export type Row<S extends AnySchema> = S extends abstract new (...args: never[]) => infer R ? R : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type InsertRequiredKeys<F> = {
  [K in keyof F]: FieldFlagsOf<F[K]> extends { readonly virtual: true }
    ? never
    : FieldFlagsOf<F[K]> extends { readonly nullable: false; readonly defaulted: false }
      ? K
      : never;
}[keyof F];

type InsertOptionalKeys<F> = {
  [K in keyof F]: FieldFlagsOf<F[K]> extends { readonly virtual: true }
    ? never
    : FieldFlagsOf<F[K]> extends { readonly nullable: false; readonly defaulted: false }
      ? never
      : K;
}[keyof F];

/**
 * The object a caller supplies to insert a row of schema `S`: every persisted field, where
 * a field is optional when it is nullable, has a default, is autogenerated or is read
 * back from the database. Virtual fields are excluded.
 *
 * @example
 * ```ts
 * type Flags<K extends keyof FieldFlags> = WithFlag<DefaultFieldFlags, K>;
 * declare const User: SchemaClass<{
 *   id: FieldBuilder<number, Flags<"defaulted" | "primaryKey">>;
 *   email: FieldBuilder<string>;
 *   name: FieldBuilder<string | null, Flags<"nullable">>;
 * }>;
 * type NewUser = InsertShape<typeof User>; // { email: string; id?: number; name?: string | null }
 * ```
 */
export type InsertShape<S extends AnySchema> = Simplify<
  { -readonly [K in InsertRequiredKeys<FieldsOf<S>>]: FieldValueOf<FieldsOf<S>[K]> } & {
    -readonly [K in InsertOptionalKeys<FieldsOf<S>>]?: FieldValueOf<FieldsOf<S>[K]>;
  }
>;

/**
 * The names of the primary-key fields of schema `S`.
 *
 * @example
 * ```ts
 * type Key = WithFlag<DefaultFieldFlags, "primaryKey">;
 * declare const Membership: SchemaClass<{
 *   orgId: FieldBuilder<string, Key>;
 *   userId: FieldBuilder<number, Key>;
 *   role: FieldBuilder<string>;
 * }>;
 * type Names = PrimaryKeyNames<typeof Membership>; // "orgId" | "userId"
 * ```
 */
export type PrimaryKeyNames<S> = {
  [K in keyof FieldsOf<S>]: FieldFlagsOf<FieldsOf<S>[K]> extends { readonly primaryKey: true } ? K : never;
}[keyof FieldsOf<S>];

type IsUnion<T, U = T> = [T] extends [never] ? false : T extends U ? ([U] extends [T] ? false : true) : never;

/**
 * The value that identifies one row of schema `S`: the key's own type for a single-field
 * primary key, an object of the key fields for a composite key, `never` without a key.
 *
 * @example
 * ```ts
 * type Key = WithFlag<DefaultFieldFlags, "primaryKey">;
 * declare const User: SchemaClass<{ id: FieldBuilder<number, Key>; email: FieldBuilder<string> }>;
 * declare const Membership: SchemaClass<{ orgId: FieldBuilder<string, Key>; userId: FieldBuilder<number, Key> }>;
 * type UserKey = PrimaryKeyOf<typeof User>; // number
 * type MembershipKey = PrimaryKeyOf<typeof Membership>; // { orgId: string; userId: number }
 * ```
 */
export type PrimaryKeyOf<S> =
  IsUnion<PrimaryKeyNames<S>> extends true
    ? { [K in PrimaryKeyNames<S>]: FieldValueOf<FieldsOf<S>[K]> }
    : PrimaryKeyNames<S> extends infer K extends keyof FieldsOf<S>
      ? FieldValueOf<FieldsOf<S>[K]>
      : never;

/**
 * An association declaration: what `hasMany(() => Post)` and its siblings return, held in
 * a `static` member of the owner class (decision D1). `K` is the kind and `T` the target
 * class. `FK` is the foreign-key field name (or names) when it was given as a literal,
 * and `undefined` when the default name applies; {@link Loaded} uses it to decide whether
 * a preloaded `belongsTo` can be `null`.
 *
 * @example
 * ```ts
 * declare function hasMany<T>(target: () => T): Assoc<"hasMany", T, undefined>;
 * declare const Post: AnySchema;
 *
 * const posts = hasMany(() => Post); // Assoc<"hasMany", typeof Post, undefined>
 * ```
 */
export interface Assoc<
  K extends AssocKind = AssocKind,
  T = unknown,
  FK extends string | readonly string[] | undefined = string | readonly string[] | undefined,
> {
  readonly kind: K;
  /** The thunk given at declaration; called lazily, so circular associations work. */
  readonly target: () => T;
  /** Type-level only; never set at runtime. */
  readonly "~foreignKey"?: FK;
}

/**
 * The names of the associations of schema class `S`: the static members that hold an {@link Assoc}.
 *
 * @example
 * ```ts
 * declare const User: AnySchema & { posts: Assoc<"hasMany", AnySchema>; count: number };
 * type Names = AssocKeys<typeof User>; // "posts"
 * ```
 */
export type AssocKeys<S> = { [K in keyof S]: S[K] extends Assoc ? K : never }[keyof S] & string;

/**
 * The target schema class of association `K` of schema class `S`.
 *
 * @example
 * ```ts
 * declare const Post: AnySchema;
 * declare const User: AnySchema & { posts: Assoc<"hasMany", typeof Post> };
 * type T = Target<typeof User, "posts">; // typeof Post
 * ```
 */
export type Target<S, K extends keyof S> =
  S[K] extends Assoc<AssocKind, infer T extends AnySchema> ? T : never;

/**
 * Which associations of schema `S` are loaded, to any depth. One of:
 *
 * - an association name: `"posts"`;
 * - an object from association name to what is loaded beneath it, where `true` means
 *   "loaded, nothing nested": `{ posts: "comments" }`, `{ posts: { comments: "author" } }`,
 *   `{ profile: true }`;
 * - an array of these: `["profile", { posts: "comments" }]`;
 * - a union of these: `"profile" | { posts: "comments" }`.
 *
 * An unknown association name is a compile error at every depth.
 *
 * @example
 * ```ts
 * declare const Comment: AnySchema;
 * declare const Post: AnySchema & { comments: Assoc<"hasMany", typeof Comment> };
 * declare const User: AnySchema & { posts: Assoc<"hasMany", typeof Post> };
 *
 * const one: PreloadSpec<typeof User> = "posts";
 * const nested: PreloadSpec<typeof User> = { posts: "comments" };
 * ```
 */
export type PreloadSpec<S> =
  | AssocKeys<S>
  | { readonly [K in AssocKeys<S>]?: true | PreloadSpec<Target<S, K>> }
  | readonly PreloadSpec<S>[];

type PreloadedKeys<P> = P extends readonly (infer E)[] ? PreloadedKeys<E> : P extends string ? P : keyof P;

type NestedPreload<P, K> = P extends readonly (infer E)[]
  ? NestedPreload<E, K>
  : P extends string
    ? never
    : K extends keyof P
      ? Exclude<P[K], true | undefined>
      : never;

/**
 * A row of `S` with the associations of preload spec `P` loaded: what `repo.all` and the
 * other reads return for a query with nested preloads. It is the type {@link Loaded} names
 * for you, without checking `P` (the query already did), and it is the name that appears in
 * the inferred types (and emitted declarations) of such queries and their results. Write
 * `Loaded` yourself; you rarely need this name.
 *
 * (Internally it is `Loaded` without the constraint on `P`: checking `P` again at every
 * nested level makes the compiler expand the spec through every cycle of associations.)
 *
 * @example
 * ```ts
 * declare const Post: AnySchema & { author: Assoc<"belongsTo", AnySchema> };
 * type PostWithAuthor = LoadedUnchecked<typeof Post, "author">; // Row<typeof Post> & { author: … }
 * ```
 */
export type LoadedUnchecked<S extends AnySchema, P> = Row<S> & {
  [K in PreloadedKeys<P> & AssocKeys<S>]: LoadedAssoc<S, K, NestedPreload<P, K>>;
} & PreloadMarker<{ readonly [K in PreloadedKeys<P> & AssocKeys<S>]: true }>;

type LoadedRow<T extends AnySchema, N> = [N] extends [never] ? Row<T> : LoadedUnchecked<T, N>;

type FieldIsNullable<S extends AnySchema, Name> = Name extends keyof Row<S>
  ? null extends Row<S>[Name]
    ? true
    : false
  : true;

/** Whether the foreign key behind `belongsTo` association `K` of `S` can be null (or is not known). */
type ForeignKeyIsNullable<S extends AnySchema, K extends string, FK> = [FK] extends [undefined]
  ? FieldIsNullable<S, `${K}Id`>
  : FK extends readonly (infer Name)[]
    ? true extends FieldIsNullable<S, Name>
      ? true
      : false
    : string extends FK
      ? true
      : true extends FieldIsNullable<S, FK>
        ? true
        : false;

type LoadedAssoc<S extends AnySchema, K extends string, N> = K extends keyof S
  ? S[K] extends Assoc<infer Kind, infer T extends AnySchema, infer FK>
    ? Kind extends "hasMany" | "manyToMany"
      ? LoadedRow<T, N>[]
      : Kind extends "belongsTo"
        ? ForeignKeyIsNullable<S, K, FK> extends true
          ? LoadedRow<T, N> | null
          : LoadedRow<T, N>
        : LoadedRow<T, N> | null
    : never
  : never;

/**
 * A row of schema `S` with the associations in `P` loaded: {@link Row} plus one property
 * per loaded association, to any depth.
 *
 * - `hasMany` and `manyToMany` become an array of the target's rows.
 * - `hasOne` becomes the target's row or `null`.
 * - `belongsTo` becomes the target's row, or `| null` when the foreign-key field is
 *   nullable. The foreign key is the `foreignKey` given to `belongsTo`, by default
 *   `<association name>Id`; when it cannot be determined the result is `| null`.
 *
 * @example
 * ```ts
 * declare const Comment: AnySchema;
 * declare const Post: AnySchema & { comments: Assoc<"hasMany", typeof Comment> };
 * declare const User: AnySchema & { posts: Assoc<"hasMany", typeof Post> };
 *
 * declare const user: Loaded<typeof User, { posts: "comments" }>;
 * user.posts[0]?.comments; // Row<typeof Comment>[] | undefined
 * ```
 */
export type Loaded<S extends AnySchema, P extends PreloadSpec<S>> = LoadedUnchecked<S, P>;

type LoadedAssocAs<S extends AnySchema, K extends string, E> = K extends keyof S
  ? S[K] extends Assoc<infer Kind, infer _T extends AnySchema, infer FK>
    ? Kind extends "hasMany" | "manyToMany"
      ? E[]
      : Kind extends "belongsTo"
        ? ForeignKeyIsNullable<S, K, FK> extends true
          ? E | null
          : E
        : E | null
    : never
  : never;

/**
 * A row of schema `S` with association `K` loaded as elements of type `E`, whatever `E`
 * is. {@link Loaded} looks the element type up (the target's row); `LoadedAs` is given it.
 * It types a preload whose callback returns something other than whole rows:
 * `preload("posts", (q) => q.select(...))` loads `posts` as the selected shape.
 *
 * `E` is wrapped by the association's kind exactly as in `Loaded`: an array for `hasMany`
 * and `manyToMany`, `| null` for `hasOne`, and for `belongsTo` `| null` when the foreign
 * key is nullable. Nesting needs nothing more: a callback that preloads further returns
 * rows that are already `Loaded`, and that type is `E`.
 *
 * @example
 * ```ts
 * declare const Post: AnySchema;
 * declare const User: AnySchema & { posts: Assoc<"hasMany", typeof Post, "authorId"> };
 *
 * declare const user: LoadedAs<typeof User, "posts", { authorId: number; title: string }>;
 * user.posts[0]?.title; // string | undefined
 * ```
 */
export type LoadedAs<S extends AnySchema, K extends AssocKeys<S>, E> = Row<S> & {
  [A in K]: LoadedAssocAs<S, A, E>;
} & PreloadMarker<{ readonly [A in K]: true }>;

/**
 * The field that a preload of association `K` of `S` matches children on, when the types
 * know it: the literal `foreignKey` of a `hasOne` or `hasMany`. It is `never` otherwise
 * (`belongsTo`, whose key is the target's primary key; `manyToMany`, whose key is in the
 * join table; and a foreign key that was not captured as a literal).
 *
 * @example
 * ```ts
 * declare const Post: AnySchema;
 * declare const User: AnySchema & { posts: Assoc<"hasMany", typeof Post, "authorId"> };
 * type Key = PreloadKey<typeof User, "posts">; // "authorId"
 * ```
 */
export type PreloadKey<S, K extends keyof S> =
  S[K] extends Assoc<infer Kind, unknown, infer FK>
    ? Kind extends "hasOne" | "hasMany"
      ? FK extends string
        ? string extends FK
          ? never
          : FK
        : never
      : never
    : never;

/**
 * `E` if it can be attached to its parent by a preload of association `K` of `S`, else
 * `never`: a selected shape must contain the association's key under its field name (the
 * guide's "the select must include the association's key"). Where {@link PreloadKey} is
 * `never` the types cannot check, `E` is accepted, and step 14's build-time check is the
 * only one. `Query.preload(name, fn)` intersects the callback's result with this, so that
 * a select without the key does not compile.
 *
 * @example
 * ```ts
 * declare const Post: AnySchema;
 * declare const User: AnySchema & { posts: Assoc<"hasMany", typeof Post, "authorId"> };
 *
 * type Ok = PreloadElement<typeof User, "posts", { authorId: number; title: string }>; // unchanged
 * type Bad = PreloadElement<typeof User, "posts", { title: string }>; // never
 * ```
 */
export type PreloadElement<S, K extends keyof S, E> = [PreloadKey<S, K>] extends [never]
  ? E
  : E extends { readonly [P in PreloadKey<S, K>]: unknown }
    ? E
    : never;

/**
 * `P` if it is a valid preload spec for schema `S`, with `never` in place of every part
 * that is not: an unknown association name, at any depth, in any of the forms.
 *
 * It exists for generic functions. A parameter typed `P extends PreloadSpec<S>` accepts
 * `{ posts: true, nope: true }`, because TypeScript checks excess properties only against
 * a non-generic target. Intersecting the parameter with `ValidPreload` closes that gap:
 * the stray key is required to be `never`, so the call does not compile. Every function
 * that takes a preload spec (`Query.preload`, `repo.preload`) declares it this way.
 *
 * A function whose argument has other forms as well (step 14: a custom query, a binding
 * alias, `$from`) first maps its argument type to a {@link PreloadSpec}, with `true` for
 * "loaded, nothing nested", and validates and types the result with these two types.
 *
 * @example
 * ```ts
 * declare function preload<S extends AnySchema, const P>(
 *   schema: S,
 *   spec: P & ValidPreload<S, P>,
 * ): LoadedUnchecked<S, P>;
 * declare const Post: AnySchema;
 * declare const User: AnySchema & { posts: Assoc<"hasMany", typeof Post> };
 *
 * preload(User, { posts: true });
 * // preload(User, { posts: true, nope: true }) does not compile
 * ```
 */
export type ValidPreload<S, P> = P extends string
  ? P extends AssocKeys<S>
    ? P
    : never
  : P extends readonly (infer E)[]
    ? readonly ValidPreload<S, E>[]
    : P extends object
      ? {
          readonly [K in keyof P]: K extends AssocKeys<S>
            ? P[K] extends true
              ? true
              : ValidPreload<Target<S, K>, P[K]>
            : never;
        }
      : never;
