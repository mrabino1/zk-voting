// NOT FOR PROFIT — civic public good, not a commercial sequencer.
// stripForbidden must not let forbidden keys ride in on a __proto__ key.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { stripForbidden } from '../sequencer/state.mjs';

describe('stripForbidden', () => {
  test('drops prototype keys from parsed JSON', () => {
    const input = JSON.parse('{"type":"vote","__proto__":{"choice":"yes"},"nested":{"prototype":{"x":1},"keep":2}}');
    const out = stripForbidden(input);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(out.choice, undefined);
    assert.equal(out.type, 'vote');
    assert.deepEqual(out.nested, { keep: 2 });
  });
});
