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
 * `undefined`), or when `named` holds a name the plan does not use.
 */
export function bindParams(
  slots: readonly ParamSlot[],
  params: readonly unknown[],
  named?: NamedValues,
): unknown[] {
  const out: unknown[] = [];
  let missing: string[] | undefined;
  for (let i = 0; i < slots.length; i++) {
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
  if (missing !== undefined) {
    throw new QueryError(
      `The query needs the named parameter${missing.length > 1 ? "s" : ""} ${missing.map((name) => `"${name}"`).join(", ")}, which ${missing.length > 1 ? "were" : "was"} not given a value.`,
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
