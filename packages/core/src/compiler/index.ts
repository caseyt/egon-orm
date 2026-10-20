/**
 * The SQL compiler (step 10): query ASTs and row-level writes to SQL text and parameter
 * slots, dialect tables, the plan cache and parameter binding. Internal: the adapter
 * (step 11) builds on it, and nothing here is exported from the package's entry point.
 *
 * @module
 */
export { bindParams, type NamedValues, toSql } from "./bind.js";
export type { CacheOperation, PlanCacheStats } from "./cache.js";
export { Compiler, type CompilerOptions, createCompiler } from "./compiler.js";
export {
  type IntegerDivision,
  LOCK_CLAUSES,
  lookup,
  MYSQL_CAPABILITIES,
  mysqlDialect,
  type PlaceholderStyle,
  POSTGRES_CAPABILITIES,
  postgresDialect,
  quoteIdentifier,
  type ScalarDbKind,
  SQLITE_CAPABILITIES,
  type SqlDialect,
  sqliteDialect,
  sqlTypeName,
  type TableOperator,
  unsupported,
} from "./dialect.js";
export type { CodecSource } from "./emit.js";
export { type EmitApi, type NodeEmitter, PRECEDENCE, registerNodeEmitter } from "./registry.js";
export { sameShape } from "./same-shape.js";
export { insertChunks } from "./write.js";
