// NOT FOR PROFIT — civic public good, not a commercial sequencer.
// JSON-RPC subset for Republic L2.
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
]);

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
      default:
        return fail(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    const code = Number.isInteger(err.code) ? err.code : -32000;
    return fail(id, code, err.message || 'internal error');
  }
}

export function createRpcServer(state, { host, port } = {}) {
  const listenHost = host || state.config.rpcHost || '127.0.0.1';
  const listenPort = Number(port || state.config.rpcPort || 8546);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          nfp: true,
          name: 'Republic L2',
          chainId: state.config.chainId,
          blockNumber: toQuantity(state.latestNumber),
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
    res.writeHead(200, { 'content-type': 'application/json' });
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
