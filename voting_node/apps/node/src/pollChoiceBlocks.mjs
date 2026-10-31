// NOT FOR PROFIT — civic public good, not a commercial product.
// Almost-live per-choice sums for a POLL. Each published row is the
// homomorphic product of the envelopes in that hour block, never an
// opened ballot. A VOTE has no rows.

import { aggregateCiphertexts, decryptAggregateCounts, isAggregateEnvelope } from './aggregateBallot.mjs';
import {
  hourBucket,
  isDisclosed,
  planPublicBlocks,
  resultsGateOpen,
} from './disclosure.mjs';
import { isVoteElection } from './electionType.mjs';
import { electionDisclosurePolicy } from './store.mjs';

export const TRAILING_UNDER_FLOOR_NOTE =
  'A trailing hour with fewer than the block floor is not published as its own choice row. ' +
  'While the poll is open it merges forward into the next hour. At the close, after the ' +
  'disclosure delay has elapsed, that short tail is folded into the previous block so the ' +
  'published row stays at least as large as the floor. If the whole poll is still under the ' +
  'floor, one closing block is the entire set (it is not a slice taken off a larger published ' +
  'row). A published block stays as first published. A later ballot does not move it and ' +
  'does not recompute it. When re-vote is enabled, the replacement is counted only in the ' +
  'final tally. That tally is not checked against the sum of the blocks.';

const LINK_KEYS = [
  'nullifier',
  'voterId',
  'userId',
  'identityCommitment',
  'superseded',
  'supersededBy',
  'supersededHashes',
  'previousBallot',
  'previousHash',
  'replaced',
  'generation',
  'items',
];

export function blockAggregateId(blockKey, slot) {
  return `block:${blockKey}:aggregate:${Number(slot)}`;
}

export function choiceBlockKey(hourStart, hourEnd) {
  return `${Number(hourStart)}-${Number(hourEnd)}`;
}

function floorOf(policy) {
  const minRaw = Number(policy.minBlockVotes);
  return Number.isFinite(minRaw) && minRaw > 1 ? Math.floor(minRaw) : 1;
}

function endedNow(policy) {
  const end = policy.endTime;
  if (end == null || end === '' || !Number.isFinite(Number(end))) return false;
  return Number(policy.now) >= Number(end);
}

function inWindow(item, endTime) {
  if (endTime == null || endTime === '' || !Number.isFinite(Number(endTime))) return true;
  const ts = Number(item.receivedAt ?? item.acceptedAt);
  return Number.isFinite(ts) && ts < Number(endTime);
}

function decorate(block, interval) {
  const span = Number(interval) || 0;
  const times = (block.items || []).map((item) => Number(item.receivedAt ?? item.acceptedAt));
  const starts = times.map((ts) => (span > 0 ? hourBucket(ts, span) : 0));
  const hourStart = starts.length ? Math.min(...starts) : 0;
  const hourEnd = span > 0 ? Math.max(...starts) + span : hourStart;
  return {
    electionId: block.electionId,
    items: block.items,
    hourStart,
    hourEnd,
    id: choiceBlockKey(hourStart, hourEnd),
    eligibleAt: block.timestamp,
    publishedAt: block.timestamp,
    ballots: block.items.length,
    foldedTail: block.foldedTail || 0,
  };
}

/**
 * Which current ballots are in a published choice block.
 * `items` are the latest ballot per person (`receivedAt` is the latest accept).
 * A vote election publishes nothing.
 */
export function planChoiceBlocks(items, policy = {}) {
  const list = Array.isArray(items) ? items : [];
  const type = policy.electionType;
  const vote =
    policy.resultsSealed === true ||
    type === 1 ||
    type === '1' ||
    String(type || '').toLowerCase() === 'vote';
  if (vote) {
    return {
      publish: [],
      hold: list,
      frozen: false,
      gateOpen: false,
      reason: 'vote',
      trailingFolded: 0,
    };
  }
  const now = policy.now;
  const interval = Number(policy.intervalSeconds) || 0;
  const delay = Math.max(0, Math.floor(Number(policy.delaySeconds) || 0));
  const floor = floorOf(policy);
  const minVotes = Number(policy.minVotes) || 0;
  const endTime = policy.endTime ?? null;
  const live = list.filter((item) => inWindow(item, endTime));
  const submitted = policy.submittedVotes != null ? Number(policy.submittedVotes) : live.length;
  const gateOpen = resultsGateOpen({
    submittedVotes: submitted,
    now,
    endTime,
    minVotes,
    tallied: false,
    openedAt: policy.resultsGateOpenedAt,
  });
  if (!gateOpen) {
    return {
      publish: [],
      hold: live,
      frozen: false,
      gateOpen: false,
      reason: 'gate',
      trailingFolded: 0,
    };
  }
  const planned = planPublicBlocks(
    live.map((item) => ({ ...item, electionId: String(item.electionId ?? '') })),
    {
      now,
      intervalSeconds: interval,
      delaySeconds: delay,
      minBlockVotes: floor,
      minVotes: 0,
      electionContext: () => ({
        submittedVotes: submitted,
        endTime,
        tallied: false,
        minVotes: 0,
        resultsSealed: false,
      }),
    },
  );
  const waiting = live.filter(
    (item) => interval > 0 && !isDisclosed(Number(item.receivedAt ?? item.acceptedAt), now, interval, delay),
  );
  const frozen = endedNow({ ...policy, endTime }) && waiting.length === 0;
  let publish = planned.publish.map((block) => decorate(block, interval));
  let trailingFolded = 0;
  if (frozen && publish.length >= 2 && publish[publish.length - 1].ballots < floor) {
    const tail = publish.pop();
    const prev = publish[publish.length - 1];
    prev.items = prev.items.concat(tail.items);
    prev.ballots = prev.items.length;
    prev.hourEnd = tail.hourEnd;
    prev.id = choiceBlockKey(prev.hourStart, prev.hourEnd);
    prev.publishedAt = Math.max(prev.publishedAt, tail.publishedAt);
    prev.eligibleAt = prev.publishedAt;
    prev.foldedTail = tail.ballots;
    trailingFolded = tail.ballots;
  }
  if (frozen && publish.length === 1 && publish[0].ballots < floor) {
    const ready = live.filter(
      (item) => interval <= 0 || isDisclosed(Number(item.receivedAt ?? item.acceptedAt), now, interval, delay),
    );
    if (ready.length) {
      const timestamp = interval > 0
        ? Math.max(...ready.map((item) => {
          const start = hourBucket(Number(item.receivedAt ?? item.acceptedAt), interval);
          return start + interval + delay;
        }))
        : Number(now);
      publish = [
        decorate(
          { electionId: String(ready[0].electionId ?? ''), items: ready, timestamp },
          interval,
        ),
      ];
      publish[0].closingBlock = true;
    }
  }
  if (frozen && publish.length === 0) {
    const ready = live.filter(
      (item) => interval <= 0 || isDisclosed(Number(item.receivedAt ?? item.acceptedAt), now, interval, delay),
    );
    if (ready.length) {
      const timestamp = interval > 0 ? Math.max(...ready.map((item) => {
        const start = hourBucket(Number(item.receivedAt ?? item.acceptedAt), interval);
        return start + interval + delay;
      })) : Number(now);
      publish = [
        decorate(
          { electionId: String(ready[0].electionId ?? ''), items: ready, timestamp, foldedTail: 0 },
          interval,
        ),
      ];
      publish[0].closingBlock = true;
    }
  }
  return {
    publish,
    hold: planned.hold,
    frozen,
    gateOpen: true,
    reason: frozen ? 'frozen' : 'open',
    trailingFolded,
  };
}

function publicBlock(block, counts, decryption) {
  const row = {
    id: block.id,
    hourStart: block.hourStart,
    hourEnd: block.hourEnd,
    eligibleAt: block.eligibleAt,
    publishedAt: block.publishedAt,
    ballots: block.ballots,
    counts: counts || null,
    decryption,
  };
  for (const key of LINK_KEYS) delete row[key];
  return row;
}

function envelopeFor(item, byNullifier) {
  const keys = [item.nullifier, item.ballotHash].filter((value) => value != null);
  for (const key of keys) {
    const found = byNullifier.get(String(key).toLowerCase());
    if (found) return found;
  }
  return null;
}

/**
 * Homomorphic product of one published block. Returns null when any
 * envelope is missing or is not an aggregate ciphertext.
 */
export function productForChoiceBlock(block, byNullifier) {
  const envelopes = [];
  for (const item of block.items || []) {
    const env = envelopeFor(item, byNullifier);
    if (!env || !isAggregateEnvelope(env.encryptedBallot)) return null;
    envelopes.push(env.encryptedBallot);
  }
  if (!envelopes.length) return null;
  return aggregateCiphertexts(envelopes);
}

function indexEnvelopes(envelopes) {
  const byNullifier = new Map();
  for (const env of envelopes || []) {
    if (!env) continue;
    if (env.nullifier != null) byNullifier.set(String(env.nullifier).toLowerCase(), env);
    if (env.ballotHash != null) byNullifier.set(String(env.ballotHash).toLowerCase(), env);
  }
  return byNullifier;
}

function groupsForBlock(partialGroups, blockKey) {
  const prefix = `block:${blockKey}:aggregate:`;
  return (partialGroups || [])
    .map((group) => ({
      index: group.index,
      partials: (group.partials || [])
        .filter((row) => String(row.ballotHash || '').startsWith(prefix))
        .map((row) => ({ ...row, ballotHash: String(row.ballotHash) })),
    }))
    .filter((group) => group.partials.length);
}

/**
 * Public poll choice blocks. Counts are filled only when threshold
 * partials match the original block product. A published block is not
 * recomputed after a re-vote.
 */
export function presentPollChoiceBlocks({
  items,
  envelopes,
  policy,
  electionId,
  ceremony = null,
  partialGroups = null,
}) {
  const planned = planChoiceBlocks(items, policy);
  if (planned.reason === 'vote') return null;
  const byNullifier = indexEnvelopes(envelopes);
  const blocks = [];
  for (const block of planned.publish) {
    const product = productForChoiceBlock(block, byNullifier);
    if (!product || !ceremony || ceremony.status !== 'ready') {
      blocks.push(publicBlock(block, null, product ? 'awaiting_threshold' : 'unavailable'));
      continue;
    }
    const groups = groupsForBlock(partialGroups, block.id);
    try {
      const counts = decryptAggregateCounts({
        product,
        electionId,
        jointPublicKey: ceremony.publicKey,
        verificationKeys: ceremony.verificationKeys,
        partialGroups: groups,
        threshold: ceremony.threshold,
        maxCount: block.ballots,
        hashForSlot: (slot) => blockAggregateId(block.id, slot),
      });
      blocks.push(publicBlock(block, counts, 'threshold'));
    } catch (err) {
      if (err?.code === 'THRESHOLD_NOT_MET') {
        blocks.push(publicBlock(block, null, 'awaiting_threshold'));
      } else {
        console.error(
          `[poll-choice-blocks] decrypt failed election=${electionId} block=${block.id} code=${err?.code || 'DECRYPT_FAILED'}`,
        );
        blocks.push(publicBlock(block, null, 'decrypt_failed'));
      }
    }
  }
  const totals = blocks.every((row) => Array.isArray(row.counts))
    ? blocks.reduce((acc, row) => {
        row.counts.forEach((count, index) => {
          acc[index] = (acc[index] || 0) + Number(count);
        });
        return acc;
      }, [])
    : null;
  return {
    almostLive: true,
    gateOpen: planned.gateOpen,
    frozen: planned.frozen,
    blocks,
    totals,
    note: TRAILING_UNDER_FLOOR_NOTE,
  };
}

/** Original accept time. A re-vote does not move a ballot into a later block. */
export function choiceItemsFromVotes(electionId, votes) {
  return (votes || []).map((vote) => ({
    receivedAt: vote.acceptedAt,
    electionId: String(electionId),
    nullifier: vote.nullifier,
    ballotHash: vote.publishedBallotHash || vote.ballotHash,
  }));
}

export function buildPollChoiceView(election, deps, now = deps.config.nowFn()) {
  if (!election || isVoteElection(election)) return null;
  const policy = electionDisclosurePolicy(election, deps.config, now);
  if (policy.resultsSealed) return null;
  const votes = deps.store.listVotes(election.id);
  const envelopes = deps.store.listEnvelopes(election.id);
  const bucket = deps.store.guardianMaterial?.(election.id);
  return presentPollChoiceBlocks({
    items: choiceItemsFromVotes(election.id, votes),
    envelopes,
    policy: {
      ...policy,
      now,
      endTime: election.cutoffTime,
      submittedVotes: choiceSubmittedVotes(deps.store, election, votes),
      electionType: 0,
      resultsSealed: false,
    },
    electionId: election.id,
    ceremony: election.tallyCeremony || null,
    partialGroups: bucket?.choiceBlockPartials || [],
  });
}

/** Server-only plan, including the envelopes that form each block product. */
export function serverChoicePlan(election, deps, now = deps.config.nowFn()) {
  if (!election || isVoteElection(election)) return null;
  const policy = electionDisclosurePolicy(election, deps.config, now);
  const votes = deps.store.listVotes(election.id);
  return planChoiceBlocks(choiceItemsFromVotes(election.id, votes), {
    ...policy,
    now,
    endTime: election.cutoffTime,
    submittedVotes: choiceSubmittedVotes(deps.store, election, votes),
    electionType: 0,
    resultsSealed: false,
  });
}

/** Visible ballots only. A soft-deleted row does not open the results gate. */
function choiceSubmittedVotes(store, election, votes) {
  if (typeof store?.visibleAcceptedBallots === 'function') return store.visibleAcceptedBallots(election);
  return Number(election?.acceptedBallots) || (votes || []).length;
}
