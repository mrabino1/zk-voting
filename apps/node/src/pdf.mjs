// NOT FOR PROFIT — civic public good, not a commercial product.
// Deterministic PDF 1.4 writer (Helvetica, fixed dates). No host timestamps
// in the file so SHA-256 of the exact bytes is stable across machines.
// Vote receipts optionally use ISO 32000 Standard Security (R=3, 128-bit RC4):
// empty user password (anyone can open/read/print/copy), owner password
// derived per receipt, permission flags that forbid modify/assemble.

import { brandName } from './branding.mjs';
import { createHash } from 'node:crypto';

import { qrPdfOperators } from './qr.mjs';

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const FONT_SIZE = 11;
const LEADING = 14;
const TITLE_SIZE = 16;
const CHAR_WIDTH = 0.5;
export const PDF_MAX_CHARS = Math.floor((PAGE_W - MARGIN * 2) / (FONT_SIZE * CHAR_WIDTH));

/** PDF 1.4 password padding (ISO 32000-1 Algorithm 2). */
export const PDF_PASSWORD_PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e,
  0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function latin1(text) {
  return String(text || '')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, (ch) => {
      const map = {
        '\u2018': "'",
        '\u2019': "'",
        '\u201c': '"',
        '\u201d': '"',
        '\u2013': '-',
        '\u2014': '-',
        '\u2022': '*',
        '\u2026': '...',
        '\u00a0': ' ',
      };
      return map[ch] || '?';
    });
}

function pdfEscape(text) {
  return latin1(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function wrapPdfLine(text, max = PDF_MAX_CHARS) {
  const raw = latin1(text).replace(/\s+/g, ' ').trim();
  if (!raw) return [''];
  const words = raw.split(' ');
  const lines = [];
  let cur = '';
  for (const word of words) {
    if (word.length > max) {
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      for (let i = 0; i < word.length; i += max) {
        const slice = word.slice(i, i + max);
        if (slice.length === max) lines.push(slice);
        else cur = slice;
      }
      continue;
    }
    const next = cur ? `${cur} ${word}` : word;
    if (next.length <= max) cur = next;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function pdfDate(isoDay) {
  const day = String(isoDay || '2026-09-19').replace(/-/g, '').slice(0, 8);
  const ymd = /^\d{8}$/.test(day) ? day : '20260919';
  return `D:${ymd}000000Z`;
}

function paginate(title, lines) {
  const wrapped = [{ size: TITLE_SIZE, text: String(title || `${brandName()} Terms of Use`) }, { size: FONT_SIZE, text: '' }];
  for (const line of lines) {
    for (const chunk of wrapPdfLine(line, PDF_MAX_CHARS)) {
      wrapped.push({ size: FONT_SIZE, text: chunk });
    }
  }
  const usable = PAGE_H - MARGIN * 2;
  const pages = [];
  let current = [];
  let yUsed = 0;
  for (const row of wrapped) {
    const h = row.text === '' ? LEADING / 2 : row.size === TITLE_SIZE ? TITLE_SIZE + 6 : LEADING;
    if (current.length && yUsed + h > usable) {
      pages.push(current);
      current = [];
      yUsed = 0;
    }
    current.push(row);
    yUsed += h;
  }
  if (current.length) pages.push(current);
  if (!pages.length) pages.push([{ size: FONT_SIZE, text: String(title || brandName()) }]);
  return pages;
}

function contentStream(rows) {
  const ops = ['BT', `/F1 ${FONT_SIZE} Tf`, `${MARGIN} ${PAGE_H - MARGIN} Td`];
  let lastSize = FONT_SIZE;
  for (const row of rows) {
    if (row.size !== lastSize) {
      ops.push(`/F1 ${row.size} Tf`);
      lastSize = row.size;
    }
    const dy = row.text === '' ? -(LEADING / 2) : row.size === TITLE_SIZE ? -(TITLE_SIZE + 6) : -LEADING;
    ops.push(`0 ${dy} Td`);
    ops.push(`(${pdfEscape(row.text)}) Tj`);
  }
  ops.push('ET');
  return `${ops.join('\n')}\n`;
}

function md5(buf) {
  return createHash('md5').update(buf).digest();
}

export function rc4(key, data) {
  const s = Buffer.alloc(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;
  const k = Buffer.isBuffer(key) ? key : Buffer.from(key);
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + k[i % k.length]) & 255;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }
  const out = Buffer.alloc(input.length);
  let x = 0;
  let y = 0;
  for (let i = 0; i < input.length; i += 1) {
    x = (x + 1) & 255;
    y = (y + s[x]) & 255;
    const tmp = s[x];
    s[x] = s[y];
    s[y] = tmp;
    out[i] = input[i] ^ s[(s[x] + s[y]) & 255];
  }
  return out;
}

export function padPdfPassword(password) {
  const raw = Buffer.from(String(password || ''), 'latin1').subarray(0, 32);
  if (raw.length === 32) return Buffer.from(raw);
  return Buffer.concat([raw, PDF_PASSWORD_PAD.subarray(0, 32 - raw.length)]);
}

/**
 * ISO 32000-1 permission flags (Revision 3+). Bits 1–2 are 0, 7–8 and 13–32 are 1.
 * Default: print + copy + accessibility, no modify / assemble / form fill.
 */
export function pdfPermissionFlags({
  print = true,
  modify = false,
  copy = true,
  annots = false,
  fillForms = false,
  assemble = false,
  accessibility = true,
  printHighQuality = true,
} = {}) {
  let bits = 0;
  if (print) bits |= 1 << 2;
  if (modify) bits |= 1 << 3;
  if (copy) bits |= 1 << 4;
  if (annots) bits |= 1 << 5;
  bits |= 1 << 6;
  bits |= 1 << 7;
  if (fillForms) bits |= 1 << 8;
  if (accessibility) bits |= 1 << 9;
  if (assemble) bits |= 1 << 10;
  if (printHighQuality) bits |= 1 << 11;
  bits |= 0xfffff000;
  return bits | 0;
}

export const PDF_RECEIPT_PERMISSIONS = pdfPermissionFlags({
  print: true,
  modify: false,
  copy: true,
  annots: false,
  fillForms: false,
  assemble: false,
  accessibility: true,
  printHighQuality: true,
});

export function pdfAllowsModify(p) {
  return (Number(p) & (1 << 3)) !== 0;
}

function xorKey(key, n) {
  const out = Buffer.alloc(key.length);
  for (let i = 0; i < key.length; i += 1) out[i] = key[i] ^ n;
  return out;
}

/** Algorithm 3 — owner-password entry O (R=3, 128-bit). */
export function pdfOwnerKey(userPassword, ownerPassword) {
  let hash = md5(padPdfPassword(ownerPassword || userPassword));
  for (let i = 0; i < 50; i += 1) hash = md5(hash);
  const key = hash.subarray(0, 16);
  let out = rc4(key, padPdfPassword(userPassword));
  for (let i = 1; i <= 19; i += 1) out = rc4(xorKey(key, i), out);
  return out;
}

/** Algorithm 2 — file encryption key (R=3, 128-bit). */
export function pdfFileKey(userPassword, ownerEntry, permissions, idBytes) {
  const pBuf = Buffer.alloc(4);
  pBuf.writeInt32LE(permissions | 0, 0);
  let hash = md5(Buffer.concat([padPdfPassword(userPassword), ownerEntry, pBuf, idBytes]));
  for (let i = 0; i < 50; i += 1) hash = md5(hash);
  return hash.subarray(0, 16);
}

/** Algorithm 5 — user-password entry U (R=3). */
export function pdfUserKey(fileKey, idBytes) {
  let out = rc4(fileKey, md5(Buffer.concat([PDF_PASSWORD_PAD, idBytes])));
  for (let i = 1; i <= 19; i += 1) out = rc4(xorKey(fileKey, i), out);
  return Buffer.concat([out.subarray(0, 16), Buffer.alloc(16)]);
}

/** Algorithm 1 — object key, then RC4 (symmetric). */
export function pdfObjectKey(fileKey, objectNumber, generation = 0) {
  const extra = Buffer.alloc(5);
  extra[0] = objectNumber & 0xff;
  extra[1] = (objectNumber >> 8) & 0xff;
  extra[2] = (objectNumber >> 16) & 0xff;
  extra[3] = generation & 0xff;
  extra[4] = (generation >> 8) & 0xff;
  const hash = md5(Buffer.concat([fileKey, extra]));
  return hash.subarray(0, Math.min(fileKey.length + 5, 16));
}

export function encryptPdfBytes(fileKey, objectNumber, data, generation = 0) {
  const plain = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return rc4(pdfObjectKey(fileKey, objectNumber, generation), plain);
}

function hexLiteral(buf) {
  return `<${Buffer.from(buf).toString('hex')}>`;
}

function encryptedPdfString(fileKey, objectNumber, text) {
  return hexLiteral(encryptPdfBytes(fileKey, objectNumber, Buffer.from(latin1(text), 'latin1')));
}

function objectBuffer(id, body) {
  const head = Buffer.from(`${id} 0 obj\n`, 'ascii');
  const tail = Buffer.from('\nendobj\n', 'ascii');
  const mid = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  return Buffer.concat([head, mid, tail]);
}

function streamBuffer(dictAndOpen, payload, close = 'endstream') {
  return Buffer.concat([
    Buffer.isBuffer(dictAndOpen) ? dictAndOpen : Buffer.from(dictAndOpen, 'ascii'),
    payload,
    Buffer.from(close, 'ascii'),
  ]);
}

export function pdfFileIdFromCanonical({ title, lines, created }) {
  const canonical = `${title}\n${created}\n${(lines || []).join('\n')}`;
  return createHash('sha256').update(canonical, 'utf8').digest().subarray(0, 16);
}

function authenticityContentStream(authenticity) {
  const heading = authenticity.heading || 'Authenticity seal';
  const lines = authenticity.lines || [];
  const ops = [
    'BT',
    `/F1 ${TITLE_SIZE} Tf`,
    `${MARGIN} ${PAGE_H - MARGIN} Td`,
    `0 ${-(TITLE_SIZE + 6)} Td`,
    `(${pdfEscape(heading)}) Tj`,
    `/F1 ${FONT_SIZE} Tf`,
  ];
  for (const line of lines) {
    for (const chunk of wrapPdfLine(line, PDF_MAX_CHARS)) {
      ops.push(`0 ${-LEADING} Td`);
      ops.push(`(${pdfEscape(chunk)}) Tj`);
    }
  }
  ops.push('ET');
  let graphics = '';
  if (authenticity.modules && authenticity.modules.length) {
    const n = authenticity.modules.length;
    const moduleSize = Number(authenticity.moduleSize) || 2.6;
    const qrW = n * moduleSize;
    const originX = authenticity.x != null ? Number(authenticity.x) : MARGIN;
    const originY = authenticity.y != null ? Number(authenticity.y) : MARGIN + 36;
    graphics = qrPdfOperators(authenticity.modules, originX, originY, moduleSize);
    const caption = authenticity.caption || '';
    if (caption) {
      const capX = originX + qrW + 16;
      const capY = originY + qrW - 12;
      const capOps = ['BT', `/F1 9 Tf`, `${capX.toFixed(2)} ${capY.toFixed(2)} Td`];
      const capWidth = Math.max(24, Math.floor((PAGE_W - capX - MARGIN) / (9 * CHAR_WIDTH)));
      let first = true;
      for (const chunk of wrapPdfLine(caption, capWidth)) {
        if (!first) capOps.push(`0 ${-12} Td`);
        capOps.push(`(${pdfEscape(chunk)}) Tj`);
        first = false;
      }
      capOps.push('ET');
      graphics += `${capOps.join('\n')}\n`;
    }
  }
  return `${ops.join('\n')}\n${graphics}`;
}

/**
 * @param {{
 *   title: string,
 *   lines: string[],
 *   created?: string,
 *   protect?: null | {
 *     ownerPassword: string,
 *     userPassword?: string,
 *     permissions?: number,
 *     fileId?: Buffer,
 *   },
 *   authenticity?: null | {
 *     heading?: string,
 *     lines?: string[],
 *     modules?: boolean[][],
 *     caption?: string,
 *     moduleSize?: number,
 *     x?: number,
 *     y?: number,
 *   }
 * }} input
 * @returns {Buffer}
 */
/**
 * `author` names the product in the PDF info dictionary. It defaults to the live
 * brand; pass a fixed value when the PDF bytes must hash the same across renames.
 */
export function buildDeterministicPdf({
  title,
  lines,
  created = '2026-09-19',
  protect = null,
  authenticity = null,
  author = brandName(),
}) {
  const pageRows = paginate(title, lines);
  const hasAuth = Boolean(authenticity && (authenticity.modules || (authenticity.lines && authenticity.lines.length)));
  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  const infoId = 4;
  const firstPageId = 5;
  const extraPages = hasAuth ? 1 : 0;
  const pageCount = pageRows.length + extraPages;
  const pageIds = Array.from({ length: pageCount }, (_, i) => firstPageId + i);
  const contentIds = Array.from({ length: pageCount }, (_, i) => firstPageId + pageCount + i);
  let maxId = contentIds[contentIds.length - 1];

  const locked = Boolean(protect && protect.ownerPassword);
  let fileKey = null;
  let fileId = null;
  let permissions = 0;
  let encryptId = null;
  let encryptBody = null;
  if (locked) {
    fileId = protect.fileId
      ? Buffer.from(protect.fileId).subarray(0, 16)
      : pdfFileIdFromCanonical({
          title,
          lines: [
            ...(lines || []),
            authenticity?.heading || '',
            ...(authenticity?.lines || []),
            authenticity?.caption || '',
          ],
          created,
        });
    if (fileId.length !== 16) {
      throw new Error('PDF file ID must be 16 bytes');
    }
    permissions = protect.permissions == null ? PDF_RECEIPT_PERMISSIONS : protect.permissions | 0;
    const userPassword = protect.userPassword || '';
    const ownerEntry = pdfOwnerKey(userPassword, protect.ownerPassword);
    fileKey = pdfFileKey(userPassword, ownerEntry, permissions, fileId);
    const userEntry = pdfUserKey(fileKey, fileId);
    encryptId = maxId + 1;
    maxId = encryptId;
    encryptBody =
      `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${permissions} /O ${hexLiteral(ownerEntry)} /U ${hexLiteral(userEntry)} >>`;
  }

  const bodies = new Array(maxId + 1);
  bodies[catalogId] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  bodies[pagesId] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  bodies[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  if (locked) {
    bodies[infoId] =
      `<< /Title ${encryptedPdfString(fileKey, infoId, title)} /Author ${encryptedPdfString(fileKey, infoId, author)} /Creator ${encryptedPdfString(fileKey, infoId, `${author} node`)} /Producer ${encryptedPdfString(fileKey, infoId, `${author} node NOT FOR PROFIT`)} /CreationDate ${encryptedPdfString(fileKey, infoId, pdfDate(created))} /ModDate ${encryptedPdfString(fileKey, infoId, pdfDate(created))} >>`;
    bodies[encryptId] = encryptBody;
  } else {
    bodies[infoId] =
      `<< /Title (${pdfEscape(title)}) /Author (${pdfEscape(author)}) /Creator (${pdfEscape(author)} node) /Producer (${pdfEscape(author)} node NOT FOR PROFIT) /CreationDate (${pdfDate(created)}) /ModDate (${pdfDate(created)}) >>`;
  }

  for (let i = 0; i < pageCount; i += 1) {
    bodies[pageIds[i]] =
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    const stream =
      i < pageRows.length ? contentStream(pageRows[i]) : authenticityContentStream(authenticity);
    if (locked) {
      const cipher = encryptPdfBytes(fileKey, contentIds[i], Buffer.from(stream, 'utf8'));
      bodies[contentIds[i]] = streamBuffer(`<< /Length ${cipher.length} >>\nstream\n`, cipher);
    } else {
      const len = Buffer.byteLength(stream, 'utf8');
      bodies[contentIds[i]] = `<< /Length ${len} >>\nstream\n${stream}endstream`;
    }
  }

  const chunks = [Buffer.from('%PDF-1.4\n%', 'ascii'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
  const offsets = [0];
  let cursor = chunks.reduce((n, b) => n + b.length, 0);
  for (let i = 1; i <= maxId; i += 1) {
    offsets[i] = cursor;
    const obj = objectBuffer(i, bodies[i]);
    chunks.push(obj);
    cursor += obj.length;
  }
  const xrefAt = cursor;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const idPair = locked ? ` /Encrypt ${encryptId} 0 R /ID [${hexLiteral(fileId)} ${hexLiteral(fileId)}]` : '';
  const tail = Buffer.from(
    `${xref}trailer\n<< /Size ${maxId + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R${idPair} >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    'utf8',
  );
  chunks.push(tail);
  return Buffer.concat(chunks);
}

export function readPdfEncryption(pdf) {
  const text = Buffer.from(pdf).toString('latin1');
  if (!/\/Filter\s*\/Standard/.test(text)) return null;
  const p = text.match(/\/P\s+(-?\d+)/);
  const o = text.match(/\/O\s*<([0-9a-fA-F]+)>/);
  const u = text.match(/\/U\s*<([0-9a-fA-F]+)>/);
  const id = text.match(/\/ID\s*\[\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\]/);
  const length = text.match(/\/Length\s+(\d+)/);
  if (!p || !o || !u || !id) return null;
  return {
    filter: 'Standard',
    revision: 3,
    permissions: Number(p[1]),
    length: length ? Number(length[1]) : 128,
    O: Buffer.from(o[1], 'hex'),
    U: Buffer.from(u[1], 'hex'),
    id: Buffer.from(id[1], 'hex'),
  };
}

/**
 * Decrypt content streams with the empty user password (receipt PDFs are
 * readable without a password; they are locked against modification).
 */
export function decryptPdfStreams(pdf, userPassword = '') {
  const enc = readPdfEncryption(pdf);
  if (!enc) return [];
  const fileKey = pdfFileKey(userPassword, enc.O, enc.permissions, enc.id);
  const text = Buffer.from(pdf).toString('latin1');
  const re = /(\d+) 0 obj\n<< \/Length (\d+) >>\nstream\n/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const num = Number(m[1]);
    const len = Number(m[2]);
    const start = m.index + m[0].length;
    const cipher = Buffer.from(text.slice(start, start + len), 'latin1');
    const plain = encryptPdfBytes(fileKey, num, cipher);
    out.push({ objectNumber: num, text: plain.toString('utf8') });
  }
  return out;
}
