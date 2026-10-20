/**
 * Schemas: the class factories, the field builder, association declarations and the
 * reflection helpers.
 *
 * This barrel is internal. `src/index.ts` decides what is public; `fieldTypeOf` and
 * `fieldState` are for the other modules of the package (query parameters, cast
 * expressions and schemaless changesets take a field builder to name a type).
 *
 * @module
 */
export type {
  AssocOrderBy,
  AssocWhere,
  BelongsToOptions,
  HasManyOptions,
  HasOneOptions,
  JoinKeys,
  KeyFields,
  ManyToManySchemaOptions,
  ManyToManyTableOptions,
  ResolvedAssoc,
  ThroughOptions,
} from "./assoc.js";
export { belongsTo, hasMany, hasOne, manyToMany } from "./assoc.js";
export type {
  EmbedFieldBuilder,
  EmbedOnReplace,
  EmbedOptions,
  FieldState,
  FieldTypes,
  TimestampFields,
  TimestampsOptions,
} from "./field.js";
export { fieldState, fieldTypeOf, t, timestamps } from "./field.js";
export { isRow, isSchema, stateOf } from "./guards.js";
export type { EmbeddedSchemaOptions, Naming, SchemaOptions } from "./schema.js";
export { EmbeddedSchema, fieldNames, meta, primaryKeyOf, Schema } from "./schema.js";
export { uuidv7 } from "./uuid.js";
