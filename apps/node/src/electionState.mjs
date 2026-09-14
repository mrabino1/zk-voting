// NOT FOR PROFIT — civic public good, not a commercial product.
// 0=Created 1=RollFrozen 2=Open 3=Closed 4=Tallied

export const STATE_NAMES = ['Created', 'RollFrozen', 'Open', 'Closed', 'Tallied'];

export function electionState(election, now = Math.floor(Date.now() / 1000)) {
  if (election.tally) return 4;
  if (now >= election.cutoffTime) return 3;
  if (now >= election.startTime && election.rollFrozen) return 2;
  if (election.rollFrozen) return 1;
  return 0;
}

export function publicElection(election, now = Math.floor(Date.now() / 1000)) {
  if (!election) return null;
  const state = electionState(election, now);
  return {
    id: election.id,
    title: election.title,
    metadataURI: election.metadataURI,
    startTime: election.startTime,
    cutoffTime: election.cutoffTime,
    maxParticipants: election.maxParticipants,
    treeDepth: election.treeDepth,
    ballotSpecHash: election.ballotSpecHash,
    questionCount: election.questionCount,
    questions: election.questions,
    jurisdictionId: election.jurisdictionId,
    clerk: election.clerk,
    registrar: election.registrar,
    disqualificationOfficer: election.disqualificationOfficer,
    tallyOperator: election.tallyOperator,
    verifier: election.verifier,
    lateUpdateAllowed: election.lateUpdateAllowed,
    rollFrozen: election.rollFrozen,
    frozenAt: election.frozenAt,
    participantCount: election.participantCount,
    acceptedBallots: election.acceptedBallots,
    eligibleRoot: election.eligibleRoot,
    disqualificationRoot: election.disqualificationRoot,
    state,
    stateName: STATE_NAMES[state],
    tally: election.tally
      ? { counts: election.tally.counts, postedAt: election.tally.postedAt }
      : null,
    createdAt: election.createdAt,
    nfp: true,
  };
}
