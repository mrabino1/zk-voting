// NOT FOR PROFIT — civic public good, not a commercial product.
// Joint-Feldman distributed key generation on P-256.
// Each guardian deals a degree-(t-1) polynomial, publishes C_k = a_k·G, and
// sends f(j) encrypted to guardian j. There is no trusted dealer.

import { encryptToTallyPub, decryptTallyEnvelope } from '../tallyCrypto.mjs';
import {
  BASE,
  IDENTITY,
  ORDER,
  evalPoly,
  mod,
  modPow,
  pointFromHex,
  pointToHex,
  randomScalar,
  scalarToBytes,
  bytesToScalar,
  scalarToHex,
} from './p256.mjs';

export function verifyFeldmanShare({ index, share, commitments }) {
  const x = BigInt(index);
  if (x <= 0n) return false;
  const lhs = BASE.multiply(share);
  let rhs = null;
  for (let k = 0; k < commitments.length; k++) {
    const exp = modPow(x, BigInt(k), ORDER);
    const term = pointFromHex(commitments[k]).multiply(exp);
    rhs = rhs ? rhs.add(term) : term;
  }
  return rhs != null && lhs.equals(rhs);
}

export function jointPublicKey(deals) {
  let acc = null;
  for (const deal of deals) {
    const c0 = pointFromHex(deal.commitments[0]);
    acc = acc ? acc.add(c0) : c0;
  }
  if (!acc || acc.equals(IDENTITY)) {
    throw Object.assign(new Error('joint public key is the identity'), { code: 'BAD_SHARE' });
  }
  return acc;
}

/** Public verification key Y_j = x_j·G implied by every dealer's commitments. */
export function expectedVerificationKey(deals, index) {
  const j = BigInt(index);
  let acc = null;
  for (const deal of deals) {
    let dealer = null;
    for (let k = 0; k < deal.commitments.length; k++) {
      const exp = modPow(j, BigInt(k), ORDER);
      const term = pointFromHex(deal.commitments[k]).multiply(exp);
      dealer = dealer ? dealer.add(term) : term;
    }
    acc = acc ? acc.add(dealer) : dealer;
  }
  return acc;
}

/**
 * Sample a polynomial and seal each share to that guardian's transport key.
 * Coefficients never leave this function.
 */
export async function createSealedDeal({ index, threshold, roster, encryptShare = encryptToTallyPub }) {
  const t = Number(threshold);
  if (!Number.isInteger(t) || t < 2) {
    throw Object.assign(new Error('threshold must be at least 2'), { code: 'BAD_THRESHOLD' });
  }
  if (!Array.isArray(roster) || roster.length < t) {
    throw Object.assign(new Error('roster is smaller than the threshold'), { code: 'BAD_GUARDIANS' });
  }
  const coeffs = Array.from({ length: t }, () => randomScalar());
  const commitments = coeffs.map((a) => pointToHex(BASE.multiply(a)));
  const encryptedShares = {};
  for (const peer of roster) {
    const peerIndex = Number(peer.index);
    const share = evalPoly(coeffs, BigInt(peerIndex), ORDER);
    const sealed = await encryptShare(peer.transportPublicKey, scalarToBytes(share));
    encryptedShares[String(peerIndex)] = sealed;
  }
  return { index: Number(index), commitments, encryptedShares };
}

export async function finalizeShare({
  index,
  privateJwk,
  deals,
  threshold,
  guardianCount,
  decryptShare = decryptTallyEnvelope,
}) {
  const myIndex = Number(index);
  if (!Array.isArray(deals) || deals.length !== Number(guardianCount)) {
    throw Object.assign(new Error('every guardian must deal before finalize'), {
      code: 'CEREMONY_INCOMPLETE',
    });
  }
  let secret = 0n;
  for (const deal of deals) {
    const ct = deal.encryptedShares?.[String(myIndex)];
    if (!ct) {
      throw Object.assign(new Error(`missing share for guardian ${myIndex} from ${deal.index}`), {
        code: 'BAD_SHARE',
      });
    }
    const plain = await decryptShare(privateJwk, ct);
    const share = bytesToScalar(plain);
    if (deal.commitments?.length !== Number(threshold)) {
      throw Object.assign(new Error('commitment count does not match threshold'), { code: 'BAD_SHARE' });
    }
    if (!verifyFeldmanShare({ index: myIndex, share, commitments: deal.commitments })) {
      throw Object.assign(new Error(`Feldman check failed for dealer ${deal.index}`), { code: 'BAD_SHARE' });
    }
    secret = mod(secret + share);
  }
  if (secret === 0n) {
    throw Object.assign(new Error('combined share is zero'), { code: 'BAD_SHARE' });
  }
  const joint = jointPublicKey(deals);
  return {
    index: myIndex,
    shareScalar: scalarToHex(secret),
    jointPublicKey: pointToHex(joint),
    threshold: Number(threshold),
    guardians: Number(guardianCount),
  };
}

export async function initGuardian({ index, guardianId, label } = {}) {
  const { generateDemoGuardian } = await import('../tallyCrypto.mjs');
  const transport = await generateDemoGuardian();
  const n = Number(index);
  return {
    version: 1,
    index: n,
    guardianId: guardianId || `guardian-${n}`,
    label: label || '',
    transportPublicKey: transport.publicKeyRaw,
    transportPrivateJwk: transport.privateJwk,
  };
}
