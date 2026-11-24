// NOT FOR PROFIT — civic public good, not a commercial product.
// L2 operation encoding, byte for byte as smart-contracts/src/libraries/Ops.sol.
// A priority op has a request part (what L1 queued) and a response part (written here).

export const OP = Object.freeze({
  CREATE_ELECTION: 0x01,
  REGISTER: 0x02,
  DISQUALIFY: 0x03,
  BALLOT: 0x04,
  FORCED_BALLOT: 0x05,
  CLOSE: 0x06,
});

export const MAX_REGISTER_PER_OP = 32;

const hex = (bytes) => Buffer.from(bytes).toString('hex');
export const toHex = (bytes) => `0x${hex(bytes)}`;
export function fromHex(h) {
  const s = String(h).replace(/^0x/i, '');
  return Uint8Array.from(Buffer.from(s, 'hex'));
}

function uint(value, bytes) {
  let n = BigInt(value);
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i -= 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n) throw new Error(`value does not fit in ${bytes} bytes`);
  return out;
}

const readUint = (b, o, n) => b.subarray(o, o + n).reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function encodeBallot({ electionId, nullifier, commitment }) {
  return concat([uint(OP.BALLOT, 1), uint(electionId, 4), uint(nullifier, 32), uint(commitment, 32)]);
}

/** CLOSE response: ballots·4 options·1 then (c1x c1y c2x c2y) per option. */
export function encodeCloseResponse({ ballotCount, accumulator }) {
  return concat([
    uint(ballotCount, 4),
    uint(accumulator.length, 1),
    ...accumulator.flatMap(([c1, c2]) => [c1[0], c1[1], c2[0], c2[1]].map((w) => uint(w, 32))),
  ]);
}

/** Size of the op at `offset` and of its request part (0 for an L2 op). */
export function sizeAt(b, offset) {
  const type = b[offset];
  switch (type) {
    case OP.CREATE_ELECTION:
      return { type, size: 118, request: 118 };
    case OP.REGISTER: {
      const count = b[offset + 5];
      if (!count || count > MAX_REGISTER_PER_OP) throw new Error('malformed REGISTER');
      return { type, size: 6 + 32 * count, request: 6 + 32 * count };
    }
    case OP.DISQUALIFY:
      return { type, size: 39, request: 39 };
    case OP.BALLOT:
      return { type, size: 69, request: 0 };
    case OP.FORCED_BALLOT:
      return { type, size: 102, request: 101 };
    case OP.CLOSE:
      return { type, size: 10 + 128 * b[offset + 9], request: 5 };
    default:
      throw new Error(`unknown op type ${type}`);
  }
}

/** Decode the request part of a queued L1 request (the PriorityRequestQueued payload). */
export function decodeRequest(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : fromHex(bytes);
  const type = b[0];
  const electionId = Number(readUint(b, 1, 4));
  switch (type) {
    case OP.CREATE_ELECTION:
      return {
        type,
        electionId,
        configHash: readUint(b, 5, 32),
        startTime: Number(readUint(b, 37, 8)),
        cutoffTime: Number(readUint(b, 45, 8)),
        optionCount: b[53],
        jointKey: [readUint(b, 54, 32), readUint(b, 86, 32)],
      };
    case OP.REGISTER: {
      const count = b[5];
      const commitments = [];
      for (let i = 0; i < count; i += 1) commitments.push(readUint(b, 6 + 32 * i, 32));
      return { type, electionId, commitments };
    }
    case OP.DISQUALIFY:
      return { type, electionId, commitment: readUint(b, 5, 32), reasonCode: Number(readUint(b, 37, 2)) };
    case OP.FORCED_BALLOT:
      return {
        type,
        electionId,
        nullifier: readUint(b, 5, 32),
        commitment: readUint(b, 37, 32),
        payloadHash: readUint(b, 69, 32),
      };
    case OP.CLOSE:
      return { type, electionId };
    default:
      throw new Error(`not a request op: ${type}`);
  }
}

/** Split pubdata into ops: `{ type, bytes, request, response }`. */
export function splitOps(pubdata) {
  const b = pubdata instanceof Uint8Array ? pubdata : fromHex(pubdata);
  const ops = [];
  let o = 0;
  while (o < b.length) {
    const { type, size, request } = sizeAt(b, o);
    if (o + size > b.length) throw new Error('truncated pubdata');
    const bytes = b.subarray(o, o + size);
    ops.push({ type, bytes, request: bytes.subarray(0, request), response: bytes.subarray(request) });
    o += size;
  }
  return ops;
}
