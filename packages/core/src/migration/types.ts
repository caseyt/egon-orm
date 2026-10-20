/**
 * The vocabulary of migrations: column types, defaults, reference actions, and the
 * operations a migration records. The operations are plain data; `ddl.ts` writes their
 * SQL.
 *
 * @module
 */
import type { FragmentNode } from "../contracts/query.js";
import type { DbType } from "../contracts/type.js";
import type { Expr, NoParams } from "../query/expr.js";

/**
 * The column types that have a name of their own: the scalar kinds of `DbType`.
 *
 * @example
 * ```ts
 * const kind: ColumnKind = "timestamptz";
 * ```
 */
export type ColumnKind = Exclude<DbType["kind"], "array" | "custom">;

/**
 * The type of a column, as a migration names it: a kind (`"integer"`), any `DbType`
 * (`{ kind: "custom", sql: "citext" }`), or a kind with its parameters
 * (`{ kind: "decimal", precision: 10, scale: 2 }`, `{ kind: "timestamptz", precision: 3 }`,
 * `{ kind: "array", of: "text" }`).
 *
 * A `custom` type's `sql` is trusted program text, written as it is when it is a plain
 * type name (letters, digits, underscores, spaces, dots, an optional `(n)` or `(n, m)`
 * and `[]` pairs), and refused otherwise.
 *
 * @example
 * ```ts
 * const price: ColumnType = { kind: "decimal", precision: 10, scale: 2 };
 * const tags: ColumnType = { kind: "array", of: "text" };
 * ```
 */
export type ColumnType =
  | ColumnKind
  | DbType
  | { readonly kind: "decimal"; readonly precision: number; readonly scale?: number }
  | { readonly kind: "time" | "timestamp" | "timestamptz"; readonly precision: number }
  | { readonly kind: "array"; readonly of: ColumnType };

/**
 * SQL written by the program, as a `fragment` template: an index predicate, a check or
 * exclusion constraint, a column default that is an expression, or a statement for
 * `m.execute`. In DDL its interpolations must be identifiers (`fragment.ident`), because
 * DDL takes no bound parameters; `m.execute` binds values as any fragment does.
 *
 * @example
 * ```ts
 * import { fragment } from "egon-orm";
 *
 * const active: SqlFragment = fragment`deleted_at is null`;
 * ```
 */
export type SqlFragment = Expr<unknown, NoParams>;

/**
 * A JSON value, for the default of a `json` or `jsonb` column.
 *
 * @example
 * ```ts
 * const settings: JsonValue = { theme: "light", sizes: [1, 2] };
 * ```
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A column default: a constant (a string, number, bigint, boolean or `null`; for `json`
 * and `jsonb` columns also an object or array), or an expression as a {@link SqlFragment}
 * (`fragment\`now()\``).
 *
 * DDL cannot bind parameters, so a constant is written into the statement as a SQL
 * literal by the dialect's literal writer: strings are quoted with every quote doubled
 * (and, on Postgres, as an `E'…'` string with every backslash doubled when they hold
 * one), numbers must be finite, and anything else is refused.
 *
 * @example
 * ```ts
 * const role: DefaultValue = "member";
 * const zero: DefaultValue = 0;
 * ```
 */
export type DefaultValue = string | number | bigint | boolean | null | JsonValue | SqlFragment;

/**
 * What a foreign key does when the row it points at is deleted or its key is updated.
 *
 * @example
 * ```ts
 * const onDelete: ReferenceAction = "cascade";
 * ```
 */
export type ReferenceAction = "cascade" | "restrict" | "setNull" | "setDefault" | "noAction";

// ---------------------------------------------------------------------------
// Recorded operations (internal)
// ---------------------------------------------------------------------------

/**
 * A column type with its parameters spelled out.
 *
 * @example
 * ```ts
 * const price: TypeSpec = { kind: "decimal", precision: 10, scale: 2, of: undefined, sql: undefined };
 * ```
 */
export interface TypeSpec {
  readonly kind: ColumnKind | "array" | "custom";
  readonly precision: number | undefined;
  readonly scale: number | undefined;
  readonly of: TypeSpec | undefined;
  readonly sql: string | undefined;
}

/**
 * A default as recorded: a constant, an expression, or the current time.
 *
 * @example
 * ```ts
 * const member: DefaultSpec = { kind: "value", value: "member" };
 * ```
 */
export type DefaultSpec =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "sql"; readonly node: FragmentNode }
  | { readonly kind: "now" };

/**
 * A table, and the database schema it lives in.
 *
 * @example
 * ```ts
 * const users: TableRef = { name: "users", schema: "auth" };
 * ```
 */
export interface TableRef {
  readonly name: string;
  readonly schema: string | undefined;
}

/**
 * A foreign key on one column.
 *
 * @example
 * ```ts
 * const author: ReferenceSpec = {
 *   name: "posts_author_id_fkey",
 *   table: { name: "users", schema: undefined },
 *   column: "id",
 *   onDelete: "cascade",
 *   onUpdate: undefined,
 * };
 * ```
 */
export interface ReferenceSpec {
  readonly name: string;
  readonly table: TableRef;
  readonly column: string;
  readonly onDelete: ReferenceAction | undefined;
  readonly onUpdate: ReferenceAction | undefined;
}

/**
 * One column of a `createTable` or an `add`. The builder fills it in place.
 *
 * @example
 * ```ts
 * declare const column: ColumnDef;
 * const required = column.notNull;
 * ```
 */
export interface ColumnDef {
  readonly name: string;
  readonly type: TypeSpec;
  /** The database generates the value from a sequence (`serial`, `bigserial`). */
  readonly serial: boolean;
  notNull: boolean;
  default: DefaultSpec | undefined;
  primaryKey: boolean;
  /** The name of the column's unique constraint, when it has one. */
  unique: string | undefined;
  references: ReferenceSpec | undefined;
  /** The check constraint of an `enumText` column: its name and allowed values. */
  check: { readonly name: string; readonly values: readonly string[] } | undefined;
}

/**
 * `createTable`.
 *
 * @example
 * ```ts
 * declare const op: CreateTableOp;
 * const names = op.columns.map((column) => column.name);
 * ```
 */
export interface CreateTableOp {
  readonly op: "createTable";
  readonly table: TableRef;
  readonly columns: readonly ColumnDef[];
  readonly ifNotExists: boolean;
}

/**
 * One change of an `alterTable`.
 *
 * @example
 * ```ts
 * const rename: AlterChange = { change: "rename", column: "name", to: "full_name" };
 * ```
 */
export type AlterChange =
  | { readonly change: "add"; readonly column: ColumnDef }
  | {
      readonly change: "modify";
      readonly column: string;
      readonly type: TypeSpec;
      readonly notNull: boolean | undefined;
      /** `null` drops the default; `undefined` leaves it. */
      readonly default: DefaultSpec | null | undefined;
    }
  | { readonly change: "remove"; readonly column: string }
  | { readonly change: "rename"; readonly column: string; readonly to: string };

/**
 * An index, as `createIndex` describes it.
 *
 * @example
 * ```ts
 * declare const index: IndexDef;
 * const sql = `drop index "${index.name}"`;
 * ```
 */
export interface IndexDef {
  readonly table: TableRef;
  readonly name: string;
  /** Column names, or expressions. */
  readonly columns: readonly (string | FragmentNode)[];
  readonly unique: boolean;
  readonly where: FragmentNode | undefined;
  readonly using: string | undefined;
  readonly concurrently: boolean;
  readonly include: readonly string[];
}

/**
 * A check or exclusion constraint.
 *
 * @example
 * ```ts
 * declare const definition: ConstraintDef;
 * const isCheck = definition.kind === "check";
 * ```
 */
export interface ConstraintDef {
  readonly kind: "check" | "exclude";
  readonly expression: FragmentNode;
  /** The index method of an exclusion constraint. */
  readonly using: string | undefined;
}

/**
 * A statement for `m.execute`: a fragment and the values it binds.
 *
 * @example
 * ```ts
 * declare const statement: ExecuteStatement;
 * const values = statement.params;
 * ```
 */
export interface ExecuteStatement {
  readonly node: FragmentNode;
  readonly params: readonly unknown[];
}

/**
 * Every operation a migration can record.
 *
 * @example
 * ```ts
 * declare const op: Operation;
 * if (op.op === "createTable") op.columns.length;
 * ```
 */
export type Operation =
  | CreateTableOp
  | {
      readonly op: "dropTable";
      readonly table: TableRef;
      readonly ifExists: boolean;
      readonly cascade: boolean;
    }
  | { readonly op: "alterTable"; readonly table: TableRef; readonly changes: readonly AlterChange[] }
  | { readonly op: "renameTable"; readonly table: TableRef; readonly to: string }
  | { readonly op: "createIndex"; readonly index: IndexDef; readonly ifNotExists: boolean }
  | {
      readonly op: "dropIndex";
      readonly table: TableRef;
      readonly name: string;
      readonly concurrently: boolean;
      readonly ifExists: boolean;
    }
  | {
      readonly op: "createConstraint";
      readonly table: TableRef;
      readonly name: string;
      readonly definition: ConstraintDef;
    }
  | {
      readonly op: "dropConstraint";
      readonly table: TableRef;
      readonly name: string;
      readonly ifExists: boolean;
    }
  | { readonly op: "execute"; readonly statement: ExecuteStatement }
  | { readonly op: "createSchema"; readonly name: string; readonly ifNotExists: boolean }
  | {
      readonly op: "dropSchema";
      readonly name: string;
      readonly ifExists: boolean;
      readonly cascade: boolean;
    }
  | {
      readonly op: "createExtension";
      readonly name: string;
      readonly schema: string | undefined;
      readonly ifNotExists: boolean;
    }
  | { readonly op: "dropExtension"; readonly name: string; readonly ifExists: boolean };
