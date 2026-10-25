// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_DISCLOSURE_INTERVAL_SECONDS,
  publicDisclosureView,
  formatCountdown,
  hourBucket,
  isDisclosed,
  isDelayedPublicType,
  lastClosedHourAt,
  lastClosedHourStart,
  nextPublishAt,
  publishedThrough,
  resolveDisclosureIntervalSeconds,
  secondsUntilNext,
  withDisclosedCount,
} from '../src/disclosure.mjs';

const HOUR = 3600;
const HOUR_START = 1_699_999_200;

describe('hourly disclosure math', () => {
  test('defaults to one hour, and to zero in tests', () => {
    assert.equal(DEFAULT_DISCLOSURE_INTERVAL_SECONDS, 3600);
    assert.equal(resolveDisclosureIntervalSeconds(undefined, { isTest: true }), 0);
    assert.equal(resolveDisclosureIntervalSeconds(undefined, { isTest: false }), 3600);
    assert.equal(resolveDisclosureIntervalSeconds('1800'), 1800);
  });

  test('a vote in the current hour is hidden until that hour closes', () => {
    const now = HOUR_START + 23 * 60;
    assert.equal(publishedThrough(now, HOUR), HOUR_START);
    assert.equal(nextPublishAt(now, HOUR), HOUR_START + HOUR);
    assert.equal(isDisclosed(HOUR_START + 5 * 60, now, HOUR), false);
    assert.equal(isDisclosed(HOUR_START - 1, now, HOUR), true);
    assert.equal(isDisclosed(HOUR_START + 5 * 60, HOUR_START + HOUR, HOUR), true);
  });

  test('hour boundary: event at the bucket start waits for the next close', () => {
    assert.equal(isDisclosed(HOUR_START, HOUR_START, HOUR), false);
    assert.equal(isDisclosed(HOUR_START - 1, HOUR_START, HOUR), true);
    assert.equal(isDisclosed(HOUR_START, HOUR_START + HOUR, HOUR), true);
    assert.equal(isDisclosed(HOUR_START + HOUR - 1, HOUR_START + HOUR, HOUR), true);
    assert.equal(isDisclosed(HOUR_START + HOUR, HOUR_START + HOUR, HOUR), false);
    assert.equal(hourBucket(HOUR_START, HOUR), HOUR_START);
    assert.equal(hourBucket(HOUR_START - 1, HOUR), HOUR_START - HOUR);
  });

  test('countdown and last closed hour for observers', () => {
    const now = HOUR_START + 23 * 60;
    assert.equal(lastClosedHourAt(now, HOUR), HOUR_START);
    assert.equal(lastClosedHourStart(now, HOUR), HOUR_START - HOUR);
    assert.equal(secondsUntilNext(now, HOUR), 2220);
    assert.equal(formatCountdown(2220), '37m 00s');
    assert.equal(formatCountdown(5), '5s');
    assert.equal(formatCountdown(3605), '1h 00m 05s');
    assert.equal(secondsUntilNext(HOUR_START, HOUR), HOUR);
    assert.equal(secondsUntilNext(now, 0), 0);
  });

  test('interval 0 publishes immediately', () => {
    assert.equal(isDisclosed(1, 1, 0), true);
    assert.equal(hourBucket(100, 0), 100);
    assert.equal(secondsUntilNext(50, 0), 0);
  });

  test('public view never includes a pending count', () => {
    const view = publicDisclosureView(1_700_000_000, HOUR);
    assert.equal(view.policy, 'hourly-polling-place-unlinkability');
    assert.equal(view.lastClosedHourAt, lastClosedHourAt(1_700_000_000, HOUR));
    assert.equal(view.lastPublishedAt, view.lastClosedHourAt);
    assert.equal(view.secondsUntilNext, secondsUntilNext(1_700_000_000, HOUR));
    assert.equal(view.acceptedBallotsDisclosed, undefined);
    assert.equal(view.pending, undefined);
    assert.equal(view.pendingCount, undefined);
    assert.equal(view.unpublished, undefined);
    assert.equal(isDelayedPublicType('vote'), true);
    assert.equal(isDelayedPublicType('register'), false);
    const withCount = withDisclosedCount(view, 4);
    assert.equal(withCount.acceptedBallotsDisclosed, 4);
    assert.equal(withCount.pending, undefined);
  });
});
