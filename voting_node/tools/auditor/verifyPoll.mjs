// NOT FOR PROFIT — civic public good, not a commercial product.
// Independent check of a token-poll auditor pack. --offline checks
// signatures, one ballot per address, and the tally math. --rpc re-derives
// every final weight from archive state.

import { verifyTypedData } from 'viem';

import { finalWeight } from '../../apps/node/src/holdWeight.mjs';
import {
  SIGNAL_LABEL,
  ballotsRootOf,
  resultHashOf,
  tokenPollTypedData,
} from '../../apps/node/src/pollTypedData.mjs';
import { createViemTokenSource } from '../../apps/node/src/tokenSource.mjs';
import { evaluateWeightedPoll } from '../../apps/node/src/weightedTally.mjs';

export const POLL_AUDITOR_SCHEMA = 'zk-voting.auditor.poll.v1';

function dec(value) {
  return BigInt(value).toString();
}

function walkBanned(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkBanned(item, `${path}[${i}]`, errors));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'userId' || key === 'user_id' || key === 'nullifier') {
      errors.push(`${path}.${key} is not allowed on a token poll`);
    }
    walkBanned(child, `${path}.${key}`, errors);
  }
}

function serializeRounds(irv) {
  if (!irv) return null;
  return irv.rounds.map((round) => ({
    round: round.round,
    counts: Object.fromEntries(Object.entries(round.counts).map(([k, v]) => [k, dec(v)])),
    continuing: dec(round.continuing),
    exhausted: dec(round.exhausted),
    remaining: round.remaining,
    eliminated: round.eliminated,
    winner: round.winner,
    ...(round.tieBroken ? { tieBroken: true } : {}),
  }));
}

async function checkSignature(poll, ballot) {
  if (ballot.sigKind === 'erc1271') return 'erc1271';
  const typed = tokenPollTypedData({
    tokenChainId: poll.tokenChainId,
    pollDomain: poll.pollDomain,
    token: poll.token,
    voter: ballot.voter,
    choiceIndexes: ballot.choiceIndexes,
    ballotSpecHash: poll.ballotSpecHash,
    issuedAt: ballot.issuedAt,
  });
  try {
    const ok = await verifyTypedData({ address: ballot.voter, ...typed, signature: ballot.sig });
    return ok ? 'eoa' : null;
  } catch {
    return null;
  }
}

export async function verifyPollBundle(bundle, { offline = true, rpcUrl = '', source = null } = {}) {
  const errors = [];
  const checks = {};
  function check(name, cond, message) {
    checks[name] = Boolean(cond);
    if (!cond) errors.push(message || name);
  }

  check('object', bundle && typeof bundle === 'object', 'bundle must be an object');
  if (!checks.object) return { ok: false, errors, checks, summary: {} };
  check('schema', bundle.schema === POLL_AUDITOR_SCHEMA, `schema must be ${POLL_AUDITOR_SCHEMA}`);
  check('nfp', bundle.nfp === true, 'nfp must be true');
  check('binding', bundle.binding === false, 'token polls are non-binding');
  check('signal', bundle.signal === SIGNAL_LABEL, 'signal label required');
  walkBanned(bundle, 'bundle', errors);

  const poll = bundle.poll || {};
  const ballots = Array.isArray(bundle.ballots) ? bundle.ballots : [];
  check('ballots', Array.isArray(bundle.ballots), 'ballots must be an array');
  const seen = new Set();
  for (const [i, ballot] of ballots.entries()) {
    const who = String(ballot?.voter || '').toLowerCase();
    if (!who) {
      errors.push(`ballot[${i}] missing voter`);
      continue;
    }
    if (seen.has(who)) errors.push(`duplicate address at ballot[${i}]`);
    seen.add(who);
    const optionIds = (poll.options || []).map((o) => o.id);
    const fromIndex = (ballot.choiceIndexes || []).map((index) => optionIds[index]);
    if (JSON.stringify(fromIndex) !== JSON.stringify(ballot.choices || [])) {
      errors.push(`ballot[${i}] choices do not match choiceIndexes`);
    }
    if (ballot.sigKind === 'erc1271') {
      check(`sig-${i}`, Boolean(ballot.sig), `ballot[${i}] missing contract signature`);
    } else {
      const kind = await checkSignature(poll, ballot);
      if (kind !== 'eoa') errors.push(`ballot[${i}] signature does not match voter`);
    }
    if (ballot.finalWeight != null && ballot.closeBalance != null) {
      if (BigInt(ballot.finalWeight) > BigInt(ballot.closeBalance)) {
        errors.push(`ballot[${i}] final weight exceeds close balance`);
      }
    }
  }

  const result = bundle.result;
  if (result) {
    let withdrawn = 0n;
    let drift = false;
    const counted = [];
    for (const ballot of ballots) {
      const prov = BigInt(ballot.provisionalWeight || '0');
      const fin = BigInt(ballot.finalWeight || '0');
      if (ballot.consistent === false) drift = true;
      if (ballot.status !== 'counted') withdrawn += prov;
      else {
        counted.push({ choices: ballot.choices, weight: fin });
        if (prov > fin) withdrawn += prov - fin;
      }
    }
    const supply = BigInt(poll.totalSupplyAtClose || '0');
    const again = evaluateWeightedPoll({
      pollType: poll.pollType,
      optionIds: (poll.options || []).map((o) => o.id),
      ballots: counted,
      quorum: poll.quorum,
      passThresholdBps: poll.passThresholdBps,
      totalSupply: supply,
    });
    if (drift) again.flags = [...again.flags, 'TOKEN_DRIFT'];
    const counts = {};
    for (const [key, value] of Object.entries(again.counts)) counts[key] = dec(value);
    const publicResult = {
      pollId: poll.id,
      closeBlock: result.closeBlock,
      participation: dec(again.participation),
      withdrawnWeight: dec(withdrawn),
      turnoutBps: dec(again.turnoutBps),
      counts,
      irvRounds: serializeRounds(again.irv),
      outcome: again.outcome,
      flags: again.flags,
      winner: again.winner,
      ballotsRoot: ballotsRootOf(ballots),
      binding: false,
      nfp: true,
      signal: SIGNAL_LABEL,
    };
    const recomputed = resultHashOf(publicResult);
    if (recomputed !== result.resultHash) errors.push('resultHash does not match recomputed tally');
    if (publicResult.outcome !== result.outcome) errors.push('outcome does not match tally');
    if (publicResult.ballotsRoot !== result.ballotsRoot) errors.push('ballotsRoot does not match ballot rows');
    if (JSON.stringify(publicResult.counts) !== JSON.stringify(result.counts)) {
      errors.push('counts do not match tally');
    }
  }

  const chain = source || (rpcUrl && !offline ? createViemTokenSource({ chainId: poll.tokenChainId, primaryUrl: rpcUrl }) : null);
  if (!offline) {
    if (!chain) errors.push('rpc source required to re-derive weights');
    else if (poll.closeBlock == null) errors.push('closeBlock required for rpc verification');
    else {
      for (const [i, ballot] of ballots.entries()) {
        const evidence = await finalWeight({
          source: chain,
          token: poll.token,
          voter: ballot.voter,
          voteBlock: ballot.voteBlock,
          closeBlock: poll.closeBlock,
        });
        if (dec(evidence.finalWeight) !== String(ballot.finalWeight)) {
          errors.push(`ballot[${i}] final weight does not match chain`);
        }
        const got = evidence.touchedBlocks.map((n) => Number(n));
        const claimed = (ballot.touchedBlocks || []).map((n) => Number(n));
        if (JSON.stringify(got) !== JSON.stringify(claimed)) {
          errors.push(`ballot[${i}] touched blocks do not match chain`);
        }
        if (ballot.sigKind === 'erc1271') {
          const typed = tokenPollTypedData({
            tokenChainId: poll.tokenChainId,
            pollDomain: poll.pollDomain,
            token: poll.token,
            voter: ballot.voter,
            choiceIndexes: ballot.choiceIndexes,
            ballotSpecHash: poll.ballotSpecHash,
            issuedAt: ballot.issuedAt,
          });
          const { hashTypedData } = await import('viem');
          const magic = await chain.isValidSignature(ballot.voter, hashTypedData(typed), ballot.sig);
          if (!magic) errors.push(`ballot[${i}] erc1271 signature rejected`);
        }
      }
    }
  }

  checks.math = !errors.some((e) => /resultHash|outcome|counts|ballotsRoot|duplicate|signature|choices/.test(e));
  return {
    ok: errors.length === 0 && Object.values(checks).every(Boolean),
    errors,
    checks,
    summary: {
      ballots: ballots.length,
      outcome: result?.outcome || null,
      binding: false,
    },
  };
}
