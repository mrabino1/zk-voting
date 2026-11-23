#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// Guardian CLI for civic votes on the rollup (smart-contracts/docs/ROLLUP.md).
// Your identity secret, polynomial and share stay in --me (keep it offline and backed up).
// The node relays your signed commitment and decryption shares to L1; it cannot forge them.
//
//   rollup-guardian init    --me me.json                       → prints your identity key
//   rollup-guardian commit  --me me.json --node URL --election ID --index N --api-key KEY
//   rollup-guardian receive --me me.json --node URL --election ID --index N --api-key KEY
//   rollup-guardian decrypt --me me.json --node URL --election ID --index N --api-key KEY

import { readFile, writeFile } from 'node:fs/promises';

import * as bc from '../public/ballot-crypto.js';

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) out._.push(argv[i]);
    else out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return out;
}

const a = args(process.argv.slice(2));
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};
const load = async () => bc.fromJSONSafe(JSON.parse(await readFile(a.me, 'utf8')));
const save = async (me) => writeFile(a.me, `${JSON.stringify(bc.toJSONSafe(me), null, 2)}\n`, { mode: 0o600 });

async function api(path, body) {
  const res = await fetch(new URL(`/api/elections/${a.election}/rollup${path}`, a.node), {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(a['api-key'] ? { authorization: `Bearer ${a['api-key']}` } : {}) },
    body: body ? JSON.stringify(bc.toJSONSafe(body)) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${json.error || ''} ${json.code || ''}`.trim());
  return bc.fromJSONSafe(json);
}

const boxContext = (view, from, to) => `zk-voting.share-box.v1:${view.l1.chainId}:${view.l1.rollup}:${view.l1.electionId}:${from}:${to}`;

async function main() {
  const cmd = a._[0];
  if (!a.me) die('--me <file> is required');
  if (cmd === 'init') {
    const id = bc.identityKeypair();
    await save({ identitySecret: id.secret, identityKey: id.key });
    console.log(JSON.stringify({ identityKey: bc.toJSONSafe(id.key) }));
    return;
  }
  for (const k of ['node', 'election', 'index']) if (!a[k]) die(`--${k} is required`);
  const index = Number(a.index);
  const me = await load();
  const view = await api('');
  if (!view.published) die('this vote is not on L1 yet');
  const ctx = bc.contextOf({ chainId: view.l1.chainId, rollup: view.l1.rollup });
  const electionId = view.l1.electionId;
  const mine = view.guardians.find((g) => g.index === index);
  if (!mine || String(mine.identityKey[0]) !== String(me.identityKey[0])) die('--index does not match your identity key');

  if (cmd === 'commit') {
    const polynomial = me.polynomial || bc.dealPolynomial(view.l1.threshold);
    me.polynomial = polynomial;
    await save(me);
    await api(`/guardians/${index}/commit`, bc.commitGuardian({ ctx, electionId, index, polynomial, identitySecret: me.identitySecret }));
    for (const g of view.guardians) {
      const share = bc.evalPolynomial(polynomial.coefficients, g.index);
      const signature = bc.signShare({ ctx, electionId, dealer: index, recipient: g.index, share, polynomial });
      const box = await bc.sealBox({
        senderSecret: me.identitySecret,
        recipientKey: g.identityKey,
        payload: { share, signature },
        context: boxContext(view, index, g.index),
      });
      await api('/mailbox', { from: index, to: g.index, box });
    }
    console.log(`committed and dealt shares to ${view.guardians.length} guardians`);
    return;
  }

  if (cmd === 'receive') {
    const { messages } = await api(`/mailbox/${index}`);
    const byDealer = new Map(messages.map((m) => [m.from, m]));
    let secret = 0n;
    for (const dealer of view.guardians.filter((g) => g.committed && !g.excluded)) {
      const msg = byDealer.get(dealer.index);
      const sign = (message) => bc.signAuth({ ctx, electionId, index, message, identitySecret: me.identitySecret });
      if (!msg) {
        console.log(`no share from guardian ${dealer.index}: opening a dispute`);
        await api('/disputes/open', { dealer: dealer.index, recipient: index, signature: sign(bc.disputeMessage(dealer.index)) });
        continue;
      }
      const { share, signature } = await bc.openBox({
        recipientSecret: me.identitySecret,
        senderKey: dealer.identityKey,
        box: msg.box,
        context: boxContext(view, dealer.index, index),
      });
      if (!bc.shareOpens(dealer.commitments, index, share)) {
        console.log(`guardian ${dealer.index} sent a bad share: complaining`);
        await api('/disputes/complain', { dealer: dealer.index, recipient: index, share, signature });
        continue;
      }
      secret = (secret + share) % bc.ORDER;
    }
    me.secretShare = secret;
    await save(me);
    console.log('your decryption share is saved in --me');
    return;
  }

  if (cmd === 'decrypt') {
    if (!view.accumulator) die(`the vote is ${view.l1.status}; decryption opens once L1 holds the final sum`);
    if (me.secretShare == null) die('run receive first');
    const accumulator = view.accumulator.map((w) => [[w[0][0], w[0][1]], [w[1][0], w[1][1]]]);
    const shares = bc.decryptionShares({ ctx, electionId, index, secretShare: me.secretShare, accumulator });
    await api(`/guardians/${index}/shares`, { shares });
    console.log('decryption shares posted for the final sum');
    return;
  }
  die('commands: init | commit | receive | decrypt');
}

await main();
