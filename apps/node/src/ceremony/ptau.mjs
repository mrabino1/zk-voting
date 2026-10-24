// NOT FOR PROFIT — civic public good, not a commercial product.
// Phase-1 powers of tau the coordinator may pin.
//
// Phase 1 is circuit-independent. zk-voting reuses the public Hermez / PSE
// perpetual powers-of-tau (prepared for phase 2) instead of running its own
// phase 1 (for example powersOfTau28_hez_final_16.ptau). Hashes are the blake2b-512 values
// published in the snarkjs README. The server never downloads these files.
// The operator places one in the ceremony input directory (or uploads it) and
// the server checks the pinned hash before the ceremony can start.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const HERMEZ_PTAU = Object.freeze([
  { power: 10, file: 'powersOfTau28_hez_final_10.ptau', url: 'https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_10.ptau', blake2b: '6cfeb8cda92453099d20120bdd0e8a5c4e7706c2da9a8f09ccc157ed2464d921fd0437fb70db42104769efd7d6f3c1f964bcf448c455eab6f6c7d863e88a5849' },
  { power: 11, file: 'powersOfTau28_hez_final_11.ptau', url: 'https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_11.ptau', blake2b: '47c282116b892e5ac92ca238578006e31a47e7c7e70f0baa8b687f0a5203e28ea07bbbec765a98dcd654bad618475d4661bfaec3bd9ad2ed12e7abc251d94d33' },
  { power: 12, file: 'powersOfTau28_hez_final_12.ptau', url: 'https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau', blake2b: 'ded2694169b7b08e898f736d5de95af87c3f1a64594013351b1a796dbee393bd825f88f9468c84505ddd11eb0b1465ac9b43b9064aa8ec97f2b73e04758b8a4a' },
  { power: 13, file: 'powersOfTau28_hez_final_13.ptau', url: 'https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_13.ptau', blake2b: '58efc8bf2834d04768a3d7ffcd8e1e23d461561729beaac4e3e7a47829a1c9066d5320241e124a1a8e8aa6c75be0ba66f65bc8239a0542ed38e11276f6fdb4d9' },
  { power: 14, file: 'powersOfTau28_hez_final_14.ptau', url: 'https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau', blake2b: 'eeefbcf7c3803b523c94112023c7ff89558f9b8e0cf5d6cdcba3ade60f168af4a181c9c21774b94fbae6c90411995f7d854d02ebd93fb66043dbb06f17a831c1' },
  { power: 15, file: 'powersOfTau28_hez_final_15.ptau', url: 'https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau', blake2b: '982372c867d229c236091f767e703253249a9b432c1710b4f326306bfa2428a17b06240359606cfe4d580b10a5a1f63fbed499527069c18ae17060472969ae6e' },
  { power: 16, file: 'powersOfTau28_hez_final_16.ptau', url: 'https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_16.ptau', blake2b: '6a6277a2f74e1073601b4f9fed6e1e55226917efb0f0db8a07d98ab01df1ccf43eb0e8c3159432acd4960e2f29fe84a4198501fa54c8dad9e43297453efec125' },
  { power: 17, file: 'powersOfTau28_hez_final_17.ptau', url: 'https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau', blake2b: '6247a3433948b35fbfae414fa5a9355bfb45f56efa7ab4929e669264a0258976741dfbe3288bfb49828e5df02c2e633df38d2245e30162ae7e3bcca5b8b49345' },
  { power: 18, file: 'powersOfTau28_hez_final_18.ptau', url: 'https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_18.ptau', blake2b: '7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e' },
  { power: 19, file: 'powersOfTau28_hez_final_19.ptau', url: 'https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_19.ptau', blake2b: 'bca9d8b04242f175189872c42ceaa21e2951e0f0f272a0cc54fc37193ff6648600eaf1c555c70cdedfaf9fb74927de7aa1d33dc1e2a7f1a50619484989da0887' },
  { power: 20, file: 'powersOfTau28_hez_final_20.ptau', url: 'https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_20.ptau', blake2b: '89a66eb5590a1c94e3f1ee0e72acf49b1669e050bb5f93c73b066b564dca4e0c7556a52b323178269d64af325d8fdddb33da3a27c34409b821de82aa2bf1a27b' },
]);

export function ptauPreset(power) {
  return HERMEZ_PTAU.find((row) => row.power === Number(power)) || null;
}

/** 64 hex = sha256, 128 hex = blake2b-512 (the snarkjs README format). */
export function hashAlgorithmFor(hex) {
  const h = String(hex || '').trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(h)) return 'sha256';
  if (/^[0-9a-f]{128}$/.test(h)) return 'blake2b512';
  return null;
}

export function hashFile(file, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}
