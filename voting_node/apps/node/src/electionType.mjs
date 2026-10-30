// NOT FOR PROFIT — civic public good, not a commercial product.
// App-side election type. Stored on the Node. Not part of the current
// ElectionFactory.createElection tuple.
//
// A later factory may add uint8 electionType as the LAST ElectionParams
// component, with getter electionType(): 0 = POLL, 1 = VOTE. This Node does
// not depend on that change. PASS_ELECTION_TYPE_ON_CHAIN stays false, so
// createElection encodes the tuple that is deployed today.

/** When false, the factory tuple omits electionType. The L2 civic open still carries it. Do not flip this alone. */
export const PASS_ELECTION_TYPE_ON_CHAIN = false;

export const ELECTION_TYPE_POLL = 0;
export const ELECTION_TYPE_VOTE = 1;

export const ELECTION_TYPE_NAME = Object.freeze({
  [ELECTION_TYPE_POLL]: 'poll',
  [ELECTION_TYPE_VOTE]: 'vote',
});

/**
 * Accept 0/1 or the names poll/vote. Omitted means POLL so existing elections
 * keep today's disclosure. Anything else is rejected.
 */
export function normalizeElectionType(raw, { required = false } = {}) {
  if (raw == null || raw === '') {
    if (required) {
      const err = new Error('electionType is required');
      err.code = 'INVALID_ELECTION_TYPE';
      throw err;
    }
    return ELECTION_TYPE_POLL;
  }
  const text = String(raw).trim().toLowerCase();
  if (text === '0' || text === 'poll') return ELECTION_TYPE_POLL;
  if (text === '1' || text === 'vote') return ELECTION_TYPE_VOTE;
  const err = new Error('electionType must be poll (0) or vote (1)');
  err.code = 'INVALID_ELECTION_TYPE';
  throw err;
}

export function electionTypeOf(election) {
  const raw = election?.electionType;
  if (raw == null || raw === '') return ELECTION_TYPE_POLL;
  if (raw === ELECTION_TYPE_VOTE || raw === '1') return ELECTION_TYPE_VOTE;
  const text = String(raw).trim().toLowerCase();
  if (text === 'vote') return ELECTION_TYPE_VOTE;
  return ELECTION_TYPE_POLL;
}

export function electionTypeName(election) {
  return ELECTION_TYPE_NAME[electionTypeOf(election)];
}

export function isVoteElection(election) {
  return electionTypeOf(election) === ELECTION_TYPE_VOTE;
}

export function isPollElection(election) {
  return !isVoteElection(election);
}

/**
 * Choice results for a VOTE stay sealed until cutoff. Missing cutoff fails closed.
 * POLL is never sealed by this check. Turnout is not a choice result: disclosed
 * ballot rows follow the hourly gate. Live diagnostic counters stay omitted.
 */
export function voteResultsSealed(election, now) {
  if (!isVoteElection(election)) return false;
  const end = Number(election?.cutoffTime);
  if (!Number.isFinite(end)) return true;
  return Number(now) < end;
}

/** English API sentence. The UI localizes the same shape with a formatted end. */
export function sealedResultsMessage(election) {
  const end = Number(election?.cutoffTime);
  if (!Number.isFinite(end)) return 'Results sealed until the election ends';
  return `Results sealed until ${new Date(end * 1000).toISOString()}`;
}

export function sealedResultsBody(election, now = Math.floor(Date.now() / 1000)) {
  if (!voteResultsSealed(election, now)) return null;
  return {
    resultsSealed: true,
    sealed: true,
    code: 'RESULTS_SEALED',
    message: sealedResultsMessage(election),
    sealedUntil: Number.isFinite(Number(election?.cutoffTime)) ? Number(election.cutoffTime) : null,
    electionType: ELECTION_TYPE_VOTE,
    electionTypeName: 'vote',
  };
}
