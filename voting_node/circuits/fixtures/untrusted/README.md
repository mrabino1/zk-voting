# UNTRUSTED Groth16 fixtures

**NOT FOR PROFIT.** **Not a ceremony.**

The powers-of-tau contribution used a **published** entropy string (`zk-voting-local-untrusted-dev-only-not-a-ceremony`). The toxic waste is known. Do not deploy these verifying keys for a binding election.

| Files | Circuit | What it is |
| --- | --- | --- |
| `vote_smoke_*` | `Vote(4)` | Smoke proof. Not an election depth. |
| `vote20_*` | `Vote(20)` | Dev election-depth proof. **UNTRUSTED.** |

Both are Poseidon(2) (`zk-voting.hash.poseidon-bn254-x5-t3-v1`) and include the disqualification-chain non-membership witness.

- Proving zkeys and `.ptau` files are gitignored (`circuits/build/vote_final.zkey` is the Vote(20) proving key).
- This directory keeps verification keys, proofs, public signals, and witness inputs.
- Solidity: `UntrustedVoteSmokeVerifier.sol` and `UntrustedVote20Verifier.sol` under `smart-contracts/test/zk/fixtures/`. Both contracts are labeled UNTRUSTED.

Regenerate:

```bash
npm run circuits:smoke
npm run circuits:setup && npm run circuits:prove
```

If these files are missing, verification fails with `GROTH16_KEYS_MISSING`. It does not fall back to `MockVerifier.acceptAll`.
