// Micro-benchmarks for packages/core/src/internal (step 02): the shape hash, the LRU that
// backs the plan cache, name conversion and inspect formatting.
//
// These utilities are not public API, so they cannot be imported from "egon-orm". They are
// loaded from the package's built `dist/internal.js` (an extra build entry that is not in
// the package's `exports`), so that this file measures built code like every other
// benchmark; only the types come from the sources.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { bench, doNotOptimize, group, resolveBuiltEgon, runBenchmarks } from "../src/harness.js";

type Internal = typeof import("../../packages/core/src/internal/index.js");

const builtInternal = join(dirname(resolveBuiltEgon()), "internal", "index.js");
if (!existsSync(builtInternal)) {
  throw new Error(`${builtInternal} does not exist. Run \`pnpm build\` first.`);
}
const {
  HASH_SEED,
  hashInt,
  hashString,
  LruCache,
  camelToSnake,
  snakeToCamel,
  formatValue,
  formatStruct,
  redactFields,
} = (await import(pathToFileURL(builtInternal).href)) as Internal;

// --- hash: what the shape of the reference 3-clause query costs to compute ---
const KINDS = ["query", "table", "bool", "binary", "column", "param", "order", "column", "param"];
const IDENTIFIERS = ["users", "u", "age", "created_at"];

// A changing input, so that the JIT cannot fold a call into a constant.
let counter = 0;

group("internal/hash", () => {
  bench("hashInt", () => doNotOptimize(hashInt(HASH_SEED, counter++)));
  bench('hashString, 11 characters ("created_at")', () => doNotOptimize(hashString(counter++, "created_at")));
  bench("shape of a 3-clause query: 9 kinds, 4 identifiers, 3 ints", () => {
    let hash = HASH_SEED;
    for (let i = 0; i < KINDS.length; i++) hash = hashString(hash, KINDS[i] as string);
    for (let i = 0; i < IDENTIFIERS.length; i++) hash = hashString(hash, IDENTIFIERS[i] as string);
    hash = hashInt(hash, 1);
    hash = hashInt(hash, 2);
    hash = hashInt(hash, 3);
    return doNotOptimize(hash);
  });
});

// --- lru: the plan cache's second level holds 1,000 plans keyed by shape hash ---
const full = new LruCache<number, object>(1000);
for (let i = 0; i < 1000; i++) full.set(hashInt(HASH_SEED, i), { i });
// Hits rotate over 64 keys, as a server cycling through its hot queries would.
const hitKeys = Array.from({ length: 64 }, (_, i) => hashInt(HASH_SEED, i * 15));
const missKey = hashInt(HASH_SEED, 5000);
const plan = { sql: "select 1" };
let turn = 0;
let next = 1000;

/**
 * The design that LruCache does NOT use, kept here as the baseline that justifies the
 * linked list: a Map in insertion order, where a hit deletes and re-inserts the entry.
 */
class InsertionOrderLru<K, V> {
  readonly #entries = new Map<K, V>();
  constructor(readonly capacity: number) {}
  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }
  set(key: K, value: V): void {
    if (!this.#entries.delete(key) && this.#entries.size >= this.capacity) {
      for (const oldest of this.#entries.keys()) {
        this.#entries.delete(oldest);
        break;
      }
    }
    this.#entries.set(key, value);
  }
}
const baseline = new InsertionOrderLru<number, object>(1000);
for (let i = 0; i < 1000; i++) baseline.set(hashInt(HASH_SEED, i), { i });
let baselineTurn = 0;
let baselineNext = 1000;

group("internal/lru (1,000 entries, full)", () => {
  bench("get, hit", () => doNotOptimize(full.get(hitKeys[turn++ & 63] as number)));
  bench("get, hit on the most recently used key", () => doNotOptimize(full.get(hitKeys[0] as number)));
  bench("get, miss", () => doNotOptimize(full.get(missKey)));
  bench("has", () => doNotOptimize(full.has(hitKeys[0] as number)));
  bench("set, existing key", () => full.set(hitKeys[turn++ & 63] as number, plan));
  bench("set, new key (evicts the oldest)", () => full.set(hashInt(HASH_SEED, next++), plan));
});

group("baseline, not used: insertion-order Map LRU (1,000 entries, full)", () => {
  bench("baseline get, hit", () => doNotOptimize(baseline.get(hitKeys[baselineTurn++ & 63] as number)));
  bench("baseline get, hit on the most recently used key", () =>
    doNotOptimize(baseline.get(hitKeys[0] as number)),
  );
  bench("baseline set, new key (evicts the oldest)", () =>
    baseline.set(hashInt(HASH_SEED, baselineNext++), plan),
  );
});

// --- naming: memoised, so the steady state is one Map lookup ---
let fresh = 0;

group("internal/naming", () => {
  bench('camelToSnake("createdAt"), memo hit', () => doNotOptimize(camelToSnake("createdAt")));
  bench('snakeToCamel("created_at"), memo hit', () => doNotOptimize(snakeToCamel("created_at")));
  bench("camelToSnake, memo miss (a new 16-character name each call)", () =>
    doNotOptimize(camelToSnake(`fieldName${fresh++}Value`)),
  );
});

// --- inspect: error messages and logs, never per row ---
const row = {
  id: 1,
  email: "ada@example.com",
  name: "Ada",
  age: 36,
  role: "member",
  passwordHash: "$2b$12$abcdefghijklmnopqrstuv",
  settings: { theme: "dark", tags: ["a", "b"] },
  lockVersion: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const redacted = new Set(["passwordHash"]);

group("internal/inspect (a 10-field row)", () => {
  bench("redactFields", () => doNotOptimize(redactFields(row, redacted)));
  bench("formatValue", () => doNotOptimize(formatValue(row)));
  bench("formatStruct", () => doNotOptimize(formatStruct("User", row, redacted)));
});

await runBenchmarks();
