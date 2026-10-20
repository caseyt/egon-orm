/**
 * The object a migration's `change`, `up` and `down` receive (`m`), and the table and
 * column builders its callbacks receive (`t`). They only record: every call appends an
 * {@link Operation}, which the runner turns into SQL (`ddl.ts`) or reverses (`reverse.ts`).
 * Arguments are checked when they are recorded, so a mistake fails at the line that made
 * it.
 *
 * @module
 */
import type { FragmentNode } from "../contracts/query.js";
import { CUSTOM_SQL_TYPE } from "../contracts/type.js";
import { isPlainObject as hasPlainPrototype } from "../internal/plain-object.js";
import { defaultName } from "./names.js";
import type {
  AlterChange,
  ColumnDef,
  ColumnKind,
  ColumnType,
  ConstraintDef,
  CreateTableOp,
  DefaultSpec,
  DefaultValue,
  ExecuteStatement,
  IndexDef,
  ModifyFrom,
  Operation,
  ReferenceAction,
  SqlFragment,
  TableRef,
  TypeSpec,
} from "./types.js";

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const KINDS: ReadonlySet<string> = new Set<ColumnKind>([
  "integer",
  "bigint",
  "float",
  "decimal",
  "boolean",
  "text",
  "uuid",
  "binary",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "json",
  "jsonb",
]);

const PRECISION_KINDS: ReadonlySet<string> = new Set(["time", "timestamp", "timestamptz"]);

const ACTIONS: ReadonlySet<string> = new Set<ReferenceAction>([
  "cascade",
  "restrict",
  "setNull",
  "setDefault",
  "noAction",
]);

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Whether `value` can be written as a SQL string constant: no NUL, and well-formed UTF-16
 * (a lone surrogate has no UTF-8 encoding and would be read back as U+FFFD).
 *
 * @example
 * ```ts
 * isLiteralText("it's"); // true
 * isLiteralText("\ud800"); // false
 * ```
 */
export function isLiteralText(value: string): boolean {
  return !value.includes("\u0000") && !LONE_SURROGATE.test(value);
}

/** A plain object (an object literal), not an array, a class instance or `null`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && hasPlainPrototype(value);
}

/** An identifier as a migration names it: a non-empty string without NUL. It is always quoted. */
function checkName(where: string, what: string, name: unknown): string {
  if (typeof name !== "string" || name.length === 0 || name.includes("\u0000")) {
    throw new TypeError(`${where}: the ${what} must be a non-empty string without NUL characters.`);
  }
  return name;
}

function checkOptions(where: string, options: unknown, keys: readonly string[]): Record<string, unknown> {
  if (options === undefined) return {};
  if (!isPlainObject(options)) throw new TypeError(`${where}: options must be a plain object.`);
  for (const key of Object.keys(options)) {
    if (!keys.includes(key)) {
      throw new TypeError(
        `${where}: unknown option "${key}". The options are ${keys.map((k) => `"${k}"`).join(", ")}.`,
      );
    }
  }
  return options;
}

function optionalBoolean(where: string, options: Record<string, unknown>, key: string): boolean {
  const value = options[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TypeError(`${where}: the option "${key}" must be a boolean.`);
  return value;
}

function optionalName(where: string, options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return value === undefined ? undefined : checkName(where, `option "${key}"`, value);
}

function wholeNumber(where: string, what: string, value: unknown, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${where}: ${what} must be a whole number of at least ${min}.`);
  }
  return value;
}

/** A fragment's node, for DDL or `m.execute`. */
function fragmentOf(
  where: string,
  what: string,
  value: unknown,
): { node: FragmentNode; params: readonly unknown[] } {
  const node =
    typeof value === "object" && value !== null ? (value as { readonly node?: unknown }).node : undefined;
  const params =
    typeof value === "object" && value !== null ? (value as { readonly params?: unknown }).params : undefined;
  if (
    typeof node !== "object" ||
    node === null ||
    (node as { readonly kind?: unknown }).kind !== "fragment" ||
    !Array.isArray(params)
  ) {
    throw new TypeError(
      `${where}: ${what} must be a fragment: fragment\`…\` (import { fragment } from "egon-orm").`,
    );
  }
  const named = (value as { readonly named?: unknown }).named;
  if (Array.isArray(named) && named.length > 0) {
    throw new TypeError(
      `${where}: ${what} has a named parameter (param()), which a migration cannot supply. Interpolate the value itself.`,
    );
  }
  return { node: node as FragmentNode, params: params as readonly unknown[] };
}

function isFragment(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly node?: { readonly kind?: unknown } }).node?.kind === "fragment"
  );
}

/**
 * The type spec of `type`.
 *
 * @throws TypeError when it is not a column type.
 *
 * @example
 * ```ts
 * typeSpec("add()", { kind: "decimal", precision: 10 }).precision; // 10
 * ```
 */
export function typeSpec(where: string, type: unknown): TypeSpec {
  if (typeof type === "string") {
    if (!KINDS.has(type)) {
      throw new TypeError(
        `${where}: unknown column type ${JSON.stringify(type)}. The types are ${[...KINDS].join(", ")}; use { kind: "custom", sql: "…" } for any other.`,
      );
    }
    return {
      kind: type as ColumnKind,
      precision: undefined,
      scale: undefined,
      of: undefined,
      sql: undefined,
    };
  }
  if (!isPlainObject(type)) {
    throw new TypeError(
      `${where}: a column type is a name ("integer") or an object ({ kind: "decimal", … }).`,
    );
  }
  const kind = type.kind;
  if (kind === "array") {
    return {
      kind: "array",
      precision: undefined,
      scale: undefined,
      of: typeSpec(where, type.of),
      sql: undefined,
    };
  }
  if (kind === "custom") {
    const sql = type.sql;
    if (typeof sql !== "string" || !CUSTOM_SQL_TYPE.test(sql)) {
      throw new TypeError(
        `${where}: a custom column type's sql must be a plain type name (letters, digits, underscores, single spaces or dots, an optional (n) or (n, m) and [] pairs). It is written into the SQL as it is, so anything else is refused.`,
      );
    }
    return { kind: "custom", precision: undefined, scale: undefined, of: undefined, sql };
  }
  if (typeof kind !== "string" || !KINDS.has(kind)) {
    throw new TypeError(`${where}: unknown column type kind ${JSON.stringify(kind)}.`);
  }
  let precision: number | undefined;
  let scale: number | undefined;
  if (kind === "decimal") {
    if (type.precision !== undefined)
      precision = wholeNumber(where, "a decimal's precision", type.precision, 1);
    if (type.scale !== undefined) {
      if (precision === undefined) throw new TypeError(`${where}: a decimal's scale needs a precision.`);
      scale = wholeNumber(where, "a decimal's scale", type.scale, 0);
    }
  } else if (PRECISION_KINDS.has(kind)) {
    if (type.precision !== undefined)
      precision = wholeNumber(where, `a ${kind}'s precision`, type.precision, 0);
  } else if (type.precision !== undefined || type.scale !== undefined) {
    throw new TypeError(`${where}: a ${kind} column takes no precision or scale.`);
  }
  return { kind: kind as ColumnKind, precision, scale, of: undefined, sql: undefined };
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 100) return false;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (value === null) return true;
      if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
      return isPlainObject(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
    default:
      return false;
  }
}

/**
 * The recorded default of a column of type `type`.
 *
 * @throws TypeError for a value that cannot be written as a SQL constant.
 *
 * @example
 * ```ts
 * defaultSpec("default()", typeSpec("x", "text"), "member"); // { kind: "value", value: "member" }
 * ```
 */
export function defaultSpec(where: string, type: TypeSpec, value: unknown): DefaultSpec {
  if (isFragment(value)) {
    const { node, params } = fragmentOf(where, "the default", value);
    if (params.length > 0) throw boundInDdl(where, "a default");
    return { kind: "sql", node };
  }
  const json = type.kind === "json" || type.kind === "jsonb";
  switch (typeof value) {
    case "string":
      if (!isLiteralText(value)) {
        throw new TypeError(`${where}: a default string cannot hold a NUL character or a lone surrogate.`);
      }
      return { kind: "value", value };
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${where}: a default number must be finite.`);
      return { kind: "value", value };
    case "bigint":
    case "boolean":
      return { kind: "value", value };
    case "object":
      if (value === null) return { kind: "value", value: null };
      if (json && isJsonValue(value)) return { kind: "value", value: JSON.stringify(value) };
      break;
    default:
      break;
  }
  throw new TypeError(
    `${where}: a default is a string, a finite number, a bigint, a boolean, null${json ? ", a JSON object or array" : ""}, or a fragment for an expression (fragment\`now()\`).`,
  );
}

function boundInDdl(where: string, what: string): TypeError {
  return new TypeError(
    `${where}: ${what} cannot bind values: DDL takes no parameters. Write the constant in the template text, or use fragment.ident() for a name.`,
  );
}

function referenceAction(where: string, key: string, value: unknown): ReferenceAction | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ACTIONS.has(value)) {
    throw new TypeError(`${where}: ${key} must be one of ${[...ACTIONS].map((a) => `"${a}"`).join(", ")}.`);
  }
  return value as ReferenceAction;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** What the column builders need to know about the table and the database. */
interface TableContext {
  readonly table: TableRef;
  /** The database's identifier limit in bytes, for default names; `undefined` for none. */
  readonly maxBytes: number | undefined;
  /** Where in the migration the builder is, for error messages. */
  readonly where: string;
}

function newColumn(name: string, type: TypeSpec, serial: boolean): ColumnDef {
  return {
    name,
    type,
    serial,
    notNull: false,
    default: undefined,
    primaryKey: false,
    unique: undefined,
    references: undefined,
    check: undefined,
  };
}

/**
 * One column being defined: `t.text("email").notNull().unique()`. Each method changes
 * the column and returns the builder, so calls chain.
 *
 * Columns allow `NULL` unless `.notNull()` is called, as in SQL.
 *
 * @example
 * ```ts
 * m.createTable("users", (t) => {
 *   t.id();
 *   t.text("email").notNull().unique();
 *   t.integer("login_count").notNull().default(0);
 * });
 * ```
 */
export class ColumnBuilder {
  readonly #column: ColumnDef;
  readonly #context: TableContext;

  /** @internal */
  constructor(column: ColumnDef, context: TableContext) {
    this.#column = column;
    this.#context = context;
  }

  /** `NOT NULL`. */
  notNull(): this {
    this.#column.notNull = true;
    return this;
  }

  /** Allows `NULL` (the default); written for clarity. */
  nullable(): this {
    this.#column.notNull = false;
    return this;
  }

  /**
   * The column's database default: a constant, or an expression as a fragment.
   *
   * @throws TypeError for a value that cannot be written as a SQL constant.
   */
  default(value: DefaultValue): this {
    this.#column.default = defaultSpec(
      `${this.#context.where}: ${this.#column.name}.default()`,
      this.#column.type,
      value,
    );
    return this;
  }

  /** Makes the column (part of) the primary key. */
  primaryKey(): this {
    this.#column.primaryKey = true;
    return this;
  }

  /**
   * A unique constraint on this column, named `<table>_<column>_key` unless `name` is given.
   *
   * @throws TypeError when an option is unknown or has the wrong type.
   */
  unique(options?: { readonly name?: string }): this {
    const where = `${this.#context.where}: ${this.#column.name}.unique()`;
    const checked = checkOptions(where, options, ["name"]);
    this.#column.unique =
      optionalName(where, checked, "name") ??
      defaultName(this.#context.table.name, [this.#column.name], "key", this.#context.maxBytes);
    return this;
  }
}

/**
 * Options of {@link ColumnAdder.id}: the key's type, `"bigint"` (`bigserial`, the default)
 * or `"integer"` (`serial`).
 *
 * @example
 * ```ts
 * const options: IdOptions = { type: "integer" };
 * ```
 */
export interface IdOptions {
  readonly type?: "bigint" | "integer";
}

/**
 * Options of {@link ColumnAdder.references}.
 *
 * @example
 * ```ts
 * const options: ReferencesOptions = { type: "uuid", onDelete: "cascade" };
 * ```
 */
export interface ReferencesOptions {
  /** The column's type; `"bigint"` by default (the type `id()` makes). */
  readonly type?: ColumnType;
  /** The referenced column; `"id"` by default. */
  readonly column?: string;
  /** The database schema of the referenced table. */
  readonly schema?: string;
  readonly onDelete?: ReferenceAction;
  readonly onUpdate?: ReferenceAction;
  /** The constraint's name; `<table>_<column>_fkey` by default. */
  readonly name?: string;
}

/**
 * Options of {@link ColumnAdder.timestamps}.
 *
 * @example
 * ```ts
 * const options: TimestampsColumnsOptions = { type: "timestamp", createdAt: "inserted_at" };
 * ```
 */
export interface TimestampsColumnsOptions {
  /** `"timestamptz"` (the default) or `"timestamp"`. */
  readonly type?: "timestamptz" | "timestamp";
  /** The column names; `created_at` and `updated_at` by default. */
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/**
 * The column methods shared by `createTable` and `alterTable`: one per column type of
 * `DbType`, and the helpers `id`, `references`, `enumText` and `timestamps`. In
 * `createTable` each defines a column; in `alterTable` each adds one.
 *
 * The method names are the `DbType` kinds, so `timestamp` is a timestamp **without** a
 * time zone and `timestamptz` one with it. (The schema field builder `t.timestamp()` is
 * stored as `timestamptz`.) `string` is another name for `text`.
 *
 * @example
 * ```ts
 * m.createTable("posts", (t) => {
 *   t.id();
 *   t.references("author_id", "users").notNull();
 *   t.text("title").notNull();
 *   t.array("tags", "text");
 *   t.timestamps();
 * });
 * ```
 */
export class ColumnAdder {
  /** @internal */
  protected readonly context: TableContext;
  /** @internal */
  protected readonly added: (column: ColumnDef) => void;

  /** @internal */
  constructor(context: TableContext, added: (column: ColumnDef) => void) {
    this.context = context;
    this.added = added;
  }

  /**
   * A column of any type: `t.add("price", { kind: "decimal", precision: 10, scale: 2 })`.
   *
   * @throws TypeError when the name or the type is not valid.
   */
  add(name: string, type: ColumnType): ColumnBuilder {
    const where = `${this.context.where}: add()`;
    return this.column(checkName(where, "column name", name), typeSpec(where, type), false);
  }

  /** `integer`. */
  integer(name: string): ColumnBuilder {
    return this.add(name, "integer");
  }

  /** `bigint`. */
  bigint(name: string): ColumnBuilder {
    return this.add(name, "bigint");
  }

  /** `double precision` on Postgres. */
  float(name: string): ColumnBuilder {
    return this.add(name, "float");
  }

  /** `numeric`, with an optional precision and scale. */
  decimal(name: string, options?: { readonly precision?: number; readonly scale?: number }): ColumnBuilder {
    const checked = checkOptions(`${this.context.where}: decimal()`, options, ["precision", "scale"]);
    return this.add(name, { kind: "decimal", ...checked } as ColumnType);
  }

  /** `boolean`. */
  boolean(name: string): ColumnBuilder {
    return this.add(name, "boolean");
  }

  /** `text`. */
  text(name: string): ColumnBuilder {
    return this.add(name, "text");
  }

  /** `text` (another name for {@link ColumnAdder.text}, as the schema field builder calls it). */
  string(name: string): ColumnBuilder {
    return this.add(name, "text");
  }

  /** `uuid`. */
  uuid(name: string): ColumnBuilder {
    return this.add(name, "uuid");
  }

  /** `bytea` on Postgres. */
  binary(name: string): ColumnBuilder {
    return this.add(name, "binary");
  }

  /** `date`. */
  date(name: string): ColumnBuilder {
    return this.add(name, "date");
  }

  /** `time`, with an optional fractional-second precision. */
  time(name: string, options?: { readonly precision?: number }): ColumnBuilder {
    return this.precise("time", name, options);
  }

  /** A timestamp **without** a time zone, with an optional fractional-second precision. */
  timestamp(name: string, options?: { readonly precision?: number }): ColumnBuilder {
    return this.precise("timestamp", name, options);
  }

  /** A timestamp **with** a time zone, with an optional fractional-second precision. */
  timestamptz(name: string, options?: { readonly precision?: number }): ColumnBuilder {
    return this.precise("timestamptz", name, options);
  }

  /** `json`. */
  json(name: string): ColumnBuilder {
    return this.add(name, "json");
  }

  /** `jsonb`. (The schema field builder `t.json()` is stored as `jsonb`.) */
  jsonb(name: string): ColumnBuilder {
    return this.add(name, "jsonb");
  }

  /** An array of `of`: `t.array("tags", "text")`. */
  array(name: string, of: ColumnType): ColumnBuilder {
    return this.add(name, { kind: "array", of });
  }

  /**
   * A column of a type named by trusted program text: `t.custom("email", "citext")`.
   *
   * @throws TypeError when `sql` is not a plain type name.
   */
  custom(name: string, sql: string): ColumnBuilder {
    return this.add(name, { kind: "custom", sql });
  }

  /**
   * A key the database generates: `bigserial primary key` named `id` by default, or
   * `serial` with `{ type: "integer" }`. The options can come first when the column is
   * named `id`: `t.id({ type: "integer" })` is `t.id("id", { type: "integer" })`.
   *
   * @throws TypeError when an option is unknown or has the wrong type, or when options
   * come first and a second argument is given too.
   */
  id(options?: IdOptions): ColumnBuilder;
  id(name?: string, options?: IdOptions): ColumnBuilder;
  id(nameOrOptions: string | IdOptions = "id", options?: IdOptions): ColumnBuilder {
    const where = `${this.context.where}: id()`;
    let name: unknown = nameOrOptions;
    if (typeof nameOrOptions === "object" && nameOrOptions !== null) {
      if (options !== undefined) {
        throw new TypeError(`${where}: give the options once, as t.id(options) or t.id(name, options).`);
      }
      name = "id";
      options = nameOrOptions;
    }
    const checked = checkOptions(where, options, ["type"]);
    const kind = checked.type ?? "bigint";
    if (kind !== "bigint" && kind !== "integer") {
      throw new TypeError(`${where}: the option "type" must be "bigint" or "integer".`);
    }
    return this.column(checkName(where, "column name", name), typeSpec(where, kind), true).primaryKey();
  }

  /**
   * A column that references another table's key, with a foreign key constraint named
   * `<table>_<column>_fkey`: `t.references("author_id", "users")`.
   *
   * @throws TypeError when an option is unknown or has the wrong type.
   */
  references(name: string, table: string, options?: ReferencesOptions): ColumnBuilder {
    const where = `${this.context.where}: references("${String(name)}")`;
    const checked = checkOptions(where, options, [
      "type",
      "column",
      "schema",
      "onDelete",
      "onUpdate",
      "name",
    ]);
    const column = checkName(where, "column name", name);
    const builder = this.column(column, typeSpec(where, checked.type ?? "bigint"), false);
    const def = this.#last as ColumnDef;
    def.references = {
      name:
        optionalName(where, checked, "name") ??
        defaultName(this.context.table.name, [column], "fkey", this.context.maxBytes),
      table: {
        name: checkName(where, "referenced table", table),
        schema: optionalName(where, checked, "schema"),
      },
      column: optionalName(where, checked, "column") ?? "id",
      onDelete: referenceAction(where, "onDelete", checked.onDelete),
      onUpdate: referenceAction(where, "onUpdate", checked.onUpdate),
    };
    return builder;
  }

  /**
   * A `text` column that only takes the given values, enforced by a check constraint named
   * `<table>_<column>_check`. The values are written into the constraint as SQL literals.
   *
   * @throws TypeError when `values` is not a non-empty array of strings without NUL.
   */
  enumText(name: string, values: readonly string[]): ColumnBuilder {
    const where = `${this.context.where}: enumText("${String(name)}")`;
    if (!Array.isArray(values) || values.length === 0) {
      throw new TypeError(`${where}: the values must be a non-empty array of strings.`);
    }
    for (const value of values) {
      if (typeof value !== "string" || !isLiteralText(value)) {
        throw new TypeError(
          `${where}: every value must be a string without NUL characters or lone surrogates.`,
        );
      }
    }
    const column = checkName(where, "column name", name);
    const builder = this.column(column, typeSpec(where, "text"), false);
    (this.#last as ColumnDef).check = {
      name: defaultName(this.context.table.name, [column], "check", this.context.maxBytes),
      values: Object.freeze([...values]),
    };
    return builder;
  }

  /**
   * `created_at` and `updated_at`: `timestamptz not null default now()`.
   *
   * @throws TypeError when an option is unknown or has the wrong type.
   */
  timestamps(options?: TimestampsColumnsOptions): void {
    const where = `${this.context.where}: timestamps()`;
    const checked = checkOptions(where, options, ["type", "createdAt", "updatedAt"]);
    const kind = checked.type ?? "timestamptz";
    if (kind !== "timestamptz" && kind !== "timestamp") {
      throw new TypeError(`${where}: the option "type" must be "timestamptz" or "timestamp".`);
    }
    for (const column of [
      optionalName(where, checked, "createdAt") ?? "created_at",
      optionalName(where, checked, "updatedAt") ?? "updated_at",
    ]) {
      this.column(column, typeSpec(where, kind), false).notNull();
      (this.#last as ColumnDef).default = { kind: "now" };
    }
  }

  /** The column most recently added. */
  #last: ColumnDef | undefined = undefined;

  private precise(
    kind: "time" | "timestamp" | "timestamptz",
    name: string,
    options: { readonly precision?: number } | undefined,
  ): ColumnBuilder {
    const checked = checkOptions(`${this.context.where}: ${kind}()`, options, ["precision"]);
    return this.add(
      name,
      (checked.precision === undefined ? kind : { kind, precision: checked.precision }) as ColumnType,
    );
  }

  private column(name: string, type: TypeSpec, serial: boolean): ColumnBuilder {
    const column = newColumn(name, type, serial);
    this.#last = column;
    this.added(column);
    return new ColumnBuilder(column, this.context);
  }
}

/**
 * The `t` of `m.createTable(name, (t) => …)`: defines the table's columns.
 *
 * @example
 * ```ts
 * m.createTable("memberships", (t) => {
 *   t.references("org_id", "orgs", { type: "uuid", onDelete: "cascade" }).notNull().primaryKey();
 *   t.references("user_id", "users", { onDelete: "cascade" }).notNull().primaryKey();
 *   t.enumText("role", ["admin", "member"]).notNull().default("member");
 * });
 * ```
 */
export class TableBuilder extends ColumnAdder {}

/**
 * Options of {@link AlterTableBuilder.modify}.
 *
 * @example
 * ```ts
 * const options: ModifyOptions = { notNull: true, from: { type: "integer", notNull: false } };
 * ```
 */
export interface ModifyOptions {
  /**
   * What the column was before: its type, or `{ type, notNull, default }`. Needed to roll
   * the change back; without it a `change` migration cannot be reversed.
   */
  readonly from?:
    | ColumnType
    | { readonly type: ColumnType; readonly notNull?: boolean; readonly default?: DefaultValue };
  /** `true` sets `NOT NULL`, `false` drops it; leave it out to keep it as it is. */
  readonly notNull?: boolean;
  /** A new default; `null` drops the default; leave it out to keep it. */
  readonly default?: DefaultValue;
}

/**
 * Options of {@link AlterTableBuilder.remove}: what the column was, for the reversal.
 *
 * @example
 * ```ts
 * const options: RemoveOptions = { notNull: true, default: 0 };
 * ```
 */
export interface RemoveOptions {
  readonly notNull?: boolean;
  readonly default?: DefaultValue;
}

/**
 * The `t` of `m.alterTable(name, (t) => …)`: adds columns with the same methods as
 * `createTable`, and modifies, removes and renames them.
 *
 * @example
 * ```ts
 * m.alterTable("users", (t) => {
 *   t.text("nickname");
 *   t.modify("age", "bigint", { from: "integer" });
 *   t.remove("legacy_flag", "boolean");
 *   t.rename("name", "full_name");
 * });
 * ```
 */
export class AlterTableBuilder extends ColumnAdder {
  readonly #changes: AlterChange[];

  /** @internal */
  constructor(context: TableContext, changes: AlterChange[]) {
    super(context, (column) => changes.push({ change: "add", column }));
    this.#changes = changes;
  }

  /**
   * Changes a column's type and, optionally, its nullability and default.
   *
   * @throws TypeError when an argument is not valid.
   */
  modify(name: string, type: ColumnType, options?: ModifyOptions): void {
    const where = `${this.context.where}: modify("${String(name)}")`;
    const checked = checkOptions(where, options, ["from", "notNull", "default"]);
    const column = checkName(where, "column name", name);
    const spec = typeSpec(where, type);
    const notNull = checked.notNull === undefined ? undefined : optionalBoolean(where, checked, "notNull");
    const def = checked.default === undefined ? undefined : nullableDefault(where, spec, checked.default);
    this.#changes.push({
      change: "modify",
      column,
      type: spec,
      notNull,
      default: def,
      from: checked.from === undefined ? undefined : modifyFrom(where, checked.from),
    });
  }

  /**
   * Drops a column. Give its type (and options) so that a `change` migration can add it
   * back on rollback.
   *
   * @throws TypeError when an argument is not valid.
   */
  remove(name: string, type?: ColumnType, options?: RemoveOptions): void {
    const where = `${this.context.where}: remove("${String(name)}")`;
    const column = checkName(where, "column name", name);
    if (type === undefined) {
      if (options !== undefined) throw new TypeError(`${where}: options need the column's type.`);
      this.#changes.push({ change: "remove", column, definition: undefined });
      return;
    }
    const checked = checkOptions(where, options, ["notNull", "default"]);
    const definition = newColumn(column, typeSpec(where, type), false);
    definition.notNull = optionalBoolean(where, checked, "notNull");
    if (checked.default !== undefined)
      definition.default = defaultSpec(where, definition.type, checked.default);
    this.#changes.push({ change: "remove", column, definition });
  }

  /**
   * Renames a column.
   *
   * @throws TypeError when a name is not valid.
   */
  rename(from: string, to: string): void {
    const where = `${this.context.where}: rename()`;
    this.#changes.push({
      change: "rename",
      column: checkName(where, "column name", from),
      to: checkName(where, "new name", to),
    });
  }
}

function nullableDefault(where: string, type: TypeSpec, value: unknown): DefaultSpec | null {
  return value === null ? null : defaultSpec(where, type, value);
}

function modifyFrom(where: string, from: unknown): ModifyFrom {
  if (isPlainObject(from) && "type" in from) {
    const checked = checkOptions(`${where} from`, from, ["type", "notNull", "default"]);
    const type = typeSpec(where, checked.type);
    return {
      type,
      notNull: checked.notNull === undefined ? undefined : optionalBoolean(where, checked, "notNull"),
      default: checked.default === undefined ? undefined : nullableDefault(where, type, checked.default),
    };
  }
  return { type: typeSpec(where, from), notNull: undefined, default: undefined };
}

// ---------------------------------------------------------------------------
// The migration builder
// ---------------------------------------------------------------------------

/**
 * Options of {@link MigrationBuilder.createTable}.
 *
 * @example
 * ```ts
 * const options: CreateTableOptions = { schema: "audit", primaryKey: false };
 * ```
 */
export interface CreateTableOptions {
  /** The database schema of the table. */
  readonly schema?: string;
  /**
   * `false` declares that the table has no primary key. Without it a table must have one
   * (`t.id()`, or `.primaryKey()` on its key columns).
   */
  readonly primaryKey?: false;
  /** `CREATE TABLE IF NOT EXISTS`. Such a table cannot be rolled back by a `change` migration. */
  readonly ifNotExists?: boolean;
}

/**
 * Options of {@link MigrationBuilder.dropTable}.
 *
 * @example
 * ```ts
 * const options: DropTableOptions = { ifExists: true };
 * ```
 */
export interface DropTableOptions {
  readonly schema?: string;
  /** As in {@link CreateTableOptions}, for the definition. */
  readonly primaryKey?: false;
  readonly ifExists?: boolean;
  /** `DROP TABLE … CASCADE`: also drops what depends on the table. Cannot be rolled back. */
  readonly cascade?: boolean;
}

/**
 * Options of {@link MigrationBuilder.createIndex} and {@link MigrationBuilder.dropIndex}.
 *
 * @example
 * ```ts
 * const options: IndexOptions = { unique: true, where: fragment`deleted_at is null`, name: "users_live_email_key" };
 * ```
 */
export interface IndexOptions {
  /** A unique index, named `<table>_<columns>_key` (else `<table>_<columns>_index`). */
  readonly unique?: boolean;
  /** The index's name, instead of the default. Required when a column is an expression. */
  readonly name?: string;
  /** A partial index: the predicate, as a fragment. */
  readonly where?: SqlFragment;
  /** The index method: `"btree"`, `"gin"`, `"gist"`, … */
  readonly using?: string;
  /** Builds (or drops) the index without locking out writes. Needs `transaction: false`. */
  readonly concurrently?: boolean;
  /** Columns stored in the index but not part of its key. */
  readonly include?: readonly string[];
  /** The database schema of the table. */
  readonly schema?: string;
  /** `createIndex` only: `IF NOT EXISTS`. Such an index cannot be rolled back by a `change` migration. */
  readonly ifNotExists?: boolean;
  /** `dropIndex` only: `IF EXISTS`. */
  readonly ifExists?: boolean;
}

/**
 * Options of {@link MigrationBuilder.createConstraint}: exactly one of `check` and `exclude`.
 *
 * @example
 * ```ts
 * const options: ConstraintOptions = { check: fragment`price > 0` };
 * ```
 */
export interface ConstraintOptions {
  /** A check constraint's condition. */
  readonly check?: SqlFragment;
  /** An exclusion constraint's elements (`during with &&`). */
  readonly exclude?: SqlFragment;
  /** An exclusion constraint's index method; `"gist"` by default. */
  readonly using?: string;
  readonly schema?: string;
}

/**
 * Options of {@link MigrationBuilder.dropConstraint}.
 *
 * @example
 * ```ts
 * const options: DropConstraintOptions = { check: fragment`price > 0`, ifExists: true };
 * ```
 */
export interface DropConstraintOptions extends ConstraintOptions {
  readonly ifExists?: boolean;
}

/**
 * The `m` a migration's `change`, `up` and `down` receive. Each method records one
 * operation; nothing runs until the runner executes the migration.
 *
 * In `change`, every operation must be reversible (the runner rolls it back by running
 * the inverses in reverse order). An operation that lacks what its inverse needs is
 * accepted when recorded and refused with `MigrationError` when it is rolled back, with
 * the fix in the message.
 *
 * @example
 * ```ts
 * import { defineMigration } from "egon-orm/migration";
 *
 * export const migration = defineMigration({
 *   change(m) {
 *     m.createTable("users", (t) => {
 *       t.id();
 *       t.text("email").notNull();
 *     });
 *     m.createIndex("users", ["email"], { unique: true });
 *   },
 * });
 * ```
 */
export class MigrationBuilder {
  readonly #operations: Operation[] = [];
  readonly #maxBytes: number | undefined;

  /** @internal */
  constructor(maxBytes: number | undefined) {
    this.#maxBytes = maxBytes;
  }

  /** @internal The operations recorded so far, in order. */
  get operations(): readonly Operation[] {
    return this.#operations;
  }

  /**
   * `CREATE TABLE`.
   *
   * @throws TypeError when an argument is not valid, when the table has no column, or
   * when it has no primary key and `primaryKey: false` was not given (or has one although
   * it was).
   */
  createTable(name: string, define: (t: TableBuilder) => void, options?: CreateTableOptions): void {
    const where = `createTable("${String(name)}")`;
    const checked = checkOptions(where, options, ["schema", "primaryKey", "ifNotExists"]);
    this.#operations.push({
      ...this.#table(where, name, define, checked),
      ifNotExists: optionalBoolean(where, checked, "ifNotExists"),
    });
  }

  /**
   * `DROP TABLE`. Pass the table's definition as `define` so that a `change` migration
   * can create it again on rollback.
   *
   * @throws TypeError when an argument is not valid.
   */
  dropTable(name: string, define?: (t: TableBuilder) => void, options?: DropTableOptions): void {
    const where = `dropTable("${String(name)}")`;
    const checked = checkOptions(where, options, ["schema", "primaryKey", "ifExists", "cascade"]);
    const table = this.#ref(where, name, checked);
    const definition =
      define === undefined ? undefined : { ...this.#table(where, name, define, checked), ifNotExists: false };
    this.#operations.push({
      op: "dropTable",
      table,
      definition,
      ifExists: optionalBoolean(where, checked, "ifExists"),
      cascade: optionalBoolean(where, checked, "cascade"),
    });
  }

  /**
   * `ALTER TABLE`: add, modify, remove and rename columns.
   *
   * @throws TypeError when an argument is not valid, or the callback changes nothing.
   */
  alterTable(
    name: string,
    define: (t: AlterTableBuilder) => void,
    options?: { readonly schema?: string },
  ): void {
    const where = `alterTable("${String(name)}")`;
    const checked = checkOptions(where, options, ["schema"]);
    const table = this.#ref(where, name, checked);
    if (typeof define !== "function")
      throw new TypeError(`${where}: the second argument must be a function.`);
    const changes: AlterChange[] = [];
    define(new AlterTableBuilder({ table, maxBytes: this.#maxBytes, where }, changes));
    if (changes.length === 0) throw new TypeError(`${where}: the callback changed nothing.`);
    this.#operations.push({ op: "alterTable", table, changes });
  }

  /**
   * Renames a table.
   *
   * @throws TypeError when a name is not valid.
   */
  renameTable(from: string, to: string, options?: { readonly schema?: string }): void {
    const where = `renameTable("${String(from)}")`;
    const checked = checkOptions(where, options, ["schema"]);
    this.#operations.push({
      op: "renameTable",
      table: this.#ref(where, from, checked),
      to: checkName(where, "new name", to),
    });
  }

  /**
   * `CREATE INDEX`, named `<table>_<columns>_key` when unique and `<table>_<columns>_index`
   * otherwise, unless `name` is given.
   *
   * @throws TypeError when an argument is not valid.
   */
  createIndex(table: string, columns: readonly (string | SqlFragment)[], options?: IndexOptions): void {
    const where = `createIndex("${String(table)}")`;
    const checked = checkOptions(where, options, [
      "unique",
      "name",
      "where",
      "using",
      "concurrently",
      "include",
      "schema",
      "ifNotExists",
    ]);
    this.#operations.push({
      op: "createIndex",
      index: this.#index(where, table, columns, checked),
      ifNotExists: optionalBoolean(where, checked, "ifNotExists"),
    });
  }

  /**
   * `DROP INDEX`. Takes the same arguments as the {@link MigrationBuilder.createIndex} it
   * undoes, which name the index and let a `change` migration create it again.
   *
   * @throws TypeError when an argument is not valid.
   */
  dropIndex(table: string, columns: readonly (string | SqlFragment)[], options?: IndexOptions): void {
    const where = `dropIndex("${String(table)}")`;
    const checked = checkOptions(where, options, [
      "unique",
      "name",
      "where",
      "using",
      "concurrently",
      "include",
      "schema",
      "ifExists",
    ]);
    this.#operations.push({
      op: "dropIndex",
      index: this.#index(where, table, columns, checked),
      ifExists: optionalBoolean(where, checked, "ifExists"),
    });
  }

  /**
   * Adds a check or exclusion constraint.
   *
   * @throws TypeError when an argument is not valid, or not exactly one of `check` and
   * `exclude` is given.
   */
  createConstraint(table: string, name: string, options: ConstraintOptions): void {
    const where = `createConstraint("${String(table)}", "${String(name)}")`;
    const checked = checkOptions(where, options, ["check", "exclude", "using", "schema"]);
    const definition = constraintDef(where, checked);
    if (definition === undefined)
      throw new TypeError(`${where}: give exactly one of { check } and { exclude }.`);
    this.#operations.push({
      op: "createConstraint",
      table: this.#ref(where, table, checked),
      name: checkName(where, "constraint name", name),
      definition,
    });
  }

  /**
   * Drops a constraint. Give its definition (`check` or `exclude`) so that a `change`
   * migration can add it back on rollback.
   *
   * @throws TypeError when an argument is not valid.
   */
  dropConstraint(table: string, name: string, options?: DropConstraintOptions): void {
    const where = `dropConstraint("${String(table)}", "${String(name)}")`;
    const checked = checkOptions(where, options, ["check", "exclude", "using", "schema", "ifExists"]);
    this.#operations.push({
      op: "dropConstraint",
      table: this.#ref(where, table, checked),
      name: checkName(where, "constraint name", name),
      definition: constraintDef(where, checked),
      ifExists: optionalBoolean(where, checked, "ifExists"),
    });
  }

  /**
   * Runs SQL written as a fragment; its interpolations are bound parameters. Give `down`
   * as well so that a `change` migration can roll it back.
   *
   * @example
   * ```ts
   * m.execute(fragment`update users set role = ${"member"} where role is null`);
   * ```
   *
   * @throws TypeError when an argument is not a fragment.
   */
  execute(up: SqlFragment, down?: SqlFragment): void {
    this.#operations.push({
      op: "execute",
      up: statement("execute()", up),
      down: down === undefined ? undefined : statement("execute()", down),
    });
  }

  /**
   * `CREATE SCHEMA` (a database schema).
   *
   * @throws TypeError when an argument is not valid.
   */
  createSchema(name: string, options?: { readonly ifNotExists?: boolean }): void {
    const where = `createSchema("${String(name)}")`;
    const checked = checkOptions(where, options, ["ifNotExists"]);
    this.#operations.push({
      op: "createSchema",
      name: checkName(where, "schema name", name),
      ifNotExists: optionalBoolean(where, checked, "ifNotExists"),
    });
  }

  /**
   * `DROP SCHEMA`.
   *
   * @throws TypeError when an argument is not valid.
   */
  dropSchema(name: string, options?: { readonly ifExists?: boolean; readonly cascade?: boolean }): void {
    const where = `dropSchema("${String(name)}")`;
    const checked = checkOptions(where, options, ["ifExists", "cascade"]);
    this.#operations.push({
      op: "dropSchema",
      name: checkName(where, "schema name", name),
      ifExists: optionalBoolean(where, checked, "ifExists"),
      cascade: optionalBoolean(where, checked, "cascade"),
    });
  }

  /**
   * `CREATE EXTENSION`.
   *
   * @throws TypeError when an argument is not valid.
   */
  createExtension(
    name: string,
    options?: { readonly ifNotExists?: boolean; readonly schema?: string },
  ): void {
    const where = `createExtension("${String(name)}")`;
    const checked = checkOptions(where, options, ["ifNotExists", "schema"]);
    this.#operations.push({
      op: "createExtension",
      name: checkName(where, "extension name", name),
      schema: optionalName(where, checked, "schema"),
      ifNotExists: optionalBoolean(where, checked, "ifNotExists"),
    });
  }

  /**
   * `DROP EXTENSION`.
   *
   * @throws TypeError when an argument is not valid.
   */
  dropExtension(name: string, options?: { readonly ifExists?: boolean }): void {
    const where = `dropExtension("${String(name)}")`;
    const checked = checkOptions(where, options, ["ifExists"]);
    this.#operations.push({
      op: "dropExtension",
      name: checkName(where, "extension name", name),
      ifExists: optionalBoolean(where, checked, "ifExists"),
    });
  }

  #ref(where: string, name: unknown, options: Record<string, unknown>): TableRef {
    return { name: checkName(where, "table name", name), schema: optionalName(where, options, "schema") };
  }

  #table(
    where: string,
    name: unknown,
    define: unknown,
    options: Record<string, unknown>,
  ): Omit<CreateTableOp, "ifNotExists"> {
    const table = this.#ref(where, name, options);
    if (typeof define !== "function")
      throw new TypeError(`${where}: the table definition must be a function.`);
    if (options.primaryKey !== undefined && options.primaryKey !== false) {
      throw new TypeError(
        `${where}: the option "primaryKey" can only be false (a table without a primary key).`,
      );
    }
    const columns: ColumnDef[] = [];
    (define as (t: TableBuilder) => void)(
      new TableBuilder({ table, maxBytes: this.#maxBytes, where }, (column) => columns.push(column)),
    );
    if (columns.length === 0) throw new TypeError(`${where}: the table has no columns.`);
    const keyed = columns.some((column) => column.primaryKey);
    if (options.primaryKey === false && keyed) {
      throw new TypeError(`${where}: primaryKey: false was given, but a column is declared .primaryKey().`);
    }
    if (options.primaryKey === undefined && !keyed) {
      throw new TypeError(
        `${where}: the table has no primary key. Add t.id() or call .primaryKey() on its key columns, or pass { primaryKey: false } for a table without one.`,
      );
    }
    return { op: "createTable", table, columns };
  }

  #index(where: string, table: unknown, columns: unknown, options: Record<string, unknown>): IndexDef {
    const ref = this.#ref(where, table, options);
    if (!Array.isArray(columns) || columns.length === 0) {
      throw new TypeError(`${where}: the columns must be a non-empty array of column names or fragments.`);
    }
    const nodes: (string | FragmentNode)[] = [];
    let expressions = false;
    for (const column of columns as readonly unknown[]) {
      if (typeof column === "string") {
        nodes.push(checkName(where, "column name", column));
      } else {
        const { node, params } = fragmentOf(where, "an index column", column);
        if (params.length > 0) throw boundInDdl(where, "an index expression");
        nodes.push(node);
        expressions = true;
      }
    }
    const unique = optionalBoolean(where, options, "unique");
    let name = optionalName(where, options, "name");
    if (name === undefined) {
      if (expressions) throw new TypeError(`${where}: an index on an expression needs { name }.`);
      name = defaultName(ref.name, nodes as string[], unique ? "key" : "index", this.#maxBytes);
    }
    let predicate: FragmentNode | undefined;
    if (options.where !== undefined) {
      const { node, params } = fragmentOf(where, "the option where", options.where);
      if (params.length > 0) throw boundInDdl(where, "an index predicate");
      predicate = node;
    }
    const include = options.include;
    if (include !== undefined && !Array.isArray(include)) {
      throw new TypeError(`${where}: the option "include" must be an array of column names.`);
    }
    return {
      table: ref,
      name,
      columns: nodes,
      unique,
      where: predicate,
      using: optionalName(where, options, "using"),
      concurrently: optionalBoolean(where, options, "concurrently"),
      include: (include ?? []).map((column: unknown) => checkName(where, "included column", column)),
    };
  }
}

function constraintDef(where: string, options: Record<string, unknown>): ConstraintDef | undefined {
  const { check, exclude } = options;
  if (check !== undefined && exclude !== undefined) {
    throw new TypeError(`${where}: give exactly one of { check } and { exclude }.`);
  }
  if (check === undefined && exclude === undefined) {
    if (options.using !== undefined)
      throw new TypeError(`${where}: the option "using" belongs to { exclude }.`);
    return undefined;
  }
  const kind = check === undefined ? "exclude" : "check";
  if (kind === "check" && options.using !== undefined) {
    throw new TypeError(`${where}: the option "using" belongs to { exclude }.`);
  }
  const { node, params } = fragmentOf(where, `the option ${kind}`, check ?? exclude);
  if (params.length > 0) throw boundInDdl(where, `a ${kind === "check" ? "check" : "exclusion"} constraint`);
  return {
    kind,
    expression: node,
    using: kind === "exclude" ? (optionalName(where, options, "using") ?? "gist") : undefined,
  };
}

function statement(where: string, value: unknown): ExecuteStatement {
  const { node, params } = fragmentOf(where, "the statement", value);
  return { node, params };
}
