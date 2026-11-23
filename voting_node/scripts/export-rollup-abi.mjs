// NOT FOR PROFIT — civic public good, not a commercial product.
// Copy the ZkVotingRollup and verifier ABIs from the Foundry build into
// packages/chain-client/abi/. Run after `forge build` whenever the contract changes;
// packages/chain-client/test/abi.test.js fails while the copy is stale.
//
//   (cd ../smart-contracts && forge build) && node scripts/export-rollup-abi.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../smart-contracts/out');
const dest = path.resolve(here, '../packages/chain-client/abi');
mkdirSync(dest, { recursive: true });

for (const [file, name] of [
  ['ZkVotingRollup.sol', 'ZkVotingRollup'],
  ['Guardians.sol', 'Guardians'],
  ['MockBatchVerifier.sol', 'MockBatchVerifier'],
  ['DesertVerifier.sol', 'DesertVerifier'],
]) {
  const artifact = JSON.parse(readFileSync(path.join(out, file, `${name}.json`), 'utf8'));
  writeFileSync(path.join(dest, `${name}.json`), `${JSON.stringify(artifact.abi, null, 2)}\n`);
  console.log(`abi/${name}.json`);
}
