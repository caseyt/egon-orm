// Step 21a: the text of an error message without its identifier and docs link, for tests
// that compare a whole message (ADR 0007: `<id>: <text> See <link>`).

/**
 * The message of `error` without the leading `<id>: ` and the trailing ` See <link>`; the
 * message as it is when it has neither (an error that is not Egon's).
 *
 * @example
 * ```ts
 * expect(messageText(error)).toBe("A database schema is not supported by postgres. See Dialect support …");
 * ```
 */
export function messageText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^[a-z]+(?:\.[a-zA-Z0-9]+)?: /, "")
    .replace(/(?:\n\n| )See https:\/\/egon-orm\.github\.io\/egon-orm\/reference\/errors\/\S+$/, "");
}
