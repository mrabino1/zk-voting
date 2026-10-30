// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_DISCLOSURE_DELAY_SECONDS,
  DEFAULT_DISCLOSURE_INTERVAL_SECONDS,
  DEFAULT_DISCLOSURE_MIN_BLOCK_VOTES,
  DEFAULT_RESULTS_MIN_VOTES,
  publicDisclosureView,
  formatCountdown,
  hourBucket,
  isDisclosed,
  isDelayedPublicType,
  lastClosedHourAt,
  lastClosedHourStart,
  nextPublishAt,
  planPublicBlocks,
  publishedThrough,
  resolveDisclosureDelaySeconds,
  resolveDisclosureIntervalSeconds,
  resolveDisclosureMinBlockVotes,
  resolveResultsMinVotes,
  resultsGateOpen,
  secondsUntilNext,
  selectPublicVotes,
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

  test('production defaults: 30 minute delay, 100 vote gate, blocks of 10', () => {
    assert.equal(DEFAULT_DISCLOSURE_DELAY_SECONDS, 1800);
    assert.equal(DEFAULT_RESULTS_MIN_VOTES, 100);
    assert.equal(DEFAULT_DISCLOSURE_MIN_BLOCK_VOTES, 10);
    assert.equal(resolveDisclosureDelaySeconds(undefined, { isTest: false }), 1800);
    assert.equal(resolveDisclosureDelaySeconds(undefined, { isTest: true }), 0);
    assert.equal(resolveResultsMinVotes(undefined, { isTest: false }), 100);
    assert.equal(resolveResultsMinVotes(undefined, { isTest: true }), 0);
    assert.equal(resolveDisclosureMinBlockVotes(undefined, { isTest: false }), 10);
    assert.equal(resolveDisclosureMinBlockVotes(undefined, { isTest: true }), 1);
    assert.equal(resolveDisclosureDelaySeconds('0', { isTest: false }), 0);
  });

  test('a vote at 08:59 stays sealed at 09:00 and publishes at 09:30', () => {
    const eight = HOUR_START;
    const voteAt = eight + 59 * 60;
    const nine = eight + HOUR;
    const nineThirty = nine + 1800;
    assert.equal(isDisclosed(voteAt, nine, HOUR, 1800), false);
    assert.equal(isDisclosed(voteAt, nineThirty - 1, HOUR, 1800), false);
    assert.equal(isDisclosed(voteAt, nineThirty, HOUR, 1800), true);
    assert.equal(isDisclosed(eight, nineThirty, HOUR, 1800), true);
    assert.equal(isDisclosed(nine, nineThirty, HOUR, 1800), false);
    assert.equal(nextPublishAt(voteAt, HOUR, 1800), nineThirty);
    assert.equal(publishedThrough(nineThirty, HOUR, 1800), nine);
    const view = publicDisclosureView(nineThirty, HOUR, { delaySeconds: 1800 });
    assert.equal(view.delaySeconds, 1800);
    assert.equal(view.lastClosedHourAt, nine);
    assert.equal(view.nextPublishAt, nine + HOUR + 1800);
  });

  test('results gate opens on the vote count or the scheduled end, whichever is earlier', () => {
    const end = HOUR_START + 5 * HOUR;
    assert.equal(resultsGateOpen({ submittedVotes: 99, now: HOUR_START, endTime: end, minVotes: 100 }), false);
    assert.equal(resultsGateOpen({ submittedVotes: 100, now: HOUR_START, endTime: end, minVotes: 100 }), true);
    assert.equal(resultsGateOpen({ submittedVotes: 1, now: end, endTime: end, minVotes: 100 }), true);
    assert.equal(resultsGateOpen({ submittedVotes: 1, now: end - 1, endTime: end, minVotes: 100 }), false);
    assert.equal(resultsGateOpen({ submittedVotes: 1, now: HOUR_START, endTime: end, minVotes: 100, tallied: true }), true);
    const hidden = selectPublicVotes(
      [{ acceptedAt: HOUR_START + 10, electionId: 'e' }],
      {
        now: HOUR_START + HOUR + 1800,
        intervalSeconds: HOUR,
        delaySeconds: 1800,
        minVotes: 100,
        minBlockVotes: 1,
        endTime: end,
        submittedVotes: 1,
      },
    );
    assert.equal(hidden.length, 0);
    const opened = selectPublicVotes(
      [{ acceptedAt: HOUR_START + 10, electionId: 'e' }],
      {
        now: end + HOUR,
        intervalSeconds: HOUR,
        delaySeconds: 0,
        minVotes: 100,
        minBlockVotes: 1,
        endTime: end,
        submittedVotes: 1,
      },
    );
    assert.equal(opened.length, 1);
  });

  test('small hours merge forward, and a short election waits for the certified tally', () => {
    const votes = [];
    for (let i = 0; i < 6; i += 1) votes.push({ id: i, acceptedAt: HOUR_START + 10 + i, electionId: 'e' });
    for (let i = 0; i < 6; i += 1) votes.push({ id: 10 + i, acceptedAt: HOUR_START + HOUR + 10 + i, electionId: 'e' });
    const policy = {
      now: HOUR_START + 2 * HOUR,
      intervalSeconds: HOUR,
      delaySeconds: 0,
      minVotes: 0,
      minBlockVotes: 10,
      endTime: HOUR_START + 8 * HOUR,
      submittedVotes: 12,
      tallied: false,
    };
    const merged = planPublicBlocks(
      votes.map((vote) => ({ ...vote, receivedAt: vote.acceptedAt, electionId: 'e' })),
      { ...policy, electionContext: () => policy },
    );
    assert.equal(merged.hold.length, 0);
    assert.equal(merged.publish.length, 1);
    assert.equal(merged.publish[0].items.length, 12);
    assert.equal(merged.publish[0].timestamp, HOUR_START + 2 * HOUR);

    const early = planPublicBlocks(
      votes.slice(0, 6).map((vote) => ({ ...vote, receivedAt: vote.acceptedAt, electionId: 'e' })),
      {
        ...policy,
        now: HOUR_START + HOUR,
        submittedVotes: 6,
        electionContext: () => ({ ...policy, submittedVotes: 6 }),
      },
    );
    assert.equal(early.publish.length, 0);
    assert.equal(early.hold.length, 6);

    const short = [];
    for (let i = 0; i < 4; i += 1) short.push({ receivedAt: HOUR_START + i, electionId: 'e' });
    const ended = planPublicBlocks(short, {
      now: HOUR_START + 8 * HOUR,
      intervalSeconds: HOUR,
      delaySeconds: 0,
      minVotes: 0,
      minBlockVotes: 10,
      electionContext: () => ({
        submittedVotes: 4,
        endTime: HOUR_START + 4 * HOUR,
        tallied: false,
      }),
    });
    assert.equal(ended.publish.length, 0);
    const tallied = planPublicBlocks(short, {
      now: HOUR_START + 8 * HOUR,
      intervalSeconds: HOUR,
      delaySeconds: 0,
      minVotes: 0,
      minBlockVotes: 10,
      electionContext: () => ({
        submittedVotes: 4,
        endTime: HOUR_START + 4 * HOUR,
        tallied: true,
      }),
    });
    assert.equal(tallied.publish.length, 1);
    assert.equal(tallied.publish[0].items.length, 4);

    const head = [];
    for (let i = 0; i < 10; i += 1) head.push({ receivedAt: HOUR_START + i, electionId: 'e' });
    for (let i = 0; i < 3; i += 1) head.push({ receivedAt: HOUR_START + HOUR + i, electionId: 'e' });
    const beforeEnd = planPublicBlocks(head, {
      now: HOUR_START + 2 * HOUR,
      intervalSeconds: HOUR,
      delaySeconds: 0,
      minVotes: 0,
      minBlockVotes: 10,
      electionContext: () => ({
        submittedVotes: 13,
        endTime: HOUR_START + 6 * HOUR,
        tallied: false,
      }),
    });
    assert.equal(beforeEnd.publish.length, 1);
    assert.equal(beforeEnd.publish[0].items.length, 10);
    assert.equal(beforeEnd.hold.length, 3);
    const atEnd = planPublicBlocks(head, {
      now: HOUR_START + 6 * HOUR,
      intervalSeconds: HOUR,
      delaySeconds: 0,
      minVotes: 0,
      minBlockVotes: 10,
      electionContext: () => ({
        submittedVotes: 13,
        endTime: HOUR_START + 6 * HOUR,
        tallied: false,
      }),
    });
    assert.equal(atEnd.publish.length, 2);
    assert.equal(atEnd.publish[0].items.length, 10);
    assert.equal(atEnd.publish[1].items.length, 3);
    assert.equal(atEnd.hold.length, 0);
  });

  test('the open hour is the final block at the deadline', () => {
    const items = [
      { electionId: 'e', receivedAt: HOUR_START + 10 },
      { electionId: 'e', receivedAt: HOUR_START + 20 },
    ];
    const end = HOUR_START + 30 * 60;
    const before = planPublicBlocks(items, {
      now: end - 1,
      intervalSeconds: HOUR,
      delaySeconds: 0,
      minBlockVotes: 1,
      minVotes: 0,
      electionContext: () => ({ submittedVotes: 2, endTime: end, tallied: false }),
    });
    assert.equal(before.publish.length, 0);
    const at = planPublicBlocks(items, {
      now: end,
      intervalSeconds: HOUR,
      delaySeconds: 0,
      minBlockVotes: 1,
      minVotes: 0,
      electionContext: () => ({ submittedVotes: 2, endTime: end, tallied: false }),
    });
    assert.equal(at.publish.length, 1);
    assert.equal(at.publish[0].items.length, 2);
    assert.equal(at.hold.length, 0);
    assert.equal(at.publish[0].timestamp, end);
  });
});
