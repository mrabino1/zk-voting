// NOT FOR PROFIT — civic public good, not a commercial product.
// Final random beacon for a phase-2 ceremony: an Ethereum mainnet block hash.
//
// Decision (2026-10-24): the only beacon source is the hash of a future
// Ethereum mainnet block. The coordinator commits to a block number at least
// N blocks (default 32, about one epoch) ahead of the current head while
// contributions are still accepted, so nobody can know the hash yet. Close is
// refused once that block exists. Finalize waits until the block is
// FINALIZED by the beacon chain, then the server reads its hash from the
// configured read-only RPC (CEREMONY_ETH_RPC_URL) and applies `zkey beacon`.
// No RPC configured means no commit, close, or finalize: it fails closed.
// Anyone can look the block up again on any explorer or node.

export const BEACON_SOURCE = 'ethereum-block';
export const BEACON_NETWORK = 'ethereum-mainnet';
export const ETH_MAINNET_CHAIN_ID = 1;
export const DEFAULT_MIN_BLOCKS_AHEAD = 32;
export const MAX_BLOCKS_AHEAD = 7200 * 60; // about 60 days of 12 s slots
export const DEFAULT_BEACON_ITERATIONS = 10;

export function beaconLookupUrl(precommit) {
  if (!precommit || precommit.source !== BEACON_SOURCE) return null;
  return `https://etherscan.io/block/${precommit.blockNumber}`;
}

/** The name snarkjs stores inside the final zkey for the beacon contribution. */
export function beaconName(precommit) {
  return `zk-voting beacon ${BEACON_NETWORK} block ${precommit.blockNumber}`;
}

/**
 * Validate a beacon precommitment against the current head.
 * `blockNumber` must be at least `minBlocksAhead` past `headBlock`.
 * If it is omitted, it defaults to head + minBlocksAhead.
 */
export function parsePrecommit(body, { headBlock, minBlocksAhead = DEFAULT_MIN_BLOCKS_AHEAD }) {
  const source = body?.source === undefined || body?.source === '' ? BEACON_SOURCE : String(body.source);
  if (source !== BEACON_SOURCE) {
    throw new Error('the only beacon source is an Ethereum mainnet block hash (source "ethereum-block")');
  }
  if (!Number.isSafeInteger(headBlock) || headBlock < 0) throw new Error('could not read the current Ethereum block');
  const raw = body?.blockNumber ?? body?.height;
  const blockNumber = raw === undefined || raw === '' || raw === null ? headBlock + minBlocksAhead : Number(raw);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 1) throw new Error('block number must be a positive integer');
  if (blockNumber < headBlock + minBlocksAhead) {
    throw new Error(
      `block ${blockNumber} is too close: the head is ${headBlock}, so pick block ${headBlock + minBlocksAhead} or later (at least ${minBlocksAhead} blocks ahead)`,
    );
  }
  if (blockNumber > headBlock + MAX_BLOCKS_AHEAD) throw new Error('block number is too far in the future');
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
  return {
    source,
    network: BEACON_NETWORK,
    chainId: ETH_MAINNET_CHAIN_ID,
    blockNumber,
    headAtCommit: headBlock,
    minBlocksAhead,
    note,
    lookupUrl: beaconLookupUrl({ source, blockNumber }),
  };
}

/** A block hash: 32 bytes of hex, with or without 0x. Returns bare lowercase hex. */
export function parseBeaconValue(value) {
  const hex = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('beacon value must be 32 bytes of hex (64 characters)');
  }
  return hex;
}
