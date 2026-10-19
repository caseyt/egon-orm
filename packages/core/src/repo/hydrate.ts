/**
 * Row hydration: the {@link RowDecoder} that turns one result row into what the query
 * selected, built once per compiled plan from its {@link OutputPlan}.
 *
 * Two builders produce the same decoder behaviour:
 *
 * - **generated** ({@link generateDecoder}): straight-line JavaScript made with
 *   `new Function`, one statement per column, no loop and no closure per row. Every name
 *   from the plan (an output alias, an object key) enters the code as a JSON string
 *   literal, so nothing from a schema or a query can become code.
 * - **interpreted** ({@link interpretDecoder}): a walk over a tree prepared once from the
 *   plan, for environments that forbid generating code (`createRepo({ codegen: false })`).
 *
 * Both read each column once, skip a conversion whose `fromDb` is the identity (by
 * reference, when the decoder is built), pass `null` through without converting it, and
 * build rows with the schema's row factory and one shared, frozen {@link RowMeta} per
 * leaf. A whole row from the optional side of an outer join is `null` when its key
 * columns are all `null` (every column, for a schema without a primary key).
 *
 * A row with preloaded associations is built with `meta.createWith(...)`: a join preload
 * gets the child of this result row (`[child]`, `[]` when absent, or the child / `null`
 * for a to-one association); a separate-query preload starts as `[]` or `null`. Merging
 * the parents of a join preload across rows is not the decoder's job (see `read.ts`).
 *
 * @module
 */
import type { Adapter, CompiledQuery, OutputPlan, RowDecoder } from "../contracts/adapter.js";
import type { RowMeta, SchemaMeta } from "../contracts/schema.js";
import { type AnyFieldType, IDENTITY } from "../contracts/type.js";
import { resolveCodec } from "../types/index.js";

/** Converts one non-null driver value to the application value. */
type FromDb = (value: unknown) => unknown;

/** Where the decoder gets each type's driver conversion from: the adapter that ran the plan. */
export type CodecSource = Pick<Adapter, "typeOverrides">;

/**
 * Whether `compile` can turn source text into a working function: false where a Content
 * Security Policy without `unsafe-eval` makes `new Function` throw.
 *
 * @example
 * ```ts
 * canGenerate((body) => new Function(body) as () => unknown); // true in Node
 * ```
 */
export function canGenerate(compile: (body: string) => () => unknown): boolean {
  try {
    return compile("return true")() === true;
  } catch {
    return false;
  }
}

/** The answer of {@link generationAllowed}, once asked. */
let generation: boolean | undefined;

/**
 * Whether this runtime lets code be generated. Asked the first time a repo with
 * `codegen` on builds a decoder, never before: a repo with `codegen: false` never calls
 * `new Function`, so a Content Security Policy never sees (or reports) an attempt.
 *
 * @example
 * ```ts
 * const decode = generationAllowed() ? generateDecoder(plan, adapter) : interpretDecoder(plan, adapter);
 * ```
 */
export function generationAllowed(): boolean {
  if (generation === undefined) generation = canGenerate((body) => new Function(body) as () => unknown);
  return generation;
}

/** The conversion of a type for this adapter; `undefined` when there is none to apply. */
function converter(type: AnyFieldType | undefined, codecs: CodecSource): FromDb | undefined {
  if (type === undefined) return undefined;
  const fromDb = resolveCodec(type, codecs).fromDb;
  return fromDb === IDENTITY ? undefined : (fromDb as FromDb);
}

/** Builds a row: `meta.create`, or the `createWith` factory of a row with preloads. */
type Factory = (values: readonly unknown[], loaded: readonly unknown[], row: RowMeta) => object;

/** The `createWith` factory of a leaf with preloads; `undefined` for one without (it uses `meta.create`). */
function loadedFactoryOf(leaf: Extract<OutputPlan, { readonly kind: "row" }>): Factory | undefined {
  const meta: SchemaMeta = leaf.meta;
  return leaf.preloads.length === 0
    ? undefined
    : meta.createWith(leaf.preloads.map((preload) => preload.assoc));
}

/**
 * The decoder of a plan for this adapter, built on the first call and stored on the plan
 * (`plan.decoder`), so that every later execution finds it without a lookup.
 *
 * The first repo to run a plan builds its decoder; another repo over the same adapter
 * reuses it. Generated and interpreted decoders return the same rows, so which one it is
 * changes only the speed.
 *
 * @example
 * ```ts
 * const plan = adapter.compile(query.ast, "all", undefined);
 * const decode = decoderFor(plan, adapter, true);
 * const rows = result.rows.map((row) => decode(row, query.ast.select?.constants ?? []));
 * ```
 *
 * @throws TypeError when the plan describes no rows (`output` is `undefined`).
 */
export function decoderFor(plan: CompiledQuery, codecs: CodecSource, codegen: boolean): RowDecoder {
  let decoder = plan.decoder;
  if (decoder === undefined) {
    const output = plan.output;
    if (output === undefined) {
      // A plan of a read always has an output plan; this guards a hand-built one.
      throw new TypeError(
        "This compiled statement returns no rows to decode (its output plan is undefined).",
      );
    }
    decoder = buildDecoder(output, codecs, codegen);
    plan.decoder = decoder;
  }
  return decoder;
}

/**
 * Builds a decoder for an output plan: generated when `codegen` is true and the runtime
 * allows it, interpreted otherwise.
 *
 * @example
 * ```ts
 * const decode = buildDecoder(plan.output, adapter, true);
 * ```
 */
export function buildDecoder(output: OutputPlan, codecs: CodecSource, codegen: boolean): RowDecoder {
  return codegen && generationAllowed() ? generateDecoder(output, codecs) : interpretDecoder(output, codecs);
}

// ---------------------------------------------------------------------------
// Generated decoders
// ---------------------------------------------------------------------------

/** What the generated code refers to, by index: conversions, row factories, row metadata. */
interface Bindings {
  readonly fromDb: FromDb[];
  /** `meta.create` (two arguments) or a `createWith` factory (three), as each row needs. */
  readonly factories: (Factory | SchemaMeta["create"])[];
  readonly rowMetas: RowMeta[];
  /** The statements before the `return`, in order: column reads, then built children. */
  readonly lines: string[];
  /** The local holding each output alias already read. */
  readonly locals: Map<string, string>;
  next: number;
}

const literal = (text: string): string => JSON.stringify(text);

/** The local that holds column `alias` of the result row, reading it on first use. */
function column(b: Bindings, alias: string): string {
  let local = b.locals.get(alias);
  if (local === undefined) {
    local = `v${b.locals.size}`;
    b.locals.set(alias, local);
    b.lines.push(`const ${local} = r[${literal(alias)}];`);
  }
  return local;
}

/** The expression of a column converted to its application value. */
function converted(b: Bindings, alias: string, fromDb: FromDb | undefined): string {
  const local = column(b, alias);
  if (fromDb === undefined) return local;
  const index = b.fromDb.length;
  b.fromDb.push(fromDb);
  return `(${local} === null ? null : f${index}(${local}))`;
}

function generate(b: Bindings, plan: OutputPlan, codecs: CodecSource): string {
  switch (plan.kind) {
    case "value":
      return converted(b, plan.alias, converter(plan.type, codecs));
    case "constant":
      return `k[${plan.index}]`;
    case "object": {
      const parts: string[] = [];
      for (let i = 0; i < plan.keys.length; i++) {
        // A computed key: `["__proto__"]` defines an own property, a plain one would not.
        parts.push(
          `[${literal(plan.keys[i] as string)}]: ${generate(b, plan.values[i] as OutputPlan, codecs)}`,
        );
      }
      return `{ ${parts.join(", ")} }`;
    }
    case "tuple":
      return `[${plan.items.map((item) => generate(b, item, codecs)).join(", ")}]`;
    case "row":
      return generateRow(b, plan, codecs);
  }
}

function generateRow(
  b: Bindings,
  leaf: Extract<OutputPlan, { readonly kind: "row" }>,
  codecs: CodecSource,
): string {
  const persisted = leaf.meta.persisted;
  const values: string[] = [];
  for (let i = 0; i < persisted.length; i++) {
    const field = persisted[i] as (typeof persisted)[number];
    values.push(converted(b, leaf.aliases[i] as string, converter(field.type, codecs)));
  }
  const loaded: string[] = [];
  for (const preload of leaf.preloads) {
    if (preload.row === undefined) {
      loaded.push(preload.cardinality === "many" ? "[]" : "null");
      continue;
    }
    // Built inside the parent's expression: a child is converted only when its parent exists.
    const expression = generate(b, preload.row, codecs);
    if (preload.cardinality === "many") {
      const child = `p${b.next++}`;
      b.lines.push(`let ${child};`);
      loaded.push(`((${child} = ${expression}) === null ? [] : [${child}])`);
    } else {
      loaded.push(expression);
    }
  }
  const factory = b.factories.length;
  const withPreloads = loadedFactoryOf(leaf);
  b.factories.push(withPreloads ?? leaf.meta.create);
  const rowMeta = b.rowMetas.length;
  b.rowMetas.push(leaf.meta.rowMeta("loaded", leaf.schema));
  const build =
    withPreloads === undefined
      ? `c${factory}([${values.join(", ")}], m${rowMeta})`
      : `c${factory}([${values.join(", ")}], [${loaded.join(", ")}], m${rowMeta})`;
  if (!leaf.nullable) return build;
  const test = leaf.key.length > 0 ? leaf.key : leaf.aliases;
  const absent = test.map((alias) => `${column(b, alias)} === null`).join(" && ");
  return `(${absent} ? null : ${build})`;
}

/**
 * Generates a decoder for `output` with `new Function`: straight-line code that reads each
 * column once into a local, converts it where its type needs it, and builds the selected
 * value with object and array literals and the row factories.
 *
 * @example
 * ```ts
 * const decode = generateDecoder({ kind: "value", alias: "c0", type: undefined }, adapter);
 * decode({ c0: 1 }, []); // 1
 * ```
 */
export function generateDecoder(output: OutputPlan, codecs: CodecSource): RowDecoder {
  const b: Bindings = { fromDb: [], factories: [], rowMetas: [], lines: [], locals: new Map(), next: 0 };
  const result = generate(b, output, codecs);
  const prelude: string[] = [];
  for (let i = 0; i < b.fromDb.length; i++) prelude.push(`const f${i} = f[${i}];`);
  for (let i = 0; i < b.factories.length; i++) prelude.push(`const c${i} = c[${i}];`);
  for (let i = 0; i < b.rowMetas.length; i++) prelude.push(`const m${i} = m[${i}];`);
  const source = `"use strict";\n${prelude.join("\n")}\nreturn function decode(r, k) {\n${b.lines.join("\n")}\nreturn ${result};\n};`;
  const make = new Function("f", "c", "m", source) as (
    f: readonly FromDb[],
    c: Bindings["factories"],
    m: readonly RowMeta[],
  ) => RowDecoder;
  return make(b.fromDb, b.factories, b.rowMetas);
}

// ---------------------------------------------------------------------------
// Interpreted decoders
// ---------------------------------------------------------------------------

/** The plan, prepared for the interpreter: every lookup and decision made once. */
type Step =
  | { readonly kind: "value"; readonly alias: string; readonly fromDb: FromDb | undefined }
  | { readonly kind: "constant"; readonly index: number }
  | {
      readonly kind: "object";
      readonly keys: readonly string[];
      readonly values: readonly Step[];
      /** Whether a key is `__proto__`, which an assignment would not make an own property. */
      readonly protoKey: boolean;
    }
  | { readonly kind: "tuple"; readonly items: readonly Step[] }
  | {
      readonly kind: "row";
      readonly aliases: readonly string[];
      readonly fromDb: readonly (FromDb | undefined)[];
      /** The columns that are all `null` when the row is absent; empty when it cannot be absent. */
      readonly absentWhenNull: readonly string[];
      readonly create: SchemaMeta["create"];
      /** The factory of a row with preloads; `undefined` without (then `create` builds it). */
      readonly createWith: Factory | undefined;
      readonly rowMeta: RowMeta;
      readonly preloads: readonly PreloadStep[];
    };

interface PreloadStep {
  readonly many: boolean;
  readonly child: Step | undefined;
}

function prepare(plan: OutputPlan, codecs: CodecSource): Step {
  switch (plan.kind) {
    case "value":
      return { kind: "value", alias: plan.alias, fromDb: converter(plan.type, codecs) };
    case "constant":
      return { kind: "constant", index: plan.index };
    case "object":
      return {
        kind: "object",
        keys: plan.keys,
        values: plan.values.map((value) => prepare(value, codecs)),
        protoKey: plan.keys.includes("__proto__"),
      };
    case "tuple":
      return { kind: "tuple", items: plan.items.map((item) => prepare(item, codecs)) };
    case "row":
      return {
        kind: "row",
        aliases: plan.aliases,
        fromDb: plan.meta.persisted.map((field) => converter(field.type, codecs)),
        absentWhenNull: plan.nullable ? (plan.key.length > 0 ? plan.key : plan.aliases) : NO_COLUMNS,
        create: plan.meta.create,
        createWith: loadedFactoryOf(plan),
        rowMeta: plan.meta.rowMeta("loaded", plan.schema),
        preloads: plan.preloads.map((preload) => ({
          many: preload.cardinality === "many",
          child: preload.row === undefined ? undefined : prepare(preload.row, codecs),
        })),
      };
  }
}

const NO_COLUMNS: readonly string[] = Object.freeze([]);

function convert(value: unknown, fromDb: FromDb | undefined): unknown {
  return value === null || fromDb === undefined ? value : fromDb(value);
}

function run(step: Step, row: Readonly<Record<string, unknown>>, constants: readonly unknown[]): unknown {
  switch (step.kind) {
    case "value":
      return convert(row[step.alias], step.fromDb);
    case "constant":
      return constants[step.index];
    case "object": {
      const out: Record<string, unknown> = {};
      const { keys, values } = step;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i] as string;
        const value = run(values[i] as Step, row, constants);
        if (step.protoKey && key === "__proto__") {
          Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
        } else {
          out[key] = value;
        }
      }
      return out;
    }
    case "tuple": {
      const items = step.items;
      const out = new Array<unknown>(items.length);
      for (let i = 0; i < items.length; i++) out[i] = run(items[i] as Step, row, constants);
      return out;
    }
    case "row":
      return runRow(step, row, constants);
  }
}

function runRow(
  step: Extract<Step, { readonly kind: "row" }>,
  row: Readonly<Record<string, unknown>>,
  constants: readonly unknown[],
): unknown {
  const absent = step.absentWhenNull;
  if (absent.length > 0) {
    let missing = true;
    for (let i = 0; i < absent.length; i++) {
      if (row[absent[i] as string] !== null) {
        missing = false;
        break;
      }
    }
    if (missing) return null;
  }
  const { aliases, fromDb } = step;
  const values = new Array<unknown>(aliases.length);
  for (let i = 0; i < aliases.length; i++) values[i] = convert(row[aliases[i] as string], fromDb[i]);
  const createWith = step.createWith;
  if (createWith === undefined) return step.create(values, step.rowMeta);
  const preloads = step.preloads;
  const loaded = new Array<unknown>(preloads.length);
  for (let i = 0; i < preloads.length; i++) {
    const preload = preloads[i] as PreloadStep;
    const child = preload.child === undefined ? null : run(preload.child, row, constants);
    loaded[i] = preload.many ? (child === null ? [] : [child]) : child;
  }
  return createWith(values, loaded, step.rowMeta);
}

/**
 * Builds a decoder for `output` without generating code: the plan is prepared once into a
 * tree whose every conversion, factory and row metadata is resolved, and the decoder walks
 * it for each row.
 *
 * @example
 * ```ts
 * const decode = interpretDecoder({ kind: "value", alias: "c0", type: undefined }, adapter);
 * decode({ c0: 1 }, []); // 1
 * ```
 */
export function interpretDecoder(output: OutputPlan, codecs: CodecSource): RowDecoder {
  const root = prepare(output, codecs);
  return (row, constants) => run(root, row, constants);
}

/**
 * Decodes every row of a result into a fresh array.
 *
 * @example
 * ```ts
 * const users = decodeRows(result.rows, decode, []);
 * ```
 */
export function decodeRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  decoder: RowDecoder,
  constants: readonly unknown[],
): unknown[] {
  const out = new Array<unknown>(rows.length);
  for (let i = 0; i < rows.length; i++)
    out[i] = decoder(rows[i] as Readonly<Record<string, unknown>>, constants);
  return out;
}
