#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// L2 identity helper for the operator (election team).
//
//   node l2/bin/l2-identity.mjs init            print fresh L2_UUID, L2_SALT, L2_ADMIN_SECRET lines for .env
//   node l2/bin/l2-identity.mjs show            l2Id, election-key domain, problems (reads env)
//   node l2/bin/l2-identity.mjs check-funding   L1 submitter balance vs. batch cost (reads L1_RPC + key)
//   node l2/bin/l2-identity.mjs election-key <electionUuid>
//
// Secrets are printed only by `init`, which writes nothing; paste the lines
// into your secret store. `show` never prints the salt or any key.
import {
  computeElectionKey,
  isUuid,
  mintAdminSecret,
  mintSalt,
  mintUuid,
  resolveIdentityAsync,
  resolveOperatorAddress,
} from '../identity.mjs';
import { checkSubmitterFunding } from '../prover/funding.mjs';

const [cmd, arg] = process.argv.slice(2);

async function main() {
  if (cmd === 'init') {
    console.log('# New L2 identity. Keep L2_SALT and L2_ADMIN_SECRET secret.');
    console.log(`L2_UUID=${mintUuid()}`);
    console.log(`L2_SALT=${mintSalt()}`);
    console.log(`L2_ADMIN_SECRET=${mintAdminSecret()}`);
    console.log('# Also set L1_SUBMITTER_PRIVATE_KEY (secret, minimal ETH) and L1_RPC, then run `show`.');
    return 0;
  }
  if (cmd === 'show') {
    const id = await resolveIdentityAsync(process.env);
    console.log(JSON.stringify(id, null, 2));
    return id.configured ? 0 : 1;
  }
  if (cmd === 'check-funding') {
    const address = await resolveOperatorAddress(process.env);
    const f = await checkSubmitterFunding({ l1Rpc: process.env.L1_RPC, address });
    console.log(JSON.stringify(f, null, 2));
    if (f.level === 'low') console.warn(`WARNING: ${f.message}`);
    return f.level === 'ok' ? 0 : f.level === 'low' ? 0 : 2;
  }
  if (cmd === 'election-key') {
    const id = await resolveIdentityAsync(process.env);
    if (!id.l2Id || !isUuid(arg)) {
      console.error('usage: election-key <electionUuid>   (needs L2_ID or L2_UUID + L2_SALT + submitter key)');
      return 1;
    }
    console.log(computeElectionKey({ l1ChainId: id.l1ChainId || 0, l2Id: id.l2Id, electionUuid: arg }));
    return 0;
  }
  console.error('usage: l2-identity.mjs init | show | check-funding | election-key <uuid>');
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message || err);
    process.exit(1);
  },
);
