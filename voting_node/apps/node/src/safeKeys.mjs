// NOT FOR PROFIT — civic public good, not a commercial product.
// Keys that must never be copied from untrusted JSON onto a plain object.

/**
 * Assigning `out['__proto__'] = value` swaps the prototype of `out`, so keys
 * hidden inside `value` become inherited properties that skip any own-key
 * filter. `constructor` and `prototype` are dropped for the same reason.
 */
export const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** @param {string} key */
export function isUnsafeObjectKey(key) {
  return UNSAFE_OBJECT_KEYS.has(key);
}
