/**
 * Conversion between camelCase field names and snake_case column names (decision D4).
 *
 * Both functions are memoised: they run when a schema is defined, but a schemaless query
 * or a dynamic field name can reach them per query.
 *
 * @module
 */

/** Past this many distinct inputs a memo is emptied, so hostile input cannot grow it without bound. */
const MEMO_LIMIT = 4096;

/**
 * Wraps a string conversion in a memo that holds at most `limit` results. When it is
 * full it is emptied and starts again: cheaper than tracking recency, and the inputs that
 * matter (the field names of the schemas) are re-learnt at once.
 *
 * @example
 * ```ts
 * const shout = memoizeBounded((name) => name.toUpperCase(), 1000);
 * shout("id"); // computed
 * shout("id"); // from the memo
 * ```
 */
export function memoizeBounded(convert: (name: string) => string, limit: number): (name: string) => string {
  const memo = new Map<string, string>();
  return (name) => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    const converted = convert(name);
    if (memo.size >= limit) memo.clear();
    memo.set(name, converted);
    return converted;
  };
}

const isUpper = (code: number): boolean => code >= 65 && code <= 90;
const isLower = (code: number): boolean => code >= 97 && code <= 122;
const isDigit = (code: number): boolean => code >= 48 && code <= 57;

/**
 * Converts a camelCase name to snake_case: an underscore goes before an upper-case
 * letter that follows a lower-case letter or a digit, and before the last letter of a
 * run of upper-case letters when a lower-case letter follows it. Everything is then
 * lower-cased. Only ASCII letters are treated as having case.
 *
 * @example
 * ```ts
 * camelToSnake("createdAt"); // "created_at"
 * camelToSnake("userID"); // "user_id"
 * camelToSnake("HTMLParser"); // "html_parser"
 * camelToSnake("address2Line"); // "address2_line"
 * camelToSnake("already_snake"); // "already_snake"
 * ```
 */
export const camelToSnake: (name: string) => string = /* @__PURE__ */ memoizeBounded((name) => {
  let out = "";
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (!isUpper(code)) {
      out += name.charAt(i);
      continue;
    }
    if (i > 0) {
      const previous = name.charCodeAt(i - 1);
      const startsWord = isLower(previous) || isDigit(previous);
      const endsAcronym = isUpper(previous) && i + 1 < name.length && isLower(name.charCodeAt(i + 1));
      if (startsWord || endsAcronym) out += "_";
    }
    out += String.fromCharCode(code + 32);
  }
  return out;
}, MEMO_LIMIT);

/**
 * Converts a snake_case name to camelCase: an underscore between two characters is
 * dropped and the character after it is upper-cased. Leading and trailing underscores
 * are kept, and so is the case of everything else.
 *
 * It reverses {@link camelToSnake} for conventional camelCase names: words of two or more
 * letters, with no acronyms and no digit directly before an upper-case letter.
 * `snakeToCamel(camelToSnake("userId"))` is `"userId"`, but `"userID"`, `"address2Line"`
 * and `"aBC"` do not survive the round trip. Schemas only ever convert in one direction
 * (field name to column name), so this matters to code that derives field names from
 * columns, not to them.
 *
 * @example
 * ```ts
 * snakeToCamel("created_at"); // "createdAt"
 * snakeToCamel("user_id"); // "userId"
 * snakeToCamel("_private_flag"); // "_privateFlag"
 * snakeToCamel("alreadyCamel"); // "alreadyCamel"
 * ```
 */
export const snakeToCamel: (name: string) => string = /* @__PURE__ */ memoizeBounded((name) => {
  let start = 0;
  while (start < name.length && name.charCodeAt(start) === 95) start++;
  let end = name.length;
  while (end > start && name.charCodeAt(end - 1) === 95) end--;

  let out = name.slice(0, start);
  let upperNext = false;
  for (let i = start; i < end; i++) {
    const code = name.charCodeAt(i);
    if (code === 95) {
      upperNext = true;
      continue;
    }
    out += upperNext && isLower(code) ? String.fromCharCode(code - 32) : name.charAt(i);
    upperNext = false;
  }
  return out + name.slice(end);
}, MEMO_LIMIT);
