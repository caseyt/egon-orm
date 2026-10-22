// Micro-benchmarks for packages/core/src/types (step 03): what a cast costs per value, what
// looking up a type's driver conversions costs per query, and what reading an array column
// costs per row.
//
// The built-in types are not public API by themselves (developers reach them through the
// field builder `t`), so they are loaded from the package's built `dist/internal.js`, as
// benchmarks/micro/internal.bench.ts loads the utilities; only the types come from the sources.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { bench, doNotOptimize, group, resolveBuiltEgon, runBenchmarks } from "../src/harness.js";

type Internal = typeof import("../../packages/core/src/internal/index.js");
type AnyFieldType = import("../../packages/core/src/contracts/type.js").AnyFieldType;
type Codec = import("../../packages/core/src/contracts/type.js").Codec;

const builtInternal = join(dirname(resolveBuiltEgon()), "internal", "index.js");
if (!existsSync(builtInternal)) {
  throw new Error(`${builtInternal} does not exist. Run \`pnpm build\` first.`);
}
const { types, deepEqual } = (await import(pathToFileURL(builtInternal).href)) as Internal;
const {
  arrayType,
  bigintType,
  binaryType,
  booleanType,
  dateType,
  decimalType,
  enumType,
  floatType,
  integerType,
  jsonType,
  localTimestampType,
  resolveCodec,
  stringType,
  timestampType,
  timeType,
  uuidType,
} = types;

// Inputs rotate over 64 values, so that the JIT cannot fold a cast into a constant and a
// call site sees the mix of inputs that form data and JSON produce.
const MASK = 63;
let turn = 0;
function rotating<T>(make: (i: number) => T): () => T {
  const values = Array.from({ length: MASK + 1 }, (_, i) => make(i));
  return () => values[turn++ & MASK] as T;
}

function benchCast(name: string, type: AnyFieldType, next: () => unknown): void {
  // Fail loudly if an input stops being accepted: a rejected cast is a different, cheaper path.
  for (let i = 0; i <= MASK; i++) {
    if (!type.cast(next()).success) throw new Error(`benchmark input for "${name}" is rejected`);
  }
  bench(name, () => doNotOptimize(type.cast(next())));
}

const two = (n: number): string => String(n).padStart(2, "0");
const uuid = (i: number): string => `6F9619FF-8B86-D011-B42D-00C04FC964${two(i)}`;

group("types/cast, one value (accepted)", () => {
  benchCast(
    "string",
    stringType(),
    rotating((i) => `user-${i}@example.com`),
  );
  benchCast(
    "integer, from a number",
    integerType(),
    rotating((i) => i * 1009),
  );
  benchCast(
    "integer, from a digit string",
    integerType(),
    rotating((i) => String(i * 1009)),
  );
  benchCast(
    "bigint, from a digit string",
    bigintType(),
    rotating((i) => `90071992547409${two(i)}`),
  );
  benchCast(
    'bigint { mode: "number" }, from a number',
    bigintType({ mode: "number" }),
    rotating((i) => i * 1009),
  );
  benchCast(
    "float, from a number",
    floatType(),
    rotating((i) => i * 1.25),
  );
  benchCast(
    "float, from a numeric string",
    floatType(),
    rotating((i) => `${i}.25`),
  );
  benchCast(
    "decimal, from a string",
    decimalType(),
    rotating((i) => `${i}19.99`),
  );
  benchCast(
    "decimal(10,2), from a string (rounds)",
    decimalType({ precision: 10, scale: 2 }),
    rotating((i) => `${i}19.995`),
  );
  benchCast(
    "decimal, from a number",
    decimalType(),
    rotating((i) => i + 0.25),
  );
  benchCast(
    "boolean, from a boolean",
    booleanType(),
    rotating((i) => i % 2 === 0),
  );
  benchCast(
    'boolean, from "true" / "0"',
    booleanType(),
    rotating((i) => (i % 2 === 0 ? "true" : "0")),
  );
  benchCast("uuid (lower-cases)", uuidType(), rotating(uuid));
  benchCast(
    "binary",
    binaryType(),
    rotating((i) => new Uint8Array([i, 2, 3])),
  );
  benchCast(
    "date, from a string",
    dateType(),
    rotating((i) => `2026-10-${two((i % 28) + 1)}`),
  );
  benchCast(
    "date, from a Date",
    dateType(),
    rotating((i) => new Date(Date.UTC(2026, 9, (i % 28) + 1))),
  );
  benchCast(
    "time",
    timeType(),
    rotating((i) => `09:30:${two(i % 60)}`),
  );
  benchCast(
    "timestamp, from a Date",
    timestampType(),
    rotating((i) => new Date(1_760_000_000_000 + i)),
  );
  benchCast(
    "timestamp, from an ISO string",
    timestampType(),
    rotating((i) => `2026-10-13T09:30:${two(i % 60)}.250+02:00`),
  );
  benchCast(
    "localTimestamp, from an ISO string",
    localTimestampType(),
    rotating((i) => `2026-10-13T09:30:${two(i % 60)}`),
  );
  benchCast(
    "enum, from a list of 4",
    enumType(["admin", "member", "guest", "owner"]),
    rotating((i) => ["admin", "member", "guest", "owner"][i % 4]),
  );
  benchCast(
    "enum, from a mapping of 3",
    enumType({ low: 1, mid: 2, high: 3 }),
    rotating((i) => (i % 2 === 0 ? "mid" : 3)),
  );
});

group("types/cast, one value (rejected)", () => {
  const integer = integerType();
  const rejectedText = rotating((i) => `${i}.5`);
  bench("integer, a string that is not an integer", () => doNotOptimize(integer.cast(rejectedText())));
  const timestamp = timestampType();
  const noOffset = rotating((i) => `2026-10-13T09:30:${two(i % 60)}`);
  bench("timestamp, an ISO string without an offset", () => doNotOptimize(timestamp.cast(noOffset())));
});

const settingsAt = (i: number) => ({
  theme: "dark",
  tags: ["a", "b", "c"],
  limits: { daily: i, monthly: i * 30 },
  on: true,
});
const settingsCopyAt = (i: number) => ({
  on: true,
  limits: { monthly: i * 30, daily: i },
  tags: ["a", "b", "c"],
  theme: "dark",
});
const settings = rotating(settingsAt);
const tenIntegers = rotating((i) => Array.from({ length: 10 }, (_, n) => String(i + n)));

group("types/cast, composite values", () => {
  benchCast("json, a 4-key document with an array and a nested object", jsonType(), settings);
  benchCast("array(integer), 10 digit strings", arrayType(integerType()), tenIntegers);
});

group("types/equal", () => {
  const json = jsonType();
  // Pairs of equal documents; a pair that differed would stop at the first difference.
  const pairs = Array.from({ length: MASK + 1 }, (_, i) => [settingsAt(i), settingsCopyAt(i)] as const);
  for (const [a, b] of pairs) {
    if (!json.equal(a, b)) throw new Error("benchmark documents are expected to be equal");
  }
  bench("json, two equal 4-key documents with keys in another order", () => {
    const pair = pairs[turn++ & MASK] as (typeof pairs)[number];
    return doNotOptimize(json.equal(pair[0], pair[1]));
  });
  bench("deepEqual of the same two documents (the helper alone)", () => {
    const pair = pairs[turn++ & MASK] as (typeof pairs)[number];
    return doNotOptimize(deepEqual(pair[0], pair[1]));
  });
  const decimal = decimalType();
  bench('decimal, "19.990" against "19.99" (normalises both)', () =>
    doNotOptimize(decimal.equal("19.990", "19.99")),
  );
  bench('decimal, "19.99" against "19.99" (same text)', () => doNotOptimize(decimal.equal("19.99", "19.99")));
  const integers = arrayType(integerType());
  const left = Array.from({ length: 100 }, (_, i) => i);
  const right = Array.from({ length: 100 }, (_, i) => i);
  bench("array(integer), two equal arrays of 100", () => doNotOptimize(integers.equal(left, right)));
});

// --- resolveCodec: once per column per compiled plan, so it is a cache hit almost always ---
const int8: Codec = { fromDb: (text) => BigInt(text as string), toDb: (value) => String(value) };
const adapter = {
  typeOverrides: (type: AnyFieldType): Codec | undefined => (type === bigintType() ? int8 : undefined),
};
const columnTypes: readonly AnyFieldType[] = [
  integerType(),
  stringType(),
  bigintType(),
  timestampType(),
  booleanType(),
  jsonType(),
  arrayType(integerType()),
  arrayType(bigintType()),
];
for (const type of columnTypes) resolveCodec(type, adapter);
group("types/resolveCodec", () => {
  bench("hit (one of 8 types, one adapter)", () =>
    doNotOptimize(resolveCodec(columnTypes[turn++ & 7] as AnyFieldType, adapter)),
  );
});

// --- reading an array column: the per-row cost of fromDb ---
const thousand = Array.from({ length: 1000 }, (_, i) => i);
const thousandTexts = thousand.map(String);
const thousandDays = thousand.map((i) => `2026-${two((i % 12) + 1)}-${two((i % 28) + 1)}`);

/** What hydration does with one column value: skip the call when the conversion is IDENTITY. */
function load(codec: Codec, value: unknown): unknown {
  return codec.fromDb === identity ? value : codec.fromDb(value);
}
const identity = resolveCodec(integerType(), adapter).fromDb;

group("types/load an array of 1,000 elements", () => {
  const integers = resolveCodec(arrayType(integerType()), adapter);
  bench("array(integer): IDENTITY, the call is skipped", () => doNotOptimize(load(integers, thousand)));
  const bigints = resolveCodec(arrayType(bigintType()), adapter);
  bench("array(bigint) with an adapter override (text to bigint per element)", () =>
    doNotOptimize(load(bigints, thousandTexts)),
  );
  const numbers = resolveCodec(arrayType(bigintType({ mode: "number" })), adapter);
  bench('array(bigint { mode: "number" }) (range check per element)', () =>
    doNotOptimize(load(numbers, thousandTexts)),
  );
  const days = resolveCodec(arrayType(dateType({ as: "date" })), adapter);
  bench('array(date { as: "date" }) (string to Date per element)', () =>
    doNotOptimize(load(days, thousandDays)),
  );
  // Baselines: the same work written by hand, and the cost of the allocations alone.
  bench("baseline: thousandTexts.map((text) => BigInt(text))", () =>
    doNotOptimize(thousandTexts.map((text) => BigInt(text))),
  );
  bench("baseline: thousand.map((ms) => new Date(ms))", () =>
    doNotOptimize(thousand.map((ms) => new Date(ms))),
  );
});

await runBenchmarks();
