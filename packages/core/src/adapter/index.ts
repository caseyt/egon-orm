/**
 * The shared adapter (step 11): the `Adapter` contract over a driver wrapper.
 *
 * @module
 */
export type { AdapterDefinition, DatabaseAdapter, PoolStats } from "./adapter.js";
export {
  beginSql,
  beginStatements,
  createAdapter,
  DEFAULT_BATCH_SIZE,
  DEFAULT_PLAN_CACHE_SIZE,
} from "./adapter.js";
export type { DriverCodec, DriverCodecs } from "./codecs.js";
export { typeOverridesFrom } from "./codecs.js";
export type { StatementCompiler, StatementCompilerOptions } from "./compiler.js";
export { createStatementCompiler } from "./compiler.js";
export type { DriverConnection, DriverCursor, DriverHooks, DriverWrapper } from "./driver.js";
export type { QueryListenerOptions } from "./telemetry.js";
export { redactParams, Telemetry } from "./telemetry.js";
