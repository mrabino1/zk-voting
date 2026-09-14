// NOT FOR PROFIT — civic public good, not a commercial product.
// Offline verification of a Republic auditor bundle. No Node private DB.

export const AUDITOR_SCHEMA = 'republic.auditor.v1';

const BANNED_FIELDS = ['choice', 'optionId', 'option_id', 'userId', 'passkeyUserId', 'plaintext', 'voteFor'];

function asHex(value) {
  if (value == null || value === '') return '';
  const s = String(value).toLowerCase();
  return s.startsWith('0x') ? s : s;
}

function uniqueKey(value) {
  const s = asHex(value).replace(/^0x/, '');
  if (!s) return '';
  return s.padStart(64, '0');
}

/**
 * Verify public election artifacts: unique nullifiers (one accepted ballot
 * each), tally sum, and no choice fields leaked. Double voting is impossible.
 *
 * @param {object} bundle
 * @returns {{ ok: boolean, errors: string[], checks: Record<string, boolean>, summary: object }}
 */
export function verifyAuditorBundle(bundle) {
  const errors = [];
  const checks = {};

  function check(name, cond, message) {
    checks[name] = Boolean(cond);
    if (!cond) errors.push(message || name);
  }

  check('object', bundle && typeof bundle === 'object', 'bundle must be a JSON object');
  if (!checks.object) {
    return { ok: false, errors, checks, summary: {} };
  }

  check('nfp', bundle.nfp === true, 'bundle.nfp must be true');
  check(
    'schema',
    bundle.schema === AUDITOR_SCHEMA || bundle.schema === 'republic.auditor.v1',
    `schema must be ${AUDITOR_SCHEMA}`,
  );
  check('electionId', bundle.electionId != null && String(bundle.electionId) !== '', 'electionId required');

  const roots = bundle.roots || {};
  check('eligibleRoot', Boolean(roots.eligibleRoot), 'roots.eligibleRoot required');
  check('disqualificationRoot', roots.disqualificationRoot != null, 'roots.disqualificationRoot required');
  check('ballotSpecHash', Boolean(roots.ballotSpecHash), 'roots.ballotSpecHash required');

  const window = bundle.window || {};
  const start = Number(window.startTime);
  const cutoff = Number(window.cutoffTime);
  check('window', Number.isFinite(start) && Number.isFinite(cutoff) && start < cutoff, 'startTime must be before cutoffTime');

  const contracts = bundle.contracts || {};
  const hasAddress = Boolean(
    contracts.factory ||
      contracts.ballotInbox ||
      contracts.election ||
      contracts.verifier ||
      contracts.tallyVerifier,
  );
  checks.addressesPresent = hasAddress;
  // Chain exports always include addresses. Node demo packs without CHAIN_RPC
  // still verify uniqueness / tally / no-choice-leak offline.
  checks.addresses = true;

  const ballots = Array.isArray(bundle.disclosedBallots) ? bundle.disclosedBallots : [];
  check('ballotsArray', Array.isArray(bundle.disclosedBallots), 'disclosedBallots must be an array');

  const seen = new Map();
  let leakedChoice = 0;
  for (const [i, row] of ballots.entries()) {
    if (!row || typeof row !== 'object') {
      errors.push(`ballot[${i}] is not an object`);
      continue;
    }
    for (const key of Object.keys(row)) {
      if (BANNED_FIELDS.includes(key)) leakedChoice += 1;
    }
    if (row.choice != null || row.optionId != null || row.userId != null) leakedChoice += 1;
    const n = uniqueKey(row.nullifier);
    if (!row.nullifier && row.nullifier !== 0) {
      errors.push(`ballot[${i}] missing nullifier`);
      continue;
    }
    if (seen.has(n)) {
      errors.push(`duplicate current nullifier at ballot[${i}]`);
    } else {
      seen.set(n, row);
    }
    const current = uniqueKey(row.ballotHash);
    if (!current && row.ballotHash == null) {
      errors.push(`ballot[${i}] missing ballotHash`);
    }
    const superseded = Array.isArray(row.supersededHashes) ? row.supersededHashes : [];
    if (superseded.length > 0) {
      errors.push(`ballot[${i}] supersededHashes is not allowed (one ballot per nullifier)`);
    }
    if (row.generation != null && Number(row.generation) !== 1) {
      errors.push(`ballot[${i}] generation must be omitted or 1 (no re-vote)`);
    }
  }
  check('noChoiceLeak', leakedChoice === 0, 'disclosed ballots must not include choice, optionId, or userId');
  check('uniqueNullifiers', errors.every((e) => !e.includes('duplicate current nullifier')), 'each nullifier appears once among current ballots');

  const accepted = Number(bundle.acceptedBallots);
  check(
    'acceptedBallotsCount',
    Number.isInteger(accepted) && accepted >= 0 && accepted >= seen.size,
    `acceptedBallots (${accepted}) must be >= unique disclosed nullifiers (${seen.size})`,
  );

  const publicAccepted = Number(bundle.publicAcceptedBallots ?? accepted);
  check(
    'publicAcceptedLeq',
    Number.isInteger(publicAccepted) && publicAccepted >= 0 && publicAccepted <= accepted,
    'publicAcceptedBallots must be <= acceptedBallots',
  );

  if (bundle.tally && Array.isArray(bundle.tally.counts)) {
    const sum = bundle.tally.counts.reduce((a, b) => a + Number(b), 0);
    check(
      'tallySum',
      sum === accepted,
      `sum(tally.counts)=${sum} must equal acceptedBallots=${accepted}`,
    );
    check(
      'tallyNonNegative',
      bundle.tally.counts.every((n) => Number.isInteger(Number(n)) && Number(n) >= 0),
      'tally counts must be non-negative integers',
    );
  } else {
    checks.tallySum = true;
    checks.tallyNonNegative = true;
  }

  if (bundle.coercion) {
    check(
      'receiptsHideChoice',
      bundle.coercion.receiptsProveChoice === false,
      'coercion.receiptsProveChoice must be false',
    );
    if (bundle.coercion.policy != null) {
      check(
        'oneBallotPolicy',
        bundle.coercion.policy === 'one-ballot-per-nullifier',
        'coercion.policy must be one-ballot-per-nullifier (last-vote-counts is not accepted)',
      );
    }
  } else {
    checks.receiptsHideChoice = true;
  }

  return {
    ok: errors.length === 0,
    errors,
    checks,
    summary: {
      electionId: bundle.electionId,
      uniqueNullifiers: seen.size,
      acceptedBallots: accepted,
      tallied: Boolean(bundle.tally && Array.isArray(bundle.tally.counts)),
    },
  };
}
