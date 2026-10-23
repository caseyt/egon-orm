/**
 * `egon-orm/messages`: the full text of every error message, for development, and
 * `explain`. Nothing in `egon-orm` imports this entry, so an application that does not
 * import it ships only the short messages (ADR 0007).
 *
 * @example
 * ```ts
 * import { useFullErrorMessages } from "egon-orm";
 * import { explain, messages } from "egon-orm/messages";
 *
 * useFullErrorMessages(messages); // every error from now on
 * console.error(explain(error)); // one error, whenever it was made
 * ```
 *
 * @module
 */
import { type ErrorCatalog, fullMessageOf, isEgonError } from "../errors.js";
import { messages } from "./catalog.js";

export { messages } from "./catalog.js";

/**
 * The full text of one error: its identifier, its short sentence, what to do about it,
 * and the docs link. It reads no global state, so it also explains an error made before
 * `useFullErrorMessages` was called (a schema that failed while its module was imported).
 *
 * `catalog` defaults to the English {@link messages}; pass a translated or custom one of
 * the same shape. Any value is accepted:
 *
 * - an Egon error whose identifier the catalog has no entry for, or made by another copy
 *   of `egon-orm`, gives its message as it is;
 * - any other `Error` gives `name: message`;
 * - anything else gives `String(value)`.
 *
 * @example
 * ```ts
 * import { explain } from "egon-orm/messages";
 *
 * try {
 *   await repo.getOrThrow(User, id);
 * } catch (error) {
 *   console.error(explain(error));
 *   throw error;
 * }
 * ```
 */
export function explain(error: unknown, catalog: ErrorCatalog = messages): string {
  if (isEgonError(error)) return fullMessageOf(error, catalog) ?? error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
