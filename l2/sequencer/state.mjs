// NOT FOR PROFIT — civic public good, not a commercial sequencer.
// Republic L2 chain state, civic mempool, and keccak256 (Ethereum).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  disclosurePublicView,
  isDisclosed,
  isHeldVoteType,
  resolveDisclosureIntervalSeconds,
} from '../disclosure.mjs';

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
]);

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

export function stripForbidden(value) {
  if (Array.isArray(value)) return value.map(stripForbidden);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(String(k).toLowerCase())) continue;
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
  if (c.identityCommitment != null) {
    out.identityCommitment = topicWord(c.identityCommitment);
  }
  if (c.eligibleRoot != null) out.eligibleRoot = topicWord(c.eligibleRoot);
  if (c.disqualificationRoot != null) {
    out.disqualificationRoot = topicWord(c.disqualificationRoot);
  }
  if (c.reasonCode != null) out.reasonCode = Number(c.reasonCode);
  if (c.evidenceHash != null) out.evidenceHash = topicWord(c.evidenceHash);
  if (c.countsHash != null) out.countsHash = topicWord(c.countsHash);
  if (type === 'userop' && c.sender) out.sender = normalizeAddress(c.sender);
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
    republicNodeUrl: (process.env.REPUBLIC_NODE_URL || file.republicNodeUrl || '').replace(
      /\/$/,
      '',
    ),
    l1Rpc: process.env.L1_RPC || file.l1Rpc || '',
    settlementAddress: process.env.SETTLEMENT_ADDRESS || file.settlementAddress || '',
    privateKey: process.env.PRIVATE_KEY || '',
    devMockProof: parseBool(process.env.DEV_MOCK_PROOF, file.devMockProof !== false),
    voteProvingPath: parseBool(process.env.REPUBLIC_PROVING_PATH, false),
    l2RpcUrl:
      process.env.L2_RPC_URL ||
      `http://${process.env.L2_RPC_HOST || file.rpcHost || '127.0.0.1'}:${
        process.env.L2_RPC_PORT || file.rpcPort || 8546
      }`,
    disclosureIntervalSeconds: resolveDisclosureIntervalSeconds(
      process.env.DISCLOSURE_INTERVAL_SECONDS ?? file.disclosureIntervalSeconds,
      { isTest: process.env.NODE_ENV === 'test' },
    ),
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
    this.producing = false;
    this.running = false;
    this.producerTask = null;
    this.eventTopics = {
      registered: topic0('Registered(uint256,uint256)'),
      voteAccepted: topic0('VoteAccepted(uint256,uint256,bytes32,address)'),
      disqualified: topic0('Disqualified(uint256,uint256,uint16,bytes32)'),
      tallySubmitted: topic0('TallySubmitted(uint256,bytes32)'),
      userOpAccepted: topic0('UserOpAccepted(bytes32,address)'),
    };
  }

  static open(config) {
    const state = new ChainState(config);
    fs.mkdirSync(path.join(config.dataDir, 'blocks'), { recursive: true });
    fs.mkdirSync(path.join(config.dataDir, 'proofs'), { recursive: true });
    state.load();
    if (state.blocks.length === 0) {
      state.writeGenesis();
    }
    return state;
  }

  get head() {
    return this.blocks[this.blocks.length - 1];
  }

  get latestNumber() {
    return this.head ? this.head.number : 0;
  }

  now() {
    if (typeof this.config.nowFn === 'function') return this.config.nowFn();
    return Math.floor(Date.now() / 1000);
  }

  disclosureView() {
    return disclosurePublicView(this.now(), this.config.disclosureIntervalSeconds);
  }

  blockPath(number) {
    return path.join(this.config.dataDir, 'blocks', `${number}.json`);
  }

  load() {
    const headPath = path.join(this.config.dataDir, 'head.json');
    if (!fs.existsSync(headPath)) return;
    const head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
    const max = Number(head.number || 0);
    for (let n = 0; n <= max; n++) {
      const file = this.blockPath(n);
      if (!fs.existsSync(file)) {
        throw new Error(`missing block file ${file}`);
      }
      const block = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.ingestLoadedBlock(block);
    }
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
      }
    }
  }

  ingestLoadedBlock(block) {
    this.blocks.push(block);
    this.blocksByHash.set(block.hash.toLowerCase(), block);
    const txs = Array.isArray(block.transactions) ? block.transactions : [];
    for (const tx of txs) {
      if (typeof tx === 'string') continue;
      this.txsByHash.set(tx.hash.toLowerCase(), tx);
      this.txNonce = BigInt(tx.nonce || 0) + 1n;
    }
    if (Array.isArray(block.logs)) {
      for (const log of block.logs) this.logs.push(log);
    }
  }

  persistHead() {
    writeJsonAtomic(path.join(this.config.dataDir, 'head.json'), {
      number: this.head.number,
      hash: this.head.hash,
      stateRoot: this.head.stateRoot,
    });
    writeJsonAtomic(path.join(this.config.dataDir, 'mempool.json'), this.mempool);
    this.persistSealed();
  }

  persistSealed() {
    writeJsonAtomic(path.join(this.config.dataDir, 'sealed.json'), this.sealed);
  }

  persistBlock(block) {
    writeJsonAtomic(this.blockPath(block.number), block);
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
    if (persist) this.persistHead();
  }

  rememberSealed(tx) {
    const hash = tx.hash.toLowerCase();
    if (this.txsByHash.has(hash) || this.mempoolHashes.has(hash) || this.sealedHashes.has(hash)) {
      throw Object.assign(new Error('already known'), { code: -32000 });
    }
    this.sealed.push(tx);
    this.sealedHashes.add(hash);
    this.persistSealed();
  }

  shouldHoldVote(tx) {
    const interval = Number(this.config.disclosureIntervalSeconds) || 0;
    return interval > 0 && isHeldVoteType(tx.civicType);
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
    if (!CIVIC_TYPES.includes(type)) {
      throw Object.assign(new Error(`unsupported civic tx type: ${type}`), {
        code: -32602,
      });
    }
    if (type === 'vote' && containsBallotPlaintext(originalCivic)) {
      throw Object.assign(new Error('ballot plaintext is forbidden'), { code: -32602 });
    }
    civic = stripForbidden(originalCivic);
    civic.type = type;
    if (type === 'vote') {
      delete civic.sender;
      delete civic.from;
    }
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
    return normalizeAddress(c.entryPoint || '0x1005');
  }

  enqueueRaw(rawHex) {
    const tx = this.decodeCivicRaw(rawHex);
    if (this.shouldHoldVote(tx)) {
      tx.receivedAt = this.now();
      this.rememberSealed(tx);
      return tx.hash;
    }
    this.txNonce += 1n;
    this.rememberPending(tx);
    return tx.hash;
  }

  promoteReadyVotes() {
    const now = this.now();
    const interval = Number(this.config.disclosureIntervalSeconds) || 0;
    const ready = [];
    const keep = [];
    for (const tx of this.sealed) {
      if (interval <= 0 || isDisclosed(tx.receivedAt, now, interval)) ready.push(tx);
      else keep.push(tx);
    }
    this.sealed = keep;
    this.sealedHashes = new Set(keep.map((t) => t.hash.toLowerCase()));
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
    if (this.producing) return null;
    this.producing = true;
    try {
      const parent = this.head;
      const number = parent.number + 1;
      const timestamp = this.now();
      const promoted = this.promoteReadyVotes();
      const room = Math.max(0, this.config.maxTxsPerBlock - promoted.length);
      const taken = [...promoted, ...this.mempool.splice(0, room)];
      for (const tx of taken) this.mempoolHashes.delete(tx.hash.toLowerCase());
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
    const base = this.config.republicNodeUrl;
    if (!base) return;
    const outcomes = { register: [], vote: [], disqualify: [], tally: [], userop: [] };
    for (const tx of block.transactions) {
      const pub = publicFieldsForTx(tx);
      if (outcomes[pub.type]) outcomes[pub.type].push(pub);
    }
    const body = {
      source: 'republic-l2',
      notForProfit: true,
      chainId: this.config.chainId,
      block: this.rpcBlock(block, true),
      outcomes,
    };
    const res = await fetch(`${base}/api/explorer/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
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
    if (tx) return this.rpcTx(tx);
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
          await this.produceBlock();
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
    this.running = false;
    if (this.producerTask) {
      await this.producerTask.catch(() => {});
    }
  }
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
