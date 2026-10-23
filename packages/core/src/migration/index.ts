/**
 * `egon-orm/migration`: hand-written, versioned migrations (`up` and `down`) and their runner.
 *
 * @example
 * ```ts
 * import { createMigrator, defineMigration } from "egon-orm/migration";
 * ```
 *
 * @module
 */

export { MigrationError } from "../errors.js";
// The builders are public as types only: a migration receives them.
export type {
  AddConstraintOptions,
  AlterTableBuilder,
  ColumnAdder,
  ColumnBuilder,
  CreateTableOptions,
  DropConstraintOptions,
  DropIndexOptions,
  DropTableOptions,
  IdOptions,
  IndexOptions,
  MigrationBuilder,
  ModifyOptions,
  ReferencesOptions,
  TableBuilder,
  TimestampsColumnsOptions,
} from "./builder.js";
export { createDatabase, dropDatabase } from "./database.js";
export type { Migration, MigrationDefinition } from "./define.js";
export { defineMigration } from "./define.js";
export type { MigrationSource } from "./loader.js";
export { parseMigrationFileName } from "./loader.js";
export type {
  DownOptions,
  MigrationEvent,
  MigrationRun,
  MigrationStatus,
  Migrator,
  MigratorOptions,
  UpOptions,
} from "./migrator.js";
export { createMigrator } from "./migrator.js";
export type {
  ColumnKind,
  ColumnType,
  DefaultValue,
  JsonValue,
  ReferenceAction,
  SqlFragment,
} from "./types.js";
