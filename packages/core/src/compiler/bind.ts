/**
 * Building the driver's parameter array from a compiled plan: one loop over its slots.
 *
 * @module
 */
import type { CompiledQuery, ParamSlot, ToDb } from "../contracts/adapter.js";
import { QueryError } from "../errors.js";

/**
 * The values supplied by name at execution: `repo.all(query, { minAge: 18 })`.
 *
 * @example
 * ```ts
 * const named: NamedValues = { minAge: 18 };
 * ```
 */
export type NamedValues = Readonly<Record<string, unknown>>;

/** The distinct names of a plan's `named` slots, computed once per slot list. */
const namesOfSlots = new WeakMap<readonly ParamSlot[], ReadonlySet<string>>();

function namesOf(slots: readonly ParamSlot[]): ReadonlySet<string> {
  let names = namesOfSlots.get(slots);
  if (names === undefined) {
    const found = new Set<string>();
    for (const slot of slots) if (slot.kind === "named") found.add(slot.name);
    names = found;
    namesOfSlots.set(slots, names);
  }
  return names;
}

/**
 * What {@link wholeNumber} and {@link wholeBigintNumber} throw; {@link bindParams} replaces
 * it with an error naming the slot.
 */
const NOT_WHOLE = new QueryError("query.notWholeNumber", "A value of an integer type is not a whole number.");

/**
 * The bind-time check of a value of the built-in `t.integer()` type (owner decision,
 * 2026-10-20), which the compiler gives such a slot in place of the identity: a number
 * that is not a whole number (a fraction, `NaN`, an infinity) is refused with
 * `QueryError` on every database. Postgres refuses it anyway (22P02); MySQL and SQLite
 * would round it, truncate it in an integer division, or compare it as it is. Anything
 * else (a whole number, digit text) is returned unchanged. One shared function, so plans
 * stay comparable and nothing is made per call.
 *
 * @example
 * ```ts
 * wholeNumber(3); // 3
 * wholeNumber(2.5); // throws QueryError
 * ```
 *
 * @throws QueryError for a number that is not a whole number.
 */
export function wholeNumber(value: unknown): unknown {
  if (typeof value !== "number" || Number.isInteger(value)) return value;
  throw NOT_WHOLE;
}

/**
 * The same check as {@link wholeNumber}, for the built-in `t.bigint({ mode: "number" })`
 * type. A separate function only so that the error can name the type. (`t.bigint()`
 * holds `bigint` values, which are always whole, and has no check.)
 *
 * @example
 * ```ts
 * wholeBigintNumber(2 ** 40); // 1099511627776
 * wholeBigintNumber(2.5); // throws QueryError
 * ```
 *
 * @throws QueryError for a number that is not a whole number.
 */
export function wholeBigintNumber(value: unknown): unknown {
  if (typeof value !== "number" || Number.isInteger(value)) return value;
  throw NOT_WHOLE;
}

/** The name of the integer type a slot's check stands for, as an error writes it. */
function wholeTypeName(slot: ParamSlot): string {
  return slot.toDb === wholeBigintNumber ? 't.bigint({ mode: "number" })' : "t.integer()";
}

/** The slot of each error {@link bindParams} threw for a value that is not a whole number. */
const refusedSlots = new WeakMap<object, ParamSlot>();

/** The error for a slot whose value was not a whole number, naming it by its position or name. */
function notWhole(slot: ParamSlot, position: number): QueryError {
  const label =
    slot.kind === "named"
      ? `The named parameter "${slot.name}"`
      : slot.kind === "list"
        ? `An item of parameter ${position}`
        : `Parameter ${position}`;
  const error = new QueryError(
    "query.paramNotWholeNumber",
    `${label} has the type ${wholeTypeName(slot)} (its own, or that of the column beside it), but its value is not a whole number.`,
  );
  refusedSlots.set(error, slot);
  return error;
}

/**
 * For a write, whose bound values are written to fields: the error to throw in place of
 * `error` when {@link bindParams} refused a value of an integer type that is not a whole
 * number. It names the field (`User.age`) and keeps `error`, which names the parameter, as
 * its `cause`. `fieldAt` gives the field label of an entry of the bound `params` (a slot's
 * `index`), or `undefined` when the entry is no field's value; any other error, or a
 * refused named parameter, is returned as it is. Called in a `catch`, so nothing runs on
 * the path that binds.
 *
 * @example
 * ```ts
 * try {
 *   bound = bindParams(plan.slots, values);
 * } catch (error) {
 *   throw fieldOfRefusal(error, (index) => `User.${columns[index]?.name}`);
 * }
 * ```
 */
export function fieldOfRefusal(error: unknown, fieldAt: (index: number) => string | undefined): unknown {
  const slot = typeof error === "object" && error !== null ? refusedSlots.get(error) : undefined;
  if (slot === undefined || slot.kind === "named") return error;
  const field = fieldAt(slot.index);
  if (field === undefined) return error;
  return new QueryError(
    "query.writeNotWholeNumber",
    `The value written to ${field} holds a number that is not a whole number where ${wholeTypeName(slot)} is expected.`,
    { cause: error },
  );
}

function mapList(list: unknown, toDb: ToDb): unknown {
  if (!Array.isArray(list)) return list;
  const out: unknown[] = [];
  for (let i = 0; i < list.length; i++) {
    const value: unknown = list[i];
    out.push(value === null || value === undefined ? value : toDb(value));
  }
  return out;
}

/**
 * The parameter array for one execution of a plan: for each slot, its value taken from
 * `params` (the executed query's `QueryAst.params`, or the array a write was compiled
 * over) or from `named`, converted with the slot's `toDb` unless it is `null`. A `list`
 * slot converts every element.
 *
 * @example
 * ```ts
 * const plan = compiler.compile(query.ast, "all", undefined);
 * const values = bindParams(plan.slots, query.ast.params, { minAge: 18 });
 * await adapter.execute(plan.sql, values, { slots: plan.slots });
 * ```
 *
 * @throws QueryError listing the names when a named parameter has no value (or
 * `undefined`), or when `named` holds a name the plan does not use; naming the parameter
 * when a `t.integer()` value is not a whole number ({@link wholeNumber}).
 */
export function bindParams(
  slots: readonly ParamSlot[],
  params: readonly unknown[],
  named?: NamedValues,
): unknown[] {
  const out: unknown[] = [];
  let missing: string[] | undefined;
  let i = 0;
  try {
    for (; i < slots.length; i++) {
      const slot = slots[i] as ParamSlot;
      let value: unknown;
      switch (slot.kind) {
        case "inline":
          value = params[slot.index];
          break;
        case "list":
          value = params[slot.index];
          out.push(slot.toDb === undefined ? value : mapList(value, slot.toDb));
          continue;
        case "element":
          value = (params[slot.index] as readonly unknown[])[slot.element];
          break;
        case "named":
          value = named === undefined || !Object.hasOwn(named, slot.name) ? undefined : named[slot.name];
          if (value === undefined) {
            missing ??= [];
            if (!missing.includes(slot.name)) missing.push(slot.name);
          }
          break;
      }
      out.push(value === null || value === undefined || slot.toDb === undefined ? value : slot.toDb(value));
    }
  } catch (error) {
    // The slot is named here, on the failing path only: the check itself is one shared function.
    throw error === NOT_WHOLE ? notWhole(slots[i] as ParamSlot, i + 1) : error;
  }
  if (missing !== undefined) {
    throw new QueryError(
      "query.namedParamMissing",
      `The query needs the named parameter${missing.length > 1 ? "s" : ""} ${missing.map((name) => `"${name}"`).join(", ")}, which ${missing.length > 1 ? "were" : "was"} not given a value.`,
      { params: { first: missing[0] ?? "name" } },
    );
  }
  if (named !== undefined) checkExtra(slots, named);
  return out;
}

function checkExtra(slots: readonly ParamSlot[], named: NamedValues): void {
  let extra: string[] | undefined;
  const names = namesOf(slots);
  for (const name in named) {
    if (Object.hasOwn(named, name) && !names.has(name)) {
      extra ??= [];
      extra.push(name);
    }
  }
  if (extra !== undefined) {
    throw new QueryError(
      "query.namedParamUnknown",
      `The query has no named parameter${extra.length > 1 ? "s" : ""} ${extra.map((name) => `"${name}"`).join(", ")}${names.size === 0 ? "; it takes none" : `; it takes ${[...names].map((name) => `"${name}"`).join(", ")}`}.`,
    );
  }
}

/**
 * The SQL of a plan and the parameters one execution would send: what `repo.toSql`
 * returns. Values are converted with each slot's `toDb`, exactly as they are sent.
 *
 * @example
 * ```ts
 * const plan = compiler.compile(query.ast, "all", undefined);
 * toSql(plan, query.ast.params); // { sql: 'select … where "u"."age" >= $1', params: [18] }
 * ```
 *
 * @throws QueryError as {@link bindParams} does.
 */
export function toSql(
  plan: CompiledQuery,
  params: readonly unknown[],
  named?: NamedValues,
): { readonly sql: string; readonly params: unknown[] } {
  return { sql: plan.sql, params: bindParams(plan.slots, params, named) };
}
