// NOT FOR PROFIT — civic public good, not a commercial product.
// Append-only L2 log. Vote proofs stay sealed until the hour that contained them
// has closed, the disclosure delay has elapsed, and the block meets the floor.
// Turnout follows that clock from the first ballot. Choice rows stay on their
// own rule. Ready rows land in one disclosure block (disclosure-clock
// timestamp, ordered by nullifier). Payloads never include a voter choice or a passkey user id.

import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { keccak256, stringToHex } from 'viem';

import {
  publicDisclosureView,
  hourBucket,
  isDelayedPublicType,
  isDisclosed,
  planPublicBlocks,
} from './disclosure.mjs';
import { PgDocument, migrate, recordImport, usingPostgres } from './db.mjs';

const CHOICE_FIELD_KEYS = new Set([
  'counts',
  'countshash',
  'resulthash',
  'winners',
  'winner',
  'openedballots',
  'choice',
  'plaintext',
  'ranking',
  'rankingpayload',
]);

function isChoiceDisclosure(type, payload) {
  const name = String(type || '').toLowerCase();
  if (name === 'tally' || name === 'l1_certify') return true;
  if (!payload || typeof payload !== 'object') return false;
  return Object.keys(payload).some((key) => CHOICE_FIELD_KEYS.has(String(key).toLowerCase()));
}

function withoutChoiceFields(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (CHOICE_FIELD_KEYS.has(String(key).toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/** Vote rows follow the same hourly import as a poll. An unknown election fails closed. */
function pollIdOf(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const id = payload.pollId ?? payload.electionId;
  return id != null ? String(id) : '';
}

function voteImportBlocked(explorer, payload) {
  const policy = explorer.disclosurePolicySnapshot();
  const id = pollIdOf(payload);
  const ctx = typeof policy.electionContext === 'function' ? policy.electionContext(id) || {} : {};
  return ctx.known === false;
}

/**
 * Choice rows stay out of the explorer until the block timestamp is at the
 * deadline. The node clock is not the seal: a late node must not drop a
 * block the chain already released. Unknown elections fail closed.
 */
function choiceRowBlocked(explorer, type, payload, at) {
  if (!isChoiceDisclosure(type, payload)) return false;
  const policy = explorer.disclosurePolicySnapshot();
  const id = pollIdOf(payload);
  const ctx = typeof policy.electionContext === 'function' ? policy.electionContext(id) || {} : {};
  if (ctx.known === false) return true;
  if (ctx.vote === true) {
    const end = Number(ctx.endTime);
    const when = Number(at);
    if (!Number.isFinite(end) || !Number.isFinite(when)) return true;
    return when < end;
  }
  return Boolean(ctx.resultsSealed);
}

function emptyChain(chainId) {
  return {
    chainId,
    nfp: true,
    app: 'zk-voting',
    genesisHash: `0x${'00'.repeat(32)}`,
    blocks: [],
    txs: {},
    sealed: [],
    sealedPolls: [],
    seenBlockHashes: [],
    ingestedTxHashes: [],
    ingestedTxByBlock: {},
    ingestedOutcomeKeys: [],
    // Not part of a block hash. Maps an earlier poll row hash to the later one.
    supersededBy: {},
    // Not part of a block hash. Source L2 height, sequence, or postedAt per tx.
    sourceOrder: {},
  };
}

/** Hashless outcomes rows have no block to prune, so the remembered keys are capped. */
export const OUTCOMES_ONLY_KEY_CAP = 64;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadIndexKey(type, payload) {
  return `${String(type || '').toLowerCase()}|${stable(payload)}`;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Source L2 height and index, or a sequence, or postedAt when the source has no height. */
function sourceOrderOf(payload, block, index) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const height = finiteNumber(block?.number ?? block?.height ?? body.l2Block ?? body.blockNumber ?? body.sourceBlock);
  const listed = finiteNumber(body.txIndex);
  const at = listed != null ? listed : finiteNumber(index) ?? 0;
  if (height != null) return { height, index: at };
  const sequence = finiteNumber(body.sequence ?? body.tallySequence);
  if (sequence != null) return { sequence, index: 0 };
  const postedAt = finiteNumber(body.postedAt);
  if (postedAt != null) return { postedAt, index: 0 };
  return null;
}

/** Negative when `a` is older than `b`. Null when the two orders cannot be compared. */
function compareSource(a, b) {
  if (!a || !b) return null;
  if (a.height != null && b.height != null) {
    if (a.height !== b.height) return a.height < b.height ? -1 : 1;
    const ai = a.index ?? 0;
    const bi = b.index ?? 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
    return 0;
  }
  if (a.sequence != null && b.sequence != null) {
    if (a.sequence !== b.sequence) return a.sequence < b.sequence ? -1 : 1;
    return 0;
  }
  if (a.postedAt != null && b.postedAt != null) {
    if (a.postedAt !== b.postedAt) return a.postedAt < b.postedAt ? -1 : 1;
    return 0;
  }
  return null;
}

function pollCandidateWins(next, prev) {
  const cmp = compareSource(next.order, prev.order);
  if (cmp != null) return cmp > 0;
  if (next.position.number !== prev.position.number) return next.position.number > prev.position.number;
  return next.position.index > prev.position.index;
}

/** Stable id for a row that arrived without a transaction hash. */
function ingestKey(type, payload, blockHash, index) {
  const listed = payload && payload.hash != null ? String(payload.hash).trim().toLowerCase() : '';
  if (listed && listed !== 'undefined') return listed;
  const block = blockHash ? String(blockHash).toLowerCase() : '';
  const tail = block && index != null ? `${index}|${stable(payload)}` : stable(payload);
  return createHash('sha256').update(`${type}|${block}|${tail}`).digest('hex');
}

function votePayload(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  return {
    nullifier: payloadNullifier(src),
    ballotHash: src.ballotHash,
    electionId: src.electionId != null ? String(src.electionId) : undefined,
    relayer: src.relayer || 'node',
  };
}

function payloadNullifier(src) {
  return src.nullifier != null ? String(src.nullifier) : '';
}

function sameNullifier(a, b) {
  const x = String(a || '')
    .toLowerCase()
    .replace(/^0x/, '');
  const y = String(b || '')
    .toLowerCase()
    .replace(/^0x/, '');
  if (!x || !y) return false;
  return x === y || x.endsWith(y) || y.endsWith(x);
}

function normalizeChain(chain, chainId) {
  chain.chainId = chain.chainId || chainId;
  chain.blocks = chain.blocks || [];
  chain.txs = chain.txs || {};
  chain.sealed = Array.isArray(chain.sealed) ? chain.sealed : [];
  chain.sealedPolls = Array.isArray(chain.sealedPolls) ? chain.sealedPolls : [];
  chain.seenBlockHashes = Array.isArray(chain.seenBlockHashes) ? chain.seenBlockHashes : [];
  chain.ingestedTxHashes = Array.isArray(chain.ingestedTxHashes) ? chain.ingestedTxHashes : [];
  if (!chain.ingestedTxByBlock || typeof chain.ingestedTxByBlock !== 'object' || Array.isArray(chain.ingestedTxByBlock)) {
    chain.ingestedTxByBlock = {};
  }
  chain.ingestedOutcomeKeys = Array.isArray(chain.ingestedOutcomeKeys) ? chain.ingestedOutcomeKeys : [];
  if (!chain.supersededBy || typeof chain.supersededBy !== 'object' || Array.isArray(chain.supersededBy)) {
    chain.supersededBy = {};
  }
  if (!chain.sourceOrder || typeof chain.sourceOrder !== 'object' || Array.isArray(chain.sourceOrder)) {
    chain.sourceOrder = {};
  }
  return chain;
}

const PG_NAMESPACE = 'l2chain';

async function readChainFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export class Explorer {
  constructor(filePath, chain) {
    this.filePath = filePath;
    this.chain = chain;
    this._write = Promise.resolve();
    this.backend = 'json';
    this.pg = null;
  }

  static async open(config) {
    await fs.mkdir(config.dataDir, { recursive: true });
    const filePath = config.l2ChainFile || path.join(config.dataDir, 'l2-chain.json');
    let chain;
    let pgDoc = null;
    let imported = false;
    if (usingPostgres(config)) {
      await migrate(config, { quiet: config.quiet });
      // txs is keyed by hash: one row per tx instead of one huge value.
      pgDoc = new PgDocument(config, PG_NAMESPACE, { mapKeys: ['txs'], coarseTimes: ['sealed'] });
      chain = await pgDoc.load();
      if (!chain) {
        chain = await readChainFile(filePath);
        imported = Boolean(chain);
      }
    } else {
      chain = await readChainFile(filePath);
    }
    chain = normalizeChain(chain || emptyChain(config.chainId), config.chainId);
    const explorer = new Explorer(filePath, chain);
    if (pgDoc) {
      explorer.backend = 'postgres';
      explorer.pg = pgDoc;
    }
    explorer.writerActive = config.writerActive !== false;
    if (explorer.writerActive) {
      if (explorer.pg) await explorer.pg.claimWriter();
      await explorer.persist();
      if (imported) {
        await recordImport(config, filePath, { blocks: chain.blocks.length, txs: Object.keys(chain.txs).length });
        if (!config.quiet) {
          console.info(
            `[zk-voting] imported ${filePath} into postgres (blocks=${chain.blocks.length} txs=${Object.keys(chain.txs).length})`,
          );
        }
      }
    }
    return explorer;
  }

  /** Take the Postgres writer fence (standby promotion). No-op on the JSON backend. */
  async claimWriter(owner) {
    if (this.pg) await this.pg.claimWriter(owner);
  }

  async persist() {
    if (this.writerActive === false) return this._write;
    if (this.pg) {
      const p = this.pg.save(this.chain);
      this._write = p.catch(() => {});
      return p;
    }
    this._write = this._write.then(async () => {
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.chain, null, 2));
      await fs.rename(tmp, this.filePath);
    });
    return this._write;
  }

  async refresh() {
    // On Postgres, a writer holding the fence is the only one that can change
    // the chain, so its in-memory copy is authoritative: skip the full reload
    // the JSON backend does before each append. Standbys still reload.
    if (this.pg && this.writerActive !== false && this.pg.epoch > 0) return this.chain;
    const side = this.chain
      ? {
          supersededBy: { ...(this.chain.supersededBy || {}) },
          sourceOrder: { ...(this.chain.sourceOrder || {}) },
        }
      : null;
    const stored = this.pg ? await this.pg.load() : await readChainFile(this.filePath);
    if (stored && Array.isArray(stored.blocks)) {
      this.chain = normalizeChain(stored, this.chain.chainId);
      if (side) {
        this.chain.supersededBy = { ...(this.chain.supersededBy || {}), ...side.supersededBy };
        this.chain.sourceOrder = { ...(this.chain.sourceOrder || {}), ...side.sourceOrder };
      }
    }
    return this.chain;
  }

  headNumber() {
    return this.chain.blocks.length === 0
      ? 0
      : this.chain.blocks[this.chain.blocks.length - 1].number;
  }

  parentHash() {
    if (this.chain.blocks.length === 0) return this.chain.genesisHash;
    return this.chain.blocks[this.chain.blocks.length - 1].hash;
  }

  async append(type, payload, opts = {}) {
    const result = await this.appendMany(type, [payload], opts.timestamp);
    return result
      ? { block: result.block, tx: this.chain.txs[result.block.transactions[0]] }
      : null;
  }

  async appendMany(type, payloads, timestamp) {
    if (!payloads.length) return null;
    await this.refresh();
    const number = this.headNumber() + 1;
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    const parentHash = this.parentHash();
    const hashes = [];
    for (let i = 0; i < payloads.length; i += 1) {
      const payload = payloads[i];
      const body = { type, payload, number, timestamp: ts, parentHash, index: i };
      const hash = keccak256(stringToHex(stable(body)));
      const tx = {
        hash,
        blockNumber: number,
        timestamp: ts,
        type,
        from: 'node',
        relayer: type === 'vote' ? 'node' : undefined,
        payload,
      };
      this.chain.txs[hash] = tx;
      hashes.push(hash);
      this.rememberPayload(type, payload, hash);
      this.noteTrackedTx(type, payload, hash, { number, index: i });
    }
    const blockHash = keccak256(
      stringToHex(stable({ number, parentHash, timestamp: ts, transactions: hashes })),
    );
    const block = {
      number,
      hash: blockHash,
      parentHash,
      timestamp: ts,
      txCount: hashes.length,
      transactions: hashes,
    };
    this.chain.blocks.push(block);
    await this.persist();
    return { block };
  }

  sealedHasNullifier(nullifier) {
    const sealed = this.chain.sealed || [];
    return sealed.some((item) => sameNullifier(payloadNullifier(item.payload || {}), nullifier));
  }

  async recordVote(payload, now, intervalSeconds) {
    const body = votePayload(payload);
    await this.refresh();
    this.chain.sealed = this.chain.sealed || [];

    if (this.findByNullifier(body.nullifier) || this.sealedHasNullifier(body.nullifier)) {
      return { duplicate: true, published: Boolean(this.findByNullifier(body.nullifier)) };
    }

    const interval = Number(intervalSeconds) || 0;
    // Interval 0 publishes at once. A positive interval waits for the hour.
    // A published block is never rewritten. A re-vote must not call this.
    if (!interval || interval <= 0) {
      return this.append('vote', body, { timestamp: now });
    }
    // Random position, so the sealed queue's order is not arrival order.
    // Callers pass a bucket-coarsened receivedAt (relay.coarseAcceptedAt).
    const at = randomInt(this.chain.sealed.length + 1);
    this.chain.sealed.splice(at, 0, { receivedAt: now, payload: body });
    await this.persist();
    return { sealed: true, published: false };
  }

  /** Drop one unpublished sealed ballot. Published blocks stay as they were. */
  async dropSealedVote(nullifier) {
    await this.refresh();
    const sealed = this.chain.sealed || [];
    const kept = sealed.filter((item) => !sameNullifier(payloadNullifier(item.payload || {}), nullifier));
    if (kept.length === sealed.length) return false;
    this.chain.sealed = kept;
    await this.persist();
    return true;
  }

  disclosurePolicySnapshot() {
    const policy = typeof this.disclosurePolicy === 'function' ? this.disclosurePolicy() : this.disclosurePolicy;
    return policy && typeof policy === 'object' ? policy : {};
  }

  async disclose(now, intervalSeconds) {
    await this.refresh();
    const interval = Number(intervalSeconds) || 0;
    this.chain.sealed = this.chain.sealed || [];
    if (!this.chain.sealed.length) {
      await this.disclosePolls(now, intervalSeconds);
      return [];
    }

    const policy = this.disclosurePolicySnapshot();
    const tagged = this.chain.sealed.map((item) => {
      const payload = votePayload(item.payload);
      return { ...item, electionId: String(payload.electionId ?? '') };
    });
    const planned = planPublicBlocks(tagged, {
      now,
      intervalSeconds: interval,
      delaySeconds: policy.delaySeconds || 0,
      minBlockVotes: policy.minBlockVotes ?? 1,
      electionContext: policy.electionContext || (() => ({})),
    });
    this.chain.sealed = planned.hold.map(({ electionId: _id, ...item }) => item);
    await this.persist();

    const published = [];
    const blocks = planned.publish.slice().sort((a, b) => a.timestamp - b.timestamp);
    for (const block of blocks) {
      const items = block.items.filter((item) => {
        const p = votePayload(item.payload);
        return !this.findByNullifier(p.nullifier);
      });
      if (!items.length) continue;
      items.sort((a, b) =>
        payloadNullifier(a.payload).localeCompare(payloadNullifier(b.payload), 'en'),
      );
      const result = await this.appendMany(
        'vote',
        items.map((item) => votePayload(item.payload)),
        block.timestamp,
      );
      if (result) published.push(result.block);
    }
    await this.disclosePolls(now, intervalSeconds);
    return published;
  }

  async recordPollVote(payload, now, intervalSeconds) {
    await this.refresh();
    this.chain.sealedPolls = this.chain.sealedPolls || [];
    const body = {
      pollId: payload.pollId,
      voter: payload.voter,
      voteBlock: payload.voteBlock,
      provisionalWeight: payload.provisionalWeight,
      choicesHash: payload.choicesHash,
      ballotDigest: payload.ballotDigest,
    };
    const interval = Number(intervalSeconds) || 0;
    if (!interval || interval <= 0) {
      return this.append('poll_vote', body, { timestamp: now });
    }
    this.chain.sealedPolls.push({ receivedAt: now, payload: body });
    await this.persist();
    return { sealed: true, published: false };
  }

  async disclosePolls(now, intervalSeconds) {
    await this.refresh();
    const interval = Number(intervalSeconds) || 0;
    this.chain.sealedPolls = this.chain.sealedPolls || [];
    if (!this.chain.sealedPolls.length) return [];
    const remaining = [];
    const ready = [];
    for (const item of this.chain.sealedPolls) {
      if (interval <= 0 || isDisclosed(item.receivedAt, now, interval)) ready.push(item);
      else remaining.push(item);
    }
    this.chain.sealedPolls = remaining;
    await this.persist();
    const published = [];
    for (const item of ready) {
      const ts = interval > 0 ? hourBucket(item.receivedAt, interval) + interval : now;
      const result = await this.append('poll_vote', item.payload, { timestamp: ts });
      if (result) published.push(result.block);
    }
    return published;
  }

  async ingest(body, now, intervalSeconds) {
    if (this.writerActive === false) {
      const err = new Error('maintenance handover');
      err.status = 503;
      throw err;
    }
    const src = body && typeof body === 'object' ? body : {};
    const block = src.block && typeof src.block === 'object' ? src.block : null;
    const outcomes = src.outcomes && typeof src.outcomes === 'object' ? src.outcomes : {};
    await this.refresh();
    this.chain.seenBlockHashes = Array.isArray(this.chain.seenBlockHashes) ? this.chain.seenBlockHashes : [];
    this.chain.ingestedTxHashes = Array.isArray(this.chain.ingestedTxHashes) ? this.chain.ingestedTxHashes : [];
    const blockHash = block && block.hash ? String(block.hash).toLowerCase() : '';
    if (blockHash && this.chain.seenBlockHashes.some((h) => String(h).toLowerCase() === blockHash)) {
      return { ok: true, imported: 0, duplicate: true };
    }
    let imported = 0;

    const fromOutcomes = [];
    for (const [type, rows] of Object.entries(outcomes)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        fromOutcomes.push({ type: String(type).toLowerCase(), payload: row });
      }
    }
    const fromBlock = [];
    const rawTxs = block ? block.transactions || block.txs || [] : [];
    for (const tx of rawTxs) {
      if (!tx || typeof tx === 'string') continue;
      const civic = tx.civic || tx.payload || {};
      const type = String(tx.civicType || civic.type || tx.type || '').toLowerCase();
      fromBlock.push({ type, payload: { ...civic, ...tx.payload, hash: tx.hash } });
    }

    const rows = fromOutcomes.length ? fromOutcomes : fromBlock;
    const l2Delayed = src.source === 'zk-voting-l2';
    const blockTs = block?.timestamp != null ? Number(block.timestamp) : now;
    let skipped = 0;
    this.loadIngestedTxs();

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const type = String(row.type || '').toLowerCase();
      if (!type) continue;
      const payload = row.payload || row;
      const rowIndex = row.index == null ? index : row.index;
      if (choiceRowBlocked(this, type, payload, blockTs)) {
        skipped += 1;
        continue;
      }
      if ((type === 'vote' || type === 'vote_superseded') && l2Delayed && voteImportBlocked(this, payload)) {
        skipped += 1;
        continue;
      }
      if (type === 'vote' || type === 'vote_superseded') {
        row.payload = withoutChoiceFields(payload);
      }
      if (type === 'poll_vote' || type === 'poll_params' || type === 'poll_tally') {
        const body = row.payload || row;
        if (type === 'poll_params' || type === 'poll_tally') {
          // Source order first, so a late copy of an earlier row is not appended.
          const order = sourceOrderOf(body, block, rowIndex);
          if (this.olderThanLatestPoll(type, body, order)) {
            this.noteIngestedTx(type, body, blockHash, rowIndex);
            continue;
          }
        }
        if (this.txAlreadyIngested(type, body, blockHash, rowIndex)) continue;
        if (type === 'poll_vote' && !l2Delayed) {
          await this.recordPollVote(body, now, intervalSeconds);
        } else if (type === 'poll_params' || type === 'poll_tally') {
          const pollId = body?.pollId ?? body?.electionId;
          const id = pollId != null ? String(pollId) : '';
          const previous = id ? this.latestPollRecord(type, id) : null;
          const order = sourceOrderOf(body, block, rowIndex);
          const appended = await this.append(type, body, { timestamp: blockTs || now });
          const hash = appended?.tx?.hash;
          if (hash) {
            this.noteSource(hash, order);
            this.noteTrackedTx(type, body, hash, { number: Number(appended.block?.number), index: 0 });
          }
          if (previous?.hash && hash && previous.hash !== hash) this.noteSuperseded(previous.hash, hash);
        } else {
          await this.append(type, body, { timestamp: blockTs || now });
        }
        this.noteIngestedTx(type, body, blockHash, rowIndex);
        imported += 1;
      } else if (isDelayedPublicType(type) || type === 'vote_superseded') {
        const body = votePayload(row.payload);
        if (!body.nullifier) continue;
        if (this.findByNullifier(body.nullifier) || this.sealedHasNullifier(body.nullifier)) continue;
        if (l2Delayed) {
          await this.append('vote', body, { timestamp: blockTs || now });
          imported += 1;
        } else {
          await this.recordVote(body, now, intervalSeconds);
          imported += 1;
        }
      } else if (type && type !== 'userop') {
        const body = row.payload || row;
        if (this.txAlreadyIngested(type, body, blockHash, rowIndex)) continue;
        await this.append(type, body);
        this.noteIngestedTx(type, body, blockHash, rowIndex);
        imported += 1;
      }
    }
    if (blockHash && skipped === 0) {
      this.pruneIngestedBlock(blockHash);
      if (!this.chain.seenBlockHashes.some((item) => String(item).toLowerCase() === blockHash)) {
        this.chain.seenBlockHashes.push(blockHash);
      }
    }
    await this.flushIngestedTxs();
    await this.disclose(now, intervalSeconds);
    return { ok: true, imported, duplicate: false };
  }

  loadIngestedTxs() {
    const list = Array.isArray(this.chain.ingestedTxHashes) ? this.chain.ingestedTxHashes : [];
    this._ingestedTxs = new Set(list.map((item) => String(item).toLowerCase()));
    this._ingestedByBlock = new Map();
    this._outcomeKeys = [];
    const owners = this.chain.ingestedTxByBlock;
    if (owners && typeof owners === 'object' && !Array.isArray(owners)) {
      for (const [block, keys] of Object.entries(owners)) {
        if (!Array.isArray(keys)) continue;
        const bucket = new Set();
        for (const key of keys) {
          const clean = String(key).toLowerCase();
          if (this._ingestedTxs.has(clean)) bucket.add(clean);
        }
        if (bucket.size) this._ingestedByBlock.set(String(block).toLowerCase(), bucket);
      }
    }
    const savedOutcomes = Array.isArray(this.chain.ingestedOutcomeKeys) ? this.chain.ingestedOutcomeKeys : [];
    for (const key of savedOutcomes) {
      const clean = String(key).toLowerCase();
      if (clean && this._ingestedTxs.has(clean)) this._outcomeKeys.push(clean);
    }
    this.trimOutcomeKeys();
    this.indexStoredPayloads();
  }

  txAlreadyIngested(type, payload, blockHash, index) {
    const key = ingestKey(type, payload, blockHash, index);
    if (!key) return false;
    if (!(this._ingestedTxs instanceof Set)) this.loadIngestedTxs();
    if (this._ingestedTxs.has(key)) return true;
    return this.storedPayload(type, payload);
  }

  /** True when this type and canonical payload are already in the chain log. */
  storedPayload(type, payload) {
    if (!(this._payloadIndex instanceof Map)) this.indexStoredPayloads();
    return this._payloadIndex.has(payloadIndexKey(type, payload));
  }

  /**
   * type|stable(payload) → earliest tx hash, plus the latest poll row per id.
   * Built once per load so a lookup does not scan every row.
   */
  indexStoredPayloads() {
    this._payloadIndex = new Map();
    this._txAt = new Map();
    this._pollLatest = new Map();
    const blocks = [...(this.chain?.blocks || [])].sort((a, b) => Number(a.number) - Number(b.number));
    for (const block of blocks) {
      const hashes = block.transactions || [];
      for (let index = 0; index < hashes.length; index += 1) {
        const hash = String(hashes[index]);
        const tx = this.chain.txs?.[hash];
        if (!tx) continue;
        const position = { number: Number(block.number), index };
        this._txAt.set(hash, position);
        const key = payloadIndexKey(tx.type, tx.payload);
        if (!this._payloadIndex.has(key)) this._payloadIndex.set(key, hash);
        this.considerPoll(tx, hash, position);
      }
    }
  }

  rememberPayload(type, payload, hash) {
    if (!(this._payloadIndex instanceof Map) || !hash) return;
    const key = payloadIndexKey(type, payload);
    if (!this._payloadIndex.has(key)) this._payloadIndex.set(key, String(hash));
  }

  noteTrackedTx(type, payload, hash, position) {
    if (!(this._txAt instanceof Map) || !hash) return;
    this._txAt.set(String(hash), position);
    if (!(this._pollLatest instanceof Map)) return;
    this.considerPoll({ type, payload }, hash, position);
  }

  considerPoll(tx, hash, position) {
    const name = String(tx?.type || '').toLowerCase();
    if (name !== 'poll_params' && name !== 'poll_tally') return;
    const id = pollIdOf(tx.payload);
    if (!id || !(this._pollLatest instanceof Map)) return;
    const order = this.chain.sourceOrder?.[hash] || null;
    const candidate = { hash: String(hash), order, position };
    const key = `${name}|${id}`;
    const prev = this._pollLatest.get(key);
    if (!prev || pollCandidateWins(candidate, prev)) this._pollLatest.set(key, candidate);
  }

  /** Side index only. Block and transaction hashes do not cover this map. */
  noteSuperseded(oldHash, newHash) {
    if (!this.chain.supersededBy || typeof this.chain.supersededBy !== 'object' || Array.isArray(this.chain.supersededBy)) {
      this.chain.supersededBy = {};
    }
    const from = String(oldHash || '');
    const to = String(newHash || '');
    if (!from || !to || from === to) return;
    this.chain.supersededBy[from] = to;
  }

  /** Side index only. Source order is not part of the block hash. */
  noteSource(hash, order) {
    if (!hash || !order) return;
    if (!this.chain.sourceOrder || typeof this.chain.sourceOrder !== 'object' || Array.isArray(this.chain.sourceOrder)) {
      this.chain.sourceOrder = {};
    }
    this.chain.sourceOrder[String(hash)] = order;
  }

  blockPosition(hash) {
    const want = String(hash || '');
    if (!want) return null;
    if (!(this._txAt instanceof Map)) this.indexStoredPayloads();
    return this._txAt.get(want) || null;
  }

  /**
   * Latest poll_params or poll_tally for one poll. Source L2 height, then
   * index. A sequence or postedAt is used when the source has no height.
   */
  latestPollRecord(type, electionId) {
    const name = String(type || '').toLowerCase();
    const body = electionId && typeof electionId === 'object' ? electionId : { pollId: electionId };
    const listed = body?.pollId ?? body?.electionId;
    const id = listed != null && listed !== '' ? String(listed) : '';
    if (!id || (name !== 'poll_params' && name !== 'poll_tally')) return null;
    if (!(this._pollLatest instanceof Map)) this.indexStoredPayloads();
    const hit = this._pollLatest.get(`${name}|${id}`);
    if (!hit) return null;
    return this.chain.txs?.[hit.hash] || null;
  }

  /**
   * True when this row's source order is not strictly newer than the latest
   * stored row for that poll. Appending it would make the older row win.
   */
  olderThanLatestPoll(type, payload, order) {
    const name = String(type || '').toLowerCase();
    if (name !== 'poll_params' && name !== 'poll_tally') return false;
    const id = payload?.pollId ?? payload?.electionId;
    if (id == null || id === '') return false;
    const latest = this.latestPollRecord(name, id);
    if (!latest) return false;
    const latestOrder = this.chain.sourceOrder?.[latest.hash] || null;
    const cmp = compareSource(order, latestOrder);
    if (cmp == null) return false;
    return cmp <= 0;
  }

  /** Recompute every published block and transaction hash. */
  verifyBlockHashes() {
    let parent = this.chain.genesisHash;
    for (const block of this.chain.blocks || []) {
      if (block.parentHash !== parent) return false;
      const hashes = Array.isArray(block.transactions) ? block.transactions : [];
      if (hashes.length !== Number(block.txCount)) return false;
      for (let index = 0; index < hashes.length; index += 1) {
        const listed = hashes[index];
        const tx = this.chain.txs[listed];
        if (!tx) return false;
        const body = {
          type: tx.type,
          payload: tx.payload,
          number: block.number,
          timestamp: block.timestamp,
          parentHash: block.parentHash,
          index,
        };
        const hash = keccak256(stringToHex(stable(body)));
        if (hash !== listed || hash !== tx.hash) return false;
      }
      const blockHash = keccak256(
        stringToHex(
          stable({
            number: block.number,
            parentHash: block.parentHash,
            timestamp: block.timestamp,
            transactions: hashes,
          }),
        ),
      );
      if (blockHash !== block.hash) return false;
      parent = block.hash;
    }
    return true;
  }

  noteIngestedTx(type, payload, blockHash, index) {
    const key = ingestKey(type, payload, blockHash, index);
    if (!key) return;
    if (!(this._ingestedTxs instanceof Set)) this.loadIngestedTxs();
    this._ingestedTxs.add(key);
    const block = blockHash ? String(blockHash).toLowerCase() : '';
    if (!block) {
      this.noteOutcomeKey(key);
      return;
    }
    let bucket = this._ingestedByBlock.get(block);
    if (!bucket) {
      bucket = new Set();
      this._ingestedByBlock.set(block, bucket);
    }
    bucket.add(key);
  }

  noteOutcomeKey(key) {
    if (!Array.isArray(this._outcomeKeys)) this._outcomeKeys = [];
    const existing = this._outcomeKeys.indexOf(key);
    if (existing !== -1) this._outcomeKeys.splice(existing, 1);
    this._outcomeKeys.push(key);
    this.trimOutcomeKeys();
  }

  trimOutcomeKeys() {
    if (!Array.isArray(this._outcomeKeys)) this._outcomeKeys = [];
    const buckets = this._ingestedByBlock instanceof Map ? this._ingestedByBlock : new Map();
    while (this._outcomeKeys.length > OUTCOMES_ONLY_KEY_CAP) {
      const dropped = this._outcomeKeys.shift();
      let still = false;
      for (const other of buckets.values()) {
        if (other.has(dropped)) {
          still = true;
          break;
        }
      }
      if (!still && this._ingestedTxs instanceof Set) this._ingestedTxs.delete(dropped);
    }
  }

  pruneIngestedBlock(blockHash) {
    const block = String(blockHash || '').toLowerCase();
    const bucket = this._ingestedByBlock?.get(block);
    if (!bucket) return;
    this._ingestedByBlock.delete(block);
    for (const key of bucket) {
      let still = false;
      for (const other of this._ingestedByBlock.values()) {
        if (other.has(key)) {
          still = true;
          break;
        }
      }
      if (!still) this._ingestedTxs.delete(key);
    }
  }

  async flushIngestedTxs() {
    if (!(this._ingestedTxs instanceof Set)) return;
    this.chain.ingestedTxHashes = [...this._ingestedTxs];
    this.chain.ingestedOutcomeKeys = [...(this._outcomeKeys || [])];
    const owners = {};
    for (const [block, keys] of this._ingestedByBlock) owners[block] = [...keys];
    this.chain.ingestedTxByBlock = owners;
    await this.persist();
  }

  presentTx(tx) {
    if (!tx) return null;
    const payload = tx.payload && typeof tx.payload === 'object' ? tx.payload : {};
    const presented = {
      ...payload,
      hash: tx.hash,
      blockNumber: tx.blockNumber,
      timestamp: tx.timestamp,
      type: String(tx.type || payload.type || '').toUpperCase(),
      from: tx.from,
      relayer: tx.relayer || payload.relayer,
      payload,
    };
    const supersededBy = this.chain.supersededBy?.[tx.hash];
    if (supersededBy) {
      presented.superseded = true;
      presented.supersededBy = supersededBy;
    }
    return presented;
  }

  listBlocks() {
    return this.chain.blocks
      .slice()
      .reverse()
      .map((b) => ({
        number: b.number,
        hash: b.hash,
        parentHash: b.parentHash,
        timestamp: b.timestamp,
        txCount: b.txCount,
        transactions: b.transactions,
        stateRoot: b.hash,
      }));
  }

  getBlock(n) {
    const number = Number(n);
    const block = this.chain.blocks.find((b) => b.number === number);
    if (!block) return null;
    const txs = (block.transactions || [])
      .map((h) => this.presentTx(this.chain.txs[h]))
      .filter(Boolean);
    return { ...block, stateRoot: block.hash, txs, transactions: txs };
  }

  getTx(hash) {
    const key = String(hash || '');
    const tx = this.chain.txs[key] || this.chain.txs[key.toLowerCase()] || null;
    return this.presentTx(tx);
  }

  findByNullifier(value) {
    const needle = String(value || '').toLowerCase();
    if (!needle) return null;
    for (const tx of Object.values(this.chain.txs)) {
      const presented = this.presentTx(tx);
      const n = String(presented.nullifier || '').toLowerCase();
      if (
        n &&
        (n === needle ||
          n.endsWith(needle.replace(/^0x/, '')) ||
          needle.endsWith(n.replace(/^0x/, '')))
      ) {
        return presented;
      }
    }
    return null;
  }

  search(q) {
    const query = String(q || '').trim();
    if (!query) return { blocks: [], txs: [] };
    if (/^election:/i.test(query)) {
      const id = query.slice(query.indexOf(':') + 1).trim();
      const txs = Object.values(this.chain.txs)
        .map((t) => this.presentTx(t))
        .filter((t) => String(t.electionId) === String(id));
      return { blocks: [], txs, electionId: id };
    }
    if (/^\d+$/.test(query)) {
      const block = this.getBlock(Number(query));
      return { blocks: block ? [block] : [], txs: block ? block.txs : [] };
    }
    const lower = query.toLowerCase();
    const txs = Object.values(this.chain.txs)
      .map((t) => this.presentTx(t))
      .filter((t) => {
        const blob = JSON.stringify(t).toLowerCase();
        return blob.includes(lower) || (t.hash && t.hash.toLowerCase() === lower);
      });
    const blocks = this.chain.blocks.filter(
      (b) => String(b.hash).toLowerCase() === lower || String(b.number) === query,
    );
    return { blocks, txs };
  }

  countPublishedVoteTxs() {
    let n = 0;
    for (const tx of Object.values(this.chain.txs || {})) {
      if (String(tx.type || '').toLowerCase() === 'vote') n += 1;
    }
    return n;
  }

  publicDisclosure(now, intervalSeconds) {
    const policy = this.disclosurePolicySnapshot();
    return publicDisclosureView(now, intervalSeconds, {
      delaySeconds: Number(policy.delaySeconds) || 0,
      resultsMinVotes: typeof policy.minVotes === 'number' ? policy.minVotes : undefined,
      minBlockVotes: typeof policy.minBlockVotes === 'number' ? policy.minBlockVotes : undefined,
      acceptedBallotsDisclosed: this.countPublishedVoteTxs(),
    });
  }
}
