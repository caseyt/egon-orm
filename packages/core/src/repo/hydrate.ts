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
 * reference, when the decoder is built), pass `null` through without converting it,
 * check that a `t.integer()` or `t.float()` value is a `number` ({@link numberCheck}), and
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
import { CastError } from "../errors.js";
import { generateFunction } from "../internal/codegen.js";
import { floatType, integerType, resolveCodec } from "../types/index.js";

/** Converts one non-null driver value to the application value. */
type FromDb = (value: unknown) => unknown;

/** Returns a non-null decoded value when it is a `number`; throws `CastError` otherwise. */
type NumberCheck = (value: unknown) => unknown;

const INTEGER: AnyFieldType = /* @__PURE__ */ integerType();
const FLOAT: AnyFieldType = /* @__PURE__ */ floatType();

/**
 * Said when the row came back from a write: the statement has run. Also added by
 * `writeThenRead` to a decoding error of the row it reads back after an insert.
 */
export const WRITTEN =
  " The write itself was applied: outside a transaction it stays; inside one it commits or rolls back with the transaction.";

function wrongKind(label: string, type: AnyFieldType, value: unknown, written: boolean): CastError {
  const after = written ? WRITTEN : "";
  // The value itself is left out of the message: the field may be redacted.
  const got = typeof value;
  const article = got === "object" || got === "undefined" ? "an" : "a";
  return type === INTEGER
    ? new CastError(
        "cast.integerNotNumber",
        `${label} is declared t.integer(), but the database returned ${article} ${got} for it, not a number.${after}`,
      )
    : new CastError(
        "cast.floatNotNumber",
        `${label} is declared t.float(), but the database returned ${article} ${got} for it, not a number.${after}`,
      );
}

/**
 * The check of a `t.integer()` or `t.float()` value, made once per value of the plan when
 * the decoder is built; `undefined` for any other type. Their application value is the
 * canonical driver value (`fromDb` is the identity), which is a `number` once the
 * dialect's driver codec has run: `pg` sends `int4` and `float8` as numbers, and the
 * MySQL and SQLite codecs turn the digit text and bigints those drivers send into numbers.
 * Anything else means the column is of another type, such as a `bigint` (`bigserial`) or
 * `numeric` column that `pg` reads as text, which would otherwise reach the row as a
 * string typed `number`. `label` names the value in the error: `User.id`, or the key of
 * a selected object. `written`: the row was returned by a write, which the error then says
 * has been applied.
 *
 * @example
 * ```ts
 * numberCheck(integerType(), "User.id")?.("12"); // throws CastError
 * ```
 */
export function numberCheck(
  type: AnyFieldType | undefined,
  label: string,
  written = false,
): NumberCheck | undefined {
  if (type !== INTEGER && type !== FLOAT) return undefined;
  return (value) => {
    // `undefined` is a column missing from the row, which no driver returns (a stub
    // adapter in a test may): it is left as it is, as without the check.
    if (typeof value === "number" || value === undefined) return value;
    throw wrongKind(label, type, value, written);
  };
}

/** `label` with a key appended, for a value inside a selected object. */
function keyLabel(label: string | undefined, key: string): string {
  return label === undefined ? JSON.stringify(key) : `${label}.${key}`;
}

/** The label of a selected value that is not inside an object. */
const SELECTED = "The selected value";

/** Where the decoder gets each type's driver conversion from: the adapter that ran the plan. */
export type CodecSource = Pick<Adapter, "typeOverrides">;

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
 * `label` is given by the writes only: the name of the schema whose returned row the plan
 * decodes. It names the values in a decoding error (`User.id`, where a read's object would
 * say `"id"`), and the error then says that the write was applied. A write plan is never a
 * read plan (their SQL differs), so the label a cached decoder was built with is its own.
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
export function decoderFor(
  plan: CompiledQuery,
  codecs: CodecSource,
  codegen: boolean,
  label?: string,
): RowDecoder {
  let decoder = plan.decoder;
  if (decoder === undefined) {
    const output = plan.output;
    if (output === undefined) {
      // A plan of a read always has an output plan; this guards a hand-built one.
      throw new TypeError(
        "This compiled statement returns no rows to decode (its output plan is undefined).",
      );
    }
    decoder = buildDecoder(output, codecs, codegen, label);
    plan.decoder = decoder;
  }
  return decoder;
}

/**
 * Builds a decoder for an output plan: generated when `codegen` is true and the runtime
 * allows it at this moment, interpreted otherwise. A repo with `codegen: false` never
 * calls `new Function`, so a Content Security Policy never sees (or reports) an attempt.
 *
 * @example
 * ```ts
 * const decode = buildDecoder(plan.output, adapter, true);
 * ```
 */
export function buildDecoder(
  output: OutputPlan,
  codecs: CodecSource,
  codegen: boolean,
  label?: string,
): RowDecoder {
  return codegen ? generateDecoder(output, codecs, label) : interpretDecoder(output, codecs, label);
}

// ---------------------------------------------------------------------------
// Generated decoders
// ---------------------------------------------------------------------------

/** What the generated code refers to, by index: conversions, row factories, row metadata. */
interface Bindings {
  readonly fromDb: FromDb[];
  /** The {@link numberCheck} of each checked value, by index. */
  readonly checks: NumberCheck[];
  /** Whether the rows come back from a write (see {@link numberCheck}). */
  readonly written: boolean;
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

/**
 * The expression of a column converted to its application value. With a check, a value
 * that needs no conversion is tested inline (`typeof`), so that a number calls nothing;
 * a converted value is passed to the check.
 */
function converted(
  b: Bindings,
  alias: string,
  fromDb: FromDb | undefined,
  check: NumberCheck | undefined,
): string {
  const local = column(b, alias);
  let checkName = "";
  if (check !== undefined) {
    checkName = `n${b.checks.length}`;
    b.checks.push(check);
  }
  if (fromDb === undefined) {
    return check === undefined
      ? local
      : `(${local} === null || typeof ${local} === "number" ? ${local} : ${checkName}(${local}))`;
  }
  const index = b.fromDb.length;
  b.fromDb.push(fromDb);
  return check === undefined
    ? `(${local} === null ? null : f${index}(${local}))`
    : `(${local} === null ? null : ${checkName}(f${index}(${local})))`;
}

function generate(b: Bindings, plan: OutputPlan, codecs: CodecSource, label: string | undefined): string {
  switch (plan.kind) {
    case "value":
      return converted(
        b,
        plan.alias,
        converter(plan.type, codecs),
        numberCheck(plan.type, label ?? SELECTED, b.written),
      );
    case "constant":
      return `k[${plan.index}]`;
    case "object": {
      const parts: string[] = [];
      for (let i = 0; i < plan.keys.length; i++) {
        // A computed key: `["__proto__"]` defines an own property, a plain one would not.
        const key = plan.keys[i] as string;
        parts.push(
          `[${literal(key)}]: ${generate(b, plan.values[i] as OutputPlan, codecs, keyLabel(label, key))}`,
        );
      }
      return `{ ${parts.join(", ")} }`;
    }
    case "tuple":
      return `[${plan.items.map((item, i) => generate(b, item, codecs, `${label ?? SELECTED}[${i}]`)).join(", ")}]`;
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
    values.push(
      converted(
        b,
        leaf.aliases[i] as string,
        converter(field.type, codecs),
        numberCheck(field.type, `${leaf.meta.name}.${field.name}`, b.written),
      ),
    );
  }
  const loaded: string[] = [];
  for (const preload of leaf.preloads) {
    if (preload.row === undefined) {
      loaded.push(preload.cardinality === "many" ? "[]" : "null");
      continue;
    }
    // Built inside the parent's expression: a child is converted only when its parent exists.
    const expression = generate(b, preload.row, codecs, undefined);
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
 * value with object and array literals and the row factories. Where the runtime refuses to
 * generate code (a Content Security Policy, a Cloudflare Worker handling a request), it
 * returns the interpreted decoder instead, which gives the same results.
 *
 * @example
 * ```ts
 * const decode = generateDecoder({ kind: "value", alias: "c0", type: undefined }, adapter);
 * decode({ c0: 1 }, []); // 1
 * ```
 */
export function generateDecoder(output: OutputPlan, codecs: CodecSource, label?: string): RowDecoder {
  const b: Bindings = {
    fromDb: [],
    checks: [],
    written: label !== undefined,
    factories: [],
    rowMetas: [],
    lines: [],
    locals: new Map(),
    next: 0,
  };
  const result = generate(b, output, codecs, label);
  const prelude: string[] = [];
  for (let i = 0; i < b.fromDb.length; i++) prelude.push(`const f${i} = f[${i}];`);
  for (let i = 0; i < b.checks.length; i++) prelude.push(`const n${i} = n[${i}];`);
  for (let i = 0; i < b.factories.length; i++) prelude.push(`const c${i} = c[${i}];`);
  for (let i = 0; i < b.rowMetas.length; i++) prelude.push(`const m${i} = m[${i}];`);
  const source = `"use strict";\n${prelude.join("\n")}\nreturn function decode(r, k) {\n${b.lines.join("\n")}\nreturn ${result};\n};`;
  const make = generateFunction(["f", "n", "c", "m"], source) as
    | ((
        f: readonly FromDb[],
        n: readonly NumberCheck[],
        c: Bindings["factories"],
        m: readonly RowMeta[],
      ) => RowDecoder)
    | undefined;
  if (make === undefined) return interpretDecoder(output, codecs, label);
  return make(b.fromDb, b.checks, b.factories, b.rowMetas);
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

/** A conversion and a check composed into one function, once per value when the tree is prepared. */
function checked(fromDb: FromDb | undefined, check: NumberCheck | undefined): FromDb | undefined {
  if (check === undefined) return fromDb;
  if (fromDb === undefined) return check;
  return (value) => check(fromDb(value));
}

function prepare(plan: OutputPlan, codecs: CodecSource, label: string | undefined, written: boolean): Step {
  switch (plan.kind) {
    case "value":
      return {
        kind: "value",
        alias: plan.alias,
        fromDb: checked(converter(plan.type, codecs), numberCheck(plan.type, label ?? SELECTED, written)),
      };
    case "constant":
      return { kind: "constant", index: plan.index };
    case "object":
      return {
        kind: "object",
        keys: plan.keys,
        values: plan.values.map((value, i) =>
          prepare(value, codecs, keyLabel(label, plan.keys[i] as string), written),
        ),
        protoKey: plan.keys.includes("__proto__"),
      };
    case "tuple":
      return {
        kind: "tuple",
        items: plan.items.map((item, i) => prepare(item, codecs, `${label ?? SELECTED}[${i}]`, written)),
      };
    case "row":
      return {
        kind: "row",
        aliases: plan.aliases,
        fromDb: plan.meta.persisted.map((field) =>
          checked(
            converter(field.type, codecs),
            numberCheck(field.type, `${plan.meta.name}.${field.name}`, written),
          ),
        ),
        absentWhenNull: plan.nullable ? (plan.key.length > 0 ? plan.key : plan.aliases) : NO_COLUMNS,
        create: plan.meta.create,
        createWith: loadedFactoryOf(plan),
        rowMeta: plan.meta.rowMeta("loaded", plan.schema),
        preloads: plan.preloads.map((preload) => ({
          many: preload.cardinality === "many",
          child: preload.row === undefined ? undefined : prepare(preload.row, codecs, undefined, written),
        })),
      };
  }
}

const NO_COLUMNS: readonly string[] = /* @__PURE__ */ Object.freeze([]);

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
export function interpretDecoder(output: OutputPlan, codecs: CodecSource, label?: string): RowDecoder {
  const root = prepare(output, codecs, label, label !== undefined);
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
