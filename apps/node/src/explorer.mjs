// NOT FOR PROFIT — civic public good, not a commercial product.
// Append-only L2 log. Vote proofs stay sealed until the hour that contained
// them closes, then land in one disclosure block (bucketed timestamp, ordered
// by nullifier). Payloads never include a voter choice or a passkey user id.

import fs from 'node:fs/promises';
import path from 'node:path';

import { keccak256, stringToHex } from 'viem';

import {
  disclosurePublicView,
  hourBucket,
  isDelayedPublicType,
  isDisclosed,
} from './disclosure.mjs';

function emptyChain(chainId) {
  return {
    chainId,
    nfp: true,
    app: 'zk-voting',
    genesisHash: `0x${'00'.repeat(32)}`,
    blocks: [],
    txs: {},
    sealed: [],
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

export class Explorer {
  constructor(filePath, chain) {
    this.filePath = filePath;
    this.chain = chain;
    this._write = Promise.resolve();
  }

  static async open(config) {
    await fs.mkdir(config.dataDir, { recursive: true });
    const filePath = config.l2ChainFile || path.join(config.dataDir, 'l2-chain.json');
    let chain;
    try {
      chain = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      chain = emptyChain(config.chainId);
    }
    chain.chainId = chain.chainId || config.chainId;
    chain.blocks = chain.blocks || [];
    chain.txs = chain.txs || {};
    chain.sealed = Array.isArray(chain.sealed) ? chain.sealed : [];
    const explorer = new Explorer(filePath, chain);
    await explorer.persist();
    return explorer;
  }

  async persist() {
    this._write = this._write.then(async () => {
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.chain, null, 2));
      await fs.rename(tmp, this.filePath);
    });
    return this._write;
  }

  async refresh() {
    try {
      const onDisk = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (onDisk && Array.isArray(onDisk.blocks)) {
        this.chain = onDisk;
        this.chain.txs = this.chain.txs || {};
        this.chain.sealed = Array.isArray(this.chain.sealed) ? this.chain.sealed : [];
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
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
    if (!interval || interval <= 0) {
      return this.append('vote', body, { timestamp: now });
    }
    this.chain.sealed.push({ receivedAt: now, payload: body });
    await this.persist();
    return { sealed: true, published: false };
  }

  async disclose(now, intervalSeconds) {
    await this.refresh();
    const interval = Number(intervalSeconds) || 0;
    this.chain.sealed = this.chain.sealed || [];
    if (!this.chain.sealed.length) return [];

    const remaining = [];
    const groups = new Map();
    for (const item of this.chain.sealed) {
      if (interval <= 0 || isDisclosed(item.receivedAt, now, interval)) {
        const bucket = interval > 0 ? hourBucket(item.receivedAt, interval) : Number(item.receivedAt) || now;
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket).push(item);
      } else {
        remaining.push(item);
      }
    }

    this.chain.sealed = remaining;
    await this.persist();

    const published = [];
    const buckets = [...groups.keys()].sort((a, b) => a - b);
    for (const bucket of buckets) {
      const items = groups.get(bucket).filter((item) => {
        const p = votePayload(item.payload);
        return !this.findByNullifier(p.nullifier);
      });
      if (!items.length) continue;
      items.sort((a, b) =>
        payloadNullifier(a.payload).localeCompare(payloadNullifier(b.payload), 'en'),
      );
      const ts = interval > 0 ? bucket + interval : now;
      const result = await this.appendMany(
        'vote',
        items.map((item) => votePayload(item.payload)),
        ts,
      );
      if (result) published.push(result.block);
    }
    return published;
  }

  async ingest(body, now, intervalSeconds) {
    const src = body && typeof body === 'object' ? body : {};
    const block = src.block && typeof src.block === 'object' ? src.block : null;
    const outcomes = src.outcomes && typeof src.outcomes === 'object' ? src.outcomes : {};
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
    const l2Delayed = src.source === 'republic-l2';
    const blockTs = block?.timestamp != null ? Number(block.timestamp) : now;

    for (const row of rows) {
      const type = String(row.type || '').toLowerCase();
      if (!type) continue;
      if (isDelayedPublicType(type) || type === 'vote_superseded') {
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
    await this.disclose(now, intervalSeconds);
    return { ok: true, imported };
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
    return disclosurePublicView(now, intervalSeconds, {
      acceptedBallotsDisclosed: this.countPublishedVoteTxs(),
    });
  }
}
