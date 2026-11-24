// NOT FOR PROFIT — civic public good, not a commercial product.
// Writes smart-contracts/test/fixtures/js-election.json: a whole election produced by the
// JavaScript cryptography (guardian ceremony, encrypted ballots, final sum, decryption
// shares, totals) for the rollup address of the Foundry fixture. CrossLanguage.t.sol feeds
// it through the real contract, so JS and Solidity cannot drift apart.
//
//   node l2/rollup/scripts/make-contract-fixture.mjs

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as bc from '../../../apps/node/public/ballot-crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../../../smart-contracts/test/fixtures/js-election.json');

const ctx = bc.contextOf({ chainId: 31337, rollup: '0xF62849F9A0B5Bf2913b396098F7c7019b51A820a' });
const electionId = 1n;
const n = 3;
const k = 2;
const optionCount = 3;
const choices = [2, 0, 2, 1, 2];

const guardians = Array.from({ length: n }, (_, i) => {
  const index = i + 1;
  const id = bc.identityKeypair();
  const polynomial = bc.dealPolynomial(k);
  const commit = bc.commitGuardian({ ctx, electionId, index, polynomial, identitySecret: id.secret });
  return { index, id, polynomial, commit };
});

for (const dealer of guardians) {
  for (const recipient of guardians) {
    const share = bc.evalPolynomial(dealer.polynomial.coefficients, recipient.index);
    if (!bc.shareOpens(dealer.polynomial.commitments, recipient.index, share)) throw new Error('share does not open');
  }
}

const dealerCommitments = guardians.map((g) => g.polynomial.commitments);
const jointKey = bc.jointKeyOf(dealerCommitments);
const secretShare = (j) =>
  guardians.reduce((s, d) => (s + bc.evalPolynomial(d.polynomial.coefficients, j)) % bc.ORDER, 0n);

let accumulator = bc.emptyAccumulator(optionCount);
const ballots = choices.map((choice, i) => {
  const ballot = bc.encryptBallot({ ctx, electionId, jointKey, optionCount, choice });
  if (!bc.verifyBallot({ ctx, electionId, jointKey, optionCount, ...ballot })) throw new Error('ballot proof');
  accumulator = bc.addCiphertexts(accumulator, ballot.ciphertexts);
  return { nullifier: bc.nullifierOf(1000n + BigInt(i), electionId), commitment: bc.ballotCommitment(ballot.ciphertexts) };
});

const subset = [1, 3];
const shares = Object.fromEntries(
  subset.map((j) => [j, bc.decryptionShares({ ctx, electionId, index: j, secretShare: secretShare(j), accumulator })]),
);
const sharesByIndex = Object.fromEntries(subset.map((j) => [j, shares[j].map((s) => [s.dX, s.dY])]));
const totals = bc.openTotals({ accumulator, sharesByIndex, subset, ballotCount: choices.length });
const expected = [0, 1, 2].map((o) => BigInt(choices.filter((c) => c === o).length));
if (totals.join() !== expected.join()) throw new Error(`totals ${totals} != ${expected}`);
if (!bc.eq(bc.publicShare(dealerCommitments, 1), bc.mulBase(secretShare(1)))) throw new Error('public share');

const fixture = bc.toJSONSafe({
  chainId: ctx.chainId,
  rollup: ctx.rollup,
  electionId,
  threshold: k,
  optionCount,
  guardians: guardians.map((g) => ({ index: g.index, identity: g.id.key, ...g.commit })),
  jointKey,
  ballots,
  accumulator: accumulator.map(([c1, c2]) => [...c1, ...c2]),
  ballotCount: choices.length,
  subset,
  shares: subset.map((j) => shares[j]),
  totals,
});
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), out)}: totals ${totals.join(', ')}`);
