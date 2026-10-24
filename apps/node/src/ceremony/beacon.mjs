// NOT FOR PROFIT — civic public good, not a commercial product.
// Final random beacon for a phase-2 ceremony.
//
// The coordinator commits to a FUTURE public random value before the
// contribution window closes: a drand round or a block hash at a given
// height. Nobody, the coordinator included, can know that value while
// contributions are still accepted. After it is published the coordinator
// pastes it in and the server applies `zkey beacon` with it. Anyone can look
// the value up again (see docs/ceremony-web.md). This server never fetches it.

/** drand networks run by the League of Entropy. Genesis and period are public. */
export const DRAND_CHAINS = Object.freeze({
  quicknet: Object.freeze({
    id: 'quicknet',
    chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
    genesisTime: 1692803367,
    period: 3,
  }),
  default: Object.freeze({
    id: 'default',
    chainHash: '8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce',
    genesisTime: 1595431050,
    period: 30,
  }),
});

export const BLOCK_NETWORKS = Object.freeze(['ethereum-mainnet', 'bitcoin-mainnet']);

export const DEFAULT_BEACON_ITERATIONS = 10;

/** Unix seconds when a drand round is published. */
export function drandRoundTime(chainId, round) {
  const chain = DRAND_CHAINS[chainId];
  if (!chain) throw new Error(`unknown drand chain ${chainId}`);
  const r = Number(round);
  if (!Number.isSafeInteger(r) || r < 1) throw new Error('drand round must be a positive integer');
  return chain.genesisTime + (r - 1) * chain.period;
}

/** First drand round published at or after `unixSeconds`. */
export function drandRoundAt(chainId, unixSeconds) {
  const chain = DRAND_CHAINS[chainId];
  if (!chain) throw new Error(`unknown drand chain ${chainId}`);
  const t = Math.max(Number(unixSeconds), chain.genesisTime);
  return Math.ceil((t - chain.genesisTime) / chain.period) + 1;
}

export function beaconLookupUrl(precommit) {
  if (!precommit) return null;
  if (precommit.source === 'drand') {
    const chain = DRAND_CHAINS[precommit.chain];
    return chain ? `https://api.drand.sh/${chain.chainHash}/public/${precommit.round}` : null;
  }
  if (precommit.source === 'block-hash') {
    if (precommit.network === 'ethereum-mainnet') return `https://etherscan.io/block/${precommit.height}`;
    if (precommit.network === 'bitcoin-mainnet') return `https://mempool.space/block-height/${precommit.height}`;
  }
  return null;
}

/**
 * Validate a beacon precommitment. `nowSeconds` must be before the round time
 * for drand, so the value is still unknown when it is committed.
 */
export function parsePrecommit(body, nowSeconds) {
  const source = String(body?.source || '');
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
  if (source === 'drand') {
    const chain = String(body.chain || 'quicknet');
    if (!DRAND_CHAINS[chain]) throw new Error('drand chain must be quicknet or default');
    const round = Number(body.round);
    const roundTime = drandRoundTime(chain, round);
    if (roundTime <= nowSeconds) {
      throw new Error('drand round must be in the future. Pick a round published after the window closes.');
    }
    return {
      source,
      chain,
      chainHash: DRAND_CHAINS[chain].chainHash,
      round,
      roundTime,
      note,
      lookupUrl: beaconLookupUrl({ source, chain, round }),
    };
  }
  if (source === 'block-hash') {
    const network = String(body.network || '');
    if (!BLOCK_NETWORKS.includes(network)) {
      throw new Error(`block network must be one of ${BLOCK_NETWORKS.join(', ')}`);
    }
    const height = Number(body.height);
    if (!Number.isSafeInteger(height) || height < 1) throw new Error('block height must be a positive integer');
    return { source, network, height, roundTime: null, note, lookupUrl: beaconLookupUrl({ source, network, height }) };
  }
  throw new Error('beacon source must be drand or block-hash');
}

/** The published value: 32 bytes of hex (drand randomness or a block hash). */
export function parseBeaconValue(value) {
  const hex = String(value || '').trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('beacon value must be 32 bytes of hex (64 characters)');
  }
  return hex;
}
