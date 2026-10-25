// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { emailVerificationStatus } from '../public/email-verify-status.js';

const identity = {
  caps: { emails: 5 },
  emails: [
    { id: 'a', email: 'primary@example.com', primary: true, verified: true },
    { id: 'b', email: 'extra@example.com', primary: false, verified: false },
  ],
};

describe('email verification status', () => {
  test('verified addresses count as done and unverified ones keep the hub open', () => {
    const view = emailVerificationStatus(identity, { mfaRequired: false });
    assert.equal(view.done, 1);
    assert.equal(view.total, 2);
    assert.equal(view.pct, 50);
    assert.equal(view.complete, false);
    assert.equal(view.tone, 'incomplete');
    assert.equal(view.pending, null);
  });

  test('a sent code for a new address is pending and not yet verified', () => {
    const view = emailVerificationStatus(
      { caps: { emails: 5 }, emails: [{ id: 'a', email: 'primary@example.com', primary: true, verified: true }] },
      {
        mfaRequired: true,
        bindEmail: true,
        email: 'next@example.com',
        emailHint: 'n***@example.com',
        codeSent: true,
        sentAt: 1000,
        expiresAt: 2000,
      },
    );
    assert.equal(view.complete, false);
    assert.equal(view.pending.email, 'next@example.com');
    assert.equal(view.pending.codeSent, true);
    assert.equal(view.done, 1);
    assert.equal(view.total, 2);
    assert.equal(view.pct, 50);
  });

  test('no email yet is incomplete at 0 of 1', () => {
    const view = emailVerificationStatus({ emails: [] }, null);
    assert.equal(view.done, 0);
    assert.equal(view.total, 1);
    assert.equal(view.pct, 0);
    assert.equal(view.complete, false);
  });

  test('all verified and no outstanding code is complete', () => {
    const view = emailVerificationStatus(
      { emails: [{ id: 'a', email: 'primary@example.com', primary: true, verified: true }] },
      { mfaRequired: false },
    );
    assert.equal(view.complete, true);
    assert.equal(view.tone, 'complete');
    assert.equal(view.pct, 100);
  });

  test('sign-in and PIN-reset challenges are not profile pending rows', () => {
    const base = { emails: [{ id: 'a', email: 'primary@example.com', primary: true, verified: true }] };
    const login = emailVerificationStatus(base, { mfaRequired: true, bindEmail: false, purpose: 'mfa' });
    const pin = emailVerificationStatus(base, { mfaRequired: true, bindEmail: true, purpose: 'pin-reset', email: 'other@example.com' });
    assert.equal(login.complete, true);
    assert.equal(login.pending, null);
    assert.equal(pin.complete, true);
    assert.equal(pin.pending, null);
  });
});
