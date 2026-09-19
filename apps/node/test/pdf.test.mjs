// NOT FOR PROFIT — civic public good, not a commercial product.
// Deterministic PDFs: Terms stay unencrypted; vote receipts are Standard-Security locked.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildDeterministicPdf,
  decryptPdfStreams,
  pdfAllowsModify,
  PDF_RECEIPT_PERMISSIONS,
  readPdfEncryption,
} from '../src/pdf.mjs';
import { sha256Hex } from '../src/terms.mjs';

describe('deterministic PDF writer', () => {
  test('unencrypted terms-style PDF has no Encrypt dict and is stable', () => {
    const a = buildDeterministicPdf({
      title: 'Republic Terms of Use',
      lines: ['Alpha line', 'Beta line'],
      created: '2026-09-19',
    });
    const b = buildDeterministicPdf({
      title: 'Republic Terms of Use',
      lines: ['Alpha line', 'Beta line'],
      created: '2026-09-19',
    });
    assert.equal(a.subarray(0, 8).toString('latin1'), '%PDF-1.4');
    assert.equal(sha256Hex(a), sha256Hex(b));
    assert.equal(readPdfEncryption(a), null);
    assert.match(a.toString('latin1'), /Alpha line/);
  });

  test('protected PDF forbids modify, hides plaintext, decrypts with empty user password', () => {
    const token = 'tok_HOLD_ER_TOKEN_VALUE_32bytes____';
    const pdf = buildDeterministicPdf({
      title: 'Republic vote receipt',
      lines: [
        'This PDF is encrypted and locked against modification.',
        `Ballot hash: 0x${'ab'.repeat(32)}`,
        `Receipt token: ${token}`,
      ],
      created: '2026-09-19',
      protect: { ownerPassword: 'unit-owner-password' },
    });
    const enc = readPdfEncryption(pdf);
    assert.ok(enc);
    assert.equal(enc.filter, 'Standard');
    assert.equal(enc.permissions, PDF_RECEIPT_PERMISSIONS);
    assert.equal(pdfAllowsModify(enc.permissions), false);
    const latin = pdf.toString('latin1');
    assert.match(latin, /\/Filter \/Standard/);
    assert.doesNotMatch(latin, new RegExp(token));
    assert.doesNotMatch(latin, /Ballot hash: 0xab/);
    const streams = decryptPdfStreams(pdf, '');
    const opened = streams.map((s) => s.text).join('\n');
    assert.match(opened, /Ballot hash: 0xab/);
    assert.match(opened, new RegExp(token));
    assert.match(opened, /locked against modification/);
    const again = buildDeterministicPdf({
      title: 'Republic vote receipt',
      lines: [
        'This PDF is encrypted and locked against modification.',
        `Ballot hash: 0x${'ab'.repeat(32)}`,
        `Receipt token: ${token}`,
      ],
      created: '2026-09-19',
      protect: { ownerPassword: 'unit-owner-password' },
    });
    assert.equal(sha256Hex(pdf), sha256Hex(again));
  });
});
