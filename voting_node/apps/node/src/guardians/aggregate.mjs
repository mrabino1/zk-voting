// NOT FOR PROFIT — civic public good, not a commercial product.
//
// How ballots are aggregated before threshold decryption is an OPEN product
// decision. Two designs are both plausible:
//
//   homomorphic — multiply (or add, in the exponent) ciphertexts, then
//                 threshold-decrypt the product once
//   mixnet      — shuffle ciphertexts, then threshold-decrypt each one
//
// Neither is selected. The tally calls getAggregator() and today only the
// `undecided` adapter is usable. It returns each ciphertext unchanged so the
// opener can still publish a histogram. That pass-through is not a mixnet
// (nothing is shuffled) and not a homomorphic tally (nothing is multiplied).
//
// A later owner can register a strategy whose `status` is `selected`. Until
// then, asking for `homomorphic` or `mixnet` fails closed.

import { ciphertextForTally } from '../tallyOpen.mjs';

export const AGGREGATION_DECISION = 'open';

/**
 * @typedef {Object} AggregationUnit
 * @property {string} id
 * @property {string} encryptedBallot
 * @property {string} ballotHash
 * @property {string[]} sourceIds
 */

/**
 * @typedef {Object} BallotAggregator
 * @property {string} id
 * @property {'selected'|'open'|'in-use'} status
 * @property {string} summary
 * @property {(envelopes: object[]) => AggregationUnit[]} prepare
 */

const registry = new Map();

export function registerAggregator(aggregator) {
  if (!aggregator?.id || typeof aggregator.prepare !== 'function') {
    throw new Error('aggregator needs an id and prepare()');
  }
  registry.set(aggregator.id, aggregator);
}

const undecidedAggregator = {
  id: 'undecided',
  status: 'in-use',
  summary:
    'No aggregation decision. Each ballot ciphertext is returned as its own decryption unit. This is not a homomorphic product and not a mixnet shuffle.',
  prepare(envelopes) {
    return (envelopes || []).map((env, i) => {
      const ballotHash = String(env.ballotHash || env.nullifier || i);
      return {
        id: ballotHash,
        encryptedBallot: ciphertextForTally(env),
        ballotHash,
        sourceIds: [ballotHash],
      };
    });
  },
};

function notSelected(id, summary) {
  return {
    id,
    status: 'open',
    summary,
    prepare() {
      throw Object.assign(
        new Error(`${id} aggregation is an open product decision and is not selected`),
        { code: 'AGGREGATION_UNDECIDED' },
      );
    },
  };
}

const homomorphicAggregator = notSelected(
  'homomorphic',
  'Would combine ciphertexts under the tally public key and threshold-decrypt the product once. Not selected. The current hybrid ECIES envelope is not an encoding this adapter can tally.',
);

const mixnetAggregator = notSelected(
  'mixnet',
  'Would shuffle ballot ciphertexts and then threshold-decrypt each one. Not selected. No shuffle is shipped.',
);

registerAggregator(undecidedAggregator);
registerAggregator(homomorphicAggregator);
registerAggregator(mixnetAggregator);

export function listAggregators() {
  return [...registry.values()].map((agg) => ({
    id: agg.id,
    status: agg.status,
    summary: agg.summary,
  }));
}

export function getAggregator(id) {
  const key = id == null || id === '' || id === 'open' ? 'undecided' : String(id);
  const found = registry.get(key);
  if (!found) {
    throw Object.assign(new Error(`unknown ballot aggregator ${key}`), { code: 'AGGREGATOR_UNKNOWN' });
  }
  if (found.status === 'open') {
    throw Object.assign(new Error(found.summary), { code: 'AGGREGATION_UNDECIDED' });
  }
  return found;
}
