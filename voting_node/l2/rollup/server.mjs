// NOT FOR PROFIT — civic public good, not a commercial product.
// HTTP API of the L2 operator. Ballots come in here; nothing that could reveal a choice
// goes out: no ciphertext, no live turnout, no per-batch sum.
//
//   GET  /health
//   GET  /v1/status
//   GET  /v1/batches?limit=50
//   GET  /v1/elections/:id
//   GET  /v1/elections/:id/roll/:commitment     membership path for the voter's ballot proof
//   GET  /v1/elections/:id/desert-proof         only once L1 is in desert mode
//   GET  /v1/receipts/:electionId/:nullifier
//   POST /v1/ballots                            { electionId, nullifier, ciphertexts, proof, eligibility }

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { fromJSONSafe, toJSONSafe } from '../../apps/node/public/ballot-crypto.js';

const MAX_BODY = 256 * 1024;

function send(res, status, body) {
  const text = JSON.stringify(toJSONSafe(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

function bearerOk(req, token) {
  if (!token) return true;
  const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * @param {import('./operator.mjs').Operator} operator
 * @param {{ ballotToken?: string }} [opts] when set, POST /v1/ballots needs `Authorization: Bearer <token>`
 *        (the node submits on behalf of voters it has authenticated).
 */
export function createApi(operator, { ballotToken } = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://l2');
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, ...operator.status() });
      }
      if (req.method === 'GET' && url.pathname === '/v1/status') {
        return send(res, 200, operator.status());
      }
      if (req.method === 'GET' && url.pathname === '/v1/batches') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
        const batches = operator.batches.slice(-limit).reverse().map(({ included, ...b }) => b);
        return send(res, 200, { batches });
      }
      if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'elections' && parts[2]) {
        const id = Number(parts[2]);
        if (parts.length === 3) {
          const view = operator.state.publicView(id);
          return view ? send(res, 200, view) : send(res, 404, { error: 'unknown election' });
        }
        if (parts[3] === 'roll' && parts[4]) {
          const path = operator.state.rollPath(id, BigInt(parts[4]));
          return path ? send(res, 200, path) : send(res, 404, { error: 'not on the roll' });
        }
        if (parts[3] === 'desert-proof') {
          if (!operator.desert) return send(res, 409, { error: 'only available in desert mode' });
          return send(res, 200, operator.state.desertProof(id));
        }
      }
      if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'receipts' && parts[3]) {
        const r = operator.receipt(Number(parts[2]), BigInt(parts[3]));
        return r ? send(res, 200, r) : send(res, 404, { error: 'no ballot under this nullifier' });
      }
      if (req.method === 'POST' && url.pathname === '/v1/ballots') {
        if (!bearerOk(req, ballotToken)) return send(res, 401, { error: 'unauthorized' });
        const body = fromJSONSafe(await readJson(req));
        const receipt = await operator.submitBallot({
          electionId: Number(body.electionId),
          nullifier: BigInt(body.nullifier),
          ciphertexts: body.ciphertexts,
          proof: body.proof,
          eligibility: body.eligibility,
        });
        return send(res, 202, receipt);
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err.status || 500;
      return send(res, status, { error: status === 500 ? 'internal error' : err.message });
    }
  });
}
