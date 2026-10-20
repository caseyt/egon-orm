/**
 * `egon-orm/testing`: helpers for tests that run against a database. The sandbox runs
 * each test in a transaction that is rolled back; `expectQueries` counts the statements a
 * piece of code runs.
 *
 * @example
 * ```ts
 * import { createSandbox, expectQueries } from "egon-orm/testing";
 * ```
 *
 * @module
 */
export type { Sandbox } from "./repo/sandbox.js";
export { createSandbox, expectQueries } from "./repo/sandbox.js";
