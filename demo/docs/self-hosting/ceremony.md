# Groth16 ceremony

**NOT FOR PROFIT** — civic public good. Not a commercial product.

zk-voting's ballot and tally proofs use Groth16, which needs a circuit-specific trusted setup ("phase 2") before keys can be trusted in a binding election. The Node can run that setup as a web ceremony. No production ceremony has been run yet; exported keys are marked untrusted until a human reviews them.

The full design, threat model, and verification guide is `docs/ceremony-web.md` in the repository. The command-line runbook is `docs/CEREMONY.md`.

## What you need

- A **super admin** account on this Node. Only the platform super admin can coordinate.
- The compiled circuit (`.r1cs`) from the reviewed commit, one per production circuit: `Vote(20)` and `Tally(8, 4)`.
- A **phase-1 file** (`.ptau`). Use a Hermez file. The Node never downloads it; fetch it yourself and check its published BLAKE2b-512 hash. Power 16 covers `Vote(20)`.
- An **Ethereum mainnet JSON-RPC endpoint** in `CEREMONY_ETH_RPC_URL` (your own node or a provider). The beacon is read from it, read-only. Without it, committing the beacon and finalizing fail closed.
- Disk: roughly (contributions + 2) × zkey size, plus the ptau, under `CEREMONY_DIR`. Back it up with the rest of `DATA_DIR`.

## Pages

| URL | Who |
| --- | --- |
| `/admin/ceremony` | Super admin: inputs, create, invite list, open, close, queue, beacon, finalize, exports, audit log |
| `/ceremony` | **Invited accounts only**: join the queue and contribute in the browser. Everyone else sees an "invite only" notice. |
| `/ceremony/<id>/transcript` | Anyone: transcript, hash-chain check, whole-chain verification, CLI commands |

## Run one

1. Upload the `.r1cs` and `.ptau` on `/admin/ceremony`, or copy them into `CEREMONY_INPUT_DIR` if they are larger than `CEREMONY_MAX_INPUT_MB`.
2. Create the ceremony. Pin the ptau with a Hermez preset or a hash. Set the minimum contributions (at least 2, default 3) and the turn length. Optionally list the handles to invite.
3. Build the invite list on the ceremony card: add existing accounts by handle, or create an email invite. An email invite gives you a single-use link (`/ceremony/<id>#invite=…`, valid 14 days) shown **once**; send it to the person yourself. Revoke any invite at any time. Only invited accounts can join or upload; the server enforces it. The public transcript shows invitees only as pseudonymous ids.
4. Open the window and tell your invitees. Participants contribute one at a time. Each upload is verified against the previous key before it is accepted.
5. Commit the beacon: a future **Ethereum mainnet block** at least `CEREMONY_BEACON_MIN_BLOCKS_AHEAD` (default 32) blocks past the current head. This is the only beacon source.
6. Close the window before that block is reached (the Node refuses afterwards). Then wait until the block is **finalized** (about 13 minutes after it appears) and press Finalize. The Node reads the block hash from the RPC, applies it, verifies the final key, and records the block number and hash in the transcript. Anyone can check that hash on any explorer.
7. Review the exports under `CEREMONY_DIR/<id>/export`. Nothing is deployed and `smart-contracts/` is not changed.

## Settings

See [Configuration reference](./configuration.md#trusted-setup-ceremony) for `CEREMONY_DIR`, `CEREMONY_INPUT_DIR`, `CEREMONY_MAX_ZKEY_MB`, `CEREMONY_MAX_INPUT_MB`, `CEREMONY_ETH_RPC_URL`, and `CEREMONY_BEACON_MIN_BLOCKS_AHEAD`.

`CEREMONY_ETH_RPC_URL` often contains a provider API key. Keep it in your secret store; the Node never logs it or shows it on a page.

## Content-Security-Policy

Ceremony pages send their own strict CSP: same-origin scripts only, no inline code. The contribution worker and the bundled snarkjs also allow `'wasm-unsafe-eval'` (WebAssembly compile, not JavaScript eval) and `blob:` workers, which snarkjs needs for its threads. If a reverse proxy adds its own CSP, it must not be stricter on `/ceremony-worker.js` and `/vendor/snarkjs.min.js`.

## Verify from the command line

The transcript page prints the exact commands. The core check is:

```bash
npx snarkjs@0.7.6 zkey verify circuit.r1cs phase2.ptau final.zkey
```

Every contribution hash it prints must match the transcript. Then look up `beacon.applied.blockNumber` on any Ethereum explorer and check its hash equals `beacon.applied.blockHash`.
