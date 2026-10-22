/**
 * `selectedAs`: a name for a selected expression (`sum(p.views) AS "total"`), and a
 * reference to it by that name from `orderBy` or `groupBy` (`ORDER BY "total"`).
 *
 * @module
 */
import { QueryError } from "../../errors.js";
import { HASH_SEED, hashString } from "../../internal/hash.js";
import { optionalShape, selectedAsNode } from "../ast.js";
import { Expr, isExpr, NONE, type NoParams, type ParamsOf, type SomeParams, type ValueOf } from "../expr.js";

const SELECTED_AS_SEED = /* @__PURE__ */ hashString(HASH_SEED, "selectedAs");

/** The type-only marks of an expression that a named copy of it keeps (no type, a named window). */
type Marks<X> = Pick<X, Extract<keyof X, "~untyped" | "~noType" | "~window" | "~needsWindow">>;

function checkName(name: unknown): string {
  if (typeof name !== "string" || name === "") {
    throw new QueryError("query.selectedAsName", "selectedAs() takes a name, a non-empty string.");
  }
  return name;
}

/**
 * Names a selected expression in the SQL (`… AS "total"`), so that `orderBy` and `groupBy`
 * can refer to it with `selectedAs("total")`. With only a name, it is that reference.
 *
 * @example
 * ```ts
 * from(Post, "p")
 *   .groupBy(({ p }) => p.authorId)
 *   .select(({ p }) => ({ authorId: p.authorId, total: selectedAs(sum(p.views), "total") }))
 *   .orderBy(() => selectedAs("total").desc());
 * ```
 *
 * @throws QueryError when the name is not a non-empty string, or the expression is not one.
 */
export function selectedAs<X extends Expr<unknown, SomeParams>, const N extends string>(
  expr: X,
  name: N,
): Expr<ValueOf<X>, ParamsOf<X>> & Marks<X>;
export function selectedAs(name: string): Expr<unknown, NoParams>;
export function selectedAs(...args: readonly unknown[]): Expr<unknown, SomeParams> {
  if (args.length === 1) {
    const name = checkName(args[0]);
    return new Expr(
      selectedAsNode(name, undefined),
      undefined,
      false,
      NONE,
      NONE,
      NONE,
      optionalShape(hashString(SELECTED_AS_SEED, name), undefined),
    );
  }
  const [expr, given] = args;
  const name = checkName(given);
  if (!isExpr(expr)) {
    throw new QueryError(
      "query.selectedAsExpression",
      `selectedAs(expr, "${name}") takes an expression to name first.`,
    );
  }
  return new Expr(
    selectedAsNode(name, expr.node),
    expr.type,
    expr.redact,
    expr.params,
    expr.lists,
    expr.named,
    optionalShape(hashString(SELECTED_AS_SEED, name), expr.shape),
  );
}
