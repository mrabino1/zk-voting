// NOT FOR PROFIT — civic public good, not a commercial product.
// Append-only L2 log. Vote proofs stay sealed until the hour that contained them
// has closed, the disclosure delay has elapsed, the results gate is open, and the
// block meets the floor. Ready rows land in one disclosure block (disclosure-clock
// timestamp, ordered by nullifier). Payloads never include a voter choice or a passkey user id.

import { randomInt } from 'node:crypto';
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
function voteImportBlocked(explorer, payload) {
  const policy = explorer.disclosurePolicySnapshot();
  const id = String((payload && payload.electionId) ?? '');
  const ctx = typeof policy.electionContext === 'function' ? policy.electionContext(id) || {} : {};
  return ctx.known === false;
}

/** Choice rows stay out of the explorer until the election deadline. Unknown elections fail closed. */
function choiceRowBlocked(explorer, type, payload) {
  if (!isChoiceDisclosure(type, payload)) return false;
  const policy = explorer.disclosurePolicySnapshot();
  const id = String((payload && payload.electionId) ?? '');
  const ctx = typeof policy.electionContext === 'function' ? policy.electionContext(id) || {} : {};
  return Boolean(ctx.resultsSealed || ctx.known === false);
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
  };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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
    const stored = this.pg ? await this.pg.load() : await readChainFile(this.filePath);
    if (stored && Array.isArray(stored.blocks)) {
      this.chain = normalizeChain(stored, this.chain.chainId);
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
    // A published block is never rewritten.
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
      minVotes: policy.minVotes || 0,
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

    for (const row of rows) {
      const type = String(row.type || '').toLowerCase();
      if (!type) continue;
      const payload = row.payload || row;
      if (choiceRowBlocked(this, type, payload)) continue;
      if ((type === 'vote' || type === 'vote_superseded') && l2Delayed && voteImportBlocked(this, payload)) {
        continue;
      }
      if (type === 'vote' || type === 'vote_superseded') {
        row.payload = withoutChoiceFields(payload);
      }
      if (type === 'poll_vote' || type === 'poll_params' || type === 'poll_tally') {
        if (type === 'poll_vote' && !l2Delayed) {
          await this.recordPollVote(row.payload || {}, now, intervalSeconds);
        } else {
          await this.append(type, row.payload || row, { timestamp: blockTs || now });
        }
        imported += 1;
      } else if (isDelayedPublicType(type) || type === 'vote_superseded') {
        const payload = votePayload(row.payload);
        if (!payload.nullifier) continue;
        if (this.findByNullifier(payload.nullifier) || this.sealedHasNullifier(payload.nullifier)) continue;
        if (l2Delayed) {
          await this.append('vote', payload, { timestamp: blockTs || now });
          imported += 1;
        } else {
          await this.recordVote(payload, now, intervalSeconds);
          imported += 1;
        }
      } else if (type && type !== 'userop') {
        await this.append(type, row.payload || row);
        imported += 1;
      }
    }
    if (blockHash) {
      this.chain.seenBlockHashes.push(blockHash);
      await this.persist();
    }
    await this.disclose(now, intervalSeconds);
    return { ok: true, imported, duplicate: false };
  }

  presentTx(tx) {
    if (!tx) return null;
    const payload = tx.payload && typeof tx.payload === 'object' ? tx.payload : {};
    return {
      ...payload,
      hash: tx.hash,
      blockNumber: tx.blockNumber,
      timestamp: tx.timestamp,
      type: String(tx.type || payload.type || '').toUpperCase(),
      from: tx.from,
      relayer: tx.relayer || payload.relayer,
      payload,
    };
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
