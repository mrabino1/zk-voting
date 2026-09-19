// NOT FOR PROFIT — civic public good, not a commercial product.
// QR Code Model 2 encoder (ISO/IEC 18004). Byte and alphanumeric, ECC M,
// versions 1–10. Used to seal official outcome PDFs; the payload is a
// verify URL or compact report token. Not a third-party dependency.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (!a || !b) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGenerator(nsym) {
  let poly = [1];
  for (let i = 0; i < nsym; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, nsym) {
  const gen = rsGenerator(nsym);
  const ecc = new Array(nsym).fill(0);
  for (const byte of data) {
    const factor = byte ^ ecc[0];
    ecc.shift();
    ecc.push(0);
    if (!factor) continue;
    for (let i = 0; i < nsym; i += 1) {
      ecc[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return ecc;
}

/** ECC-M block layout: ec per block, groups of [blockCount, dataPerBlock]. */
const EC_M = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] },
};

const ALIGN = {
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const REMAINDER = { 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export function isQrAlphanumeric(text) {
  return [...String(text || '')].every((ch) => ALNUM.includes(ch));
}

function dataCapacity(version) {
  const spec = EC_M[version];
  return spec.groups.reduce((n, [blocks, data]) => n + blocks * data, 0);
}

function charCountBits(version, mode) {
  if (mode === 'alnum') return version <= 9 ? 9 : 11;
  return version <= 9 ? 8 : 16;
}

function bitWriter() {
  const bits = [];
  function write(value, len) {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  }
  function toBytes(max) {
    const out = [];
    for (let i = 0; i < bits.length && out.length < max; i += 8) {
      let b = 0;
      for (let j = 0; j < 8 && i + j < bits.length; j += 1) {
        b = (b << 1) | bits[i + j];
      }
      if (i + 8 > bits.length) b <<= 8 - (bits.length - i);
      out.push(b);
    }
    return out;
  }
  return { bits, write, toBytes, get length() { return bits.length; } };
}

function encodeDataBits(payload, version, mode) {
  const text = String(payload || '');
  const w = bitWriter();
  if (mode === 'alnum') {
    w.write(0b0010, 4);
    w.write(text.length, charCountBits(version, 'alnum'));
    for (let i = 0; i < text.length; i += 2) {
      if (i + 1 < text.length) {
        w.write(ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
      } else {
        w.write(ALNUM.indexOf(text[i]), 6);
      }
    }
  } else {
    const bytes = Buffer.from(text, 'utf8');
    w.write(0b0100, 4);
    w.write(bytes.length, charCountBits(version, 'byte'));
    for (const b of bytes) w.write(b, 8);
  }
  const cap = dataCapacity(version) * 8;
  const term = Math.min(4, cap - w.length);
  if (term > 0) w.write(0, term);
  while (w.length % 8 !== 0 && w.length < cap) w.write(0, 1);
  const bytes = w.toBytes(dataCapacity(version));
  const pads = [0xec, 0x11];
  let p = 0;
  while (bytes.length < dataCapacity(version)) {
    bytes.push(pads[p % 2]);
    p += 1;
  }
  return bytes;
}

function eccBlocks(dataBytes, version) {
  const spec = EC_M[version];
  const blocks = [];
  let offset = 0;
  for (const [count, dataLen] of spec.groups) {
    for (let i = 0; i < count; i += 1) {
      const data = dataBytes.slice(offset, offset + dataLen);
      offset += dataLen;
      blocks.push({ data, ecc: rsEncode(data, spec.ec) });
    }
  }
  const interleaved = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) interleaved.push(block.data[i]);
    }
  }
  const maxEcc = spec.ec;
  for (let i = 0; i < maxEcc; i += 1) {
    for (const block of blocks) interleaved.push(block.ecc[i]);
  }
  return interleaved;
}

function sizeOf(version) {
  return 21 + 4 * (version - 1);
}

function inFinder(row, col, size) {
  const in7 = (r, c) => r >= 0 && r < 7 && c >= 0 && c < 7;
  return in7(row, col) || in7(row, col - (size - 7)) || in7(row - (size - 7), col);
}

function inTiming(row, col, size) {
  if (inFinder(row, col, size)) return false;
  return row === 6 || col === 6;
}

function alignmentCoords(version) {
  const pos = ALIGN[version];
  if (!pos) return [];
  const out = [];
  for (const r of pos) {
    for (const c of pos) {
      if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (r === pos[pos.length - 1] && c === 6)) {
        continue;
      }
      out.push([r, c]);
    }
  }
  return out;
}

function inAlignment(row, col, version) {
  for (const [cr, cc] of alignmentCoords(version)) {
    if (Math.abs(row - cr) <= 2 && Math.abs(col - cc) <= 2) return true;
  }
  return false;
}

function reserved(row, col, version) {
  const size = sizeOf(version);
  if (inFinder(row, col, size)) return true;
  if (row === 6 || col === 6) return true;
  if (inAlignment(row, col, version)) return true;
  if (row === 8 && (col <= 8 || col >= size - 8)) return true;
  if (col === 8 && (row <= 8 || row >= size - 8)) return true;
  if (version >= 7) {
    if (row < 6 && col >= size - 11) return true;
    if (col < 6 && row >= size - 11) return true;
  }
  return false;
}

function placeFinder(grid, top, left) {
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      const edge = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      grid[top + r][left + c] = edge || core;
    }
  }
}

function placeAlignment(grid, cr, cc) {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const edge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
      grid[cr + dr][cc + dc] = edge || (dr === 0 && dc === 0);
    }
  }
}

function maskBit(mask, row, col) {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function bch15(data) {
  let bits = data << 10;
  const gen = 0b10100110111;
  for (let i = 14; i >= 10; i -= 1) {
    if ((bits >>> i) & 1) bits ^= gen << (i - 10);
  }
  return ((data << 10) | bits) ^ 0x5412;
}

function placeFormat(grid, mask) {
  const size = grid.length;
  const bits = bch15((0b00 << 3) | mask);
  const coords = [];
  for (let i = 0; i <= 5; i += 1) coords.push([i, 8]);
  coords.push([7, 8], [8, 8], [8, 7]);
  for (let i = 5; i >= 0; i -= 1) coords.push([8, i]);
  for (let i = 0; i < 15; i += 1) {
    const bit = Boolean((bits >>> (14 - i)) & 1);
    const [r, c] = coords[i];
    grid[r][c] = bit;
    if (i < 8) grid[8][size - 1 - i] = bit;
    else grid[size - 15 + i][8] = bit;
  }
  grid[size - 8][8] = true;
}

function bch18(data) {
  let bits = data << 12;
  const gen = 0b1111100100101;
  for (let i = 17; i >= 12; i -= 1) {
    if ((bits >>> i) & 1) bits ^= gen << (i - 12);
  }
  return (data << 12) | bits;
}

function placeVersion(grid, version) {
  if (version < 7) return;
  const size = grid.length;
  const bits = bch18(version);
  let k = 0;
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const bit = Boolean((bits >>> k) & 1);
      k += 1;
      grid[i][size - 11 + j] = bit;
      grid[size - 11 + j][i] = bit;
    }
  }
}

function zigzagFill(grid, version, codewords) {
  const size = grid.length;
  const bits = [];
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  }
  const rem = REMAINDER[version] || 0;
  for (let i = 0; i < rem; i += 1) bits.push(0);
  let bi = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let n = 0; n < size; n += 1) {
      const row = up ? size - 1 - n : n;
      for (const c of [col, col - 1]) {
        if (reserved(row, c, version)) continue;
        grid[row][c] = bi < bits.length ? Boolean(bits[bi]) : false;
        bi += 1;
      }
    }
    up = !up;
  }
}

function applyMask(grid, version, mask) {
  const size = grid.length;
  const out = grid.map((row) => row.slice());
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (reserved(r, c, version)) continue;
      if (maskBit(mask, r, c)) out[r][c] = !out[r][c];
    }
  }
  return out;
}

function penalty(grid) {
  const size = grid.length;
  let score = 0;
  for (let r = 0; r < size; r += 1) {
    let run = 1;
    for (let c = 1; c < size; c += 1) {
      if (grid[r][c] === grid[r][c - 1]) {
        run += 1;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  for (let c = 0; c < size; c += 1) {
    let run = 1;
    for (let r = 1; r < size; r += 1) {
      if (grid[r][c] === grid[r - 1][c]) {
        run += 1;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }
  const finder = [true, false, true, true, true, false, true];
  function finderRuns(line) {
    for (let i = 0; i <= line.length - 7; i += 1) {
      let ok = true;
      for (let j = 0; j < 7; j += 1) {
        if (line[i + j] !== finder[j]) {
          ok = false;
          break;
        }
      }
      if (ok) score += 40;
    }
  }
  for (let r = 0; r < size; r += 1) finderRuns(grid[r]);
  for (let c = 0; c < size; c += 1) finderRuns(grid.map((row) => row[c]));
  let dark = 0;
  for (const row of grid) for (const cell of row) if (cell) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

function emptyGrid(version) {
  const size = sizeOf(version);
  const grid = Array.from({ length: size }, () => Array(size).fill(false));
  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, size - 7);
  placeFinder(grid, size - 7, 0);
  for (let i = 8; i < size - 8; i += 1) {
    grid[6][i] = i % 2 === 0;
    grid[i][6] = i % 2 === 0;
  }
  for (const [r, c] of alignmentCoords(version)) placeAlignment(grid, r, c);
  placeVersion(grid, version);
  return grid;
}

function fitVersion(payload, mode) {
  const text = String(payload || '');
  const bytes = Buffer.from(text, 'utf8');
  for (let v = 1; v <= 10; v += 1) {
    const capBits = dataCapacity(v) * 8;
    let need;
    if (mode === 'alnum') {
      const pairs = Math.floor(text.length / 2);
      const odd = text.length % 2;
      need = 4 + charCountBits(v, 'alnum') + pairs * 11 + odd * 6;
    } else {
      need = 4 + charCountBits(v, 'byte') + bytes.length * 8;
    }
    if (need + 4 <= capBits) return v;
  }
  throw new Error('QR payload too long for versions 1-10');
}

/**
 * @param {string} payload
 * @returns {{ version: number, size: number, modules: boolean[][], payload: string, mode: string }}
 */
export function encodeQr(payload) {
  const text = String(payload || '');
  if (!text) throw new Error('QR payload required');
  const mode = isQrAlphanumeric(text) ? 'alnum' : 'byte';
  const version = fitVersion(text, mode);
  const data = encodeDataBits(text, version, mode);
  const codewords = eccBlocks(data, version);
  const base = emptyGrid(version);
  zigzagFill(base, version, codewords);
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const masked = applyMask(base, version, mask);
    placeFormat(masked, mask);
    placeVersion(masked, version);
    const score = penalty(masked);
    if (score < bestScore) {
      bestScore = score;
      best = masked;
    }
  }
  return {
    version,
    size: best.length,
    modules: best,
    payload: text,
    mode,
    ecc: 'M',
  };
}

export function qrPdfOperators(modules, originX, originY, moduleSize) {
  const n = modules.length;
  const ops = ['q', '0 g'];
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (!modules[r][c]) continue;
      const x = originX + c * moduleSize;
      const y = originY + (n - 1 - r) * moduleSize;
      ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${moduleSize.toFixed(2)} ${moduleSize.toFixed(2)} re`);
    }
  }
  ops.push('f', 'Q');
  return `${ops.join('\n')}\n`;
}
