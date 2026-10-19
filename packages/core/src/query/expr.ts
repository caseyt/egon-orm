/**
 * Typed expressions: what a developer writes inside `where`, `select`, `orderBy` and the
 * other clause callbacks. `u.age.gte(18)` is a method call on a {@link Col} that returns a
 * new {@link Expr} wrapping a node of the AST.
 *
 * An expression is immutable. It carries, beside its node, everything a query builder
 * needs to add it to a query without walking it again: the bound values in canonical
 * order (`params`), the lengths of its lists (`lists`) and its structural hash (`shape`).
 * Each operator computes those from its operands' in constant time.
 *
 * Every JavaScript value given to an operator becomes a {@link ParamNode} (decision D9),
 * typed like the expression on the other side, so `u.role.eq("admin")` writes `"admin"`
 * with `role`'s type, and marked `redact` when that side is a redacted field.
 *
 * @module
 */
import type { BinaryOp, ExprNode, NamedParamNode, OrderNode, QueryAst } from "../contracts/query.js";
import type { FieldBuilder, FieldFlags, FieldMeta } from "../contracts/schema.js";
import type { AnyFieldType } from "../contracts/type.js";
import { QueryError } from "../errors.js";
import { fieldState } from "../schema/field.js";
import { booleanType, elementTypeOf, jsonType, stringType } from "../types/index.js";
import {
  betweenNode,
  binaryNode,
  caseNode,
  castNode,
  collectParams,
  columnNode,
  fnNode,
  foldShape,
  jsonPathNode,
  listNode,
  literalNode,
  namedParamNode,
  naryNode,
  orderNode,
  paramNode,
  shapeOf,
  shapeOfBetween,
  shapeOfBinary,
  shapeOfCast,
  shapeOfColumn,
  shapeOfJsonPath,
  shapeOfList,
  shapeOfLiteral,
  shapeOfOrder,
  shapeOfParam,
  shapeOfUnary,
  startFn,
  startNary,
  unaryNode,
} from "./ast.js";

// ---------------------------------------------------------------------------
// Type-level helpers
// ---------------------------------------------------------------------------

/**
 * The named parameters of an expression that uses none.
 *
 * @example
 * ```ts
 * declare const e: Expr<boolean, NoParams>;
 * ```
 */
export type NoParams = Record<never, never>;

/**
 * The named-parameter position that accepts an expression whatever parameters it needs:
 * `Expr<boolean, SomeParams>` is any boolean expression. Named parameters are a
 * requirement, so `Expr` is contravariant in them: an expression that needs `minAge` is not
 * an `Expr<boolean>` (which needs none), and `never` is the type every requirement accepts.
 *
 * **A constraint only.** Use it to accept any expression (a parameter type, a generic
 * constraint), never as a return or variable type: an expression typed with it has
 * requirements nobody knows, and so does everything built from it, so a query made from it
 * cannot be executed. A function that returns an expression declares the parameters it
 * uses: `Expr<boolean, { minAge: number }>`.
 *
 * @example
 * ```ts
 * function describe(condition: Expr<boolean | null, SomeParams>): string {
 *   return condition.node.kind;
 * }
 * describe(u.age.gte(param("minAge", t.integer())));
 * ```
 */
export type SomeParams = never;

type Simplify<X> = { [K in keyof X]: X[K] };

/**
 * Type only: marks an expression that binds a value with no type that is not text, such
 * as `val(5)` or `caseWhen(c, 1)`. Nothing in SQL gives such a value a type in a select
 * list, where the database would return it as text, so `select` does not accept one
 * (owner decision of 2026-10-15): give the value a type, `val(5, t.integer())`.
 * The property never exists at run time.
 *
 * @example
 * ```ts
 * type Five = Expr<5> & Untyped; // what val(5) is
 * ```
 */
export interface Untyped extends NoType {
  readonly "~untyped": true;
}

/**
 * Type only: marks an expression whose value is bound with no type, text included
 * (`val("x")`, `caseWhen(c, "x")`). It is fine in a select, where the database reads it
 * as text, but a later untyped value beside it has nothing to take a type from:
 * `caseWhen(c, "x").else(5)` is {@link Untyped}. Every `Untyped` expression is `NoType`.
 * The property never exists at run time.
 *
 * @example
 * ```ts
 * type Label = Expr<"x"> & NoType; // what val("x") is
 * ```
 */
export interface NoType {
  readonly "~noType": true;
}

/**
 * Whether nothing gives `V` a type: a plain value (bound with the type of its other side,
 * when there is none), or an expression marked {@link NoType}.
 *
 * @example
 * ```ts
 * type A = HasNoType<5>; // true
 * type B = HasNoType<Col<number>>; // false
 * ```
 */
export type HasNoType<V> = [V] extends [{ readonly "~expr": unknown }]
  ? [V] extends [NoType]
    ? true
    : false
  : true;

/**
 * {@link NoType} when nothing gives `V` a type, else `unknown`.
 *
 * @example
 * ```ts
 * type A = NoTypeIf<"x">; // NoType
 * ```
 */
export type NoTypeIf<V> = HasNoType<V> extends true ? NoType : unknown;

/**
 * What the operand `O` of a comparison on `S` must also satisfy: when neither has a type,
 * the database compares them as text, so only text may be compared (owner decision of
 * 2026-10-15, option A). An error type then, `unknown` otherwise.
 *
 * @example
 * ```ts
 * declare const ten: Expr<10> & Untyped;
 * // ten.gt(9) does not compile: Comparable<typeof ten, 9> is an error type
 * ```
 */
export type Comparable<S, O> = [S] extends [NoType]
  ? HasNoType<O> extends true
    ? [S] extends [Untyped]
      ? UntypedComparison
      : [UntypedIf<O>] extends [Untyped]
        ? UntypedComparison
        : unknown
    : unknown
  : unknown;

interface UntypedComparison {
  readonly "~error": "neither side of this comparison has a type, so the database would compare them as text: give one a type, val(value, t.integer())";
}

/**
 * `Untyped` when a value given to `val` or a `caseWhen` branch is bound with no type and
 * is not text; nothing (`unknown`) otherwise. A string or `null` is fine untyped: the
 * database reads it as text.
 *
 * @example
 * ```ts
 * type A = UntypedIf<5>; // Untyped
 * type B = UntypedIf<"x">; // unknown
 * ```
 */
export type UntypedIf<V> = [V] extends [{ readonly "~expr": unknown }]
  ? [V] extends [Untyped]
    ? Untyped
    : unknown
  : [V] extends [string | null]
    ? unknown
    : Untyped;

/** Whether `A` and `B` are each assignable to the other: one type for a named parameter. */
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Two sets of named parameters together.
 *
 * @example
 * ```ts
 * type Both = MergeParams<{ minAge: number }, { role: string }>; // { minAge: number; role: string }
 * ```
 */
export type MergeParams<A, B> = Simplify<A & B>;

/**
 * The named parameters an operand brings: those of an expression or a subquery, none for
 * a plain value.
 *
 * @example
 * ```ts
 * type P = ParamsOf<Expr<number, { minAge: number }>>; // { minAge: number }
 * ```
 */
export type ParamsOf<X> = X extends { readonly "~expr": { readonly params: (params: infer Q) => void } }
  ? Q
  : X extends { readonly "~order": { readonly params: (params: infer Q) => void } }
    ? Q
    : X extends SubqueryOperand<unknown, infer Q>
      ? Q
      : NoParams;

/** `true` when some member of the union `X` has unknown named parameters (`SomeParams`). */
type HasSomeParams<X> = true extends (
  X extends unknown
    ? [ParamsOf<X>] extends [never]
      ? true
      : false
    : never
)
  ? true
  : false;

/**
 * The named parameters of every element of a list of operands, together. When any element's
 * parameters are unknown (`SomeParams`, that is `never`), so are the result's: an unknown
 * requirement is never widened to "no parameters".
 *
 * @example
 * ```ts
 * type P = ParamsOfAll<[Expr<number, { a: number }>, string]>; // { a: number }
 * type Q = ParamsOfAll<[Expr<number, SomeParams>, string]>; // never
 * ```
 */
export type ParamsOfAll<A extends readonly unknown[]> = [A[number]] extends [never]
  ? NoParams
  : HasSomeParams<A[number]> extends true
    ? SomeParams
    : AgreedParams<ParamsOf<A[number]>>;

/** The keys of every member of the union `U`. */
type KeysOfUnion<U> = U extends unknown ? keyof U : never;

/** The union of the types the members of `U` that have key `K` give it. */
type TypesAt<U, K> = U extends unknown ? (K extends keyof U ? U[K] : never) : never;

/** `true` when a member of `U` gives key `K` a type other than `T`. */
type Disagrees<U, K, T> = true extends (
  U extends unknown
    ? K extends keyof U
      ? SameType<U[K], T> extends true
        ? false
        : true
      : false
    : never
)
  ? true
  : false;

/**
 * A union of sets of named parameters (one per operand) as one set, with
 * {@link MergeParams}'s rule: a name every operand that uses it gives the same type keeps
 * it, any other is `never`.
 */
type AgreedParams<U> = Simplify<{
  [K in KeysOfUnion<U>]: Disagrees<U, K, TypesAt<U, K>> extends true ? never : TypesAt<U, K>;
}>;

/**
 * The value type of an operand: `T` for an `Expr<T>`, the value's own type otherwise.
 *
 * @example
 * ```ts
 * type V = ValueOf<Expr<string | null>>; // string | null
 * ```
 */
export type ValueOf<X> = X extends { readonly "~expr": { readonly type: infer T } } ? T : X;

/** `null` when `T` admits it. */
type NullOf<T> = null extends T ? null : never;

/** The number type an arithmetic result has: `bigint` stays `bigint`, everything else is `number`. */
type Numeric<T> = NonNullable<T> extends bigint ? bigint : number;

/** The element type of an array type. */
type ElementOf<T> = NonNullable<T> extends readonly (infer E)[] ? E : never;

/**
 * What a comparison or arithmetic operator takes for an expression of type `T`: a non-null
 * value of `T` (bound as a parameter) or an expression of `T`, nullable or not.
 *
 * @example
 * ```ts
 * const operand: Operand<number | null> = 18;
 * ```
 */
export type Operand<T> = NonNullable<T> | Expr<T | null, SomeParams>;

/**
 * Refuses, at compile time, a set of named parameters `X` that uses a name of `P` with
 * another type: {@link Compatible} for parameters that do not come from one operand (the
 * parts of `concat`, a window spec).
 *
 * @example
 * ```ts
 * declare function over<W>(spec: W & CompatibleParams<{ n: number }, ParamsOf<W>>): void;
 * ```
 */
export type CompatibleParams<P, X> = [Clashes<P, X>] extends [never]
  ? unknown
  : { readonly "~error": `the named parameter "${Clashes<P, X> & string}" is used with two types` };

/** The keys two sets of named parameters share with different types. */
type Clashes<A, B> = [A] extends [never]
  ? never
  : [B] extends [never]
    ? never
    : {
        [K in keyof A & keyof B]: [A[K]] extends [B[K]] ? ([B[K]] extends [A[K]] ? never : K) : K;
      }[keyof A & keyof B];

/**
 * Refuses an operand at compile time, by intersecting the parameter type with an error
 * object it cannot satisfy: an operand that is always `null` (`lit(null)`, `val(null)`),
 * and one whose named parameters use a name of this expression's with another type.
 * Otherwise `unknown`, which leaves the parameter type as it is.
 *
 * @example
 * ```ts
 * declare function eq<O extends Operand<number>>(other: O & Checked<NoParams, O>): Expr<boolean>;
 * ```
 */
export type Checked<P, O> = ([ValueOf<O>] extends [null]
  ? { readonly "~error": "null is never equal to anything: use isNull() or isDistinctFrom()" }
  : unknown) &
  Compatible<P, O>;

/**
 * The named-parameter half of {@link Checked}: refuses an operand that uses a parameter
 * name of this expression's with another type.
 *
 * @example
 * ```ts
 * declare function isDistinctFrom<O>(other: O & Compatible<NoParams, O>): Expr<boolean>;
 * ```
 */
export type Compatible<P, O> = [Clashes<P, ParamsOf<O>>] extends [never]
  ? unknown
  : { readonly "~error": `the named parameter "${Clashes<P, ParamsOf<O>> & string}" is used with two types` };

/** What `and`, `or` and `filter` take. */
type BoolOperand = boolean | Expr<boolean | null, SomeParams>;

/** What the text operators take. */
type TextOperand = string | Expr<string | null, SomeParams>;

/** A key of a JSON path: an object key, or an array index. */
type JsonKey = string | number;

/** Types that are never JSON documents, so `path` is refused on them at compile time. */
type NotJson = string | number | bigint | boolean | Date | Uint8Array;

/** `this` for `path` / `pathText`: an expression that may hold a JSON document. */
type JsonExpr<T> = [NonNullable<T>] extends [NotJson] ? never : Expr<T, SomeParams>;

/**
 * The result of `cast`: `U`, nullable when the operand is (an `unknown` operand is not
 * assumed nullable). A cast of something that is always `null` is still always `null`.
 */
type CastResult<T, U> = [T] extends [null] ? null : U | (unknown extends T ? never : NullOf<T>);

// ---------------------------------------------------------------------------
// Subqueries
// ---------------------------------------------------------------------------

/**
 * The method by which a query turns itself into an expression (`(SELECT …)`), so that it
 * can be an operand: `u.id.in(query)`, `exists(query)`. The query builder implements it.
 *
 * @example
 * ```ts
 * class Query {
 *   [AS_SUBQUERY](): Expr<number> {
 *     return subqueryExpr(this.ast);
 *   }
 * }
 * ```
 */
export const AS_SUBQUERY: unique symbol = Symbol.for("egon.asSubquery");

/**
 * Something that can stand as a subquery whose single value is of type `R`, with the
 * named parameters `P`: a query.
 *
 * @example
 * ```ts
 * declare const ids: SubqueryOperand<number, NoParams>;
 * ```
 */
export interface SubqueryOperand<R, P> {
  [AS_SUBQUERY](): Expr<R, P>;
}

/**
 * Whether `value` is a subquery operand: an object with an `[AS_SUBQUERY]` method.
 *
 * @example
 * ```ts
 * isSubqueryOperand(from(Post, "p").select(({ p }) => p.authorId)); // true
 * ```
 */
export function isSubqueryOperand(value: unknown): value is SubqueryOperand<unknown, SomeParams> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { [AS_SUBQUERY]?: unknown })[AS_SUBQUERY] === "function"
  );
}

/**
 * The expression a subquery operand stands for, checked to be one.
 *
 * @example
 * ```ts
 * const sub = subqueryOf(query, "exists");
 * ```
 *
 * @throws QueryError when the operand does not produce a subquery expression.
 */
export function subqueryOf(
  value: SubqueryOperand<unknown, SomeParams>,
  method: string,
): AnyExpr & { readonly node: { readonly kind: "subquery"; readonly query: QueryAst } } {
  const expr = value[AS_SUBQUERY]();
  if (!(expr instanceof Expr) || expr.node.kind !== "subquery") {
    throw new QueryError(`${method}() takes a query, which did not produce a subquery expression.`);
  }
  return expr as AnyExpr & { readonly node: { readonly kind: "subquery"; readonly query: QueryAst } };
}

// ---------------------------------------------------------------------------
// Expr
// ---------------------------------------------------------------------------

/**
 * An expression of any type and any named parameters: what the implementation handles.
 *
 * @example
 * ```ts
 * function describe(expr: AnyExpr): string {
 *   return expr.node.kind;
 * }
 * ```
 */
export type AnyExpr = Expr<unknown, SomeParams>;

/**
 * The shared empty array for `params`, `lists` and `named`. Frozen, never mutated.
 *
 * @example
 * ```ts
 * new Expr(node, undefined, false, NONE, NONE, NONE, shapeOf(node));
 * ```
 */
export const NONE: readonly never[] = Object.freeze([]);

const BOOLEAN: AnyFieldType = booleanType();
const STRING: AnyFieldType = stringType();
const JSON_VALUE: AnyFieldType = jsonType();

/**
 * A typed SQL expression. `T` is the type of its value in TypeScript; `P` the named
 * parameters ({@link param}) it uses, which a query collects so that executing it requires
 * them.
 *
 * Operators are methods. Each exists for the types it fits: `like` on text, `add` on
 * numbers, `contains` on arrays, `path` on JSON, `and` on booleans. Calling one on an
 * expression of another type is a compile error.
 *
 * An expression is immutable: every method returns a new one.
 *
 * @example
 * ```ts
 * const adult: Expr<boolean> = u.age.gte(18).and(u.role.eq("admin"));
 * ```
 */
export class Expr<out T, in P = NoParams> {
  /**
   * Type information only; there is no such property at run time. `params` is a function
   * type so that `P` is contravariant: see {@link SomeParams}.
   */
  declare readonly "~expr": { readonly type: T; readonly params: (params: P) => void };
  /** The AST node. */
  readonly node: ExprNode;
  /** The type the value is loaded with when it is selected, when one is known. */
  readonly type: AnyFieldType | undefined;
  /** Whether a value compared with or assigned to this expression is hidden from logs. */
  readonly redact: boolean;
  /** The bound values of {@link node}, in canonical order. */
  readonly params: readonly unknown[];
  /** The lengths of the lists of {@link node}, in canonical order. */
  readonly lists: readonly number[];
  /** The named parameters of {@link node}, in canonical order (a name may repeat). */
  readonly named: readonly NamedParamNode[];
  /** The structural hash of {@link node} (`shapeOf(node)`). */
  readonly shape: number;

  /**
   * Internal: expressions come from columns, operators and the expression functions.
   *
   * @example
   * ```ts
   * new Expr(node, undefined, false, NONE, NONE, NONE, shapeOf(node));
   * ```
   */
  constructor(
    node: ExprNode,
    type: AnyFieldType | undefined,
    redact: boolean,
    params: readonly unknown[],
    lists: readonly number[],
    named: readonly NamedParamNode[],
    shape: number,
  ) {
    this.node = node;
    this.type = type;
    this.redact = redact;
    this.params = params;
    this.lists = lists;
    this.named = named;
    this.shape = shape;
  }

  // --- comparison -----------------------------------------------------------

  /**
   * `=`. A value becomes a bound parameter with this expression's type. `null` is refused:
   * use {@link isNull}.
   *
   * @example
   * ```ts
   * u.email.eq("ada@example.com");
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  eq<S extends AnyExpr, O extends Operand<T>>(
    this: S,
    other: O & Checked<P, O> & Comparable<S, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return compare("eq", this, other) as never;
  }

  /**
   * `<>`.
   *
   * @example
   * ```ts
   * u.role.neq("admin");
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  neq<S extends AnyExpr, O extends Operand<T>>(
    this: S,
    other: O & Checked<P, O> & Comparable<S, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return compare("neq", this, other) as never;
  }

  /**
   * `>`.
   *
   * @example
   * ```ts
   * u.age.gt(17);
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  gt<S extends AnyExpr, O extends Operand<T>>(
    this: S,
    other: O & Checked<P, O> & Comparable<S, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return compare("gt", this, other) as never;
  }

  /**
   * `>=`.
   *
   * @example
   * ```ts
   * u.age.gte(18);
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  gte<S extends AnyExpr, O extends Operand<T>>(
    this: S,
    other: O & Checked<P, O> & Comparable<S, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return compare("gte", this, other) as never;
  }

  /**
   * `<`.
   *
   * @example
   * ```ts
   * p.createdAt.lt(new Date());
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  lt<S extends AnyExpr, O extends Operand<T>>(
    this: S,
    other: O & Checked<P, O> & Comparable<S, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return compare("lt", this, other) as never;
  }

  /**
   * `<=`.
   *
   * @example
   * ```ts
   * u.age.lte(65);
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  lte<S extends AnyExpr, O extends Operand<T>>(
    this: S,
    other: O & Checked<P, O> & Comparable<S, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return compare("lte", this, other) as never;
  }

  /**
   * `BETWEEN low AND high`, both ends included.
   *
   * @example
   * ```ts
   * u.age.between(18, 65);
   * ```
   *
   * @throws QueryError when either end is `null` or `undefined`.
   */
  between<S extends AnyExpr, L extends Operand<T>, H extends Operand<T>>(
    this: S,
    low: L & Checked<P, L> & Comparable<S, L>,
    high: H & Checked<MergeParams<P, ParamsOf<L>>, H> & Comparable<S, H>,
  ): Expr<boolean, MergeParams<P, MergeParams<ParamsOf<L>, ParamsOf<H>>>> {
    const lowExpr = toOperand(low, this.type, this.redact, "between", true);
    const highExpr = toOperand(high, this.type, this.redact, "between", true);
    const self: AnyExpr = lowExpr.redact || highExpr.redact ? redacted(this) : this;
    return new Expr(
      betweenNode(self.node, lowExpr.node, highExpr.node),
      BOOLEAN,
      false,
      join(join(self.params, lowExpr.params), highExpr.params),
      join(join(self.lists, lowExpr.lists), highExpr.lists),
      joinNamed(joinNamed(self.named, lowExpr.named), highExpr.named),
      shapeOfBetween(self.shape, lowExpr.shape, highExpr.shape),
    ) as never;
  }

  /**
   * `= ANY($1)` (or `IN (…)`): one bound list, a column or expression of array type, or
   * a query. An empty list is `false`, without a parameter.
   *
   * @example
   * ```ts
   * u.role.in(["admin", "member"]);
   * ```
   *
   * @throws QueryError when the list holds `null` or `undefined`, or the argument is not a list, an expression or a query.
   */
  in<S extends AnyExpr, O extends InOperand<T>>(
    this: S,
    values: O & Checked<P, O> & Comparable<S, O extends readonly (infer E)[] ? E : O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return membership("in", this, values) as never;
  }

  /**
   * The negation of {@link in}. An empty list is `true`.
   *
   * @example
   * ```ts
   * u.role.notIn(["admin"]);
   * ```
   *
   * @throws QueryError when the list holds `null` or `undefined`, or the argument is not a list, an expression or a query.
   */
  notIn<S extends AnyExpr, O extends InOperand<T>>(
    this: S,
    values: O & Checked<P, O> & Comparable<S, O extends readonly (infer E)[] ? E : O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return membership("notIn", this, values) as never;
  }

  /**
   * `IS NULL`.
   *
   * @example
   * ```ts
   * u.name.isNull();
   * ```
   */
  isNull(): Expr<boolean, P> {
    return unary("isNull", this, BOOLEAN, false) as never;
  }

  /**
   * `IS NOT NULL`.
   *
   * @example
   * ```ts
   * u.name.isNotNull();
   * ```
   */
  isNotNull(): Expr<boolean, P> {
    return unary("isNotNull", this, BOOLEAN, false) as never;
  }

  /**
   * `IS DISTINCT FROM`: inequality that treats `null` as a value, so `null` is accepted.
   *
   * @example
   * ```ts
   * u.name.isDistinctFrom(u.email);
   * ```
   *
   * @throws QueryError when given `undefined`.
   */
  isDistinctFrom<S extends AnyExpr, O extends Operand<T> | null>(
    this: S,
    other: O & Compatible<P, O> & Comparable<S, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return operate(
      "isDistinctFrom",
      this,
      other,
      this.type,
      this.redact,
      BOOLEAN,
      false,
      "isDistinctFrom",
      true,
    );
  }

  // --- boolean --------------------------------------------------------------

  /**
   * `AND`. Chained calls make one flat `a AND b AND c`.
   *
   * @example
   * ```ts
   * u.age.gte(18).and(u.role.eq("admin"));
   * ```
   *
   * @throws QueryError when given anything but a boolean or a boolean expression.
   */
  and<O extends BoolOperand>(
    this: Expr<boolean | null, SomeParams>,
    other: O & Checked<P, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return logical("and", this, other) as never;
  }

  /**
   * `OR`. Chained calls make one flat `a OR b OR c`.
   *
   * @example
   * ```ts
   * u.role.eq("admin").or(u.age.gte(65));
   * ```
   *
   * @throws QueryError when given anything but a boolean or a boolean expression.
   */
  or<O extends BoolOperand>(
    this: Expr<boolean | null, SomeParams>,
    other: O & Checked<P, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return logical("or", this, other) as never;
  }

  /**
   * `NOT`.
   *
   * @example
   * ```ts
   * p.published.not();
   * ```
   */
  not(this: Expr<boolean | null, SomeParams>): Expr<boolean, P> {
    return unary("not", this, BOOLEAN, false) as never;
  }

  // --- text -----------------------------------------------------------------

  /**
   * `LIKE`: `%` matches any run of characters, `_` one character.
   *
   * @example
   * ```ts
   * u.email.like("%@example.com");
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  like<O extends TextOperand>(
    this: Expr<string | null, SomeParams>,
    pattern: O & Checked<P, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return operate("like", this, pattern, STRING, this.redact, BOOLEAN, false, "like", false, true);
  }

  /**
   * `NOT LIKE`.
   *
   * @example
   * ```ts
   * u.email.notLike("%@example.com");
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  notLike<O extends TextOperand>(
    this: Expr<string | null, SomeParams>,
    pattern: O & Checked<P, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return operate("notLike", this, pattern, STRING, this.redact, BOOLEAN, false, "notLike", false, true);
  }

  /**
   * `ILIKE`: `LIKE` ignoring case.
   *
   * @example
   * ```ts
   * u.name.ilike("%ann%");
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  ilike<O extends TextOperand>(
    this: Expr<string | null, SomeParams>,
    pattern: O & Checked<P, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return operate("ilike", this, pattern, STRING, this.redact, BOOLEAN, false, "ilike", false, true);
  }

  /**
   * `||`: text joined together. `null` anywhere makes the result `null`.
   *
   * @example
   * ```ts
   * u.firstName.concat(" ", u.lastName);
   * ```
   *
   * @throws QueryError when a part is `null` or `undefined`, or no part is given.
   */
  concat<S extends string | null, const A extends readonly TextOperand[]>(
    this: Expr<S, SomeParams>,
    ...parts: A & CompatibleParams<P, ParamsOfAll<A>>
  ): Expr<string | NullOf<S> | NullOf<ValueOf<A[number]>>, MergeParams<P, ParamsOfAll<A>>> {
    if (parts.length === 0) throw new QueryError("concat() needs at least one part to append.");
    let result: AnyExpr = this;
    for (const part of parts) {
      result = operate("concat", result, part, STRING, this.redact, STRING, this.redact, "concat", false);
    }
    return result as never;
  }

  /**
   * `lower(x)`.
   *
   * @example
   * ```ts
   * u.email.lower().eq("ada@example.com");
   * ```
   */
  lower<S extends string | null>(this: Expr<S, SomeParams>): Expr<string | NullOf<S>, P> {
    return call("lower", this, STRING, this.redact) as never;
  }

  /**
   * `upper(x)`.
   *
   * @example
   * ```ts
   * u.email.upper();
   * ```
   */
  upper<S extends string | null>(this: Expr<S, SomeParams>): Expr<string | NullOf<S>, P> {
    return call("upper", this, STRING, this.redact) as never;
  }

  // --- arithmetic -----------------------------------------------------------

  /**
   * `+`. The result keeps the operand's type and is nullable when either side is.
   *
   * @example
   * ```ts
   * u.loginCount.add(1);
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  add<S extends number | bigint | null, O extends Operand<S>>(
    this: Expr<S, SomeParams>,
    other: O & Checked<P, O>,
  ): Expr<Numeric<S> | NullOf<S> | NullOf<ValueOf<O>>, MergeParams<P, ParamsOf<O>>> {
    return arithmetic("add", this, other);
  }

  /**
   * `-`.
   *
   * @example
   * ```ts
   * p.views.sub(1);
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  sub<S extends number | bigint | null, O extends Operand<S>>(
    this: Expr<S, SomeParams>,
    other: O & Checked<P, O>,
  ): Expr<Numeric<S> | NullOf<S> | NullOf<ValueOf<O>>, MergeParams<P, ParamsOf<O>>> {
    return arithmetic("sub", this, other);
  }

  /**
   * `*`.
   *
   * @example
   * ```ts
   * p.views.mul(2);
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  mul<S extends number | bigint | null, O extends Operand<S>>(
    this: Expr<S, SomeParams>,
    other: O & Checked<P, O>,
  ): Expr<Numeric<S> | NullOf<S> | NullOf<ValueOf<O>>, MergeParams<P, ParamsOf<O>>> {
    return arithmetic("mul", this, other);
  }

  /**
   * `/`. Between two integers the database divides as integers.
   *
   * @example
   * ```ts
   * p.views.div(2);
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  div<S extends number | bigint | null, O extends Operand<S>>(
    this: Expr<S, SomeParams>,
    other: O & Checked<P, O>,
  ): Expr<Numeric<S> | NullOf<S> | NullOf<ValueOf<O>>, MergeParams<P, ParamsOf<O>>> {
    return arithmetic("div", this, other);
  }

  /**
   * `%`: the remainder.
   *
   * @example
   * ```ts
   * u.id.mod(2).eq(0);
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  mod<S extends number | bigint | null, O extends Operand<S>>(
    this: Expr<S, SomeParams>,
    other: O & Checked<P, O>,
  ): Expr<Numeric<S> | NullOf<S> | NullOf<ValueOf<O>>, MergeParams<P, ParamsOf<O>>> {
    return arithmetic("mod", this, other);
  }

  /**
   * Unary `-`.
   *
   * @example
   * ```ts
   * p.views.neg();
   * ```
   */
  neg<S extends number | bigint | null>(this: Expr<S, SomeParams>): Expr<Numeric<S> | NullOf<S>, P> {
    return unary("neg", this, this.type, this.redact) as never;
  }

  // --- arrays ---------------------------------------------------------------

  /**
   * `@>`: the array holds every element of `values`.
   *
   * @example
   * ```ts
   * p.tagList.contains(["ts"]);
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  contains<O extends Operand<T>>(
    this: Expr<readonly unknown[] | null, SomeParams>,
    values: O & Checked<P, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return operate("contains", this, values, this.type, this.redact, BOOLEAN, false, "contains", false);
  }

  /**
   * `<@`: every element of the array is in `values`.
   *
   * @example
   * ```ts
   * p.tagList.containedBy(["ts", "sql"]);
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  containedBy<O extends Operand<T>>(
    this: Expr<readonly unknown[] | null, SomeParams>,
    values: O & Checked<P, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return operate("containedBy", this, values, this.type, this.redact, BOOLEAN, false, "containedBy", false);
  }

  /**
   * `&&`: the arrays share an element.
   *
   * @example
   * ```ts
   * p.tagList.overlaps(["ts", "sql"]);
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  overlaps<O extends Operand<T>>(
    this: Expr<readonly unknown[] | null, SomeParams>,
    values: O & Checked<P, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return operate("overlaps", this, values, this.type, this.redact, BOOLEAN, false, "overlaps", false);
  }

  /**
   * `element = ANY(array)`: the array holds `element`.
   *
   * @example
   * ```ts
   * p.tagList.has("ts");
   * ```
   *
   * @throws QueryError when given `null` or `undefined`.
   */
  has<S extends readonly unknown[] | null, O extends Operand<ElementOf<S>>>(
    this: Expr<S, SomeParams>,
    element: O & Checked<P, O>,
  ): Expr<boolean, MergeParams<P, ParamsOf<O>>> {
    return operate(
      "has",
      this,
      element,
      elementType(this.type),
      this.redact,
      BOOLEAN,
      false,
      "has",
      false,
      true,
    );
  }

  /**
   * `array_append(array, element)`: the array with `element` added at the end. Appending
   * to a `null` array gives a one-element array. For bulk updates: `.set(({ p }) => ({ tagList: p.tagList.append("ts") }))`.
   *
   * @example
   * ```ts
   * p.tagList.append("ts");
   * ```
   *
   * @throws QueryError when given `undefined`.
   */
  append<S extends readonly unknown[] | null, O extends Operand<ElementOf<S>> | null>(
    this: Expr<S, SomeParams>,
    element: O & Compatible<P, O>,
  ): Expr<NonNullable<S>, MergeParams<P, ParamsOf<O>>> {
    return call2(
      "arrayAppend",
      this,
      toOperand(element, elementType(this.type), this.redact, "append", false, true),
    );
  }

  /**
   * `array_remove(array, element)`: the array without any element equal to `element`.
   *
   * @example
   * ```ts
   * p.tagList.remove("draft");
   * ```
   *
   * @throws QueryError when given `undefined`.
   */
  remove<S extends readonly unknown[] | null, O extends Operand<ElementOf<S>> | null>(
    this: Expr<S, SomeParams>,
    element: O & Compatible<P, O>,
  ): Expr<S, MergeParams<P, ParamsOf<O>>> {
    return call2(
      "arrayRemove",
      this,
      toOperand(element, elementType(this.type), this.redact, "remove", false, true),
    );
  }

  // --- JSON -----------------------------------------------------------------

  /**
   * `#>`: the JSON value at a path of keys (and array indexes). Each key is a bound
   * parameter. The result is JSON of unknown shape: give it a type with `cast` or `as`.
   *
   * @example
   * ```ts
   * u.settings.path("theme");
   * u.settings.path("limits", 0).cast(t.integer());
   * ```
   *
   * @throws QueryError when no key is given, a key is not a string or a whole number, or
   * the expression has a known type that is not JSON.
   */
  path(this: JsonExpr<T>, ...keys: readonly [JsonKey, ...JsonKey[]]): Expr<unknown, P> {
    return jsonPath(this as AnyExpr, keys, false, JSON_VALUE, "path") as never;
  }

  /**
   * `#>>`: the value at a path of keys, as text (`null` when there is nothing there).
   *
   * @example
   * ```ts
   * u.settings.pathText("theme").eq("dark");
   * ```
   *
   * @throws QueryError when no key is given, a key is not a string or a whole number, or
   * the expression has a known type that is not JSON.
   */
  pathText(this: JsonExpr<T>, ...keys: readonly [JsonKey, ...JsonKey[]]): Expr<string | null, P> {
    return jsonPath(this as AnyExpr, keys, true, STRING, "pathText") as never;
  }

  // --- typing ---------------------------------------------------------------

  /**
   * `CAST(x AS type)`, where `type` is a field type: `t.integer()`, `t.string()`. The
   * result is loaded with that type. A nullable operand gives a nullable result.
   *
   * @example
   * ```ts
   * u.age.cast(t.string());
   * sum(p.views).cast(t.bigint());
   * ```
   *
   * @throws QueryError when `type` is not a field type.
   */
  cast<S, U, F extends FieldFlags>(
    this: Expr<S, SomeParams>,
    type: FieldBuilder<U, F>,
  ): Expr<CastResult<S, U>, P> {
    const target = typeArgument(type, "cast");
    return new Expr(
      castNode(this.node, target),
      target,
      this.redact,
      this.params,
      this.lists,
      this.named,
      shapeOfCast(this.shape, target),
    ) as never;
  }

  /**
   * Gives the expression another TypeScript type. No SQL: it is an assertion, so it is
   * only as right as you make it.
   *
   * @example
   * ```ts
   * fragment`lower(${u.email})`.as<string>();
   * ```
   */
  as<U>(): Expr<U, P> {
    return this as never;
  }

  // --- ordering -------------------------------------------------------------

  /**
   * Ascending order (`ASC`).
   *
   * @example
   * ```ts
   * u.name.asc().nullsLast();
   * ```
   */
  asc(): OrderExpr<P> {
    return new OrderExpr(
      orderNode(this.node, "asc", undefined),
      this.params,
      this.lists,
      this.named,
      shapeOfOrder(this.shape, "asc", undefined),
      this.shape,
    );
  }

  /**
   * Descending order (`DESC`).
   *
   * @example
   * ```ts
   * u.createdAt.desc().nullsLast();
   * ```
   */
  desc(): OrderExpr<P> {
    return new OrderExpr(
      orderNode(this.node, "desc", undefined),
      this.params,
      this.lists,
      this.named,
      shapeOfOrder(this.shape, "desc", undefined),
      this.shape,
    );
  }
}

/** What `in` and `notIn` take for an expression of type `T`. */
type InOperand<T> =
  | readonly NonNullable<T>[]
  | Expr<readonly (T | null)[] | null, SomeParams>
  | SubqueryOperand<T | null, SomeParams>;

/**
 * A column of a binding: `u.email`. Query bindings hold one per field, made once per
 * schema and alias.
 *
 * @example
 * ```ts
 * const email = new Col<string>("u", meta(User).fieldsByName.get("email"));
 * ```
 */
export class Col<T> extends Expr<T, NoParams> {
  /** The alias of the binding. */
  readonly binding: string;
  /** The field the column belongs to. */
  readonly field: FieldMeta;

  /**
   * Internal: columns are made by the query builder's bindings.
   *
   * @example
   * ```ts
   * new Col("u", field);
   * ```
   */
  constructor(binding: string, field: FieldMeta) {
    super(
      columnNode(binding, field.name, field.column),
      field.type,
      field.redact,
      NONE,
      NONE,
      NONE,
      shapeOfColumn(binding, field.column),
    );
    this.binding = binding;
    this.field = field;
  }
}

/**
 * One `ORDER BY` item: `u.createdAt.desc().nullsLast()`.
 *
 * @example
 * ```ts
 * const newestFirst: OrderExpr = u.createdAt.desc();
 * ```
 */
export class OrderExpr<in P = NoParams> {
  /** Type information only; there is no such property at run time. */
  declare readonly "~order": { readonly params: (params: P) => void };
  /** The AST node. */
  readonly node: OrderNode;
  /** The bound values of {@link node}, in canonical order. */
  readonly params: readonly unknown[];
  /** The lengths of the lists of {@link node}, in canonical order. */
  readonly lists: readonly number[];
  /** The named parameters of {@link node}, in canonical order. */
  readonly named: readonly NamedParamNode[];
  /** The structural hash of {@link node}. */
  readonly shape: number;
  /** The structural hash of the ordered expression. */
  readonly exprShape: number;

  /**
   * Internal: order items come from `asc()` and `desc()`.
   *
   * @example
   * ```ts
   * new OrderExpr(node, NONE, NONE, NONE, shape, exprShape);
   * ```
   */
  constructor(
    node: OrderNode,
    params: readonly unknown[],
    lists: readonly number[],
    named: readonly NamedParamNode[],
    shape: number,
    exprShape: number,
  ) {
    this.node = node;
    this.params = params;
    this.lists = lists;
    this.named = named;
    this.shape = shape;
    this.exprShape = exprShape;
  }

  /**
   * `NULLS FIRST`.
   *
   * @example
   * ```ts
   * u.name.asc().nullsFirst();
   * ```
   */
  nullsFirst(): OrderExpr<P> {
    return this.withNulls("first");
  }

  /**
   * `NULLS LAST`.
   *
   * @example
   * ```ts
   * u.createdAt.desc().nullsLast();
   * ```
   */
  nullsLast(): OrderExpr<P> {
    return this.withNulls("last");
  }

  private withNulls(nulls: "first" | "last"): OrderExpr<P> {
    const { expr, direction } = this.node;
    return new OrderExpr(
      orderNode(expr, direction, nulls),
      this.params,
      this.lists,
      this.named,
      shapeOfOrder(this.exprShape, direction, nulls),
      this.exprShape,
    );
  }
}

/**
 * Whether `value` is an expression.
 *
 * @example
 * ```ts
 * isExpr(u.age.gte(18)); // true
 * isExpr(18); // false
 * ```
 */
export function isExpr(value: unknown): value is AnyExpr {
  return value instanceof Expr;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Two arrays one after the other, without copying when either is empty.
 *
 * @example
 * ```ts
 * join(left.params, right.params);
 * ```
 */
export function join<V>(a: readonly V[], b: readonly V[]): readonly V[] {
  const left = a.length;
  if (left === 0) return b;
  const right = b.length;
  if (right === 0) return a;
  // A copy loop: faster than concat for the short arrays expressions hold.
  const out = new Array<V>(left + right);
  for (let i = 0; i < left; i++) out[i] = a[i] as V;
  for (let i = 0; i < right; i++) out[left + i] = b[i] as V;
  return out;
}

function appendOne<V>(a: readonly V[], value: V): readonly V[] {
  const length = a.length;
  if (length === 0) return [value];
  const out = new Array<V>(length + 1);
  for (let i = 0; i < length; i++) out[i] = a[i] as V;
  out[length] = value;
  return out;
}

/**
 * The named parameters of two expressions together. A name used with two different types
 * is refused: the query could never be given one value for both.
 *
 * @example
 * ```ts
 * joinNamed(left.named, right.named);
 * ```
 *
 * @throws QueryError when one name has two types.
 */
export function joinNamed(
  a: readonly NamedParamNode[],
  b: readonly NamedParamNode[],
): readonly NamedParamNode[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  for (const x of a) {
    for (const y of b) {
      if (x.name === y.name && (x.type !== y.type || NULLABLE_PARAMS.has(x) !== NULLABLE_PARAMS.has(y))) {
        const left = namedTypeName(x);
        const right = namedTypeName(y);
        throw new QueryError(
          `The named parameter "${x.name}" is used with two types, ${left} and ${left === right ? `another ${right} type (other values or options)` : right}. A named parameter has one type: give the other use its own name.`,
        );
      }
    }
  }
  return join(a, b);
}

/**
 * The named-parameter nodes declared with a nullable field type (`param("n",
 * t.integer().nullable())`). Kept beside the node, not on it: `NamedParamNode` is a
 * contract shape. A node is added once, when `param` makes it.
 *
 * @example
 * ```ts
 * NULLABLE_PARAMS.has(param("n", t.integer().nullable()).named[0]); // true
 * ```
 */
export const NULLABLE_PARAMS: WeakSet<NamedParamNode> = new WeakSet();

function namedTypeName(node: NamedParamNode): string {
  const name = node.type?.name ?? "untyped";
  return NULLABLE_PARAMS.has(node) ? `${name} | null` : name;
}

/**
 * The type a field builder names, for functions that take one (`cast`, `val`, `param`).
 *
 * @example
 * ```ts
 * typeArgument(t.integer(), "param").name; // "integer"
 * ```
 *
 * @throws QueryError when `value` is not a field builder.
 */
export function typeArgument(value: unknown, method: string): AnyFieldType {
  const state = fieldState(value);
  if (state === undefined) {
    throw new QueryError(
      `${method}() takes a field type such as t.integer() or t.string() to name the type.`,
    );
  }
  return state.type;
}

function elementType(type: AnyFieldType | undefined): AnyFieldType | undefined {
  return type === undefined ? undefined : elementTypeOf(type);
}

function nullOperand(method: string, comparison: boolean): QueryError {
  return comparison
    ? new QueryError(
        `${method}() was given null. A comparison with null is always unknown in SQL, so it would match nothing: use isNull() or isNotNull(), or isDistinctFrom() to compare treating null as a value.`,
      )
    : new QueryError(`${method}() was given null, which it cannot take.`);
}

/**
 * Whether an expression is always `null`: `lit(null)`, `val(null)`, or either of them cast.
 *
 * @example
 * ```ts
 * isNullOperand(val(null).cast(t.integer())); // true
 * ```
 */
export function isNullOperand(expr: AnyExpr): boolean {
  let node = expr.node;
  while (node.kind === "cast") node = node.expr;
  return (node.kind === "param" || node.kind === "literal") && node.value === null;
}

/**
 * An operand as an expression: an expression as it is, a value as a bound parameter of
 * `type`. A parameter given as an expression (`val(x)`, `param(…)`) takes `redact` from the
 * other side, as a plain value does. Unless `allowNull`, an operand that is `null` is
 * refused, whether a plain `null` or an expression that is always `null`.
 *
 * @example
 * ```ts
 * toOperand(18, u.age.type, u.age.redact, "gte", true);
 * ```
 *
 * @throws QueryError when `value` is `undefined`, or `null` unless `allowNull`.
 */
export function toOperand(
  value: unknown,
  type: AnyFieldType | undefined,
  redact: boolean,
  method: string,
  comparison: boolean,
  allowNull = false,
): AnyExpr {
  if (value instanceof Expr) {
    if (!allowNull && isNullOperand(value)) throw nullOperand(method, comparison);
    return redact ? redacted(value) : value;
  }
  if (value === undefined) {
    throw new QueryError(
      allowNull
        ? `${method}() was given undefined, which is not a value. Pass null for SQL NULL.`
        : `${method}() was given undefined, which is not a value.`,
    );
  }
  if (value === null && !allowNull) throw nullOperand(method, comparison);
  return new Expr(
    paramNode(value, type, redact),
    type,
    redact,
    [value],
    NONE,
    NONE,
    shapeOfParam(type, redact),
  );
}

/** The functions whose result is made of their arguments' values, so a secret argument makes a secret result. */
const VALUE_FUNCTIONS: ReadonlySet<string> = new Set([
  "lower",
  "upper",
  "coalesce",
  "arrayAppend",
  "arrayRemove",
]);
/** The binary operators whose result is made of their operands' values. */
const VALUE_OPERATORS: ReadonlySet<string> = new Set(["add", "sub", "mul", "div", "mod", "concat"]);

/**
 * `node` with every parameter it carries a value through marked `redact`: a bare parameter,
 * and the parameters under value-preserving wrappers (`cast`, unary `-`, `lower`, `upper`,
 * `coalesce`, the array functions, arithmetic, `concat`, a JSON path's value, the results
 * and `ELSE` of a `CASE`). Comparisons, `CASE` conditions, aggregates and subqueries are not
 * entered: they are not the value. Nor is a fragment: its SQL is unknown, so its arguments
 * are deliberately left as they are (mark one with `val(x)` beside the field instead). The
 * same node object when nothing changes.
 */
function redactNode(node: ExprNode): ExprNode {
  switch (node.kind) {
    case "param":
      return node.redact ? node : paramNode(node.value, node.type, true);
    case "namedParam": {
      if (node.redact) return node;
      const marked = namedParamNode(node.name, node.type, true);
      if (NULLABLE_PARAMS.has(node)) NULLABLE_PARAMS.add(marked);
      return marked;
    }
    case "cast": {
      const inner = redactNode(node.expr);
      return inner === node.expr ? node : castNode(inner, node.type);
    }
    case "unary": {
      if (node.op !== "neg") return node;
      const inner = redactNode(node.operand);
      return inner === node.operand ? node : unaryNode(node.op, inner);
    }
    case "fn": {
      if (!VALUE_FUNCTIONS.has(node.name)) return node;
      let changed = false;
      const args = node.args.map((arg) => {
        const marked = redactNode(arg);
        if (marked !== arg) changed = true;
        return marked;
      });
      return changed ? fnNode(node.name, args) : node;
    }
    case "binary": {
      if (!VALUE_OPERATORS.has(node.op)) return node;
      const left = redactNode(node.left);
      const right = redactNode(node.right);
      return left === node.left && right === node.right ? node : binaryNode(node.op, left, right);
    }
    case "jsonPath": {
      const inner = redactNode(node.expr);
      return inner === node.expr ? node : jsonPathNode(inner, node.path, node.asText);
    }
    case "case": {
      // The branch results and the ELSE are the value; the conditions are not.
      let changed = false;
      const whens = node.whens.map((branch) => {
        const result = redactNode(branch.result);
        if (result === branch.result) return branch;
        changed = true;
        return { when: branch.when, result };
      });
      const otherwise = node.else === undefined ? undefined : redactNode(node.else);
      return changed || otherwise !== node.else ? caseNode(whens, otherwise) : node;
    }
    default:
      return node;
  }
}

/**
 * The same expression with the parameters it carries a value through marked `redact`
 * (see `redactNode`): `val(x)`, `param(…)`, and either under `cast`, `lower()`, arithmetic,
 * `concat` and the like. The expression itself when there is nothing to mark. Used where a
 * value meets a redacted field, so it is not on the path of ordinary comparisons.
 *
 * @example
 * ```ts
 * redacted(val("secret").cast(t.string())).node; // cast(param "secret", redact: true)
 * ```
 */
export function redacted(value: AnyExpr): AnyExpr {
  const node = redactNode(value.node);
  if (node === value.node) return value;
  const named: NamedParamNode[] = [];
  collectParams(node, [], undefined, named);
  return new Expr(
    node,
    value.type,
    value.redact,
    value.params,
    value.lists,
    named.length === 0 ? NONE : named,
    shapeOf(node),
  );
}

/** A comparison: the operand takes the left side's type and `redact`; `null` is refused. */
function compare(op: BinaryOp, left: AnyExpr, right: unknown): AnyExpr {
  return operate(op, left, right, left.type, left.redact, BOOLEAN, false, op, false, true);
}

function arithmetic<R>(op: BinaryOp, left: AnyExpr, right: unknown): R {
  return operate(op, left, right, left.type, left.redact, left.type, left.redact, op, false);
}

/**
 * A binary operation whose right side is an operand. A plain value takes the fast path:
 * one parameter node, no intermediate expression. When the right side is redacted and the
 * left one is a bare parameter (`val(x).eq(u.passwordHash)`), the left one is redacted too.
 */
function operate<R>(
  op: BinaryOp,
  left: AnyExpr,
  right: unknown,
  operandType: AnyFieldType | undefined,
  operandRedact: boolean,
  type: AnyFieldType | undefined,
  redact: boolean,
  method: string,
  allowNull: boolean,
  comparison = false,
): R {
  if (right instanceof Expr || right === null || right === undefined) {
    const operand = toOperand(right, operandType, operandRedact, method, comparison, allowNull);
    const first = operand.redact ? redacted(left) : left;
    return new Expr(
      binaryNode(op, first.node, operand.node),
      type,
      redact,
      join(first.params, operand.params),
      join(first.lists, operand.lists),
      joinNamed(first.named, operand.named),
      shapeOfBinary(op, first.shape, operand.shape),
    ) as R;
  }
  return new Expr(
    binaryNode(op, left.node, paramNode(right, operandType, operandRedact)),
    type,
    redact,
    appendOne(left.params, right),
    left.lists,
    left.named,
    shapeOfBinary(op, left.shape, shapeOfParam(operandType, operandRedact)),
  ) as R;
}

function unary(
  op: "not" | "neg" | "isNull" | "isNotNull",
  operand: AnyExpr,
  type: AnyFieldType | undefined,
  redact: boolean,
): AnyExpr {
  return new Expr(
    unaryNode(op, operand.node),
    type,
    redact,
    operand.params,
    operand.lists,
    operand.named,
    shapeOfUnary(op, operand.shape),
  );
}

/** A one-argument function call. */
function call(name: string, arg: AnyExpr, type: AnyFieldType | undefined, redact: boolean): AnyExpr {
  return new Expr(
    fnNode(name, [arg.node]),
    type,
    redact,
    arg.params,
    arg.lists,
    arg.named,
    foldShape(startFn(name), arg.shape),
  );
}

/** A two-argument function call that keeps the first argument's type. */
function call2<R>(name: string, first: AnyExpr, second: AnyExpr): R {
  return new Expr(
    fnNode(name, [first.node, second.node]),
    first.type,
    first.redact,
    join(first.params, second.params),
    join(first.lists, second.lists),
    joinNamed(first.named, second.named),
    foldShape(foldShape(startFn(name), first.shape), second.shape),
  ) as R;
}

/**
 * An `and`/`or` operand as an expression: a boolean expression, or `true`/`false` bound
 * as a boolean parameter.
 *
 * @example
 * ```ts
 * booleanOperand(p.published, "and");
 * ```
 *
 * @throws QueryError for anything else.
 */
export function booleanOperand(value: unknown, method: string): AnyExpr {
  if (value instanceof Expr) return value;
  if (typeof value === "boolean") {
    return new Expr(
      paramNode(value, BOOLEAN, false),
      BOOLEAN,
      false,
      [value],
      NONE,
      NONE,
      shapeOfParam(BOOLEAN, false),
    );
  }
  throw new QueryError(`${method}() takes a boolean expression, such as u.age.gte(18), or true or false.`);
}

function logical(op: "and" | "or", left: AnyExpr, right: unknown): AnyExpr {
  const operand = booleanOperand(right, op);
  const node = left.node;
  const params = join(left.params, operand.params);
  const lists = join(left.lists, operand.lists);
  const named = joinNamed(left.named, operand.named);
  if (node.kind === "nary" && node.op === op) {
    const args = node.args.slice();
    args.push(operand.node);
    return new Expr(
      naryNode(op, args),
      BOOLEAN,
      false,
      params,
      lists,
      named,
      foldShape(left.shape, operand.shape),
    );
  }
  return new Expr(
    naryNode(op, [node, operand.node]),
    BOOLEAN,
    false,
    params,
    lists,
    named,
    foldShape(foldShape(startNary(op), left.shape), operand.shape),
  );
}

const FALSE: AnyExpr = new Expr(literalNode(false), BOOLEAN, false, NONE, NONE, NONE, shapeOfLiteral(false));
const TRUE: AnyExpr = new Expr(literalNode(true), BOOLEAN, false, NONE, NONE, NONE, shapeOfLiteral(true));

/**
 * The literal `true` or `false` as an expression. Shared: expressions are immutable.
 *
 * @example
 * ```ts
 * booleanLiteral(true).node; // { kind: "literal", value: true }
 * ```
 */
export function booleanLiteral(value: boolean): AnyExpr {
  return value ? TRUE : FALSE;
}

/**
 * `x IN ()`: `FALSE` (and `x NOT IN ()`: `TRUE`), whatever `x` is. When `x` uses named
 * parameters they stay in the query, so that its type and its tree agree on the parameters
 * it needs: `FALSE AND x IS NULL` (`TRUE OR x IS NULL`), which is still false (true).
 */
function emptyMembership(op: "in" | "notIn", left: AnyExpr): AnyExpr {
  const constant = op === "in" ? FALSE : TRUE;
  if (left.named.length === 0) return constant;
  const connective = op === "in" ? "and" : "or";
  const isNull = unaryNode("isNull", left.node);
  return new Expr(
    naryNode(connective, [constant.node, isNull]),
    BOOLEAN,
    false,
    left.params,
    left.lists,
    left.named,
    foldShape(foldShape(startNary(connective), constant.shape), shapeOfUnary("isNull", left.shape)),
  );
}

function membership(op: "in" | "notIn", left: AnyExpr, values: unknown): AnyExpr {
  if (Array.isArray(values)) {
    const length = values.length;
    if (length === 0) return emptyMembership(op, left);
    // A copy, so that changing the caller's array later cannot change the query, and so
    // that `lists` keeps matching the list.
    const copy = new Array<unknown>(length);
    for (let i = 0; i < length; i++) {
      const value: unknown = values[i];
      if (value === undefined) {
        throw new QueryError(`${op}() was given a list holding undefined, which is not a value.`);
      }
      if (value === null) {
        throw new QueryError(
          `${op}() was given a list holding null. x ${op === "in" ? "IN" : "NOT IN"} (…, NULL) never matches the null: filter it out and add isNull() separately.`,
        );
      }
      copy[i] = value;
    }
    return new Expr(
      binaryNode(op, left.node, listNode(copy, left.type, left.redact)),
      BOOLEAN,
      false,
      appendOne(left.params, copy),
      appendOne(left.lists, length),
      left.named,
      shapeOfBinary(op, left.shape, shapeOfList(left.type, left.redact)),
    );
  }
  let right: AnyExpr;
  if (values instanceof Expr) {
    if (isNullOperand(values)) throw nullOperand(op, true);
    right = left.redact ? redacted(values) : values;
  } else if (isSubqueryOperand(values)) right = subqueryOf(values, op);
  else {
    throw new QueryError(`${op}() takes an array of values, an expression of array type, or a query.`);
  }
  const first = right.redact ? redacted(left) : left;
  return new Expr(
    binaryNode(op, first.node, right.node),
    BOOLEAN,
    false,
    join(first.params, right.params),
    join(first.lists, right.lists),
    joinNamed(first.named, right.named),
    shapeOfBinary(op, first.shape, right.shape),
  );
}

const JSON_KINDS: ReadonlySet<string> = new Set(["json", "jsonb", "custom"]);

function jsonPath(
  value: AnyExpr,
  keys: readonly unknown[],
  asText: boolean,
  type: AnyFieldType,
  method: string,
): AnyExpr {
  if (value.type !== undefined && !JSON_KINDS.has(value.type.db.kind)) {
    throw new QueryError(
      `${method}() reads inside a JSON value, and this expression has the type ${value.type.name}. Use it on a t.json() or embedded field, or on a fragment.`,
    );
  }
  if (keys.length === 0) throw new QueryError(`${method}() needs at least one key.`);
  const path: ExprNode[] = [];
  const shapes: number[] = [];
  const keyShape = shapeOfParam(undefined, false);
  for (const key of keys) {
    if (typeof key !== "string" && !(typeof key === "number" && Number.isInteger(key))) {
      throw new QueryError(`${method}() takes keys that are strings, or whole numbers for array positions.`);
    }
    path.push(paramNode(key, undefined, false));
    shapes.push(keyShape);
  }
  return new Expr(
    jsonPathNode(value.node, path, asText),
    type,
    value.redact,
    join(value.params, keys),
    value.lists,
    value.named,
    shapeOfJsonPath(value.shape, shapes, asText),
  );
}
