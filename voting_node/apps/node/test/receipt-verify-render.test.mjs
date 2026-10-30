// NOT FOR PROFIT — civic public good, not a commercial product.
// A mismatched receipt PDF is a warning. Every other accepted ballot keeps the server note.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { renderReceiptPortal } from '../public/receipt.js';

const SERVER_NOTE =
  'Your replacement ballot is counted in the final tally. The receipt still cannot prove which option was marked.';
const MISMATCH =
  'This ballot was accepted, but that PDF does not match the locked file the Node issued.';

function h(tag, attrs = {}, ...children) {
  return { tag, attrs: attrs || {}, children: children.flat() };
}

function nodes(node, acc = []) {
  if (node == null || node === false) return acc;
  if (Array.isArray(node)) {
    for (const child of node) nodes(child, acc);
    return acc;
  }
  if (typeof node === 'object' && node.tag) {
    acc.push(node);
    for (const child of node.children || []) nodes(child, acc);
  }
  return acc;
}

async function submit(result) {
  let painted = [];
  await renderReceiptPortal(
    {},
    {
      h,
      api: async (path) => {
        if (path === '/api/elections') return { elections: [] };
        if (path === '/api/receipts/verify') return result;
        if (String(path).startsWith('/api/receipts/metrics')) return { hours: [], note: '' };
        return null;
      },
      fill(_node, ...children) {
        painted = children.flat();
      },
      announce() {},
      setTitle() {},
    },
  );
  const form = nodes(painted).find((node) => node.tag === 'form');
  assert.ok(form?.attrs?.onSubmit);
  await form.attrs.onSubmit({
    preventDefault() {},
    target: { proof: { value: 'receipt-proof' } },
  });
  return nodes(painted);
}

function infoBanner(tree) {
  return tree.find((node) => String(node.attrs?.class || '').includes('notice') && node.attrs.class !== 'notice notice-error');
}

describe('receipt verify banner', () => {
  test('a mismatched PDF is a warning and any other accepted ballot keeps the server note', async () => {
    const mismatch = await submit({
      counted: true,
      pdfUnmodified: false,
      note: SERVER_NOTE,
      published: false,
      replacement: true,
      ballotHash: '0x22',
    });
    const warning = infoBanner(mismatch);
    assert.equal(warning.attrs.class, 'notice notice-warn');
    assert.equal(warning.children[0].attrs.text, MISMATCH);
    assert.equal(
      mismatch.some((node) => String(node.attrs?.class || '').includes('notice-ok') && node.children?.[0]?.attrs?.text === MISMATCH),
      false,
    );

    const accepted = await submit({
      counted: true,
      pdfUnmodified: true,
      note: SERVER_NOTE,
      published: false,
      replacement: true,
      ballotHash: '0x22',
    });
    const ok = infoBanner(accepted);
    assert.equal(ok.attrs.class, 'notice notice-ok');
    assert.equal(ok.children[0].attrs.text, SERVER_NOTE);
  });
});
