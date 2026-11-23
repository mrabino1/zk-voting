// NOT FOR PROFIT — civic public good, not a commercial product.
// The whole system against a real L1 (Anvil + DeployLocal): guardian ceremony in JS,
// roll through the priority queue, encrypted ballots and a revote through the operator,
// CLOSE, threshold decryption of the sum on L1. Skipped without Foundry (fails in CI).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as bc from '../../../apps/node/public/ballot-crypto.js';
import { createL1 } from '../l1.mjs';
import { Operator } from '../operator.mjs';
import { DEV_KEY, deployLocal, foundryAvailable, startAnvil } from './helpers/anvil.mjs';

const skip = foundryAvailable() ? false : process.env.CI === 'true' ? false : 'Foundry (anvil, forge) not installed';
const toHex32 = (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`;

let anvil;
let l1;
let op;
let deployment;

before(async () => {
  if (skip) return;
  anvil = await startAnvil();
  deployment = deployLocal(anvil.rpcUrl);
  l1 = createL1({ rpcUrl: anvil.rpcUrl, chainId: 31337, rollup: deployment.rollup, privateKey: DEV_KEY });
  op = await new Operator({ l1, chainId: 31337, allowMockProofs: true }).init();
});

after(() => anvil?.stop());

test('an election runs end to end and only its sum is decrypted', { skip, timeout: 600_000 }, async () => {
  const ctx = bc.contextOf({ chainId: 31337, rollup: l1.address });
  const now = await anvil.now();

  // Guardians: identity keys and polynomials live on their own devices.
  const k = 2;
  const guardians = [1, 2, 3].map((index) => ({ index, id: bc.identityKeypair(), poly: bc.dealPolynomial(k) }));

  await l1.send('createElection', [
    {
      jurisdictionId: deployment.jurisdictionId,
      startTime: BigInt(now + 2 * 3600),
      cutoffTime: BigInt(now + 3 * 3600),
      optionCount: 3,
      minBallots: 3,
      registrar: l1.account,
      officer: l1.account,
      guardians: guardians.map((g) => g.id.key),
      threshold: k,
      ballotSpecHash: toHex32(123),
      metadataURI: 'ipfs://ballot',
    },
  ]);
  const electionId = 1;

  for (const g of guardians) {
    const c = bc.commitGuardian({ ctx, electionId, index: g.index, polynomial: g.poly, identitySecret: g.id.secret });
    await l1.send('commitGuardian', [electionId, g.index, c.cx, c.cy, c.pok, c.auth]);
  }
  await anvil.warp(3601);
  await l1.send('finalizeKey', [electionId]);
  const jointKey = bc.jointKeyOf(guardians.map((g) => g.poly.commitments));

  // Roll: seven voters; voter 6 is disqualified before the start.
  const voters = Array.from({ length: 7 }, (_, i) => ({ trapdoor: 100n + BigInt(i), secret: 200n + BigInt(i) }));
  const commitments = voters.map((v) => bc.poseidon2(v.trapdoor, v.secret));
  await l1.send('registerVoters', [electionId, commitments]);
  await l1.send('disqualify', [electionId, commitments[6], 5]);
  const b1 = await op.tick();
  assert.deepEqual(b1.ops, { create: 1, register: 7, disqualify: 1 });
  assert.equal(op.state.publicView(electionId).rollSize, 7);
  assert.equal(op.state.rollPath(electionId, commitments[6]), null, 'disqualified voter has no membership path');
  assert.ok(op.state.rollPath(electionId, commitments[0]));

  // Voting: five ballots, then voter 0 changes their mind.
  await anvil.warp(3601);
  await op.sync();
  const choices = [0, 2, 2, 1, 2];
  const cast = async (i, choice) => {
    const ballot = bc.encryptBallot({ ctx, electionId, jointKey, optionCount: 3, choice });
    return op.submitBallot({ electionId, nullifier: bc.nullifierOf(voters[i].secret, electionId), ...ballot });
  };
  for (const [i, choice] of choices.entries()) await cast(i, choice);
  const b2 = await op.tick();
  assert.equal(b2.ops.ballots, 5);
  const receipt = await cast(0, 1);
  await op.tick();
  assert.equal(op.receipt(electionId, receipt.nullifier).status, 'settled');
  assert.equal(op.state.publicView(electionId).ballotCount, null, 'no live turnout before close');

  // A malformed ballot (two options set) is refused before it reaches a batch.
  const two = bc.encryptBallot({ ctx, electionId, jointKey, optionCount: 3, choice: 0 });
  two.ciphertexts[1] = bc.encryptBallot({ ctx, electionId, jointKey, optionCount: 3, choice: 1 }).ciphertexts[1];
  await assert.rejects(
    op.submitBallot({ electionId, nullifier: bc.nullifierOf(voters[5].secret, electionId), ...two }),
    /ballot proof does not verify/,
  );

  // The desert-mode proof format verifies against the deployed DesertVerifier.
  const proof = op.state.desertProof(electionId);
  const desertOk = await l1.publicClient.readContract({
    address: deployment.desertVerifier,
    abi: (await import('../../../packages/chain-client/abi/DesertVerifier.json', { with: { type: 'json' } })).default,
    functionName: 'verifyElection',
    args: [BigInt(await l1.read('executedStateRoot')), BigInt(electionId), proof.leaf, proof.accumulator, proof.siblings],
  });
  assert.equal(desertOk, true);

  // Close after the cutoff; the final sum is the only ciphertext that reaches L1.
  await anvil.warp(3601);
  await l1.send('closeElection', [electionId]);
  await op.tick();
  const info = await l1.read('election', [electionId]);
  assert.equal(Number(info.status), 4, 'closed');
  assert.equal(Number(info.ballotCount), 5);

  const acc = (await l1.read('accumulator', [electionId])).map((w) => [
    [w[0], w[1]],
    [w[2], w[3]],
  ]);
  const secretShare = (j) =>
    guardians.reduce((s, d) => (s + bc.evalPolynomial(d.poly.coefficients, j)) % bc.ORDER, 0n);
  const subset = [2, 3];
  const sharesByIndex = {};
  for (const j of subset) {
    const shares = bc.decryptionShares({ ctx, electionId, index: j, secretShare: secretShare(j), accumulator: acc });
    await l1.send('postDecryptionShares', [electionId, j, shares]);
    sharesByIndex[j] = shares.map((s) => [s.dX, s.dY]);
  }
  const totals = bc.openTotals({ accumulator: acc, sharesByIndex, subset, ballotCount: 5 });
  assert.deepEqual(totals, [0n, 2n, 3n], 'voter 0 moved from option 0 to option 1');
  await l1.send('finalizeResult', [electionId, totals, subset]);
  const [counts] = await l1.read('result', [electionId]);
  assert.deepEqual(counts, totals);
});
