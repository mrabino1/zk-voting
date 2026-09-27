// NOT FOR PROFIT — civic public good, not a commercial product.
// Token polls are signal-only. Holding the token is the only credential.
// This module does not import voteGate, PIN checks, or assertCanVote.

import { randomUUID } from 'node:crypto';

import { getAddress, hashTypedData, isAddress, verifyTypedData } from 'viem';

import { assemblePollAuditorPack } from './auditorPack.mjs';
import { hashBallotSpec } from './ballotSpec.mjs';
import { hourBucket, isDisclosed } from './disclosure.mjs';
import { relayTokenPollBallot } from './relay.mjs';
import { finalWeight } from './holdWeight.mjs';
import { HttpError } from './http.mjs';
import { buildDeterministicPdf } from './pdf.mjs';
import {
  ABSTAIN_ID,
  SIGNAL_LABEL,
  ballotsRootOf,
  canonicalPollParams,
  choicesHashOf,
  dec,
  hashCanonical,
  pollDomainOf,
  resultHashOf,
  tokenPollTypedData,
} from './pollTypedData.mjs';
import { buildPollReceipt } from './receipts.mjs';
import { tokenPollResultsDto } from './results.mjs';
import { evaluateWeightedPoll } from './weightedTally.mjs';

export const REPUBLIC_L2_CHAIN_ID = 27427;
const MAX_OPTIONS_DEFAULT = 32;

function fail(status, message, code) {
  throw new HttpError(status, message, { code });
}

function intField(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n)) fail(400, `${field} must be an integer`, 'INVALID_CHOICES');
  return n;
}

function decimalString(value, field, { allowZero = false } = {}) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) fail(400, `${field} must be a base-unit integer`, 'INVALID_CHOICES');
  if (!allowZero && s === '0') fail(400, `${field} must be positive`, 'INVALID_CHOICES');
  return BigInt(s).toString();
}

export function pollPhase(poll, now) {
  if (poll.resultHash || poll.state === 'TALLIED') return 'TALLIED';
  if (poll.state === 'TALLYING') return 'TALLYING';
  if (!poll.pollParamsHash) return 'DRAFT';
  if (now < Number(poll.startTime)) return 'SCHEDULED';
  if (now < Number(poll.cutoffTime)) return 'OPEN';
  return 'CLOSED';
}

export function presentPoll(poll, now) {
  const phase = pollPhase(poll, now);
  return {
    id: poll.id,
    kind: 'token_poll',
    jurisdictionId: poll.jurisdictionId,
    title: poll.title,
    options: poll.options,
    includeAbstain: true,
    pollType: poll.pollType,
    token: poll.token,
    tokenChainId: poll.tokenChainId,
    tokenSymbol: poll.tokenSymbol,
    decimals: poll.decimals,
    quorum: poll.quorum,
    passThresholdBps: poll.passThresholdBps,
    minBallotWeight: poll.minBallotWeight,
    privacyMode: 'public_weighted',
    startTime: poll.startTime,
    cutoffTime: poll.cutoffTime,
    closeBlock: poll.closeBlock ?? null,
    closeBlockHash: poll.closeBlockHash ?? null,
    totalSupplyAtClose: poll.totalSupplyAtClose ?? null,
    ballotSpecHash: poll.ballotSpecHash,
    pollDomain: poll.pollDomain,
    pollParamsHash: poll.pollParamsHash || null,
    state: phase,
    createdBy: poll.createdBy,
    createdAt: poll.createdAt,
    nfp: true,
    binding: false,
    signal: SIGNAL_LABEL,
    custodyNote:
      'Tokens held in staking contracts or liquidity pools cannot vote unless that contract signs the ballot.',
  };
}

function normalizeQuorum(raw) {
  if (raw == null || raw === '' || raw === false) return null;
  if (typeof raw !== 'object') fail(400, 'quorum must be { mode, value } or null', 'INVALID_CHOICES');
  const mode = String(raw.mode || '');
  if (mode !== 'absolute' && mode !== 'bps_of_supply') {
    fail(400, 'quorum.mode must be absolute or bps_of_supply', 'INVALID_CHOICES');
  }
  const value = decimalString(raw.value, 'quorum.value', { allowZero: false });
  if (mode === 'bps_of_supply') {
    const n = BigInt(value);
    if (n < 1n || n > 10000n) fail(400, 'quorum bps must be 1..10000', 'INVALID_CHOICES');
  }
  return { mode, value };
}

function normalizeThreshold(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10000) {
    fail(400, 'passThresholdBps must be 1..10000 or omitted', 'INVALID_CHOICES');
  }
  return n;
}

function normalizeOptions(raw, maxOptions) {
  if (!Array.isArray(raw)) fail(400, 'options must be an array', 'INVALID_CHOICES');
  const options = [];
  const seen = new Set();
  raw.forEach((item, index) => {
    const obj = typeof item === 'string' ? { label: item } : item;
    if (!obj || typeof obj !== 'object') fail(400, `options[${index}] is invalid`, 'INVALID_CHOICES');
    const id = String(obj.id || `o${index + 1}`).trim();
    const label = String(obj.label || obj.name || '').trim();
    if (!id || !label) fail(400, `options[${index}] needs an id and a label`, 'INVALID_CHOICES');
    if (id.toLowerCase() === ABSTAIN_ID) return;
    if (seen.has(id)) fail(400, `duplicate option id ${id}`, 'INVALID_CHOICES');
    seen.add(id);
    options.push({ id, label });
  });
  if (options.length < 2) fail(400, 'a poll needs at least 2 options', 'INVALID_CHOICES');
  if (options.length > maxOptions) fail(400, `at most ${maxOptions} options`, 'INVALID_CHOICES');
  options.push({ id: ABSTAIN_ID, label: 'Abstain' });
  return options;
}

function ballotSpecFor(poll) {
  const type = poll.pollType === 'ranked_irv' ? 'RANKED' : 'SINGLE_CHOICE';
  return hashBallotSpec({
    title: poll.title,
    questions: [
      {
        id: 'q1',
        type,
        prompt: poll.title,
        options: poll.options.map((o) => ({ id: o.id, label: o.label })),
      },
    ],
  });
}

function applyParams(poll, body, config) {
  const title = String(body.title ?? poll.title ?? '').trim();
  if (!title) fail(400, 'title required', 'INVALID_CHOICES');
  const pollType = String(body.pollType ?? poll.pollType ?? '');
  if (pollType !== 'plurality' && pollType !== 'ranked_irv') {
    fail(400, 'pollType must be plurality or ranked_irv', 'INVALID_CHOICES');
  }
  if (body.privacyMode && body.privacyMode !== 'public_weighted') {
    fail(400, 'phase 1 privacyMode is public_weighted', 'INVALID_CHOICES');
  }
  const token = config.votingToken;
  if (!token?.configured || !isAddress(String(token.address || ''))) {
    fail(503, 'token polls are disabled until VOTING_TOKEN_ADDRESS is a valid address', 'POLLS_DISABLED');
  }
  if (token.chainId === REPUBLIC_L2_CHAIN_ID || !Number.isInteger(token.chainId) || token.chainId <= 0) {
    fail(503, 'VOTING_TOKEN_CHAIN_ID is invalid', 'POLLS_DISABLED');
  }
  const startTime = intField(body.startTime ?? poll.startTime, 'startTime');
  const cutoffTime = intField(body.cutoffTime ?? poll.cutoffTime, 'cutoffTime');
  if (startTime >= cutoffTime) fail(400, 'startTime must be before cutoffTime', 'INVALID_CHOICES');
  const maxOptions = Number(config.pollMaxOptions || MAX_OPTIONS_DEFAULT);
  const options = body.options ? normalizeOptions(body.options, maxOptions) : poll.options;
  if (!options || options.length < 3) fail(400, 'a poll needs at least 2 options', 'INVALID_CHOICES');
  const jurisdictionId = String(body.jurisdictionId ?? poll.jurisdictionId ?? '').trim();
  if (!jurisdictionId) fail(400, 'jurisdictionId required', 'INVALID_CHOICES');
  const minBallotWeight = decimalString(
    body.minBallotWeight ?? poll.minBallotWeight ?? '1',
    'minBallotWeight',
    { allowZero: false },
  );
  poll.title = title;
  poll.pollType = pollType;
  poll.token = getAddress(token.address);
  poll.tokenChainId = token.chainId;
  poll.startTime = startTime;
  poll.cutoffTime = cutoffTime;
  poll.options = options;
  poll.includeAbstain = true;
  poll.jurisdictionId = jurisdictionId;
  poll.quorum = body.quorum === undefined && poll.quorum !== undefined ? poll.quorum : normalizeQuorum(body.quorum);
  poll.passThresholdBps =
    body.passThresholdBps === undefined && poll.passThresholdBps !== undefined
      ? poll.passThresholdBps
      : normalizeThreshold(body.passThresholdBps);
  poll.minBallotWeight = minBallotWeight;
  poll.privacyMode = 'public_weighted';
  poll.ballotSpecHash = ballotSpecFor(poll);
  return poll;
}

async function probe(deps, poll) {
  let source;
  try {
    source = deps.tokenRegistry.get(poll.tokenChainId);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    fail(503, 'token RPC unavailable', 'RPC_UNAVAILABLE');
  }
  const info = await source.probeToken(poll.token);
  poll.tokenSymbol = info.symbol;
  poll.decimals = info.decimals;
  poll.supplyAtCreate = dec(info.totalSupply);
  poll.preflightWarnings = info.warnings || [];
  return info;
}

export async function createPoll(deps, actor, body) {
  if (!actor || actor.role !== 'platform_super_admin') {
    fail(403, 'only the platform super admin can create token polls', 'FORBIDDEN');
  }
  const store = deps.store;
  const poll = {
    id: `poll-${randomUUID()}`,
    kind: 'token_poll',
    state: 'DRAFT',
    createdBy: actor.id,
    createdAt: new Date().toISOString(),
    pollParamsHash: null,
    pollDomain: null,
  };
  applyParams(poll, body || {}, deps.config);
  if (!store.getJurisdiction(poll.jurisdictionId)) fail(400, 'unknown jurisdictionId', 'INVALID_CHOICES');
  poll.pollDomain = pollDomainOf(store.nodeId(), poll.id);
  const info = await probe(deps, poll);
  await store.savePoll(poll);
  return { poll: presentPoll(poll, deps.config.nowFn()), preflight: publicPreflight(info) };
}

function publicPreflight(info) {
  return {
    symbol: info.symbol,
    decimals: info.decimals,
    totalSupply: dec(info.totalSupply),
    warnings: info.warnings || [],
    nfp: true,
    binding: false,
  };
}

export async function updatePoll(deps, actor, id, body) {
  if (!actor || actor.role !== 'platform_super_admin') {
    fail(403, 'only the platform super admin can edit token polls', 'FORBIDDEN');
  }
  const poll = deps.store.getPoll(id);
  if (!poll) fail(404, 'poll not found', 'NOT_FOUND');
  const now = deps.config.nowFn();
  const phase = pollPhase(poll, now);
  if (phase !== 'DRAFT' && phase !== 'SCHEDULED') {
    fail(409, 'poll params are frozen', 'POLL_NOT_OPEN');
  }
  const input = body || {};
  const { token: _ignoredToken, tokenChainId: _ignoredChain, ...editable } = input;
  applyParams(poll, { ...poll, ...editable, options: input.options || poll.options }, deps.config);
  if (!deps.store.getJurisdiction(poll.jurisdictionId)) fail(400, 'unknown jurisdictionId', 'INVALID_CHOICES');
  await probe(deps, poll);
  if (phase === 'SCHEDULED') {
    poll.pollParamsHash = hashCanonical(canonicalPollParams(poll));
    await postL2(deps, 'poll_params', paramsTx(poll));
  }
  await deps.store.savePoll(poll);
  return presentPoll(poll, now);
}

function paramsTx(poll) {
  return {
    pollId: poll.id,
    pollParamsHash: poll.pollParamsHash,
    token: poll.token,
    tokenChainId: poll.tokenChainId,
    startTime: poll.startTime,
    cutoffTime: poll.cutoffTime,
  };
}

export async function schedulePoll(deps, actor, id) {
  if (!actor || actor.role !== 'platform_super_admin') {
    fail(403, 'only the platform super admin can schedule token polls', 'FORBIDDEN');
  }
  const poll = deps.store.getPoll(id);
  if (!poll) fail(404, 'poll not found', 'NOT_FOUND');
  const now = deps.config.nowFn();
  const phase = pollPhase(poll, now);
  if (phase !== 'DRAFT' && phase !== 'SCHEDULED') fail(409, 'poll cannot be scheduled', 'POLL_NOT_OPEN');
  applyParams(poll, poll, deps.config);
  await probe(deps, poll);
  poll.pollParamsHash = hashCanonical(canonicalPollParams(poll));
  poll.state = 'SCHEDULED';
  await deps.store.savePoll(poll);
  const l2 = await postL2(deps, 'poll_params', paramsTx(poll));
  poll.l2ParamsTx = l2?.tx?.hash || l2?.hash || null;
  await deps.store.savePoll(poll);
  return presentPoll(poll, now);
}

async function postL2(deps, type, payload) {
  if (!deps.explorer?.append) return null;
  if (type === 'poll_vote' && deps.explorer.recordPollVote) {
    return deps.explorer.recordPollVote(payload, deps.config.nowFn(), deps.config.disclosureIntervalSeconds);
  }
  return deps.explorer.append(type, payload, { timestamp: deps.config.nowFn() });
}

export function listPolls(deps) {
  const now = deps.config.nowFn();
  return deps.store.listPolls().map((poll) => presentPoll(poll, now));
}

export function getPollView(deps, id) {
  const poll = deps.store.getPoll(id);
  if (!poll) fail(404, 'poll not found', 'NOT_FOUND');
  return presentPoll(poll, deps.config.nowFn());
}

function sourceFor(deps, poll) {
  try {
    return deps.tokenRegistry.get(poll.tokenChainId);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    fail(503, 'token RPC unavailable', 'RPC_UNAVAILABLE');
  }
}

export async function weightView(deps, id, address) {
  const poll = deps.store.getPoll(id);
  if (!poll) fail(404, 'poll not found', 'NOT_FOUND');
  if (!isAddress(String(address || ''))) fail(400, 'address required', 'INVALID_CHOICES');
  const voter = getAddress(address);
  const now = deps.config.nowFn();
  const phase = pollPhase(poll, now);
  const ballot = deps.store.getPollBallot(poll.id, voter);
  const disclosed = ballot
    ? isDisclosed(ballot.acceptedAt, now, deps.config.disclosureIntervalSeconds)
    : false;
  let current = null;
  if (phase === 'OPEN' || phase === 'SCHEDULED' || phase === 'DRAFT') {
    try {
      const source = sourceFor(deps, poll);
      const latest = await source.latestBlock();
      current = dec(await source.balanceAt(poll.token, voter, latest.number));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      fail(503, 'token RPC unavailable', 'RPC_UNAVAILABLE');
    }
  }
  return {
    nfp: true,
    binding: false,
    signal: SIGNAL_LABEL,
    pollId: poll.id,
    address: voter,
    state: phase,
    currentBalance: current,
    voted: Boolean(ballot),
    provisionalWeight: ballot ? ballot.provisionalWeight : null,
    finalWeight: phase === 'TALLIED' && ballot ? ballot.finalWeight : null,
    status: ballot ? ballot.status : null,
    disclosed,
    choices: disclosed && ballot ? ballot.choices : null,
    reduced:
      phase === 'TALLIED' && ballot && ballot.finalWeight != null
        ? BigInt(ballot.finalWeight) < BigInt(ballot.provisionalWeight)
        : false,
    note: 'Final weight is the lowest end-of-block balance from the vote block through close. Tokens added later do not increase it.',
  };
}

function choiceIndexesFrom(poll, choices) {
  if (!Array.isArray(choices) || !choices.length) fail(400, 'choices required', 'INVALID_CHOICES');
  const indexes = choices.map((choice) => {
    if (typeof choice === 'number' || (typeof choice === 'string' && /^\d+$/.test(choice))) {
      const n = Number(choice);
      if (!Number.isInteger(n) || n < 0 || n >= poll.options.length) {
        fail(400, 'choice index out of range', 'INVALID_CHOICES');
      }
      return n;
    }
    const id = String(choice);
    const index = poll.options.findIndex((o) => o.id === id);
    if (index < 0) fail(400, `unknown option ${id}`, 'INVALID_CHOICES');
    return index;
  });
  const unique = new Set(indexes);
  if (unique.size !== indexes.length) fail(400, 'choices must not repeat', 'INVALID_CHOICES');
  if (poll.pollType === 'plurality' && indexes.length !== 1) {
    fail(400, 'plurality accepts one choice', 'INVALID_CHOICES');
  }
  if (poll.pollType === 'ranked_irv' && indexes.length > poll.options.length) {
    fail(400, 'too many ranks', 'INVALID_CHOICES');
  }
  return indexes;
}

export function typedDataFor(deps, id, address, choices, issuedAt) {
  const poll = deps.store.getPoll(id);
  if (!poll) fail(404, 'poll not found', 'NOT_FOUND');
  if (!poll.pollDomain || !poll.ballotSpecHash) fail(409, 'poll is not scheduled', 'POLL_NOT_OPEN');
  if (!isAddress(String(address || ''))) fail(400, 'address required', 'INVALID_CHOICES');
  const voter = getAddress(address);
  const indexes = choiceIndexesFrom(poll, choices);
  const at = issuedAt == null ? deps.config.nowFn() : intField(issuedAt, 'issuedAt');
  const typed = tokenPollTypedData({
    tokenChainId: poll.tokenChainId,
    pollDomain: poll.pollDomain,
    token: poll.token,
    voter,
    choiceIndexes: indexes,
    ballotSpecHash: poll.ballotSpecHash,
    issuedAt: at,
  });
  return {
    nfp: true,
    binding: false,
    typedData: {
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: {
        ...typed.message,
        republicChainId: typed.message.republicChainId.toString(),
        issuedAt: typed.message.issuedAt.toString(),
      },
    },
    choiceIndexes: indexes,
    issuedAt: at,
  };
}

export async function castBallot(deps, rawBody) {
  const body = relayTokenPollBallot(rawBody);
  const poll = deps.store.getPoll(body.pollId || rawBody.pollId);
  if (!poll) fail(404, 'poll not found', 'NOT_FOUND');
  const now = deps.config.nowFn();
  if (pollPhase(poll, now) !== 'OPEN') fail(409, 'poll is not open', 'POLL_NOT_OPEN');
  if (!isAddress(String(body.voter || ''))) fail(400, 'voter address required', 'BAD_SIGNATURE');
  const voter = getAddress(body.voter);
  if (deps.store.getPollBallot(poll.id, voter)) fail(409, 'address already voted', 'ALREADY_VOTED');
  const issuedAt = intField(body.issuedAt, 'issuedAt');
  if (issuedAt < poll.startTime || issuedAt >= poll.cutoffTime) fail(409, 'ballot is outside the window', 'POLL_NOT_OPEN');
  if (now < poll.startTime || now >= poll.cutoffTime) fail(409, 'poll is not open', 'POLL_NOT_OPEN');
  const indexes = choiceIndexesFrom(poll, body.choices);
  const sig = String(body.sig || body.signature || '');
  if (!sig.startsWith('0x')) fail(400, 'signature required', 'BAD_SIGNATURE');
  const typed = tokenPollTypedData({
    tokenChainId: poll.tokenChainId,
    pollDomain: poll.pollDomain,
    token: poll.token,
    voter,
    choiceIndexes: indexes,
    ballotSpecHash: poll.ballotSpecHash,
    issuedAt,
  });
  const source = sourceFor(deps, poll);
  let sigKind = null;
  try {
    const ok = await verifyTypedData({ address: voter, ...typed, signature: sig });
    if (ok) sigKind = 'eoa';
  } catch {
    sigKind = null;
  }
  if (!sigKind) {
    const digest = hashTypedData(typed);
    const magic = await source.isValidSignature(voter, digest, sig);
    if (magic) sigKind = 'erc1271';
  }
  if (!sigKind) fail(400, 'signature does not match the holding address', 'BAD_SIGNATURE');
  const latest = await source.latestBlock();
  const provisional = await source.balanceAt(poll.token, voter, latest.number);
  const floor = BigInt(poll.minBallotWeight || '1');
  if (provisional === 0n || provisional < floor) fail(400, 'zero balance cannot vote', 'NO_BALANCE');
  const digest = hashTypedData(typed);
  const acceptedAt = now;
  const ballot = {
    pollId: poll.id,
    voter,
    choices: indexes.map((i) => poll.options[i].id),
    choiceIndexes: indexes,
    sig,
    sigKind,
    ballotDigest: digest,
    voteBlock: Number(latest.number),
    voteBlockHash: latest.hash,
    provisionalWeight: dec(provisional),
    finalWeight: null,
    minBlock: null,
    touchedBlocks: null,
    closeBalance: null,
    consistent: null,
    status: 'pending',
    acceptedAt,
    disclosureHour: hourBucket(acceptedAt, deps.config.disclosureIntervalSeconds),
    issuedAt,
    l2TxHash: null,
  };
  if (Object.prototype.hasOwnProperty.call(ballot, 'userId')) delete ballot.userId;
  await deps.store.insertPollBallot(ballot);
  const l2 = await postL2(deps, 'poll_vote', {
    pollId: poll.id,
    voter,
    voteBlock: ballot.voteBlock,
    provisionalWeight: ballot.provisionalWeight,
    choicesHash: choicesHashOf(indexes),
    ballotDigest: digest,
  });
  ballot.l2TxHash = l2?.tx?.hash || l2?.hash || null;
  await deps.store.savePollBallot(ballot);
  return {
    ok: true,
    nfp: true,
    binding: false,
    signal: SIGNAL_LABEL,
    receipt: buildPollReceipt(ballot),
  };
}

export function disclosedBallots(deps, id) {
  const poll = deps.store.getPoll(id);
  if (!poll) fail(404, 'poll not found', 'NOT_FOUND');
  const now = deps.config.nowFn();
  const interval = deps.config.disclosureIntervalSeconds;
  const rows = deps.store.listPollBallots(poll.id).filter((ballot) =>
    isDisclosed(ballot.acceptedAt, now, interval),
  );
  return {
    nfp: true,
    binding: false,
    signal: SIGNAL_LABEL,
    pollId: poll.id,
    ballots: rows.map(publicBallot),
  };
}

function publicBallot(ballot) {
  return {
    pollId: ballot.pollId,
    voter: ballot.voter,
    choices: ballot.choices,
    choiceIndexes: ballot.choiceIndexes,
    sig: ballot.sig,
    sigKind: ballot.sigKind,
    ballotDigest: ballot.ballotDigest,
    voteBlock: ballot.voteBlock,
    voteBlockHash: ballot.voteBlockHash,
    provisionalWeight: ballot.provisionalWeight,
    finalWeight: ballot.finalWeight,
    minBlock: ballot.minBlock,
    touchedBlocks: ballot.touchedBlocks,
    status: ballot.status,
    acceptedAt: ballot.acceptedAt,
    disclosureHour: ballot.disclosureHour,
    issuedAt: ballot.issuedAt,
  };
}

function canTally(user, poll, store) {
  if (!user) return false;
  if (user.role === 'platform_super_admin' || user.role === 'platform_admin') return true;
  if (user.role === 'tally_operator') return true;
  return store.userHasJurisdictionRole(user, ['tally_operator'], poll.jurisdictionId);
}

export async function tallyPoll(deps, actor, id) {
  const poll = deps.store.getPoll(id);
  if (!poll) fail(404, 'poll not found', 'NOT_FOUND');
  if (!canTally(actor, poll, deps.store)) fail(403, 'tally_operator required', 'FORBIDDEN');
  const now = deps.config.nowFn();
  const phase = pollPhase(poll, now);
  if (phase === 'TALLIED') return presentResult(deps.store.getPollResult(poll.id), poll);
  if (phase !== 'CLOSED' && phase !== 'TALLYING') fail(409, 'poll is not closed', 'CLOSE_NOT_FINAL');
  const source = sourceFor(deps, poll);
  const close = await source.blockBeforeTimestamp(poll.cutoffTime);
  if (!close) fail(409, 'close block is not available', 'CLOSE_NOT_FINAL');
  const finalized = await source.finalizedBlock();
  if (!finalized || BigInt(finalized.number) < BigInt(close.number)) {
    fail(409, 'close block is not finalized', 'CLOSE_NOT_FINAL');
  }
  poll.state = 'TALLYING';
  poll.closeBlock = Number(close.number);
  poll.closeBlockHash = close.hash;
  const supply = await source.totalSupplyAt(poll.token, close.number);
  poll.totalSupplyAtClose = dec(supply);
  const floor = BigInt(poll.minBallotWeight || '1');
  const ballots = deps.store.listPollBallots(poll.id);
  let withdrawnWeight = 0n;
  let drift = false;
  for (const ballot of ballots) {
    const voteBlock = await source.getBlock(ballot.voteBlock);
    if (voteBlock.hash !== ballot.voteBlockHash) {
      ballot.voteBlockHash = voteBlock.hash;
      ballot.voteBlockReorg = true;
    }
    const evidence = await finalWeight({
      source,
      token: poll.token,
      voter: ballot.voter,
      voteBlock: ballot.voteBlock,
      closeBlock: close.number,
    });
    const fin = evidence.finalWeight;
    const prov = BigInt(ballot.provisionalWeight);
    ballot.finalWeight = dec(fin);
    ballot.minBlock = Number(evidence.minBlock);
    ballot.touchedBlocks = evidence.touchedBlocks.map((n) => Number(n));
    ballot.closeBalance = dec(evidence.closeBalance);
    ballot.consistent = evidence.consistent;
    if (!evidence.consistent) drift = true;
    if (fin < floor) {
      ballot.status = 'withdrawn_by_transfer';
      withdrawnWeight += prov;
    } else {
      ballot.status = 'counted';
      if (prov > fin) withdrawnWeight += prov - fin;
    }
  }
  const counted = ballots
    .filter((b) => b.status === 'counted')
    .map((b) => ({ choices: b.choices, weight: BigInt(b.finalWeight) }));
  const math = evaluateWeightedPoll({
    pollType: poll.pollType,
    optionIds: poll.options.map((o) => o.id),
    ballots: counted,
    quorum: poll.quorum,
    passThresholdBps: poll.passThresholdBps,
    totalSupply: supply,
  });
  if (drift) math.flags = [...math.flags, 'TOKEN_DRIFT'];
  const counts = {};
  for (const [key, value] of Object.entries(math.counts)) counts[key] = dec(value);
  const irvRounds = math.irv
    ? math.irv.rounds.map((round) => ({
        round: round.round,
        counts: Object.fromEntries(Object.entries(round.counts).map(([k, v]) => [k, dec(v)])),
        continuing: dec(round.continuing),
        exhausted: dec(round.exhausted),
        remaining: round.remaining,
        eliminated: round.eliminated,
        winner: round.winner,
        ...(round.tieBroken ? { tieBroken: true } : {}),
      }))
    : null;
  const publicResult = {
    pollId: poll.id,
    closeBlock: poll.closeBlock,
    participation: dec(math.participation),
    withdrawnWeight: dec(withdrawnWeight),
    turnoutBps: dec(math.turnoutBps),
    counts,
    irvRounds,
    outcome: math.outcome,
    flags: math.flags,
    winner: math.winner,
    ballotsRoot: ballotsRootOf(ballots),
    binding: false,
    nfp: true,
    signal: SIGNAL_LABEL,
  };
  publicResult.resultHash = resultHashOf(publicResult);
  const stored = {
    ...publicResult,
    tallyAt: new Date(now * 1000).toISOString(),
    tallyBy: actor.id,
    l1TxHash: null,
    l1Mirror: 'skipped',
    l1MirrorNote:
      'L1TallyMirror.postResult keys a uint256 civic election id. A token poll id is not that slot. Mirroring would change the existing mirror contract, so phase 1 skips it.',
  };
  poll.state = 'TALLIED';
  poll.resultHash = stored.resultHash;
  await deps.store.commitPollTally(poll, ballots, stored);
  await postL2(deps, 'poll_tally', {
    pollId: poll.id,
    closeBlock: stored.closeBlock,
    ballotsRoot: stored.ballotsRoot,
    resultHash: stored.resultHash,
    participation: stored.participation,
    outcome: stored.outcome,
  });
  return presentResult(stored, poll);
}

export function presentResult(result, poll) {
  if (!result) {
    return {
      nfp: true,
      binding: false,
      official: false,
      signal: SIGNAL_LABEL,
      pollId: poll?.id || null,
      state: poll ? pollPhase(poll, 0) : null,
      note: 'Official results publish after the poll closes. There is no live provisional tally.',
    };
  }
  return {
    ...result,
    official: true,
    nfp: true,
    binding: false,
    signal: SIGNAL_LABEL,
    decimals: poll?.decimals,
    tokenSymbol: poll?.tokenSymbol,
  };
}

export function resultsView(deps, id) {
  const poll = deps.store.getPoll(id);
  if (!poll) fail(404, 'poll not found', 'NOT_FOUND');
  const phase = pollPhase(poll, deps.config.nowFn());
  if (phase !== 'TALLIED') {
    return tokenPollResultsDto(null, { tallied: false, pollId: poll.id, state: phase });
  }
  return tokenPollResultsDto(presentResult(deps.store.getPollResult(poll.id), poll), {
    tallied: true,
    pollId: poll.id,
    state: phase,
  });
}

export function buildPollAuditorPack(deps, id) {
  const poll = deps.store.getPoll(id);
  if (!poll) fail(404, 'poll not found', 'NOT_FOUND');
  const now = deps.config.nowFn();
  const interval = deps.config.disclosureIntervalSeconds;
  const phase = pollPhase(poll, now);
  const ballots = deps.store
    .listPollBallots(poll.id)
    .filter((ballot) => isDisclosed(ballot.acceptedAt, now, interval))
    .map(publicBallot);
  const result = phase === 'TALLIED' ? deps.store.getPollResult(poll.id) : null;
  return assemblePollAuditorPack({
    pollView: presentPoll(poll, now),
    params: canonicalPollParams(poll),
    pollParamsHash: poll.pollParamsHash,
    closeBlock: poll.closeBlock ?? null,
    ballots,
    result,
  });
}

export function pollOutcomePdf(deps, id) {
  const poll = deps.store.getPoll(id);
  if (!poll) fail(404, 'poll not found', 'NOT_FOUND');
  const result = deps.store.getPollResult(poll.id);
  if (!result) fail(409, 'poll is not tallied', 'CLOSE_NOT_FINAL');
  const lines = [
    SIGNAL_LABEL,
    'This result triggers no on-chain action.',
    `Poll: ${poll.title}`,
    `Token: ${poll.tokenSymbol || ''} ${poll.token} chain ${poll.tokenChainId}`,
    `Outcome: ${result.outcome}`,
    `Winner: ${result.winner || 'none'}`,
    `Flags: ${(result.flags || []).join(', ') || 'none'}`,
    `Participation (base units): ${result.participation}`,
    `Withdrawn by transfer (base units): ${result.withdrawnWeight}`,
    `Turnout bps of supply at close: ${result.turnoutBps}`,
    `Close block: ${result.closeBlock}`,
    `Result hash: ${result.resultHash}`,
  ];
  for (const [optionId, weight] of Object.entries(result.counts || {})) {
    lines.push(`Count ${optionId}: ${weight}`);
  }
  return buildDeterministicPdf({
    title: `Token poll ${poll.title}`,
    lines,
    created: '2026-09-27',
  });
}
