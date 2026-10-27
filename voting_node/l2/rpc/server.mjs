// NOT FOR PROFIT — civic public good, not a commercial sequencer.
// JSON-RPC subset for ZK-Voting L2.
import http from 'node:http';
import { toQuantity } from '../sequencer/state.mjs';

const METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getLogs',
  'eth_sendRawTransaction',
  'eth_call',
  'net_version',
  'eth_getBalance',
  // ZK-Voting identity and per-election reads (no ballots, no secrets).
  'zkv_l2Identity',
  'zkv_getElection',
  'zkv_listElections',
]);

/** Public identity of this L2. Never returns L2_SALT or L2_ADMIN_SECRET. */
export function publicIdentity(state) {
  const id = state.config.identity || {};
  return {
    chainId: state.config.chainId,
    l2Uuid: id.l2Uuid || state.config.l2Uuid || '',
    l2Id: id.l2Id || '',
    operator: id.operator || '',
    l1ChainId: id.l1ChainId || String(state.config.l1ChainId || ''),
    registryAddress: id.registryAddress || '',
    admission: state.config.admission || 'open',
    adminWritesEnabled: Boolean(state.config.adminSecret),
  };
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function dispatch(state, req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    return fail(null, -32600, 'invalid request');
  }
  const { id, method, params } = req;
  if (id === undefined) return null;
  if (typeof method !== 'string') return fail(id, -32600, 'invalid request');
  if (!METHODS.has(method)) return fail(id, -32601, `method not found: ${method}`);
  const p = Array.isArray(params) ? params : params && typeof params === 'object' ? [params] : [];
  try {
    switch (method) {
      case 'eth_chainId':
        return ok(id, toQuantity(state.config.chainId));
      case 'net_version':
        return ok(id, String(state.config.chainId));
      case 'eth_blockNumber':
        return ok(id, toQuantity(state.latestNumber));
      case 'eth_getBlockByNumber':
        return ok(id, state.getBlockByNumber(p[0], p[1]));
      case 'eth_getBlockByHash':
        return ok(id, state.getBlockByHash(p[0], p[1]));
      case 'eth_getTransactionByHash':
        return ok(id, state.getTransactionByHash(p[0]));
      case 'eth_getLogs':
        return ok(id, state.getLogs(p[0] || {}));
      case 'eth_sendRawTransaction': {
        const raw = p[0];
        if (typeof raw !== 'string' || !raw.length) {
          return fail(id, -32602, 'missing raw transaction');
        }
        return ok(id, state.enqueueRaw(raw));
      }
      case 'eth_call':
        return ok(id, state.ethCall(p[0] || {}));
      case 'eth_getBalance': {
        if (!p[0]) return fail(id, -32602, 'missing address');
        return ok(id, state.getBalance(p[0]));
      }
      case 'zkv_l2Identity':
        return ok(id, publicIdentity(state));
      case 'zkv_getElection': {
        if (typeof p[0] !== 'string' || !p[0]) return fail(id, -32602, 'missing election UUID');
        const info = typeof state.electionInfo === 'function' ? state.electionInfo(p[0]) : null;
        return ok(id, info ? { ...info, l2: publicIdentity(state) } : null);
      }
      case 'zkv_listElections':
        return ok(id, typeof state.listElections === 'function' ? state.listElections() : []);
      default:
        return fail(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    const code = Number.isInteger(err.code) ? err.code : -32000;
    return fail(id, code, err.message || 'internal error');
  }
}

/**
 * Per-client write budget for a gasless chain. Off by default (the Node app
 * relays every vote from one address); set L2_WRITE_RATE_PER_MIN when the RPC
 * is reachable from the public internet.
 */
export function createWriteLimiter(perMinute, nowFn = () => Date.now()) {
  const limit = Number(perMinute) || 0;
  const buckets = new Map();
  return function allow(key) {
    if (limit <= 0) return true;
    const now = nowFn();
    const b = buckets.get(key) || { tokens: limit, at: now };
    b.tokens = Math.min(limit, b.tokens + ((now - b.at) / 60_000) * limit);
    b.at = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 10_000) buckets.delete(buckets.keys().next().value);
    return true;
  };
}

export function createRpcServer(state, { host, port } = {}) {
  const listenHost = host || state.config.rpcHost || '127.0.0.1';
  const listenPort = Number(port || state.config.rpcPort || 8546);
  const allowWrite = createWriteLimiter(process.env.L2_WRITE_RATE_PER_MIN || state.config.writeRatePerMin || 0);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health' || req.url.startsWith('/health?'))) {
      const mode = state.acceptingWrites() ? 'active' : 'standby';
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-zk-voting-mode': mode,
      });
      res.end(
        JSON.stringify({
          ok: true,
          ready: true,
          nfp: true,
          name: 'ZK-Voting L2',
          role: 'sequencer',
          mode,
          acceptingWrites: state.acceptingWrites(),
          epoch: typeof state.writerEpoch === 'function' ? state.writerEpoch() : 0,
          chainId: state.config.chainId,
          blockNumber: toQuantity(state.latestNumber),
          skipEmptyBlocks: state.config.skipEmptyBlocks !== false,
          disclosure: state.disclosureView(),
        }),
      );
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'POST JSON-RPC only' }));
      return;
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify(fail(null, -32600, 'payload too large')));
          return;
        }
        chunks.push(chunk);
      }
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fail(null, -32700, err.message)));
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
    } catch {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fail(null, -32700, 'parse error')));
      return;
    }
    const writes = (Array.isArray(body) ? body : [body]).some(
      (item) => item && item.method === 'eth_sendRawTransaction',
    );
    if (writes && !allowWrite(req.socket?.remoteAddress || 'unknown')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
      res.end(JSON.stringify(fail(Array.isArray(body) ? null : body?.id ?? null, -32005, 'write rate limit')));
      return;
    }
    if (writes && !state.acceptingWrites()) {
      const id = Array.isArray(body) ? null : body.id ?? null;
      res.writeHead(503, {
        'content-type': 'application/json',
        'retry-after': '2',
        'x-zk-voting-mode': 'standby',
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32003,
            message: 'maintenance handover',
            data: { mode: 'standby', retryAfter: 2 },
          },
        }),
      );
      return;
    }
    let result;
    if (Array.isArray(body)) {
      if (body.length > 100) {
        result = fail(null, -32600, 'batch too large');
      } else {
        result = body.map((item) => dispatch(state, item)).filter((x) => x != null);
      }
    } else {
      result = dispatch(state, body);
    }
    const handover =
      result && !Array.isArray(result) && result.error && result.error.code === -32003;
    if (handover) {
      res.writeHead(503, {
        'content-type': 'application/json',
        'retry-after': '2',
        'x-zk-voting-mode': 'standby',
      });
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify(result));
  });

  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, listenHost, () => {
        server.removeListener('error', reject);
        resolve({ host: listenHost, port: listenPort, server });
      });
    });

  const close = () =>
    new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  return { server, listen, close, host: listenHost, port: listenPort };
}
