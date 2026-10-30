// NOT FOR PROFIT — civic public good, not a commercial sequencer.
// ZK-Voting L2 chain state, civic mempool, and keccak256 (Ethereum).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  publicDisclosureView,
  isDisclosed,
  isHeldVoteType,
  planPublicBlocks,
  publishedThrough,
  resolveDisclosureDelaySeconds,
  resolveDisclosureIntervalSeconds,
  resolveDisclosureMinBlockVotes,
  resolveResultsMinVotes,
} from '../disclosure.mjs';
import { StaleFenceError, WriterLease } from '../lease/lease.mjs';
import { isAdminTxType, verifyAdminCivic } from '../adminAuth.mjs';
import { normalizeElectionType, voteResultsSealed } from '../../apps/node/src/electionType.mjs';

export const L2_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHAIN_ID = 27427;
export const ZERO_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
export const EMPTY_UNCLE_HASH =
  '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347';
export const EMPTY_LOGS_BLOOM = '0x' + '00'.repeat(256);
export const EMPTY_KECCAK =
  '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
export const CIVIC_TYPES = Object.freeze([
  'register',
  'vote',
  'disqualify',
  'tally',
  'userop',
  'party_add',
  'party_reject',
  'party_attest',
  'election_open',
]);

/** Admission modes. strict: operator-authenticated admin txs, UUID elections, approved voters only. */
export const ADMISSION_MODES = Object.freeze(['open', 'strict']);
const ELECTION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Civic types that act inside one election and must name an opened election in strict mode. */
const ELECTION_SCOPED_TYPES = new Set(['register', 'vote', 'disqualify', 'tally', 'userop']);

/** Token-poll txs. Accepted only when POLLS_ENABLED is set. Vote validation is unchanged. */
export const POLL_TX_TYPES = Object.freeze(['poll_params', 'poll_vote', 'poll_tally']);

const FORBIDDEN_KEYS = new Set([
  'plaintext',
  'choice',
  'optionid',
  'option',
  'ballot',
  'ballotplaintext',
  'selectedoption',
  'selected',
  'voteplaintext',
  'name',
  'legalname',
  'dob',
  'dateofbirth',
  'ssn',
  'street',
  'homeaddress',
  'legaladdress',
  'email',
  'phone',
  'pii',
  'candidate',
]);

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const RHO = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18,
  2, 61, 56, 14,
];

function rotl(x, n) {
  const s = BigInt(n % 64);
  const v = x & 0xffffffffffffffffn;
  if (s === 0n) return v;
  return ((v << s) | (v >> (64n - s))) & 0xffffffffffffffffn;
}

function keccakf(A) {
  const B = new Array(25);
  const C = new Array(5);
  const D = new Array(5);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        A[x + 5 * y] = (A[x + 5 * y] ^ D[x]) & 0xffffffffffffffffn;
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], RHO[x + 5 * y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        A[x + 5 * y] =
          (B[x + 5 * y] ^
            ((B[((x + 1) % 5) + 5 * y] ^ 0xffffffffffffffffn) &
              B[((x + 2) % 5) + 5 * y])) &
          0xffffffffffffffffn;
      }
    }
    A[0] = (A[0] ^ RC[round]) & 0xffffffffffffffffn;
  }
}

function keccak256Sponge(bytes) {
  const state = new Array(25).fill(0n);
  const rate = 136;
  const buf = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const padLen = rate - (buf.length % rate);
  const padded = new Uint8Array(buf.length + padLen);
  padded.set(buf);
  padded[buf.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 0; j < 8; j++) {
        lane |= BigInt(padded[offset + i * 8 + j]) << BigInt(8 * j);
      }
      state[i] ^= lane;
    }
    keccakf(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number((state[i] >> BigInt(8 * j)) & 0xffn);
    }
  }
  return out;
}

export function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return Uint8Array.from(data);
}

export function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex) {
  let h = String(hex).trim();
  if (h.startsWith('0x') || h.startsWith('0X')) h = h.slice(2);
  if (h.length % 2) h = '0' + h;
  if (!h.length) return new Uint8Array();
  if (!/^[0-9a-fA-F]+$/.test(h)) {
    throw new Error('invalid hex');
  }
  return Uint8Array.from(Buffer.from(h, 'hex'));
}

export function keccak256(data) {
  const bytes = toBytes(data);
  try {
    return new Uint8Array(createHash('keccak256').update(bytes).digest());
  } catch {
    return keccak256Sponge(bytes);
  }
}

export function keccak256Hex(data) {
  return '0x' + bytesToHex(keccak256(data));
}

export function toQuantity(n) {
  const v = typeof n === 'bigint' ? n : BigInt(n);
  if (v === 0n) return '0x0';
  return '0x' + v.toString(16);
}

export function parseQuantity(q) {
  if (q === undefined || q === null) return 0n;
  if (typeof q === 'bigint') return q;
  if (typeof q === 'number') return BigInt(q);
  const s = String(q).trim();
  if (s === 'latest' || s === 'pending' || s === 'earliest' || s === 'safe' || s === 'finalized') {
    return s;
  }
  return BigInt(s);
}

export function normalizeHex(hex, sizeBytes) {
  let h = String(hex || '0x').trim();
  if (!h.startsWith('0x') && !h.startsWith('0X')) h = '0x' + h;
  h = '0x' + h.slice(2).toLowerCase();
  if (sizeBytes != null) {
    const body = h.slice(2).padStart(sizeBytes * 2, '0');
    if (body.length > sizeBytes * 2) {
      throw new Error('hex value too long');
    }
    h = '0x' + body;
  }
  return h;
}

export function normalizeAddress(addr) {
  if (!addr) return '0x0000000000000000000000000000000000000000';
  return normalizeHex(addr, 20);
}

export function topicWord(value) {
  if (value == null) return ZERO_HASH;
  const s = String(value);
  if (s.startsWith('0x') || s.startsWith('0X')) {
    const body = s.slice(2).toLowerCase();
    if (body.length <= 40 && body.length !== 64) {
      return '0x' + body.padStart(64, '0');
    }
    return '0x' + body.padStart(64, '0').slice(-64);
  }
  try {
    return '0x' + BigInt(s).toString(16).padStart(64, '0');
  } catch {
    return keccak256Hex(s);
  }
}

// Copying `__proto__` (or `constructor` / `prototype`) from parsed JSON onto
// `out` would swap its prototype and let forbidden keys ride along as
// inherited properties.
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function stripForbidden(value) {
  if (Array.isArray(value)) return value.map(stripForbidden);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(String(k).toLowerCase()) || UNSAFE_OBJECT_KEYS.has(k)) continue;
      out[k] = stripForbidden(v);
    }
    return out;
  }
  return value;
}

export function publicFieldsForTx(tx) {
  const c = tx.civic && typeof tx.civic === 'object' ? tx.civic : {};
  const type = String(c.type || tx.civicType || 'userop').toLowerCase();
  const out = { type, hash: tx.hash };
  if (c.electionId != null) out.electionId = String(c.electionId);
  if (c.nullifier != null) out.nullifier = topicWord(c.nullifier);
  if (c.ballotHash != null) out.ballotHash = topicWord(c.ballotHash);
  const partyTx = type === 'party_add' || type === 'party_reject' || type === 'party_attest';
  if (c.identityCommitment != null && type !== 'vote') {
    out.identityCommitment = partyTx ? String(c.identityCommitment) : topicWord(c.identityCommitment);
  }
  if (partyTx) {
    if (c.partyId != null) out.partyId = String(c.partyId);
    if (c.partyName != null) out.partyName = String(c.partyName);
    if (c.mode != null) out.mode = String(c.mode);
  }
  if (c.eligibleRoot != null) out.eligibleRoot = topicWord(c.eligibleRoot);
  if (c.disqualificationRoot != null) {
    out.disqualificationRoot = topicWord(c.disqualificationRoot);
  }
  if (c.reasonCode != null) out.reasonCode = Number(c.reasonCode);
  if (c.evidenceHash != null) out.evidenceHash = topicWord(c.evidenceHash);
  if (c.countsHash != null) out.countsHash = topicWord(c.countsHash);
  if (type === 'userop' && c.sender) out.sender = normalizeAddress(c.sender);
  if (c.pollId != null) out.pollId = String(c.pollId);
  if (c.voter != null) out.voter = normalizeAddress(c.voter);
  if (c.partyId != null) out.partyId = String(c.partyId);
  if (c.partyName != null) out.partyName = String(c.partyName);
  if (c.mode != null) out.mode = String(c.mode);
  if (c.resultHash != null) out.resultHash = topicWord(c.resultHash);
  return out;
}

export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

export function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function parseNonNegativeInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function loadConfig(root = L2_ROOT) {
  const genesis = JSON.parse(
    fs.readFileSync(path.join(root, 'genesis.json'), 'utf8'),
  );
  const file = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const chainId = Number(process.env.L2_CHAIN_ID || file.chainId || genesis.chainId || CHAIN_ID);
  const blockTimeMs = Number(
    process.env.L2_BLOCK_TIME_MS ||
      file.blockTimeMs ||
      (genesis.blockTime || genesis.period || 2) * 1000,
  );
  const sequencer = normalizeAddress(
    process.env.L2_SEQUENCER || file.sequencer || genesis.sequencer,
  );
  const paymaster = normalizeAddress(
    process.env.L2_PAYMASTER || file.paymaster || genesis.paymaster,
  );
  const bundler = normalizeAddress(
    process.env.L2_BUNDLER || file.bundler || genesis.bundler || sequencer,
  );
  return {
    root,
    genesis,
    chainId,
    blockTimeMs,
    batchSize: Number(process.env.L2_BATCH_SIZE || file.batchSize || 4),
    rpcHost: process.env.L2_RPC_HOST || file.rpcHost || '127.0.0.1',
    rpcPort: Number(process.env.L2_RPC_PORT || file.rpcPort || 8546),
    dataDir: path.resolve(root, process.env.L2_DATA_DIR || file.dataDir || 'data'),
    maxTxsPerBlock: Number(file.maxTxsPerBlock || 4096),
    paymasterBalanceWei: BigInt(file.paymasterBalanceWei || '1000000000000000000000000000'),
    sequencer,
    paymaster,
    bundler,
    genesisStateRoot: normalizeHex(genesis.genesisStateRoot || ZERO_HASH, 32),
    contracts: file.contracts || {},
    zkVotingNodeUrl: (process.env.ZK_VOTING_NODE_URL || file.zkVotingNodeUrl || '').replace(
      /\/$/,
      '',
    ),
    explorerIngestSecret: String(process.env.EXPLORER_INGEST_SECRET || file.explorerIngestSecret || '').trim(),
    l1Rpc: process.env.L1_RPC || file.l1Rpc || '',
    settlementAddress: process.env.SETTLEMENT_ADDRESS || file.settlementAddress || '',
    // L1 batch submitter key. Paid by the L2 operator, never by voters.
    privateKey: process.env.L1_SUBMITTER_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
    // strict: only the operator (L2_ADMIN_SECRET) opens elections and registers
    // voters, election ids are UUIDs unique on this L2, and votes must bind an
    // approved eligibility root. open: legacy demo behaviour.
    admission: ADMISSION_MODES.includes(String(process.env.L2_ADMISSION || file.admission || '').toLowerCase())
      ? String(process.env.L2_ADMISSION || file.admission).toLowerCase()
      : 'open',
    adminSecret: String(process.env.L2_ADMIN_SECRET || '').trim(),
    l2Uuid: String(process.env.L2_UUID || file.l2Uuid || '').trim().toLowerCase(),
    devMockProof: parseBool(process.env.DEV_MOCK_PROOF, file.devMockProof !== false),
    voteProvingPath: parseBool(process.env.ZK_VOTING_PROVING_PATH, false),
    l2RpcUrl:
      process.env.L2_RPC_URL ||
      `http://${process.env.L2_RPC_HOST || file.rpcHost || '127.0.0.1'}:${
        process.env.L2_RPC_PORT || file.rpcPort || 8546
      }`,
    disclosureIntervalSeconds: resolveDisclosureIntervalSeconds(
      process.env.DISCLOSURE_INTERVAL_SECONDS ?? file.disclosureIntervalSeconds,
      { isTest: process.env.NODE_ENV === 'test' },
    ),
    disclosureDelaySeconds: resolveDisclosureDelaySeconds(
      process.env.DISCLOSURE_DELAY_SECONDS ?? file.disclosureDelaySeconds,
      { isTest: process.env.NODE_ENV === 'test' },
    ),
    resultsMinVotes: resolveResultsMinVotes(
      process.env.RESULTS_MIN_VOTES ?? file.resultsMinVotes,
      { isTest: process.env.NODE_ENV === 'test' },
    ),
    disclosureMinBlockVotes: resolveDisclosureMinBlockVotes(
      process.env.DISCLOSURE_MIN_BLOCK_VOTES ?? file.disclosureMinBlockVotes,
      { isTest: process.env.NODE_ENV === 'test' },
    ),
    pollsEnabled: parseBool(process.env.POLLS_ENABLED, false),
    // Seal only when there is a tx, the disclosure hour closes, or the heartbeat
    // interval has elapsed. L2_SKIP_EMPTY_BLOCKS=0 restores a block every period.
    skipEmptyBlocks: parseBool(
      process.env.L2_SKIP_EMPTY_BLOCKS ?? file.skipEmptyBlocks,
      true,
    ),
    heartbeatSeconds: parseNonNegativeInt(
      process.env.L2_HEARTBEAT_SECONDS ?? file.heartbeatSeconds,
      3600,
    ),
    l1ChainId: process.env.L1_CHAIN_ID || file.l1ChainId || '',
    leaseTtlMs: Number(process.env.WRITER_LEASE_TTL_MS || 0) || undefined,
  };
}

function u64be(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(n));
  return buf;
}

function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, jsonReplacer) + '\n');
  fs.renameSync(tmp, file);
}

function writeJsonExclusive(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;
  const fd = fs.openSync(file, flags);
  try {
    fs.writeFileSync(fd, JSON.stringify(obj, jsonReplacer) + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

function normId(value) {
  return String(value ?? '').trim().toLowerCase();
}

function topic0(signature) {
  return keccak256Hex(signature);
}

export function selfTestKeccak() {
  const empty = keccak256Hex(new Uint8Array());
  if (empty !== EMPTY_KECCAK) {
    throw new Error(`keccak256 empty self-test failed: ${empty}`);
  }
  const abc = keccak256Hex(Buffer.from('abc'));
  if (abc !== '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45') {
    throw new Error(`keccak256 abc self-test failed: ${abc}`);
  }
}

selfTestKeccak();

export class ChainState {
  constructor(config) {
    this.config = config;
    this.blocks = [];
    this.blocksByHash = new Map();
    this.txsByHash = new Map();
    this.logs = [];
    this.mempool = [];
    this.mempoolHashes = new Set();
    this.sealed = [];
    this.sealedHashes = new Set();
    this.txNonce = 0n;
    this._latestNumber = null;
    this.producing = false;
    this.running = false;
    this.producerTask = null;
    this.writerLease = null;
    this.writerActive = true;
    this.shuttingDown = false;
    this._flushing = false;
    this.nullifierIndex = new Set();
    this.commitmentIndex = new Set();
    this.tallyIndex = new Set();
    /** electionUuid -> { openedBy, eligibleRoots:Set, approvedSenders:Set, openTx } */
    this.electionRegistry = new Map();
    this.eventTopics = {
      registered: topic0('Registered(uint256,uint256)'),
      voteAccepted: topic0('VoteAccepted(uint256,uint256,bytes32,address)'),
      disqualified: topic0('Disqualified(uint256,uint256,uint16,bytes32)'),
      tallySubmitted: topic0('TallySubmitted(uint256,bytes32)'),
      userOpAccepted: topic0('UserOpAccepted(bytes32,address)'),
      partyRejected: topic0('PartyRejected(uint256,bytes32,uint256,uint16)'),
      partyAdded: topic0('PartyAdded(uint256,bytes32)'),
      partyAttested: topic0('PartyAttested(uint256,bytes32,uint256)'),
      pollParams: topic0('PollParams(bytes32,address,uint256)'),
      pollVote: topic0('PollVote(bytes32,address,uint256)'),
      pollTally: topic0('PollTally(bytes32,bytes32)'),
    };
  }

  static open(config) {
    const state = new ChainState(config);
    fs.mkdirSync(path.join(config.dataDir, 'blocks'), { recursive: true });
    fs.mkdirSync(path.join(config.dataDir, 'proofs'), { recursive: true });
    state.load();
    state.attachLease();
    if (state.writerActive && state.blocks.length === 0) {
      state.writeGenesis();
    }
    return state;
  }

  get head() {
    if (this._latestNumber != null && this.blocks[this._latestNumber]) {
      return this.blocks[this._latestNumber];
    }
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (this.blocks[i]) return this.blocks[i];
    }
    return undefined;
  }

  get latestNumber() {
    if (this._latestNumber != null) return this._latestNumber;
    return this.head ? this.head.number : 0;
  }

  now() {
    if (typeof this.config.nowFn === 'function') return this.config.nowFn();
    return Math.floor(Date.now() / 1000);
  }

  disclosureView() {
    return publicDisclosureView(this.now(), this.config.disclosureIntervalSeconds, {
      delaySeconds: this.config.disclosureDelaySeconds,
      resultsMinVotes: this.config.resultsMinVotes,
      minBlockVotes: this.config.disclosureMinBlockVotes,
    });
  }

  blockPath(number) {
    return path.join(this.config.dataDir, 'blocks', `${number}.json`);
  }

  load() {
    const headPath = path.join(this.config.dataDir, 'head.json');
    if (!fs.existsSync(headPath)) return;
    const head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
    const max = Number(head.number || 0);
    this._latestNumber = max;
    if (head.txNonce != null && head.txNonce !== '') {
      try {
        this.txNonce = BigInt(head.txNonce);
      } catch {
        this.txNonce = 0n;
      }
    }
    const archiveIndex = readArchiveIndexFile(this.config.dataDir);
    if (archiveIndex?.txNonce) {
      try {
        const indexed = BigInt(archiveIndex.txNonce);
        if (indexed > this.txNonce) this.txNonce = indexed;
      } catch {
        // keep head nonce
      }
    }
    const archivedThrough = Number(archiveIndex?.archivedThrough ?? -1);
    for (let n = 0; n <= max; n++) {
      const file = this.blockPath(n);
      if (fs.existsSync(file)) {
        const block = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (block && block.archived) continue;
        this.ingestLoadedBlock(block);
        continue;
      }
      if (n === 0) {
        throw new Error(`missing block file ${file}`);
      }
      if (n <= archivedThrough) continue;
      throw new Error(`missing block file ${file}`);
    }
    rememberArchivedTxHashes(this, archiveIndex);
    const memPath = path.join(this.config.dataDir, 'mempool.json');
    if (fs.existsSync(memPath)) {
      const pending = JSON.parse(fs.readFileSync(memPath, 'utf8'));
      for (const tx of pending) {
        try {
          this.rememberPending(tx, false);
        } catch {
          continue;
        }
        const next = BigInt(tx.nonce || 0) + 1n;
        if (next > this.txNonce) this.txNonce = next;
      }
    }
    const sealedPath = path.join(this.config.dataDir, 'sealed.json');
    if (fs.existsSync(sealedPath)) {
      const held = JSON.parse(fs.readFileSync(sealedPath, 'utf8'));
      for (const tx of held) {
        const hash = String(tx.hash || '').toLowerCase();
        if (!hash || this.txsByHash.has(hash) || this.mempoolHashes.has(hash) || this.sealedHashes.has(hash)) {
          continue;
        }
        this.sealed.push(tx);
        this.sealedHashes.add(hash);
        this._indexCivic(tx);
      }
    }
  }

  ingestLoadedBlock(block) {
    this.blocks[block.number] = block;
    if (this._latestNumber == null || block.number > this._latestNumber) {
      this._latestNumber = block.number;
    }
    this.blocksByHash.set(block.hash.toLowerCase(), block);
    const txs = Array.isArray(block.transactions) ? block.transactions : [];
    for (const tx of txs) {
      if (typeof tx === 'string') continue;
      this.txsByHash.set(tx.hash.toLowerCase(), tx);
      this._indexCivic(tx);
      const next = BigInt(tx.nonce || 0) + 1n;
      if (next > this.txNonce) this.txNonce = next;
    }
    if (Array.isArray(block.logs)) {
      for (const log of block.logs) this.logs.push(log);
    }
  }

  persistHead() {
    this.assertWritable();
    const epoch = this.writerEpoch();
    writeJsonAtomic(path.join(this.config.dataDir, 'head.json'), {
      number: this.head.number,
      hash: this.head.hash,
      stateRoot: this.head.stateRoot,
      txNonce: this.txNonce.toString(),
      epoch,
    });
    writeJsonAtomic(path.join(this.config.dataDir, 'mempool.json'), this.mempool);
    this.persistSealed();
  }

  persistSealed() {
    this.assertWritable();
    writeJsonAtomic(path.join(this.config.dataDir, 'sealed.json'), this.sealed);
  }

  persistBlock(block) {
    this.assertWritable();
    const file = this.blockPath(block.number);
    if (fs.existsSync(file)) {
      throw Object.assign(new Error(`block ${block.number} already exists`), { code: -32000 });
    }
    if (block.number > 0) {
      const prevFile = this.blockPath(block.number - 1);
      if (!fs.existsSync(prevFile)) {
        throw Object.assign(new Error(`missing parent block ${block.number - 1}`), { code: -32000 });
      }
      const prev = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
      if (String(prev.hash).toLowerCase() !== String(block.parentHash).toLowerCase()) {
        throw Object.assign(new Error('parent hash mismatch'), { code: -32000 });
      }
    }
    const fenced = { ...block, epoch: this.writerEpoch() };
    try {
      writeJsonExclusive(file, fenced);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        throw Object.assign(new Error(`block ${block.number} already exists`), { code: -32000 });
      }
      throw err;
    }
    this.persistHead();
  }

  writeGenesis() {
    const timestamp = this.now();
    const extraData = '0x' + Buffer.from('NOT-FOR-PROFIT').toString('hex');
    const hash = keccak256Hex(
      Buffer.concat([
        hexToBytes(ZERO_HASH),
        hexToBytes(this.config.genesisStateRoot),
        hexToBytes(EMPTY_KECCAK),
        u64be(0),
        u64be(timestamp),
      ]),
    );
    const genesis = this.formatBlock({
      number: 0,
      hash,
      parentHash: ZERO_HASH,
      stateRoot: this.config.genesisStateRoot,
      transactionsRoot: EMPTY_KECCAK,
      timestamp,
      extraData,
      transactions: [],
      logs: [],
    });
    this.ingestLoadedBlock(genesis);
    this.persistBlock(genesis);
  }

  formatBlock({
    number,
    hash,
    parentHash,
    stateRoot,
    transactionsRoot,
    timestamp,
    extraData,
    transactions,
    logs,
  }) {
    const miner = this.config.sequencer;
    const gasUsed = toQuantity(0);
    return {
      number,
      hash,
      parentHash,
      nonce: '0x0000000000000000',
      sha3Uncles: EMPTY_UNCLE_HASH,
      logsBloom: EMPTY_LOGS_BLOOM,
      transactionsRoot,
      stateRoot,
      receiptsRoot: EMPTY_KECCAK,
      miner,
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: extraData || '0x' + Buffer.from('NOT-FOR-PROFIT').toString('hex'),
      size: toQuantity(JSON.stringify(transactions, jsonReplacer).length + 512),
      gasLimit: '0x1c9c380',
      gasUsed,
      timestamp,
      uncles: [],
      baseFeePerGas: '0x0',
      mixHash: ZERO_HASH,
      transactions,
      logs: logs || [],
    };
  }

  rpcBlock(block, fullTxs) {
    if (!block) return null;
    const txs = fullTxs
      ? block.transactions.map((tx) => this.rpcTx(tx, block))
      : block.transactions.map((tx) => (typeof tx === 'string' ? tx : tx.hash));
    return {
      number: toQuantity(block.number),
      hash: block.hash,
      parentHash: block.parentHash,
      nonce: block.nonce,
      sha3Uncles: block.sha3Uncles,
      logsBloom: block.logsBloom,
      transactionsRoot: block.transactionsRoot,
      stateRoot: block.stateRoot,
      receiptsRoot: block.receiptsRoot,
      miner: block.miner,
      difficulty: block.difficulty,
      totalDifficulty: block.totalDifficulty,
      extraData: block.extraData,
      size: block.size,
      gasLimit: block.gasLimit,
      gasUsed: block.gasUsed,
      timestamp: toQuantity(block.timestamp),
      uncles: [],
      baseFeePerGas: block.baseFeePerGas,
      mixHash: block.mixHash,
      transactions: txs,
    };
  }

  rpcTx(tx, block) {
    if (!tx) return null;
    const blk = block || (tx.blockHash && this.blocksByHash.get(tx.blockHash.toLowerCase()));
    return {
      hash: tx.hash,
      nonce: toQuantity(tx.nonce || 0),
      blockHash: blk ? blk.hash : tx.blockHash || null,
      blockNumber: blk ? toQuantity(blk.number) : tx.blockNumber != null ? toQuantity(tx.blockNumber) : null,
      transactionIndex:
        tx.transactionIndex != null ? toQuantity(tx.transactionIndex) : null,
      from: tx.from,
      to: tx.to,
      value: '0x0',
      gas: '0x0',
      gasPrice: '0x0',
      input: tx.input,
      type: '0x0',
      civicType: tx.civicType,
      civic: publicFieldsForTx(tx),
    };
  }

  rememberPending(tx, persist = true) {
    const hash = tx.hash.toLowerCase();
    if (this.txsByHash.has(hash) || this.mempoolHashes.has(hash) || this.sealedHashes.has(hash)) {
      throw Object.assign(new Error('already known'), { code: -32000 });
    }
    this.mempool.push(tx);
    this.mempoolHashes.add(hash);
    this._indexCivic(tx);
    if (persist) this.persistHead();
  }

  rememberSealed(tx) {
    const hash = tx.hash.toLowerCase();
    if (this.txsByHash.has(hash) || this.mempoolHashes.has(hash) || this.sealedHashes.has(hash)) {
      throw Object.assign(new Error('already known'), { code: -32000 });
    }
    this.sealed.push(tx);
    this.sealedHashes.add(hash);
    this._indexCivic(tx);
    this.persistSealed();
  }

  shouldHoldVote(tx) {
    if (!isHeldVoteType(tx.civicType)) return false;
    return (Number(this.config.disclosureIntervalSeconds) || 0) > 0;
  }

  /**
   * Ballot rows follow the hourly gate for both types. A tally is choice
   * data: refuse it for an election this L2 never opened, and while a vote
   * is sealed. An invalid stored type fails closed.
   */
  _assertChoicePolicy(tx) {
    const type = String(tx.civicType || '').toLowerCase();
    const civic = tx.civic || {};
    if (type === 'election_open') {
      if (civic.electionType != null && civic.electionType !== '') {
        normalizeElectionType(civic.electionType, { required: true });
      }
      return;
    }
    if (type !== 'tally') return;
    const id = String(civic.electionId ?? '').toLowerCase();
    const entry = this.electionRegistry.get(id);
    if (!entry) {
      throw Object.assign(new Error('unknown election on this L2'), { code: -32001 });
    }
    const typed = {
      electionType: entry.typeInvalid ? 1 : entry.electionType,
      cutoffTime: entry.typeInvalid ? null : entry.cutoffTime,
    };
    if (entry.typeInvalid || voteResultsSealed(typed, this.now())) {
      throw Object.assign(new Error('choice results are sealed until cutoff'), { code: -32001 });
    }
  }

  decodeCivicRaw(rawHex) {
    const bytes = hexToBytes(rawHex);
    const hash = keccak256Hex(bytes);
    let civic;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      civic = JSON.parse(text);
    } catch {
      civic = { type: 'userop', raw: normalizeHex(rawHex) };
    }
    if (civic && typeof civic === 'object' && civic.params && civic.type == null) {
      throw Object.assign(new Error('not a civic transaction'), { code: -32602 });
    }
    const originalCivic = civic && typeof civic === 'object' ? civic : { type: 'userop' };
    let type = String(originalCivic.type || 'userop').toLowerCase();
    const pollType = POLL_TX_TYPES.includes(type);
    if (!CIVIC_TYPES.includes(type) && !(pollType && this.config.pollsEnabled)) {
      throw Object.assign(new Error(`unsupported civic tx type: ${type}`), {
        code: -32602,
      });
    }
    if (type === 'vote') {
      civic = allowVoteFields(originalCivic);
    } else {
      civic = stripForbidden(originalCivic);
      civic.type = type;
    }
    if (pollType) assertPollShape(type, civic);
    const from =
      type === 'vote' || type === 'userop'
        ? this.config.bundler
        : normalizeAddress(civic.from || this.config.sequencer);
    const to = this.contractForType(type);
    const input =
      type === 'userop' && civic.raw
        ? normalizeHex(civic.raw)
        : '0x' + Buffer.from(JSON.stringify(civic), 'utf8').toString('hex');
    const tx = {
      hash,
      nonce: Number(this.txNonce),
      from,
      to,
      input,
      civicType: type,
      civic,
      value: '0x0',
      gas: '0x0',
      gasPrice: '0x0',
    };
    return tx;
  }

  contractForType(type) {
    const c = this.config.contracts;
    if (type === 'register') return normalizeAddress(c.voterRegistry || '0x1001');
    if (type === 'vote') return normalizeAddress(c.ballotInbox || '0x1002');
    if (type === 'disqualify') {
      return normalizeAddress(c.disqualificationRegistry || '0x1003');
    }
    if (type === 'tally') return normalizeAddress(c.tallyVerifier || '0x1004');
    if (type === 'party_add' || type === 'party_reject' || type === 'party_attest') {
      return normalizeAddress(c.externalPartyRegistry || '0x1006');
    }
    if (type === 'poll_params' || type === 'poll_vote' || type === 'poll_tally') {
      return normalizeAddress(c.pollRegistry || '0x1007');
    }
    if (type === 'election_open') return normalizeAddress(c.electionRegistry || '0x1008');
    return normalizeAddress(c.entryPoint || '0x1005');
  }

  enqueueRaw(rawHex) {
    const tx = this.decodeCivicRaw(rawHex);
    if (this._knownHash(tx.hash)) return tx.hash;
    this.assertWritable();
    this._assertUniqueCivic(tx);
    this._assertAdmitted(tx);
    this._assertChoicePolicy(tx);
    if (this.shouldHoldVote(tx)) {
      tx.receivedAt = this.now();
      this.rememberSealed(tx);
      return tx.hash;
    }
    this.txNonce += 1n;
    this.rememberPending(tx);
    return tx.hash;
  }

  readySealedCount() {
    return this.promoteReadyVotes({ apply: false }).length;
  }

  // Producer gate. Explicit produceBlock() still seals immediately so tests and
  // a manual mine keep parent-hash numbering contiguous.
  shouldProduceBlock() {
    if (!this.config.skipEmptyBlocks) return true;
    if (this.mempool.length > 0) return true;
    if (this.readySealedCount() > 0) return true;
    const now = this.now();
    const headTs = Number(this.head?.timestamp || 0);
    const interval = Number(this.config.disclosureIntervalSeconds) || 0;
    if (interval > 0 && headTs < publishedThrough(now, interval, this.config.disclosureDelaySeconds)) return true;
    const heartbeat = Number(this.config.heartbeatSeconds) || 0;
    if (heartbeat > 0 && now - headTs >= heartbeat) return true;
    return false;
  }

  async tickProducer() {
    // Chain heartbeat (L2_HEARTBEAT_SECONDS) and skip-empty still apply.
    // Only the lease holder reaches them, so a standby cannot seal a
    // second heartbeat block for the same head.
    if (!this.acceptingWrites()) return null;
    if (!this.shouldProduceBlock()) return null;
    return this.produceBlock();
  }

  electionDisclosureContext(electionId) {
    const raw = String(electionId ?? '');
    const key = raw.toLowerCase();
    const entry = this.electionRegistry.get(key);
    let submitted = 0;
    const countTx = (tx) => {
      if (!tx || typeof tx !== 'object') return;
      if (String(tx.civicType || tx.civic?.type || '').toLowerCase() !== 'vote') return;
      const id = String(tx.civic?.electionId ?? '');
      if (id !== raw && id.toLowerCase() !== key) return;
      submitted += 1;
    };
    for (const tx of this.sealed) countTx(tx);
    for (const block of this.blocks) {
      for (const tx of block.transactions || []) countTx(tx);
    }
    const vote = Boolean(entry && (entry.typeInvalid || Number(entry.electionType) === 1));
    const sealed =
      vote &&
      (entry.typeInvalid ||
        voteResultsSealed(
          {
            electionType: 1,
            cutoffTime: entry.typeInvalid ? null : entry.cutoffTime,
          },
          this.now(),
        ));
    return {
      submittedVotes: submitted,
      endTime: entry?.typeInvalid ? null : entry?.cutoffTime ?? null,
      // A sealed vote has no public tally yet. The hourly planner still sees turnout.
      tallied: sealed ? false : this.tallyIndex.has(raw) || this.tallyIndex.has(key),
      resultsSealed: sealed,
      ...(vote ? { minVotes: 0 } : {}),
    };
  }

  promoteReadyVotes({ apply = true } = {}) {
    const now = this.now();
    const interval = Number(this.config.disclosureIntervalSeconds) || 0;
    const delay = Number(this.config.disclosureDelaySeconds) || 0;
    const hourly = [];
    const other = [];
    for (const tx of this.sealed) {
      if (String(tx.civicType || '').toLowerCase() === 'vote') hourly.push(tx);
      else other.push(tx);
    }
    const planned = planPublicBlocks(
      hourly.map((tx) => ({
        tx,
        receivedAt: tx.receivedAt,
        electionId: String(tx.civic?.electionId ?? ''),
      })),
      {
        now,
        intervalSeconds: interval,
        delaySeconds: delay,
        minBlockVotes: this.config.disclosureMinBlockVotes ?? 1,
        minVotes: this.config.resultsMinVotes || 0,
        electionContext: (id) => this.electionDisclosureContext(id),
      },
    );
    const ready = [];
    for (const tx of other) {
      if (interval <= 0 || isDisclosed(tx.receivedAt, now, interval)) ready.push(tx);
      else planned.hold.push({ tx });
    }
    for (const block of planned.publish) {
      for (const item of block.items) {
        if (apply) item.tx.disclosureTimestamp = block.timestamp;
        ready.push(item.tx);
      }
    }
    if (!apply) return ready;
    this.sealed = planned.hold.map((item) => item.tx);
    this.sealedHashes = new Set(this.sealed.map((t) => t.hash.toLowerCase()));
    ready.sort((a, b) => String(a.hash).toLowerCase().localeCompare(String(b.hash).toLowerCase()));
    for (const tx of ready) {
      delete tx.receivedAt;
      tx.nonce = Number(this.txNonce);
      this.txNonce += 1n;
    }
    return ready;
  }

  logsForTx(tx, block, index, logIndexStart) {
    const c = tx.civic || {};
    const type = tx.civicType;
    const logs = [];
    const base = {
      address: tx.to,
      blockHash: block.hash,
      blockNumber: toQuantity(block.number),
      transactionHash: tx.hash,
      transactionIndex: toQuantity(index),
      removed: false,
    };
    if (type === 'register') {
      logs.push({
        ...base,
        logIndex: toQuantity(logIndexStart),
        topics: [
          this.eventTopics.registered,
          topicWord(c.electionId || 0),
          topicWord(c.identityCommitment || 0),
        ],
        data: '0x',
      });
    } else if (type === 'vote') {
      const ballotHash = topicWord(c.ballotHash || ZERO_HASH);
      const relayer = topicWord(tx.from);
      logs.push({
        ...base,
        logIndex: toQuantity(logIndexStart),
        topics: [
          this.eventTopics.voteAccepted,
          topicWord(c.electionId || 0),
          topicWord(c.nullifier || 0),
        ],
        data: ballotHash + relayer.slice(2),
      });
    } else if (type === 'disqualify') {
      logs.push({
        ...base,
        logIndex: toQuantity(logIndexStart),
        topics: [
          this.eventTopics.disqualified,
          topicWord(c.electionId || 0),
          topicWord(c.identityCommitment || 0),
        ],
        data:
          '0x' +
          topicWord(c.reasonCode || 0).slice(2) +
          topicWord(c.evidenceHash || ZERO_HASH).slice(2),
      });
    } else if (type === 'tally') {
      logs.push({
        ...base,
        logIndex: toQuantity(logIndexStart),
        topics: [this.eventTopics.tallySubmitted, topicWord(c.electionId || 0)],
        data: topicWord(c.countsHash || ZERO_HASH),
      });
    } else if (type === 'party_reject') {
      logs.push({
        ...base,
        logIndex: toQuantity(logIndexStart),
        topics: [this.eventTopics.partyRejected, topicWord(c.electionId || 0), topicWord(c.partyId || 0)],
        data:
          '0x' +
          topicWord(c.identityCommitment || 0).slice(2) +
          topicWord(c.reasonCode || 0).slice(2),
      });
    } else if (type === 'party_add') {
      logs.push({
        ...base,
        logIndex: toQuantity(logIndexStart),
        topics: [this.eventTopics.partyAdded, topicWord(c.electionId || 0), topicWord(c.partyId || 0)],
        data: '0x',
      });
    } else if (type === 'party_attest') {
      logs.push({
        ...base,
        logIndex: toQuantity(logIndexStart),
        topics: [
          this.eventTopics.partyAttested,
          topicWord(c.electionId || 0),
          topicWord(c.partyId || 0),
        ],
        data: topicWord(c.identityCommitment || 0),
      });
    } else if (type === 'poll_params' || type === 'poll_vote' || type === 'poll_tally') {
      const topic =
        type === 'poll_params'
          ? this.eventTopics.pollParams
          : type === 'poll_vote'
            ? this.eventTopics.pollVote
            : this.eventTopics.pollTally;
      logs.push({
        ...base,
        logIndex: toQuantity(logIndexStart),
        topics: [topic, topicWord(c.pollId || 0)],
        data: '0x',
      });
    } else if (type === 'userop') {
      logs.push({
        ...base,
        logIndex: toQuantity(logIndexStart),
        topics: [this.eventTopics.userOpAccepted, topicWord(tx.hash)],
        data: topicWord(c.sender || tx.from),
      });
    }
    return logs;
  }

  computeStateRoot(txs) {
    if (!txs.length) return keccak256Hex(new Uint8Array());
    const conc = Buffer.concat(txs.map((tx) => Buffer.from(hexToBytes(tx.hash))));
    return keccak256Hex(conc);
  }

  async produceBlock() {
    if (!this.acceptingWrites()) return null;
    if (this.producing) return null;
    if (!this.head) return null;
    this.producing = true;
    try {
      this.assertWritable();
      const parent = this.head;
      const number = parent.number + 1;
      const promoted = this.promoteReadyVotes();
      const disclosureStamps = promoted
        .map((tx) => tx.disclosureTimestamp)
        .filter((n) => Number.isFinite(n));
      const room = Math.max(0, this.config.maxTxsPerBlock - promoted.length);
      const fromPool = this.mempool.splice(0, room);
      const taken = [...promoted, ...fromPool];
      for (const tx of taken) {
        this.mempoolHashes.delete(tx.hash.toLowerCase());
        delete tx.disclosureTimestamp;
      }
      let timestamp = this.now();
      if (fromPool.length === 0 && promoted.length > 0 && disclosureStamps.length === promoted.length) {
        const clock = Math.max(...disclosureStamps);
        timestamp = Math.max(Number(parent.timestamp) || 0, Math.min(this.now(), clock));
      }
      const stateRoot = this.computeStateRoot(taken);
      const extraData = '0x' + Buffer.from('NOT-FOR-PROFIT').toString('hex');
      const hash = keccak256Hex(
        Buffer.concat([
          hexToBytes(parent.hash),
          hexToBytes(stateRoot),
          hexToBytes(stateRoot),
          u64be(number),
          u64be(timestamp),
        ]),
      );
      const logs = [];
      const sealed = taken.map((tx, i) => {
        const txLogs = this.logsForTx(tx, { hash, number }, i, logs.length);
        logs.push(...txLogs);
        return {
          ...tx,
          blockHash: hash,
          blockNumber: number,
          transactionIndex: i,
        };
      });
      const block = this.formatBlock({
        number,
        hash,
        parentHash: parent.hash,
        stateRoot,
        transactionsRoot: stateRoot,
        timestamp,
        extraData,
        transactions: sealed,
        logs,
      });
      this.ingestLoadedBlock(block);
      this.persistBlock(block);
      this.postExplorer(block).catch((err) => {
        const now = Date.now();
        if (now - (this._ingestWarnedAt || 0) > 15_000) {
          this._ingestWarnedAt = now;
          console.warn('explorer ingest failed (ignored):', err.message || err);
        }
      });
      return block;
    } finally {
      this.producing = false;
    }
  }

  async postExplorer(block) {
    const base = this.config.zkVotingNodeUrl;
    if (!base) return;
    const outcomes = {
      register: [],
      vote: [],
      disqualify: [],
      tally: [],
      userop: [],
      party_add: [],
      party_reject: [],
      party_attest: [],
      poll_params: [],
      poll_vote: [],
      poll_tally: [],
    };
    for (const tx of block.transactions) {
      const pub = publicFieldsForTx(tx);
      if (outcomes[pub.type]) outcomes[pub.type].push(pub);
    }
    const body = {
      source: 'zk-voting-l2',
      notForProfit: true,
      chainId: this.config.chainId,
      block: this.rpcBlock(block, true),
      outcomes,
    };
    const headers = { 'content-type': 'application/json' };
    if (this.config.explorerIngestSecret) {
      headers['x-zk-voting-ingest-secret'] = this.config.explorerIngestSecret;
    }
    let wait = 400;
    let res;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(`${base}/api/explorer/ingest`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      });
      if (res.status !== 503 || attempt === 4) break;
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait;
      await new Promise((r) => setTimeout(r, delay));
      wait = Math.min(wait * 2, 2000);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  }

  resolveBlockTag(tag) {
    if (tag === undefined || tag === null || tag === 'latest' || tag === 'safe' || tag === 'finalized') {
      return this.head;
    }
    if (tag === 'earliest') return this.blocks[0];
    if (tag === 'pending') {
      const parent = this.head;
      const txs = this.mempool.slice();
      const stateRoot = this.computeStateRoot(txs);
      return this.formatBlock({
        number: parent.number + 1,
        hash: ZERO_HASH,
        parentHash: parent.hash,
        stateRoot,
        transactionsRoot: stateRoot,
        timestamp: this.now(),
        extraData: '0x' + Buffer.from('NOT-FOR-PROFIT').toString('hex'),
        transactions: txs,
        logs: [],
      });
    }
    const n = Number(typeof tag === 'bigint' ? tag : parseQuantity(tag));
    return this.blocks[n] || null;
  }

  getBlockByNumber(tag, fullTxs) {
    return this.rpcBlock(this.resolveBlockTag(tag), Boolean(fullTxs));
  }

  getBlockByHash(hash, fullTxs) {
    if (!hash) return null;
    return this.rpcBlock(this.blocksByHash.get(String(hash).toLowerCase()), Boolean(fullTxs));
  }

  getTransactionByHash(hash) {
    if (!hash) return null;
    const tx = this.txsByHash.get(String(hash).toLowerCase());
    if (tx) return tx.archived ? null : this.rpcTx(tx);
    const pending = this.mempool.find((t) => t.hash.toLowerCase() === String(hash).toLowerCase());
    return pending ? this.rpcTx(pending) : null;
  }

  getLogs(filter = {}) {
    const from = this.resolveBlockTag(filter.fromBlock || 'earliest');
    const to = this.resolveBlockTag(filter.toBlock || 'latest');
    const fromN = from ? from.number : 0;
    const toN = to ? to.number : this.latestNumber;
    let addresses = filter.address
      ? (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) =>
          normalizeAddress(a),
        )
      : null;
    const topics = filter.topics || [];
    const out = [];
    for (const log of this.logs) {
      const n = Number(BigInt(log.blockNumber));
      if (n < fromN || n > toN) continue;
      if (addresses && !addresses.includes(normalizeAddress(log.address))) continue;
      if (!topicsMatch(topics, log.topics)) continue;
      out.push(log);
    }
    return out;
  }

  getBalance(address) {
    const addr = normalizeAddress(address);
    if (
      addr === this.config.sequencer ||
      addr === this.config.paymaster ||
      addr === this.config.bundler
    ) {
      return toQuantity(this.config.paymasterBalanceWei);
    }
    return '0x0';
  }

  ethCall(call = {}) {
    const data = String(call.data || call.input || '0x');
    const selector = data.slice(0, 10).toLowerCase();
    if (selector === '0x70a08231' && data.length >= 74) {
      const addr = '0x' + data.slice(data.length - 40);
      const bal = this.getBalance(addr);
      return '0x' + BigInt(bal).toString(16).padStart(64, '0');
    }
    return '0x';
  }

  startProducer() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      while (this.running) {
        const started = Date.now();
        try {
          await this.tickProducer();
        } catch (err) {
          console.error('block production error:', err);
        }
        const wait = Math.max(0, this.config.blockTimeMs - (Date.now() - started));
        await new Promise((r) => setTimeout(r, wait));
      }
    };
    this.producerTask = loop();
  }

  async stop() {
    this.shuttingDown = true;
    this.running = false;
    if (this._promoteTimer) {
      clearInterval(this._promoteTimer);
      this._promoteTimer = null;
    }
    if (this.producerTask) {
      await this.producerTask.catch(() => {});
    }
    const deadline = Date.now() + 8_000;
    while (this.producing && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (this.writerLease && this.writerActive && this.head) {
      this._flushing = true;
      try {
        this.persistHead();
      } catch (err) {
        console.warn('sequencer flush failed:', err.message || err);
      }
      this._flushing = false;
    }
    if (this.writerLease) this.writerLease.release();
    this.writerActive = false;
  }

  attachLease() {
    if (this.config.writerLease === false) {
      this.writerLease = null;
      this.writerActive = true;
      return;
    }
    this.writerLease = new WriterLease({
      dataDir: this.config.dataDir,
      role: 'sequencer',
      ttlMs: this.config.leaseTtlMs,
      ownerId: this.config.leaseOwnerId,
      nowFn: this.config.leaseNowFn,
    });
    const got = this.writerLease.tryAcquire();
    this.writerActive = got.acquired;
    if (got.acquired) this.writerLease.startHeartbeat();
  }

  writerEpoch() {
    return this.writerLease && this.writerActive ? this.writerLease.epoch : 0;
  }

  acceptingWrites() {
    if (this.shuttingDown && !this._flushing) return false;
    if (!this.writerLease) return true;
    return Boolean(this.writerActive && this.writerLease.holds() && !this.writerLease.draining);
  }

  assertWritable() {
    if (this.shuttingDown && !this._flushing) {
      throw Object.assign(new Error('maintenance handover'), {
        code: -32003,
        httpStatus: 503,
        retryAfter: 2,
      });
    }
    if (!this.writerLease) return;
    if (!this.writerActive || this.writerLease.draining || !this.writerLease.holds()) {
      throw Object.assign(new Error('maintenance handover'), {
        code: -32003,
        httpStatus: 503,
        retryAfter: 2,
      });
    }
    try {
      this.writerLease.assertFence();
    } catch (err) {
      if (err instanceof StaleFenceError || err.code === 'STALE_FENCE') {
        this.writerActive = false;
        throw Object.assign(new Error('stale writer fence'), { code: -32003, httpStatus: 503 });
      }
      throw err;
    }
  }

  _knownHash(hash) {
    const key = String(hash || '').toLowerCase();
    return this.txsByHash.has(key) || this.mempoolHashes.has(key) || this.sealedHashes.has(key);
  }

  _indexCivic(tx) {
    if (!tx || typeof tx !== 'object') return;
    const civic = tx.civic || {};
    const type = String(tx.civicType || civic.type || '').toLowerCase();
    const election = String(civic.electionId ?? '');
    if (type === 'vote' && civic.nullifier != null && normId(civic.nullifier)) {
      this.nullifierIndex.add(`${election}|${normId(civic.nullifier)}`);
    }
    if ((type === 'register' || type === 'disqualify') && civic.identityCommitment != null) {
      const id = normId(civic.identityCommitment);
      if (id) this.commitmentIndex.add(`${type}|${election}|${id}`);
    }
    if (type === 'tally') this.tallyIndex.add(election);
    if (type === 'election_open' && election) {
      const key = election.toLowerCase();
      if (!this.electionRegistry.has(key)) {
        this.electionRegistry.set(key, {
          electionUuid: key,
          openTx: tx.hash,
          eligibleRoots: new Set(),
          approvedSenders: new Set(),
          cutoffTime: null,
        });
      }
      const entry = this.electionRegistry.get(key);
      if (civic.cutoffTime != null && Number.isFinite(Number(civic.cutoffTime))) {
        entry.cutoffTime = Number(civic.cutoffTime);
      }
      if (civic.electionType != null && civic.electionType !== '') {
        try {
          entry.electionType = normalizeElectionType(civic.electionType, { required: true });
          entry.typeInvalid = false;
        } catch {
          // Fail closed on replay: an unknown type keeps choice results sealed.
          entry.electionType = 1;
          entry.cutoffTime = null;
          entry.typeInvalid = true;
        }
      }
      if (civic.eligibleRoot != null) entry.eligibleRoots.add(topicWord(civic.eligibleRoot));
      for (const a of Array.isArray(civic.approvedSenders) ? civic.approvedSenders : []) {
        entry.approvedSenders.add(normalizeAddress(a));
      }
    }
    if (type === 'register' && election && civic.eligibleRoot != null) {
      const entry = this.electionRegistry.get(election.toLowerCase());
      if (entry) entry.eligibleRoots.add(topicWord(civic.eligibleRoot));
    }
  }

  /**
   * Admission gate for a gasless chain (strict mode). Voters pay nothing, so
   * the sequencer refuses anything that is not operator-authenticated or bound
   * to an election this L2 opened and voters this L2 approved.
   */
  _assertAdmitted(tx) {
    if (this.config.admission !== 'strict') return;
    const reject = (msg) => {
      throw Object.assign(new Error(`not admitted: ${msg}`), { code: -32001 });
    };
    const civic = tx.civic || {};
    const type = String(tx.civicType || '').toLowerCase();
    if (isAdminTxType(type)) {
      const auth = verifyAdminCivic(civic, {
        secret: this.config.adminSecret,
        chainId: this.config.chainId,
        l2Uuid: this.config.l2Uuid,
      });
      if (!auth.ok) reject(auth.reason);
    }
    if (type === 'election_open') {
      const id = String(civic.electionId ?? '');
      if (!ELECTION_UUID_RE.test(id)) reject('electionId must be a UUID');
      if (this.electionRegistry.has(id.toLowerCase())) reject('election UUID already exists on this L2');
      return;
    }
    if (!ELECTION_SCOPED_TYPES.has(type)) return;
    const id = String(civic.electionId ?? '').toLowerCase();
    if (!ELECTION_UUID_RE.test(id)) reject('electionId must be a UUID opened on this L2');
    const entry = this.electionRegistry.get(id);
    if (!entry) reject('unknown election on this L2');
    if (type === 'vote') {
      if (entry.eligibleRoots.size === 0) reject('no approved voters for this election yet');
      if (civic.eligibleRoot == null) reject('vote must bind the election eligibleRoot');
      if (!entry.eligibleRoots.has(topicWord(civic.eligibleRoot))) {
        reject('eligibleRoot is not an approved voter set for this election');
      }
    }
    if (type === 'userop') {
      const sender = civic.sender ? normalizeAddress(civic.sender) : '';
      if (!sender || !entry.approvedSenders.has(sender)) reject('sender is not approved for this election');
    }
  }

  /** Public view of one election on this L2. Never includes ballots or secrets. */
  electionInfo(electionUuid) {
    const key = String(electionUuid || '').toLowerCase();
    const entry = this.electionRegistry.get(key);
    if (!entry) return null;
    const sealedVote =
      entry.typeInvalid ||
      voteResultsSealed(
        {
          electionType: entry.typeInvalid ? 1 : entry.electionType,
          cutoffTime: entry.typeInvalid ? null : entry.cutoffTime,
        },
        this.now(),
      );
    let registered = 0;
    let votes = 0;
    let tally = null;
    let openedAtBlock = null;
    for (const block of this.blocks) {
      for (const tx of block.transactions || []) {
        if (!tx || typeof tx !== 'object') continue;
        const c = tx.civic || {};
        if (String(c.electionId ?? '').toLowerCase() !== key) continue;
        const t = String(tx.civicType || c.type || '').toLowerCase();
        if (t === 'election_open') openedAtBlock = block.number;
        else if (t === 'register') registered += 1;
        else if (t === 'vote') votes += 1;
        else if (t === 'tally') {
          const choiceSealed =
            entry.typeInvalid ||
            voteResultsSealed(
              { electionType: entry.electionType, cutoffTime: entry.cutoffTime },
              this.now(),
            );
          if (!choiceSealed) {
            tally = {
              blockNumber: block.number,
              txHash: tx.hash,
              countsHash: c.countsHash != null ? topicWord(c.countsHash) : null,
              resultHash: c.resultHash != null ? topicWord(c.resultHash) : null,
              counts: Array.isArray(c.counts) || (c.counts && typeof c.counts === 'object') ? c.counts : null,
            };
          }
        }
      }
    }
    return {
      electionUuid: key,
      openTx: entry.openTx,
      openedAtBlock,
      eligibleRoots: [...entry.eligibleRoots],
      approvedSenders: entry.approvedSenders.size,
      registered,
      electionType: entry.typeInvalid ? null : entry.electionType ?? null,
      typeInvalid: Boolean(entry.typeInvalid),
      // Turnout already in blocks. Choice data stays on tally, which is null while sealed.
      votesSealedInBlocks: votes,
      tally: sealedVote ? null : tally,
    };
  }

  listElections() {
    return [...this.electionRegistry.keys()];
  }

  _assertUniqueCivic(tx) {
    const civic = tx.civic || {};
    const type = String(tx.civicType || '').toLowerCase();
    const election = String(civic.electionId ?? '');
    if (type === 'vote' && civic.nullifier != null && normId(civic.nullifier)) {
      const key = `${election}|${normId(civic.nullifier)}`;
      if (this.nullifierIndex.has(key)) {
        throw Object.assign(new Error('duplicate nullifier'), { code: -32000 });
      }
    }
    if ((type === 'register' || type === 'disqualify') && civic.identityCommitment != null) {
      const key = `${type}|${election}|${normId(civic.identityCommitment)}`;
      if (this.commitmentIndex.has(key)) {
        throw Object.assign(new Error(`duplicate identityCommitment for ${type}`), { code: -32000 });
      }
    }
    if (type === 'tally' && this.tallyIndex.has(election)) {
      throw Object.assign(new Error('duplicate tally'), { code: -32000 });
    }
  }

  reloadFromDisk() {
    this.blocks = [];
    this.blocksByHash = new Map();
    this.txsByHash = new Map();
    this.logs = [];
    this.mempool = [];
    this.mempoolHashes = new Set();
    this.sealed = [];
    this.sealedHashes = new Set();
    this.txNonce = 0n;
    this._latestNumber = null;
    this.nullifierIndex = new Set();
    this.commitmentIndex = new Set();
    this.tallyIndex = new Set();
    this.electionRegistry = new Map();
    this.load();
    if (this.writerActive && this.blocks.length === 0) this.writeGenesis();
  }

  /** Active producer, or poll until the previous container releases the lease. */
  armProducer() {
    const start = () => {
      this.writerLease?.startHeartbeat();
      this.startProducer();
    };
    if (!this.writerLease || this.writerActive) {
      start();
      return;
    }
    console.log('sequencer standby; waiting for the writer lease');
    this._promoteTimer = setInterval(() => {
      if (this.shuttingDown) return;
      const got = this.writerLease.tryAcquire();
      if (!got.acquired) return;
      clearInterval(this._promoteTimer);
      this._promoteTimer = null;
      this.writerActive = true;
      this.reloadFromDisk();
      console.log(`sequencer active epoch=${got.epoch} head=${this.latestNumber}`);
      start();
    }, this.writerLease.pollMs);
    if (typeof this._promoteTimer.unref === 'function') this._promoteTimer.unref();
  }
}

function readArchiveIndexFile(dataDir) {
  const file = path.join(dataDir, 'archive', 'index.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function rememberArchivedTxHashes(state, archiveIndex) {
  if (!archiveIndex || !archiveIndex.hours) return;
  for (const hour of Object.values(archiveIndex.hours)) {
    for (const hash of hour.txHashes || []) {
      const key = String(hash).toLowerCase();
      if (!key || state.txsByHash.has(key)) continue;
      state.txsByHash.set(key, { hash, archived: true });
    }
  }
}

function isPollBytes32(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value || ''));
}

function isPollAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));
}

function assertPollShape(type, civic) {
  const bad = (message) => Object.assign(new Error(message), { code: -32602 });
  if (!civic || !civic.pollId) throw bad('pollId required');
  if (type === 'poll_params') {
    if (!isPollBytes32(civic.pollParamsHash)) throw bad('pollParamsHash required');
    if (!isPollAddress(civic.token)) throw bad('token required');
    const chain = Number(civic.tokenChainId);
    if (!Number.isInteger(chain) || chain <= 0 || chain === CHAIN_ID) throw bad('tokenChainId invalid');
    const start = Number(civic.startTime);
    const cutoff = Number(civic.cutoffTime);
    if (!Number.isFinite(start) || !Number.isFinite(cutoff) || start >= cutoff) throw bad('window invalid');
  } else if (type === 'poll_vote') {
    if (!isPollAddress(civic.voter)) throw bad('voter required');
    if (!Number.isInteger(Number(civic.voteBlock))) throw bad('voteBlock required');
    if (!/^\d+$/.test(String(civic.provisionalWeight ?? ''))) throw bad('provisionalWeight required');
    if (!isPollBytes32(civic.choicesHash)) throw bad('choicesHash required');
    if (!isPollBytes32(civic.ballotDigest)) throw bad('ballotDigest required');
  } else if (type === 'poll_tally') {
    if (!Number.isInteger(Number(civic.closeBlock))) throw bad('closeBlock required');
    if (!isPollBytes32(civic.ballotsRoot)) throw bad('ballotsRoot required');
    if (!isPollBytes32(civic.resultHash)) throw bad('resultHash required');
    if (!/^\d+$/.test(String(civic.participation ?? ''))) throw bad('participation required');
    if (!civic.outcome) throw bad('outcome required');
  }
}

const VOTE_ALLOWED_KEYS = new Set([
  'type',
  'electionid',
  'nullifier',
  'ballothash',
  'ballotcommitment',
  'eligibleroot',
  'root',
  'disqualificationroot',
  'disqroot',
  'proof',
  'publicinputs',
  'encryptedballot',
]);

const VOTE_REJECT_KEYS = new Set([
  'identitycommitment',
  'answers',
  'ranking',
  'rankingpayload',
  'choice',
  'option',
  'optionid',
  'plaintext',
  'ballotplaintext',
  'selected',
  'selectedoption',
  'voteplaintext',
  'candidate',
  'userophash',
  'credentialid',
  'address',
  'userid',
  'user_id',
]);

function rejectedVoteKey(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = rejectedVoteKey(item);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const k = String(key).toLowerCase();
    if (VOTE_REJECT_KEYS.has(k) || FORBIDDEN_KEYS.has(k)) return key;
    const hit = rejectedVoteKey(child);
    if (hit) return hit;
  }
  return null;
}

/** Vote txs keep only the statement, the proof, and the ciphertext. */
export function allowVoteFields(civic) {
  const refused = rejectedVoteKey(civic);
  if (refused) {
    throw Object.assign(new Error(`vote field refused: ${refused}`), { code: -32602 });
  }
  const out = { type: 'vote' };
  for (const [key, value] of Object.entries(civic || {})) {
    if (String(key).toLowerCase() === 'type') continue;
    if (!VOTE_ALLOWED_KEYS.has(String(key).toLowerCase())) continue;
    out[key] = value;
  }
  delete out.sender;
  delete out.from;
  return out;
}

function containsBallotPlaintext(value) {
  if (!value || typeof value !== 'object') return false;
  const banned = new Set([
    'plaintext',
    'choice',
    'optionid',
    'option',
    'ballotplaintext',
    'selectedoption',
    'selected',
    'voteplaintext',
    'candidate',
  ]);
  if (Array.isArray(value)) return value.some(containsBallotPlaintext);
  for (const [k, v] of Object.entries(value)) {
    if (banned.has(String(k).toLowerCase())) return true;
    if (v && typeof v === 'object' && containsBallotPlaintext(v)) return true;
  }
  return false;
}

function topicsMatch(filterTopics, logTopics) {
  if (!filterTopics || !filterTopics.length) return true;
  for (let i = 0; i < filterTopics.length; i++) {
    const f = filterTopics[i];
    if (f == null) continue;
    const candidates = (Array.isArray(f) ? f : [f]).filter((x) => x != null).map((x) =>
      String(x).toLowerCase(),
    );
    if (!candidates.length) continue;
    const have = String(logTopics[i] || '').toLowerCase();
    if (!candidates.includes(have)) return false;
  }
  return true;
}
