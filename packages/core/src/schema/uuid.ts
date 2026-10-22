/**
 * UUID version 7: what `t.uuid().autogenerate()` produces.
 *
 * @module
 */

const HEX: readonly string[] = /* @__PURE__ */ Array.from({ length: 256 }, (_, byte) =>
  (byte + 0x100).toString(16).slice(1),
);

/** Reused between calls: the text is built before the next call can overwrite it. */
const bytes = /* @__PURE__ */ new Uint8Array(16);

/**
 * Generates a UUID of version 7 (RFC 9562): the first 48 bits are the time in
 * milliseconds, the rest is random. Values made later sort later, to the millisecond, so
 * a key of this kind is appended to the end of its index instead of scattered over it.
 *
 * @example
 * ```ts
 * uuidv7(); // "0192a1c4-5b6e-7c3a-9f41-8e2d6b7a0c15"
 * uuidv7(0).slice(0, 13); // "00000000-0000"
 * ```
 */
export function uuidv7(now: number = Date.now()): string {
  crypto.getRandomValues(bytes);
  // The time does not fit in 32 bits, so the two halves are split by division.
  const high = Math.floor(now / 0x1_0000_0000);
  const low = now % 0x1_0000_0000;
  bytes[0] = high >>> 8;
  bytes[1] = high;
  bytes[2] = low >>> 24;
  bytes[3] = low >>> 16;
  bytes[4] = low >>> 8;
  bytes[5] = low;
  bytes[6] = 0x70 | ((bytes[6] as number) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f);
  let text = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) text += "-";
    text += HEX[bytes[i] as number];
  }
  return text;
}
