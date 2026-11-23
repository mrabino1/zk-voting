/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Keccak-256 (Ethereum's hash, not NIST SHA-3), dependency-free, for the browser and Node.
 *   keccak256("")    = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
 *   keccak256("abc") = 4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
 */

const textEncoder = new TextEncoder();

function hexOf(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (Array.isArray(input)) return Uint8Array.from(input);
  throw new TypeError("keccak256: expected bytes or a string");
}

const KECCAK_RC = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

const KECCAK_RHO = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

const MASK64 = 0xffffffffffffffffn;

function rotl64(x, n) {
  const s = BigInt(n % 64);
  if (s === 0n) return x;
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

function keccakF1600(a) {
  for (let round = 0; round < 24; round++) {
    const c = new Array(5);
    for (let x = 0; x < 5; x++) {
      c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    }
    const d = new Array(5);
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }
    for (let i = 0; i < 25; i++) a[i] ^= d[i % 5];

    const b = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const src = x + 5 * y;
        const destX = y;
        const destY = (2 * x + 3 * y) % 5;
        b[destX + 5 * destY] = rotl64(a[src], KECCAK_RHO[src]);
      }
    }

    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        a[i] = b[i] ^ (~b[((x + 1) % 5) + 5 * y] & b[((x + 2) % 5) + 5 * y]);
        a[i] &= MASK64;
      }
    }
    a[0] ^= KECCAK_RC[round];
  }
}

/**
 * @param {BufferSource | Uint8Array | number[] | string} input bytes, or UTF-8 string
 * @returns {Uint8Array} 32-byte digest
 */
export function keccak256(input) {
  const data =
    typeof input === "string" ? textEncoder.encode(input) : asBytes(input);
  const rate = 136;
  const state = new Array(25).fill(0n);
  const block = new Uint8Array(rate);
  let offset = 0;
  while (offset < data.length) {
    const n = Math.min(rate, data.length - offset);
    block.fill(0);
    block.set(data.subarray(offset, offset + n));
    if (n < rate) {
      block[n] ^= 0x01;
      block[rate - 1] ^= 0x80;
      xorBlock(state, block);
      keccakF1600(state);
      offset = data.length;
      break;
    }
    xorBlock(state, block);
    keccakF1600(state);
    offset += n;
  }
  if (data.length % rate === 0) {
    block.fill(0);
    block[0] ^= 0x01;
    block[rate - 1] ^= 0x80;
    xorBlock(state, block);
    keccakF1600(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) store64(out, i * 8, state[i]);
  return out;
}

function xorBlock(state, block) {
  for (let i = 0; i < 17; i++) {
    state[i] ^= load64(block, i * 8);
  }
}

function load64(bytes, offset) {
  let x = 0n;
  for (let i = 0; i < 8; i++) x |= BigInt(bytes[offset + i]) << BigInt(8 * i);
  return x;
}

function store64(bytes, offset, x) {
  for (let i = 0; i < 8; i++) bytes[offset + i] = Number((x >> BigInt(8 * i)) & 0xffn);
}

export function keccak256Hex(input) {
  return "0x" + hexOf(keccak256(input));
}
