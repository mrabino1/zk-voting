// NOT FOR PROFIT — civic public good, not a commercial product.
// Groth16 check for a vote. Mock proofs are limited to the local dev chain
// and to the Node test default chain. A missing ceremony zkey is not treated
// as success.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CHAIN_ID } from './setup.mjs';
import { HttpError } from './http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS_BUILD = path.resolve(HERE, '../../../circuits/build');

const VK_FILES = [
  'vote_verification_key.json',
  'vote_smoke_verification_key.json',
];

const ZK_FILES = new Map([
  ['/zk/vote.wasm', ['vote_js/vote.wasm', 'vote_smoke_js/vote_smoke.wasm']],
  ['/zk/vote.zkey', ['vote_final.zkey', 'vote_smoke_final.zkey']],
  ['/zk/vote_verification_key.json', ['vote_verification_key.json', 'vote_smoke_verification_key.json']],
]);

/** Serve a dev or ceremony proving key from circuits/build. Missing files 404. */
export function zkArtifactRoute() {
  return function zkArtifacts(req, res, next) {
    const names = ZK_FILES.get(req.path);
    if (!names) return next();
    for (const name of names) {
      const full = path.join(CIRCUITS_BUILD, name);
      if (fs.existsSync(full)) {
        res.sendFile(full);
        return;
      }
    }
    res.status(404).type('text').send('dev proving key is not built; run circuits:smoke (UNTRUSTED, not a ceremony)');
  };
}

const LOCAL_DEV_CHAIN_ID = 31337;

export function mockVoteProofAllowed(config) {
  if (config && Object.prototype.hasOwnProperty.call(config, 'allowMockProofs')) {
    return Boolean(config.allowMockProofs);
  }
  const chainId = Number(config?.chainId);
  if (chainId === LOCAL_DEV_CHAIN_ID) return true;
  const isTest = process.env.NODE_ENV === 'test';
  return isTest && chainId === DEFAULT_CHAIN_ID;
}

export function isMockVoteProof(proof) {
  if (!proof || typeof proof !== 'object') return true;
  if (proof.accept === true || proof.accept === 'true') return true;
  if (proof.mock === true || proof.mock === 'true') return true;
  return false;
}

export function voteVerificationKeyPath() {
  for (const name of VK_FILES) {
    const full = path.join(CIRCUITS_BUILD, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function loadVerificationKey() {
  const full = voteVerificationKeyPath();
  if (!full) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function snarkProof(proof) {
  if (proof.pi_a && proof.pi_b && proof.pi_c) {
    return { pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c, protocol: proof.protocol, curve: proof.curve };
  }
  if (proof.a && proof.b && proof.c) {
    return {
      pi_a: [...proof.a, '1'],
      pi_b: proof.b,
      pi_c: [...proof.c, '1'],
      protocol: 'groth16',
      curve: 'bn128',
    };
  }
  return null;
}

/**
 * Refuse a mock proof off the dev chain. When a real proof is present, check
 * it with snarkjs against the dev or ceremony verification key and require
 * the five public signals to be the ballot statement.
 */
export async function assertVoteProof({ proof, publicSignals, config }) {
  if (isMockVoteProof(proof)) {
    if (!mockVoteProofAllowed(config)) {
      throw new HttpError(
        400,
        'mock vote proofs are accepted only on the local dev chain',
        { code: 'MOCK_PROOF_NOT_ALLOWED' },
      );
    }
    return { mock: true };
  }
  const vk = loadVerificationKey();
  if (!vk) {
    throw new HttpError(
      503,
      'vote verification key is not installed. Run circuits:smoke for an UNTRUSTED dev key, or swap in a ceremony Vote(20) zkey. Mock proofs are not accepted on this chain.',
      { code: 'VOTE_VK_MISSING' },
    );
  }
  const shaped = snarkProof(proof);
  if (!shaped) {
    throw new HttpError(400, 'vote proof is not a Groth16 proof', { code: 'PROOF_INVALID' });
  }
  const { groth16 } = await import('snarkjs');
  const signals = (publicSignals || []).map((word) => BigInt(word).toString());
  const ok = await groth16.verify(vk, signals, shaped);
  if (!ok) {
    throw new HttpError(400, 'vote proof failed verification', { code: 'PROOF_INVALID' });
  }
  return { mock: false, devKey: path.basename(voteVerificationKeyPath() || '').includes('smoke') };
}
