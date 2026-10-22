/**
 * The keys of the runner's lock. They are a contract between versions of this library:
 * two versions of an application that migrate the same database during one rolling deploy
 * must take the same lock, or they race. So the hash is fixed here, apart from the hash
 * the plan cache uses (`internal/hash.ts`, which may be tuned), and its values are pinned
 * by a test. **Never change it.**
 *
 * @module
 */

const encoder = /* @__PURE__ */ new TextEncoder();

/**
 * 32-bit FNV-1a over the UTF-8 bytes of `text`, as a signed 32-bit integer (what
 * `pg_advisory_lock(int4, int4)` takes).
 *
 * @example
 * ```ts
 * lockHash("egon-orm migrations"); // the same number in every version
 * ```
 */
export function lockHash(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * The two keys of the lock for a tracking table: one for this library, one for the table
 * (its database schema and name).
 *
 * @example
 * ```ts
 * lockKeys(undefined, "schema_migrations"); // [classKey, tableKey]
 * ```
 */
export function lockKeys(schema: string | undefined, table: string): readonly [number, number] {
  return [lockHash("egon-orm migrations"), lockHash(`${schema ?? ""}\u0000${table}`)];
}
