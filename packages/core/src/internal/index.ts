/**
 * Small utilities shared by the rest of the package. Internal: nothing here is part of
 * the public API, and `src/index.ts` does not re-export it.
 *
 * @module
 */

// Not a utility: the query expressions (step 07), re-exported only so that
// benchmarks/micro/expr.bench.ts can make columns (which the query builder makes, and no
// public function does) from built code. A benchmark that uses them takes every expression
// function from here too: the classes in dist/internal.js are not those of dist/index.js.
export * as expr from "../query/expr.js";
export * as expressions from "../query/functions.js";
// Not a utility either: the built-in types (step 03), re-exported here only so that
// `dist/internal.js` carries them and benchmarks/micro/types.bench.ts can measure built
// code. Nothing inside the package imports the types through this barrel.
export * as types from "../types/index.js";
export { deepEqual } from "./deep-equal.js";
export { HASH_SEED, hashInt, hashString } from "./hash.js";
export { formatStruct, formatValue, REDACTED, redactFields } from "./inspect.js";
export { LruCache } from "./lru.js";
export { camelToSnake, snakeToCamel } from "./naming.js";
export { isPlainObject } from "./plain-object.js";
