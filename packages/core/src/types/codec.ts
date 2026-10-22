/**
 * `resolveCodec`: the driver conversions of a type for one adapter.
 *
 * @module
 */
import type { Adapter } from "../contracts/adapter.js";
import type { AnyFieldType, Codec } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import { elementTypeOf, mapElements } from "./composite.js";
import { detached } from "./define.js";

const IDENTITY_CODEC: Codec = /* @__PURE__ */ Object.freeze({ fromDb: IDENTITY, toDb: IDENTITY });

/** Per adapter instance, not per dialect: two adapters of one dialect may read a type differently. */
const cache = /* @__PURE__ */ new WeakMap<object, WeakMap<AnyFieldType, Codec>>();

function buildCodec(type: AnyFieldType, adapter: Pick<Adapter, "typeOverrides">): Codec {
  const override = adapter.typeOverrides(type);
  if (override !== undefined) return override;

  // An array the adapter has nothing to say about still needs the adapter's conversion
  // of its elements (an int8[] arrives as text[] exactly as an int8 arrives as text).
  const element = elementTypeOf(type);
  if (element !== undefined) {
    const inner = resolveCodec(element, adapter);
    // When nothing was overridden below, the array's own conversions already compose these.
    if (inner.fromDb !== detached(element, "fromDb") || inner.toDb !== detached(element, "toDb")) {
      return Object.freeze({
        fromDb: inner.fromDb === IDENTITY ? IDENTITY : mapElements(inner.fromDb),
        toDb: inner.toDb === IDENTITY ? IDENTITY : mapElements(inner.toDb),
      });
    }
  }
  const fromDb = detached(type, "fromDb");
  const toDb = detached(type, "toDb");
  if (fromDb === IDENTITY && toDb === IDENTITY) return IDENTITY_CODEC;
  return Object.freeze({ fromDb, toDb });
}

/**
 * The conversions to use for `type` with `adapter`: the adapter's override when it has
 * one (`Adapter.typeOverrides`), otherwise the type's own `fromDb` and `toDb`. For an
 * array type without an override of its own, the element type is resolved the same way
 * and applied to each element.
 *
 * The answer is computed once per (type, adapter instance) and the same frozen object
 * is returned afterwards. Either member may be `IDENTITY`; callers skip that call with a
 * reference check. The members are plain functions, safe to call without a receiver even
 * when the type was written by hand as a class.
 *
 * @example
 * ```ts
 * const { fromDb } = resolveCodec(field.type, adapter);
 * const value = raw === null || fromDb === IDENTITY ? raw : fromDb(raw);
 * ```
 */
export function resolveCodec(type: AnyFieldType, adapter: Pick<Adapter, "typeOverrides">): Codec {
  let perAdapter = cache.get(adapter);
  if (perAdapter === undefined) {
    perAdapter = new WeakMap();
    cache.set(adapter, perAdapter);
  }
  let codec = perAdapter.get(type);
  if (codec === undefined) {
    codec = buildCodec(type, adapter);
    perAdapter.set(type, codec);
  }
  return codec;
}
