// NOT FOR PROFIT — civic public good, not a commercial product.
// Constant-time comparison for raw, variable-length secrets.
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compare a configured or session secret with a value from a request.
 * Both sides are hashed first, so the compare always runs on two equal-length
 * digests and neither a length mismatch nor a prefix match returns early.
 * An empty expected or provided value never matches.
 * @param {unknown} expected
 * @param {unknown} provided
 */
export function secretsEqual(expected, provided) {
  const a = String(expected ?? '');
  const b = String(provided ?? '');
  if (!a || !b) return false;
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}
