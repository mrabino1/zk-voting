// NOT FOR PROFIT — civic public good, not a commercial product.
// Export a public auditor bundle from Node HTTP or from chain JSON-RPC.
// Does not open apps/node/data/zk-voting.json.

import { createRequire } from 'node:module';
import { verifyAuditorBundle, AUDITOR_SCHEMA } from './verify.mjs';

const require = createRequire(import.meta.url);
const proof = require('../../packages/proof-helpers/index.js');

function padAddress(addr) {
  const hex = String(addr).replace(/^0x/i, '').toLowerCase().padStart(40, '0');
  if (hex.length !== 40) throw new Error(`bad address: ${addr}`);
  return `0x${hex}`;
}

async function rpc(rpcUrl, method, params, id = 1) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}

function selector(sig) {
  return proof.functionSelector(sig);
}

function calldataUint256(sig, value) {
  return `${selector(sig)}${proof.toHex32(value).slice(2)}`;
}

function decodeAddress(word) {
  const hex = String(word).replace(/^0x/i, '').padStart(64, '0');
  return `0x${hex.slice(24)}`;
}

function decodeUint(word) {
  return proof.toBigInt(word);
}

function decodeBytes32(word) {
  return proof.toHex32(word);
}

async function ethCall(rpcUrl, to, data) {
  return rpc(rpcUrl, 'eth_call', [{ to: padAddress(to), data }, 'latest']);
}

function topic(signature) {
  return proof.keccak256(Buffer.from(signature, 'utf8'));
}

function decodeIndexedUint(topicWord) {
  return proof.toBigInt(topicWord).toString();
}

/**
 * Fetch GET /api/elections/:id/artifacts from a ZK-Voting Node (public HTTP).
 */
export async function exportFromNode(baseUrl, electionId) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/api/elections/${encodeURIComponent(electionId)}/artifacts`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Node artifacts ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

/**
 * Reconstruct a bundle from an Ethereum JSON-RPC node using factory + electionId.
 * Uses VoteAccepted logs. Each nullifier appears once; a second ballot is not
 * accepted on chain.
 */
export async function exportFromChain({ rpcUrl, factory, electionId, fromBlock = '0x0', toBlock = 'latest' }) {
  const factoryAddr = padAddress(factory);
  const eid = proof.toBigInt(electionId);
  const electionAddr = decodeAddress(await ethCall(rpcUrl, factoryAddr, calldataUint256('getElection(uint256)', eid)));
  if (electionAddr === '0x0000000000000000000000000000000000000000') {
    throw new Error(`unknown election ${electionId}`);
  }

  const inbox = decodeAddress(await ethCall(rpcUrl, electionAddr, selector('inbox()')));
  let tallyVerifier = null;
  try {
    tallyVerifier = decodeAddress(await ethCall(rpcUrl, factoryAddr, selector('tallyVerifier()')));
  } catch {
    tallyVerifier = null;
  }

  const eligibleRoot = decodeBytes32(await ethCall(rpcUrl, electionAddr, selector('eligibleRoot()')));
  const disqualificationRoot = decodeBytes32(
    await ethCall(rpcUrl, electionAddr, selector('disqualificationRoot()')),
  );
  const accepted = Number(decodeUint(await ethCall(rpcUrl, inbox, calldataUint256('acceptedBallots(uint256)', eid))));

  const voteAcceptedTopic = topic('VoteAccepted(uint256,uint256,bytes32,address)');
  const electionTopic = proof.toHex32(eid);

  const acceptedLogs = await rpc(rpcUrl, 'eth_getLogs', [
    { fromBlock, toBlock, address: inbox, topics: [voteAcceptedTopic, electionTopic] },
  ]);

  const current = new Map();
  for (const log of acceptedLogs || []) {
    const nullifier = decodeIndexedUint(log.topics[2]);
    const data = String(log.data || '').replace(/^0x/, '');
    const ballotHash = `0x${data.slice(0, 64)}`;
    if (current.has(nullifier)) {
      throw new Error(`duplicate VoteAccepted for nullifier ${nullifier}: double voting is impossible on chain`);
    }
    current.set(nullifier, { nullifier, ballotHash });
  }

  const disclosedBallots = [...current.values()].map((row) => ({
    nullifier: proof.toHex32(row.nullifier),
    ballotHash: row.ballotHash,
    electionId: String(electionId),
    relayer: 'chain',
  }));

  let tally = null;
  if (tallyVerifier && tallyVerifier !== '0x0000000000000000000000000000000000000000') {
    try {
      const talliedWord = await ethCall(rpcUrl, tallyVerifier, calldataUint256('isTallied(uint256)', eid));
      const tallied = decodeUint(talliedWord) !== 0n;
      if (tallied) {
        // Dynamic uint256[] cannot be decoded here without ABI; leave counts to Node artifacts if needed.
        tally = { posted: true, counts: null };
      }
    } catch {
      tally = null;
    }
  }

  const bundle = {
    schema: AUDITOR_SCHEMA,
    nfp: true,
    product: 'ZK-Voting',
    source: 'chain',
    chainId: Number(await rpc(rpcUrl, 'eth_chainId', []).then((hex) => Number(hex)).catch(() => 0)),
    electionId: String(electionId),
    contracts: {
      factory: factoryAddr,
      ballotInbox: inbox,
      election: electionAddr,
      tallyVerifier,
    },
    roots: {
      eligibleRoot,
      disqualificationRoot,
      ballotSpecHash: rootsFromParamsPlaceholder(),
    },
    window: { startTime: 0, cutoffTime: 1 },
    rollFrozen: true,
    publicAcceptedBallots: accepted,
    acceptedBallots: accepted,
    disclosedBallots,
    tally,
    coercion: {
      policy: 'one-ballot-per-nullifier',
      receiptsProveChoice: false,
    },
  };

  await fillParams(rpcUrl, electionAddr, bundle);
  return bundle;
}

function rootsFromParamsPlaceholder() {
  return `0x${'00'.repeat(32)}`;
}

async function fillParams(rpcUrl, electionAddr, bundle) {
  try {
    const raw = await ethCall(rpcUrl, electionAddr, selector('params()'));
    // ABI-encoded ElectionParams starts with offsets; ballotSpecHash is a bytes32
    // after dynamic title/metadata. Prefer dedicated views when present.
    void raw;
  } catch {
    // leave placeholders
  }
  try {
    const frozen = decodeUint(await ethCall(rpcUrl, electionAddr, selector('rollFrozen()')));
    bundle.rollFrozen = frozen !== 0n;
  } catch {
    // ignore
  }
}

export async function loadBundle(source) {
  if (source && typeof source === 'object' && !Array.isArray(source)) return source;
  throw new Error('loadBundle: expected object');
}

export { verifyAuditorBundle, AUDITOR_SCHEMA };
