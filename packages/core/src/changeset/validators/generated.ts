/**
 * The generated builders of the objects a validator sees, kept apart from `validate.ts`
 * so that `Schema()` can generate them when a schema is defined, without importing the
 * changeset code.
 *
 * Workers allow code generation while a script starts and refuse it while the script
 * handles a request. A schema is usually defined at startup, so its builders are made
 * then; a schema defined later (inside a handler) is generated when it is first
 * validated, or built from loops where the runtime refuses. The field table of a
 * changeset without a schema class is never generated: it always uses loops.
 *
 * @module
 */
import type { FieldMeta } from "../../contracts/schema.js";
import { generateFunction } from "../../internal/codegen.js";

type Values = Readonly<Record<string, unknown>>;

/**
 * Builds the object a validator sees: every field with the changes applied, in field
 * order, leaving out fields with no value.
 */
export type ValuesBuilder = (changes: Values, base: Values) => Values;

/** Makes the builder of the values before the changes, given the function that reads one. */
export type BeforeMaker = <C>(
  before: (changeset: C, name: string) => unknown,
) => (changeset: C) => Record<string, unknown>;

/** The generated builders of one field table. */
export interface GeneratedBuilders {
  readonly build: ValuesBuilder;
  readonly before: BeforeMaker;
}

const generated = /* @__PURE__ */ new WeakMap<ReadonlyMap<string, FieldMeta>, GeneratedBuilders>();
/** Field tables of schemas declared with `codegen: false`, and of changesets without a schema class: never generated, always loops. */
const loopsOnly = /* @__PURE__ */ new WeakSet<ReadonlyMap<string, FieldMeta>>();

/**
 * Marks the field table of a schema declared with `codegen: false`, or of a changeset
 * without a schema class: its validator builders are never generated, so `new Function`
 * is never called for it.
 *
 * @example
 * ```ts
 * if (options?.codegen === false) refuseGeneration(tables.fieldsByName);
 * ```
 */
export function refuseGeneration(fields: ReadonlyMap<string, FieldMeta>): void {
  loopsOnly.add(fields);
}

/**
 * The generated builders of a field table, made now if they were not made before.
 * `undefined` when the runtime refuses to generate code, or the table is of a schema
 * declared with `codegen: false` or of a changeset without a schema class (which has no
 * `codegen` option, so it never generates code).
 *
 * The builders store one field at a time with its name as a literal, which is several
 * times faster than storing under computed names. A change is never `undefined`, so
 * `hasOwn` is asked only for a field that reads as changed. Names go in as string
 * literals, so nothing a schema declares can become code.
 *
 * @example
 * ```ts
 * const builders = generatedBuilders(meta(User).fieldsByName);
 * const values = builders?.build({ email: "a@b.c" }, row);
 * ```
 */
export function generatedBuilders(fields: ReadonlyMap<string, FieldMeta>): GeneratedBuilders | undefined {
  if (loopsOnly.has(fields)) return undefined;
  let builders = generated.get(fields);
  if (builders !== undefined) return builders;
  const keys = [...fields.keys()].map((name) => JSON.stringify(name));
  const buildLines = keys.map((key) =>
    [
      `v = changes[${key}];`,
      `if (v === undefined || !hasOwn(changes, ${key})) v = base[${key}];`,
      `if (v !== undefined) out[${key}] = v;`,
    ].join("\n"),
  );
  const makeBuild = generateFunction(
    ["hasOwn"],
    `"use strict";\nreturn function values(changes, base) {\nconst out = {};\nlet v;\n${buildLines.join("\n")}\nreturn out;\n};`,
  ) as ((hasOwn: typeof Object.hasOwn) => ValuesBuilder) | undefined;
  if (makeBuild === undefined) return undefined;
  const beforeLines = keys.map((key) => `out[${key}] = before(changeset, ${key});`);
  const outerBefore = generateFunction(
    [],
    `"use strict";\nreturn function make(before) {\nreturn function valuesBefore(changeset) {\nconst out = {};\n${beforeLines.join("\n")}\nreturn out;\n};\n};`,
  ) as (() => BeforeMaker) | undefined;
  if (outerBefore === undefined) return undefined;
  builders = { build: makeBuild(Object.hasOwn), before: outerBefore() };
  generated.set(fields, builders);
  return builders;
}
