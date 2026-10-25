// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { getAggregator } from '../src/guardians/aggregate.mjs';
import {
  createSealedDeal,
  finalizeShare,
  initGuardian,
  partialDecrypt,
  verifyFeldmanShare,
  verifyPartial,
} from '../src/guardians/index.mjs';
import { expectedVerificationKey } from '../src/guardians/dkg.mjs';
import { hexToScalar, lagrangeAtZero, mod, pointFromHex, pointToHex, pointXBytes } from '../src/guardians/p256.mjs';
import { ephemeralFromEnvelope, decryptEnvelopeWithPartials } from '../src/guardians/threshold.mjs';
import {
  decryptTallyEnvelope,
  decryptTallyEnvelopeWithSharedBits,
  encryptToTallyPub,
  generateDemoGuardian,
  packChoices,
  unpackChoices,
} from '../src/tallyCrypto.mjs';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/guardian.mjs', import.meta.url));

function jwkScalar(jwk) {
  const pad = jwk.d.length % 4 === 0 ? '' : '='.repeat(4 - (jwk.d.length % 4));
  const buf = Buffer.from(jwk.d.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
  return hexToScalar(`0x${buf.toString('hex')}`);
}

async function ceremony({ guardians = 3, threshold = 2 } = {}) {
  const secrets = [];
  for (let i = 1; i <= guardians; i++) {
    secrets.push(await initGuardian({ index: i, guardianId: `g${i}` }));
  }
  const roster = secrets.map((secret) => ({
    index: secret.index,
    transportPublicKey: secret.transportPublicKey,
  }));
  const deals = [];
  for (const secret of secrets) {
    deals.push(await createSealedDeal({ index: secret.index, threshold, roster }));
  }
  const shares = [];
  for (const secret of secrets) {
    shares.push(
      await finalizeShare({
        index: secret.index,
        privateJwk: secret.transportPrivateJwk,
        deals,
        threshold,
        guardianCount: guardians,
      }),
    );
  }
  return { secrets, deals, shares, threshold, guardians };
}

function partialsFor(shares, { envelope, electionId, ballotHash, jointPublicKey }) {
  const ephemeral = ephemeralFromEnvelope(envelope);
  return shares.map((share) => ({
    index: share.index,
    ...partialDecrypt({
      shareScalar: share.shareScalar,
      index: share.index,
      electionId,
      ballotHash,
      jointPublicKey,
      ephemeral,
    }),
  }));
}

describe('Feldman guardians', () => {
  test('WebCrypto ECDH x-coordinate matches P-256 scalar multiplication', async () => {
    const key = await generateDemoGuardian();
    const env = await encryptToTallyPub(key.publicKeyRaw, packChoices([2]));
    const viaJwk = await decryptTallyEnvelope(key.privateJwk, env);
    const shared = pointFromHex(ephemeralFromEnvelope(env)).multiply(jwkScalar(key.privateJwk));
    const viaScalar = await decryptTallyEnvelopeWithSharedBits(pointXBytes(shared), env);
    assert.deepEqual(unpackChoices(viaScalar), unpackChoices(viaJwk));
  });

  test('t guardians decrypt and t-1 guardians cannot', async () => {
    const { shares, deals, threshold } = await ceremony({ guardians: 3, threshold: 2 });
    const jointKey = shares[0].jointPublicKey;
    assert.ok(shares.every((share) => share.jointPublicKey === jointKey));
    const electionId = 'election-1';
    const ballotHash = '0xballot';
    const envelope = await encryptToTallyPub(jointKey, packChoices([4]));
    const rows = partialsFor(shares, { envelope, electionId, ballotHash, jointPublicKey: jointKey });
    const verificationKeys = {};
    for (const share of shares) {
      verificationKeys[share.index] = pointToHex(expectedVerificationKey(deals, share.index));
    }

    const plain = await decryptEnvelopeWithPartials({
      envelopeHex: envelope,
      electionId,
      ballotHash,
      jointPublicKey: jointKey,
      verificationKeys,
      partials: rows.slice(0, threshold),
      threshold,
    });
    assert.deepEqual(unpackChoices(plain), [4]);

    const other = await decryptEnvelopeWithPartials({
      envelopeHex: envelope,
      electionId,
      ballotHash,
      jointPublicKey: jointKey,
      verificationKeys,
      partials: [rows[0], rows[2]],
      threshold,
    });
    assert.deepEqual(unpackChoices(other), [4]);

    await assert.rejects(
      () =>
        decryptEnvelopeWithPartials({
          envelopeHex: envelope,
          electionId,
          ballotHash,
          jointPublicKey: jointKey,
          verificationKeys,
          partials: rows.slice(0, threshold - 1),
          threshold,
        }),
      (err) => err.code === 'THRESHOLD_NOT_MET',
    );

    const points = shares.map((share) => ({ x: share.index, y: hexToScalar(share.shareScalar) }));
    const secret = lagrangeAtZero(points.slice(0, threshold));
    const short = lagrangeAtZero(points.slice(0, threshold - 1));
    assert.notEqual(secret, short);
    const wrongPoint = pointFromHex(ephemeralFromEnvelope(envelope)).multiply(short);
    await assert.rejects(() => decryptTallyEnvelopeWithSharedBits(pointXBytes(wrongPoint), envelope));
    const rightPoint = pointFromHex(ephemeralFromEnvelope(envelope)).multiply(secret);
    const openedPlain = await decryptTallyEnvelopeWithSharedBits(pointXBytes(rightPoint), envelope);
    assert.deepEqual(unpackChoices(openedPlain), [4]);
  });

  test('a bad partial decryption is rejected', async () => {
    const { shares, deals, threshold } = await ceremony({ guardians: 3, threshold: 2 });
    const joint = shares[0].jointPublicKey;
    const env = await encryptToTallyPub(joint, packChoices([1]));
    const ballotHash = '0xone';
    const rows = partialsFor(shares, {
      envelope: env,
      electionId: 'e',
      ballotHash,
      jointPublicKey: joint,
    });
    const expectedY = pointToHex(expectedVerificationKey(deals, rows[0].index));
    const ephemeral = ephemeralFromEnvelope(env);
    assert.equal(
      verifyPartial({
        partial: rows[0],
        electionId: 'e',
        index: rows[0].index,
        jointPublicKey: joint,
        expectedY,
        ephemeral,
      }),
      true,
    );
    const bad = structuredClone(rows[0]);
    const bumped = (BigInt(bad.proof.z) + 1n).toString(16).padStart(64, '0');
    bad.proof.z = `0x${bumped}`;
    assert.equal(
      verifyPartial({
        partial: bad,
        electionId: 'e',
        index: bad.index,
        jointPublicKey: joint,
        expectedY,
        ephemeral,
      }),
      false,
    );
    const verificationKeys = {};
    for (const share of shares) {
      verificationKeys[share.index] = pointToHex(expectedVerificationKey(deals, share.index));
    }
    await assert.rejects(
      () =>
        decryptEnvelopeWithPartials({
          envelopeHex: env,
          electionId: 'e',
          ballotHash,
          jointPublicKey: joint,
          verificationKeys,
          partials: [bad, rows[1]],
          threshold,
        }),
      (err) => err.code === 'BAD_PARTIAL',
    );
  });

  test('a Feldman share that does not match its commitments is rejected', async () => {
    const { secrets, deals } = await ceremony();
    const { decryptTallyEnvelope: openShare } = await import('../src/tallyCrypto.mjs');
    const plain = await openShare(secrets[0].transportPrivateJwk, deals[1].encryptedShares['1']);
    const share = hexToScalar(`0x${Buffer.from(plain).toString('hex')}`);
    assert.equal(verifyFeldmanShare({ index: 1, share, commitments: deals[1].commitments }), true);
    assert.equal(
      verifyFeldmanShare({
        index: 1,
        share: mod(share + 1n),
        commitments: deals[1].commitments,
      }),
      false,
    );
  });

  test('homomorphic and mixnet aggregators are not selected', () => {
    const pass = getAggregator('undecided').prepare([{ encryptedBallot: '0xab', ballotHash: 'h' }]);
    assert.equal(pass.length, 1);
    assert.equal(pass[0].encryptedBallot, '0xab');
    assert.equal(pass[0].sourceIds[0], 'h');
    for (const id of ['homomorphic', 'mixnet']) {
      assert.throws(() => getAggregator(id), (err) => err.code === 'AGGREGATION_UNDECIDED');
    }
  });

  test('CLI deal file has no secret share and t partials verify', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'republic-guardian-cli-'));
    try {
      const secrets = [];
      for (let i = 1; i <= 3; i++) {
        const out = path.join(dir, `g${i}.json`);
        await execFileAsync(process.execPath, [cli, 'init', '--index', String(i), '--id', `g${i}`, '--out', out]);
        secrets.push(out);
      }
      const loaded = [];
      for (const file of secrets) loaded.push(JSON.parse(await readFile(file, 'utf8')));
      const rosterPath = path.join(dir, 'roster.json');
      await writeRoster(rosterPath, loaded);
      const dealPaths = [];
      for (const file of secrets) {
        const dealPath = path.join(dir, `deal-${path.basename(file)}`);
        await execFileAsync(process.execPath, [
          cli,
          'deal',
          '--secret',
          file,
          '--threshold',
          '2',
          '--roster',
          rosterPath,
          '--out',
          dealPath,
        ]);
        const deal = JSON.parse(await readFile(dealPath, 'utf8'));
        assert.equal(deal.shareScalar, undefined);
        assert.equal(deal.transportPrivateJwk, undefined);
        assert.equal(deal.commitments.length, 2);
        dealPaths.push(dealPath);
      }
      const sharePaths = [];
      for (const file of secrets) {
        const sharePath = path.join(dir, `share-${path.basename(file)}`);
        await execFileAsync(process.execPath, [
          cli,
          'finalize',
          '--secret',
          file,
          '--deals',
          dealPaths.join(','),
          '--threshold',
          '2',
          '--guardians',
          '3',
          '--out',
          sharePath,
        ]);
        sharePaths.push(sharePath);
      }
      const share = JSON.parse(await readFile(sharePaths[0], 'utf8'));
      const env = await encryptToTallyPub(share.jointPublicKey, packChoices([3]));
      const envPath = path.join(dir, 'envelopes.json');
      const { writeFile: write } = await import('node:fs/promises');
      await write(
        envPath,
        JSON.stringify({ envelopes: [{ ballotHash: '0xcli', encryptedBallot: env }] }),
      );
      const partialPath = path.join(dir, 'partial.json');
      await execFileAsync(process.execPath, [
        cli,
        'partial',
        '--share',
        sharePaths[0],
        '--election',
        'cli-election',
        '--envelopes',
        envPath,
        '--out',
        partialPath,
      ]);
      const ceremonyPath = path.join(dir, 'ceremony.json');
      const deals = [];
      for (const file of dealPaths) deals.push(JSON.parse(await readFile(file, 'utf8')));
      const verificationKeys = {
        1: pointToHex(expectedVerificationKey(deals, 1)),
        2: pointToHex(expectedVerificationKey(deals, 2)),
        3: pointToHex(expectedVerificationKey(deals, 3)),
      };
      await write(ceremonyPath, JSON.stringify({ publicKey: share.jointPublicKey, verificationKeys }));
      const { stdout } = await execFileAsync(process.execPath, [
        cli,
        'verify',
        '--partial',
        partialPath,
        '--ceremony',
        ceremonyPath,
        '--envelope',
        env,
        '--ballot-hash',
        '0xcli',
        '--election',
        'cli-election',
        '--index',
        '1',
      ]);
      assert.match(stdout, /partial ok/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function writeRoster(file, secrets) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    file,
    JSON.stringify(
      secrets.map((secret) => ({ index: secret.index, transportPublicKey: secret.transportPublicKey })),
    ),
  );
}
