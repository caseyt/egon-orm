/**
 * Code generation with a fallback: the one place that calls `new Function`.
 *
 * Whether a runtime lets code be generated is asked at the moment code is generated, not
 * when the module loads. Cloudflare Workers allow `new Function` while a script starts and
 * refuse it while the script handles a request; a Content Security Policy without
 * `unsafe-eval` refuses it always. A refusal (an `EvalError`) is remembered, so that later
 * callers go straight to their loop implementations without throwing and catching again.
 * A success is not remembered: the next call asks again.
 *
 * @module
 */

/** Set once the runtime has refused to generate code. */
let refused = false;

/**
 * Makes a function from source text, or returns `undefined` when the runtime refuses to
 * generate code (now, or at an earlier attempt). The caller then uses its loop
 * implementation, which must return the same results.
 *
 * Only an `EvalError` counts as a refusal. Any other error (a syntax error in the
 * generated source) is a bug and is thrown.
 *
 * @example
 * ```ts
 * const make = generateFunction(["k"], '"use strict"; return function get(o) { return o[k]; };');
 * const get = make === undefined ? (o: Record<string, unknown>) => o.id : make("id");
 * ```
 */
export function generateFunction(
  params: readonly string[],
  body: string,
): ((...args: never[]) => unknown) | undefined {
  if (refused) return undefined;
  try {
    return new Function(...params, body) as (...args: never[]) => unknown;
  } catch (error) {
    if (!(error instanceof EvalError)) throw error;
    refused = true;
    return undefined;
  }
}

/**
 * Whether code generation has been refused by this runtime. Never asks: a runtime that has
 * not been asked yet reports `false`.
 *
 * @example
 * ```ts
 * if (generationRefused()) useLoops();
 * ```
 */
export function generationRefused(): boolean {
  return refused;
}
