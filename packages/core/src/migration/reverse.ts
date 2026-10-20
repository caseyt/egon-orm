/**
 * The rollback of a `change` migration: the inverse of every recorded operation, in
 * reverse order. An operation that lacks what its inverse needs, or whose inverse could
 * destroy something the migration did not create, is refused with `MigrationError` here,
 * that is when the migration is rolled back, never when it is applied.
 *
 * @module
 */
import { MigrationError } from "../errors.js";
import type { AlterChange, CreateTableOp, Operation } from "./types.js";

/**
 * The migration being reversed, for error messages.
 *
 * @example
 * ```ts
 * const context: ReverseContext = { version: 20261012093000, migration: "create_users" };
 * ```
 */
export interface ReverseContext {
  readonly version: number;
  readonly migration: string;
}

function irreversible(context: ReverseContext, what: string, fix: string): MigrationError {
  return new MigrationError(
    `Migration ${context.version}_${context.migration} cannot be rolled back: ${what}. ${fix}`,
    { version: context.version, migration: context.migration },
  );
}

const UP_DOWN = "Or write the migration as up() and down() instead of change().";

/**
 * The operations that undo `operations`: each one's inverse, last first.
 *
 * @example
 * ```ts
 * const down = reverseOperations(recorded, { version: 20261012093000, migration: "create_users" });
 * ```
 *
 * @throws MigrationError when an operation cannot be reversed.
 */
export function reverseOperations(operations: readonly Operation[], context: ReverseContext): Operation[] {
  const inverse: Operation[] = [];
  for (let i = operations.length - 1; i >= 0; i--) {
    inverse.push(reverseOperation(operations[i] as Operation, context));
  }
  return inverse;
}

function reverseOperation(op: Operation, context: ReverseContext): Operation {
  switch (op.op) {
    case "createTable":
      if (op.ifNotExists) {
        throw irreversible(
          context,
          `createTable("${op.table.name}", …, { ifNotExists: true }) may have found the table already there, and dropping it could destroy a table this migration did not create`,
          `Write the migration as up() and down(), and decide there what down() drops.`,
        );
      }
      return { op: "dropTable", table: op.table, definition: op, ifExists: false, cascade: false };
    case "dropTable":
      if (op.definition === undefined) {
        throw irreversible(
          context,
          `dropTable("${op.table.name}") has no definition to create the table from`,
          `Pass the table's definition: m.dropTable("${op.table.name}", (t) => { … }). ${UP_DOWN}`,
        );
      }
      if (op.cascade || op.ifExists) {
        throw irreversible(
          context,
          `dropTable("${op.table.name}", …, { ${op.cascade ? "cascade" : "ifExists"}: true }) ${op.cascade ? "also drops what depends on the table, which cannot be recreated" : "may have found no table to drop"}`,
          UP_DOWN,
        );
      }
      return { ...op.definition, ifNotExists: false } satisfies CreateTableOp;
    case "alterTable": {
      const changes: AlterChange[] = [];
      for (let i = op.changes.length - 1; i >= 0; i--) {
        changes.push(reverseChange(op.table.name, op.changes[i] as AlterChange, context));
      }
      return { op: "alterTable", table: op.table, changes };
    }
    case "renameTable":
      return { op: "renameTable", table: { name: op.to, schema: op.table.schema }, to: op.table.name };
    case "createIndex":
      if (op.ifNotExists) {
        throw irreversible(
          context,
          `createIndex("${op.index.table.name}", …, { ifNotExists: true }) may have found the index "${op.index.name}" already there`,
          UP_DOWN,
        );
      }
      return { op: "dropIndex", index: op.index, ifExists: false };
    case "dropIndex":
      if (op.ifExists) {
        throw irreversible(
          context,
          `dropIndex("${op.index.table.name}", …, { ifExists: true }) may have found no index "${op.index.name}" to drop`,
          UP_DOWN,
        );
      }
      return { op: "createIndex", index: op.index, ifNotExists: false };
    case "createConstraint":
      return {
        op: "dropConstraint",
        table: op.table,
        name: op.name,
        definition: op.definition,
        ifExists: false,
      };
    case "dropConstraint":
      if (op.definition === undefined) {
        throw irreversible(
          context,
          `dropConstraint("${op.table.name}", "${op.name}") has no definition to add the constraint from`,
          `Pass it: m.dropConstraint("${op.table.name}", "${op.name}", { check: fragment\`…\` }) (or { exclude }). ${UP_DOWN}`,
        );
      }
      if (op.ifExists) {
        throw irreversible(
          context,
          `dropConstraint("${op.table.name}", "${op.name}", { ifExists: true }) may have found no constraint to drop`,
          UP_DOWN,
        );
      }
      return { op: "createConstraint", table: op.table, name: op.name, definition: op.definition };
    case "execute":
      if (op.down === undefined) {
        throw irreversible(
          context,
          "execute() was given only the statement that applies it",
          "Give the statement that undoes it as the second argument: m.execute(up, down).",
        );
      }
      return { op: "execute", up: op.down, down: op.up };
    case "createSchema":
      if (op.ifNotExists) {
        throw irreversible(
          context,
          `createSchema("${op.name}", { ifNotExists: true }) may have found the schema already there`,
          UP_DOWN,
        );
      }
      return { op: "dropSchema", name: op.name, ifExists: false, cascade: false };
    case "dropSchema":
      if (op.cascade || op.ifExists) {
        throw irreversible(
          context,
          `dropSchema("${op.name}", { ${op.cascade ? "cascade" : "ifExists"}: true }) ${op.cascade ? "also drops everything in the schema" : "may have found no schema to drop"}`,
          UP_DOWN,
        );
      }
      return { op: "createSchema", name: op.name, ifNotExists: false };
    case "createExtension":
      if (op.ifNotExists) {
        throw irreversible(
          context,
          `createExtension("${op.name}", { ifNotExists: true }) may have found the extension already installed`,
          UP_DOWN,
        );
      }
      return { op: "dropExtension", name: op.name, ifExists: false };
    case "dropExtension":
      throw irreversible(
        context,
        `dropExtension("${op.name}") does not record how the extension was installed`,
        UP_DOWN,
      );
  }
}

function reverseChange(table: string, change: AlterChange, context: ReverseContext): AlterChange {
  switch (change.change) {
    case "add":
      return { change: "remove", column: change.column.name, definition: change.column };
    case "remove":
      if (change.definition === undefined) {
        throw irreversible(
          context,
          `alterTable("${table}"): remove("${change.column}") has no type to add the column back with`,
          `Give its type: t.remove("${change.column}", "integer") (with { notNull, default } when it had them). ${UP_DOWN}`,
        );
      }
      return { change: "add", column: change.definition };
    case "rename":
      return { change: "rename", column: change.to, to: change.column };
    case "modify": {
      const from = change.from;
      if (from === undefined) {
        throw irreversible(
          context,
          `alterTable("${table}"): modify("${change.column}") does not say what the column was before`,
          `Give it: t.modify("${change.column}", type, { from: previousType }). ${UP_DOWN}`,
        );
      }
      if (change.notNull !== undefined && from.notNull === undefined) {
        throw irreversible(
          context,
          `alterTable("${table}"): modify("${change.column}") changes notNull, but from does not say whether the column was nullable`,
          `Give it: { from: { type, notNull: … } }. ${UP_DOWN}`,
        );
      }
      if (change.default !== undefined && from.default === undefined) {
        throw irreversible(
          context,
          `alterTable("${table}"): modify("${change.column}") changes the default, but from does not give the previous one`,
          `Give it: { from: { type, default: … } } (null when there was none). ${UP_DOWN}`,
        );
      }
      return {
        change: "modify",
        column: change.column,
        type: from.type,
        notNull: change.notNull === undefined ? undefined : from.notNull,
        default: change.default === undefined ? undefined : from.default,
        from: { type: change.type, notNull: change.notNull, default: change.default },
      };
    }
  }
}
