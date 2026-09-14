// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_DISCLOSURE_INTERVAL_SECONDS,
  disclosurePublicView,
  hourBucket,
  isDisclosed,
  isDelayedPublicType,
  nextPublishAt,
  publishedThrough,
  resolveDisclosureIntervalSeconds,
} from '../src/disclosure.mjs';

describe('hourly disclosure math', () => {
  test('defaults to one hour, and to zero in tests', () => {
    assert.equal(DEFAULT_DISCLOSURE_INTERVAL_SECONDS, 3600);
    assert.equal(resolveDisclosureIntervalSeconds(undefined, { isTest: true }), 0);
    assert.equal(resolveDisclosureIntervalSeconds(undefined, { isTest: false }), 3600);
    assert.equal(resolveDisclosureIntervalSeconds('1800'), 1800);
  });

  test('a vote in the current hour is hidden until that hour closes', () => {
    const hourStart = 1_699_999_200;
    const now = hourStart + 23 * 60;
    assert.equal(publishedThrough(now, 3600), hourStart);
    assert.equal(nextPublishAt(now, 3600), hourStart + 3600);
    assert.equal(isDisclosed(hourStart + 5 * 60, now, 3600), false);
    assert.equal(isDisclosed(hourStart - 1, now, 3600), true);
    assert.equal(isDisclosed(hourStart + 5 * 60, hourStart + 3600, 3600), true);
  });

  test('interval 0 publishes immediately', () => {
    assert.equal(isDisclosed(1, 1, 0), true);
    assert.equal(hourBucket(100, 0), 100);
  });

  test('public view never includes a pending count', () => {
    const view = disclosurePublicView(1_700_000_000, 3600);
    assert.equal(view.policy, 'hourly-polling-place-unlinkability');
    assert.equal(view.pending, undefined);
    assert.equal(view.pendingCount, undefined);
    assert.equal(view.unpublished, undefined);
    assert.equal(isDelayedPublicType('vote'), true);
    assert.equal(isDelayedPublicType('register'), false);
  });
});
