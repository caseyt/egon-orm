/**
 * Conditions and expressions built before the query they are used in: `dynamic(…)`, and
 * `field(binding, name)` for a column chosen at run time.
 *
 * A dynamic expression is a function from bindings to an expression, so every clause that
 * takes a callback takes one: `where`, `orWhere`, `having`, `orderBy`, `groupBy`,
 * `select`, `distinct` and the `on` of a join. Its type says which bindings it needs, so
 * using it on a query without them does not compile. Dynamic conditions combine with
 * `and`, `or` and `not`, and `dynamic.true()` / `dynamic.false()` start a fold.
 *
 * @module
 */
import type { AnySchema } from "../../contracts/schema.js";
import { QueryError } from "../../errors.js";
import { isPlainObject } from "../../internal/plain-object.js";
import { isSchema } from "../../schema/guards.js";
import type { Binding } from "../bindings.js";
import {
  booleanLiteral,
  type CompatibleParams,
  type Expr,
  isExpr,
  type MergeParams,
  type NoParams,
  type ParamsOf,
  type SomeParams,
  type ValueOf,
} from "../expr.js";
import { not } from "../functions.js";

/** The schemas a dynamic expression needs, by alias. */
type Schemas = { readonly [alias: string]: AnySchema };

/**
 * The bindings a dynamic expression receives for the schemas `Bs`: one binding per alias,
 * nullable or not, so that it fits a query whatever the join kind.
 *
 * @example
 * ```ts
 * type B = DynamicBindings<{ u: typeof User }>; // { readonly u: Binding<typeof User, boolean> }
 * ```
 */
export type DynamicBindings<Bs> = {
  readonly [K in keyof Bs]: Bs[K] extends AnySchema ? Binding<Bs[K], boolean> : never;
};

/** A boolean expression: what a dynamic condition returns. */
type Condition = Expr<boolean | null, SomeParams>;

/**
 * The methods of a dynamic condition.
 *
 * @example
 * ```ts
 * declare const adult: Dynamic<{ u: typeof User }, Expr<boolean>>;
 * adult.and(admin).or(dynamic.true());
 * ```
 */
export interface DynamicMethods<Bs, X> {
  /**
   * `this AND other`, needing the bindings of both.
   *
   * @throws QueryError (when the query runs the callback) when either side is not a condition.
   */
  and<Bs2, X2 extends Condition>(
    this: DynamicCondition<Bs>,
    other: Dynamic<Bs2, X2> & CompatibleParams<ParamsOf<X>, ParamsOf<X2>>,
  ): Dynamic<Bs & Bs2, Expr<boolean, MergeParams<ParamsOf<X>, ParamsOf<X2>>>>;
  /**
   * `this OR other`, needing the bindings of both.
   *
   * @throws QueryError (when the query runs the callback) when either side is not a condition.
   */
  or<Bs2, X2 extends Condition>(
    this: DynamicCondition<Bs>,
    other: Dynamic<Bs2, X2> & CompatibleParams<ParamsOf<X>, ParamsOf<X2>>,
  ): Dynamic<Bs & Bs2, Expr<boolean, MergeParams<ParamsOf<X>, ParamsOf<X2>>>>;
  /**
   * `NOT this`.
   *
   * @throws QueryError (when the query runs the callback) when this is not a condition.
   */
  not(this: DynamicCondition<Bs>): Dynamic<Bs, Expr<boolean, ParamsOf<X>>>;
}

/**
 * An expression built before its query: a function from the bindings `Bs` needs to `X`,
 * which any clause that takes a callback accepts.
 *
 * @example
 * ```ts
 * const adult: Dynamic<{ u: typeof User }, Expr<boolean>> = dynamic<{ u: typeof User }>(({ u }) => u.age.gte(18));
 * ```
 */
export type Dynamic<Bs, X> = ((bindings: DynamicBindings<Bs>) => X) & DynamicMethods<Bs, X>;

/** A dynamic condition: what `and`, `or` and `not` may be called on. */
type DynamicCondition<Bs> = (bindings: DynamicBindings<Bs>) => Condition;

/** What the dynamic functions remember about a dynamic expression: the schemas it needs, when known. */
const DYNAMICS = new WeakMap<object, Schemas | undefined>();

/** The schemas a dynamic expression needs, checked against the bindings it is given, when it was made with them. */
function checkBindings(required: Schemas | undefined, bindings: unknown): void {
  if (required === undefined) return;
  const given = bindings as Readonly<Record<string, { readonly $schema?: unknown } | undefined>>;
  for (const alias of Object.keys(required)) {
    const schema = required[alias] as AnySchema;
    const binding = Object.hasOwn(given, alias) ? given[alias] : undefined;
    if (binding === undefined || binding.$schema !== schema) {
      throw new QueryError(
        `A dynamic expression needs the binding "${alias}" of ${schema.name}, which this query ${binding === undefined ? "does not have" : "binds to another schema"}.`,
      );
    }
  }
}

function makeDynamic(
  call: (bindings: unknown) => unknown,
  required: Schemas | undefined,
): Dynamic<unknown, unknown> {
  const fn = (bindings: unknown): unknown => {
    checkBindings(required, bindings);
    return call(bindings);
  };
  const made = Object.assign(fn, METHODS);
  DYNAMICS.set(made, required);
  return made as never;
}

function conditionOf(value: unknown, method: string): Condition {
  if (!isExpr(value)) {
    throw new QueryError(
      `dynamic ${method}(): both sides must be conditions, such as dynamic(({ u }) => u.age.gte(18)).`,
    );
  }
  return value as Condition;
}

function dynamicOf(value: unknown, method: string): (bindings: unknown) => unknown {
  if (typeof value !== "function" || !DYNAMICS.has(value)) {
    throw new QueryError(
      `${method}() on a dynamic expression takes another dynamic expression: a.${method}(dynamic(…)).`,
    );
  }
  return value as (bindings: unknown) => unknown;
}

function merged(a: object, b: object): Schemas | undefined {
  const left = DYNAMICS.get(a);
  const right = DYNAMICS.get(b);
  if (left === undefined) return right;
  if (right === undefined) return left;
  return { ...left, ...right };
}

/** The methods every dynamic expression has; `this` is the dynamic expression. */
const METHODS = {
  and(this: (bindings: unknown) => unknown, other: unknown): unknown {
    const right = dynamicOf(other, "and");
    return makeDynamic(
      (bindings) => conditionOf(this(bindings), "and").and(conditionOf(right(bindings), "and") as never),
      merged(this, right),
    );
  },
  or(this: (bindings: unknown) => unknown, other: unknown): unknown {
    const right = dynamicOf(other, "or");
    return makeDynamic(
      (bindings) => conditionOf(this(bindings), "or").or(conditionOf(right(bindings), "or") as never),
      merged(this, right),
    );
  },
  not(this: (bindings: unknown) => unknown): unknown {
    return makeDynamic((bindings) => not(conditionOf(this(bindings), "not")), DYNAMICS.get(this));
  },
};

/**
 * The `dynamic` function, and `dynamic.true()` / `dynamic.false()`.
 *
 * @example
 * ```ts
 * const all = filters.reduce((acc, f) => acc.and(f), dynamic.true());
 * ```
 */
export interface DynamicFunction {
  /**
   * A condition built before its query, needing the bindings `Bs` (alias to schema class).
   * This form takes no named parameters; to use them, or to build anything but a
   * condition, pass the schemas as a value.
   */
  <Bs extends Schemas>(
    fn: (bindings: DynamicBindings<Bs>) => Expr<boolean | null, NoParams>,
  ): Dynamic<Bs, Expr<boolean, NoParams>>;
  /**
   * An expression built before its query, needing a binding of each schema under its
   * alias: a condition, an order item, a select shape. The query checks the bindings when
   * it runs the callback.
   */
  <const Bs extends Schemas, X>(schemas: Bs, fn: (bindings: DynamicBindings<Bs>) => X): Dynamic<Bs, X>;
  /** `TRUE`, needing no binding: the start of a fold with `and`. */
  true(): Dynamic<NoParams, Expr<boolean, NoParams>>;
  /** `FALSE`, needing no binding: the start of a fold with `or`. */
  false(): Dynamic<NoParams, Expr<boolean, NoParams>>;
}

function dynamicFn(...args: readonly unknown[]): unknown {
  if (args.length === 1) {
    const fn = args[0];
    if (typeof fn !== "function") {
      throw new QueryError(
        "dynamic() takes a callback that receives the bindings: dynamic(({ u }) => u.age.gte(18)).",
      );
    }
    return makeDynamic(fn as (bindings: unknown) => unknown, undefined);
  }
  const [schemas, fn] = args;
  if (typeof schemas !== "object" || schemas === null || !isPlainObject(schemas)) {
    throw new QueryError(
      "dynamic(schemas, callback) takes the schemas it needs by alias first: dynamic({ u: User }, ({ u }) => …).",
    );
  }
  for (const alias of Object.keys(schemas)) {
    if (!isSchema((schemas as Record<string, unknown>)[alias])) {
      throw new QueryError(
        `dynamic({ ${alias} }, …): "${alias}" must name a schema class, such as { ${alias}: User }.`,
      );
    }
  }
  if (typeof fn !== "function") {
    throw new QueryError(
      "dynamic(schemas, callback) takes a callback second: dynamic({ u: User }, ({ u }) => u.age.gte(18)).",
    );
  }
  return makeDynamic(fn as (bindings: unknown) => unknown, { ...(schemas as Schemas) });
}

/**
 * A condition or expression built before the query it is used in, for filters assembled
 * from data. Give the bindings it needs as a type (`dynamic<{ u: typeof User }>(…)`, a
 * condition without named parameters) or as a value (`dynamic({ u: User }, …)`, anything,
 * with its named parameters and a run-time check of the bindings). Any clause that takes a
 * callback takes it.
 *
 * @example
 * ```ts
 * const filters = [
 *   dynamic<{ u: typeof User }>(({ u }) => u.age.gte(18)),
 *   dynamic<{ u: typeof User }>(({ u }) => u.role.eq("member")),
 * ];
 * from(User, "u").where(filters.reduce((acc, f) => acc.and(f), dynamic.true()));
 * ```
 *
 * @throws QueryError when the arguments are not a callback, or schemas and a callback; and
 * when the query runs it, when a binding it needs is missing or of another schema.
 */
export const dynamic: DynamicFunction = Object.assign(dynamicFn, {
  true: () => makeDynamic(() => booleanLiteral(true), undefined),
  false: () => makeDynamic(() => booleanLiteral(false), undefined),
}) as never;

/** The keys of a binding that are columns. */
type FieldKeys<X> = {
  [K in keyof X]: K extends `$${string}` | `~${string}`
    ? never
    : X[K] extends Expr<unknown, NoParams>
      ? K
      : never;
}[keyof X] &
  string;

/**
 * A column of a binding chosen by a name known only at run time, such as a sort key from a
 * request. The name is checked against the binding's columns; the type is the union of the
 * types of the columns it may name.
 *
 * @example
 * ```ts
 * from(User, "u").orderBy(({ u }) => field(u, sortColumn).asc());
 * ```
 *
 * @throws QueryError when `name` is not one of the binding's columns.
 */
export function field<X extends object, const N extends FieldKeys<X>>(
  binding: X,
  name: N,
): Expr<{ [K in N]: X[K] extends Expr<unknown, NoParams> ? ValueOf<X[K]> : never }[N], NoParams>;
export function field<X extends object>(
  binding: X,
  name: string,
): Expr<
  { [K in FieldKeys<X>]: X[K] extends Expr<unknown, NoParams> ? ValueOf<X[K]> : never }[FieldKeys<X>],
  NoParams
>;
export function field(binding: object, name: string): Expr<unknown, NoParams> {
  if (typeof binding !== "object" || binding === null) {
    throw new QueryError("field() takes a binding first, such as u in ({ u }) => field(u, name).");
  }
  const column =
    typeof name === "string" && !name.startsWith("$") && Object.hasOwn(binding, name)
      ? (binding as Record<string, unknown>)[name]
      : undefined;
  if (!isExpr(column)) {
    // The list of columns is built only for the message.
    const columns = Object.keys(binding).filter(
      (key) => !key.startsWith("$") && isExpr((binding as Record<string, unknown>)[key]),
    );
    throw new QueryError(
      `field() was given ${typeof name === "string" ? `"${name}"` : `a ${typeof name}`}, which is not a column of the binding. Its columns are: ${columns.join(", ")}.`,
    );
  }
  return column as Expr<unknown, NoParams>;
}
