// NOT FOR PROFIT — civic public good, not a commercial product.
// Deterministic PDF 1.4 writer (Helvetica, fixed dates). No host timestamps
// in the file so SHA-256 of the exact bytes is stable across machines.

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const FONT_SIZE = 11;
const LEADING = 14;
const TITLE_SIZE = 16;
const CHAR_WIDTH = 0.5;
export const PDF_MAX_CHARS = Math.floor((PAGE_W - MARGIN * 2) / (FONT_SIZE * CHAR_WIDTH));

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
  const wrapped = [{ size: TITLE_SIZE, text: String(title || 'Republic Terms of Use') }, { size: FONT_SIZE, text: '' }];
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
  if (!pages.length) pages.push([{ size: FONT_SIZE, text: String(title || 'Republic') }]);
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

/**
 * @param {{ title: string, lines: string[], created?: string }} input
 * @returns {Buffer}
 */
export function buildDeterministicPdf({ title, lines, created = '2026-09-19' }) {
  const pageRows = paginate(title, lines);
  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  const infoId = 4;
  const firstPageId = 5;
  const pageCount = pageRows.length;
  const pageIds = pageRows.map((_, i) => firstPageId + i);
  const contentIds = pageRows.map((_, i) => firstPageId + pageCount + i);
  const maxId = contentIds[contentIds.length - 1];

  const bodies = new Array(maxId + 1);
  bodies[catalogId] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  bodies[pagesId] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  bodies[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  bodies[infoId] =
    `<< /Title (${pdfEscape(title)}) /Author (Republic) /Creator (Republic Node) /Producer (Republic Node NOT FOR PROFIT) /CreationDate (${pdfDate(created)}) /ModDate (${pdfDate(created)}) >>`;

  for (let i = 0; i < pageCount; i += 1) {
    bodies[pageIds[i]] =
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    const stream = contentStream(pageRows[i]);
    const len = Buffer.byteLength(stream, 'utf8');
    bodies[contentIds[i]] = `<< /Length ${len} >>\nstream\n${stream}endstream`;
  }

  const chunks = [Buffer.from('%PDF-1.4\n%', 'ascii'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
  const offsets = [0];
  let cursor = chunks.reduce((n, b) => n + b.length, 0);
  for (let i = 1; i <= maxId; i += 1) {
    offsets[i] = cursor;
    const obj = Buffer.from(`${i} 0 obj\n${bodies[i]}\nendobj\n`, 'utf8');
    chunks.push(obj);
    cursor += obj.length;
  }
  const xrefAt = cursor;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const tail = Buffer.from(
    `${xref}trailer\n<< /Size ${maxId + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    'utf8',
  );
  chunks.push(tail);
  return Buffer.concat(chunks);
}
