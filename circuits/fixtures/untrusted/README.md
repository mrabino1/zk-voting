# Untrusted Groth16 fixture

**NOT FOR PROFIT.** **Not a ceremony.**

These files are a local Groth16 proof for `circuits/mains/vote_smoke.circom` (`Vote(4)`), hashed with Poseidon(2) (`republic.hash.poseidon-bn254-x5-t3-v1`).

- The powers-of-tau contribution used a **published** entropy string (`republic-local-untrusted-dev-only-not-a-ceremony`). The toxic waste is known.
- Depth **4** is not an election. `ElectionParams.treeDepth` is 16..32. `Vote(20)` is `circuits/vote.circom` and needs its own setup (`npm run circuits:setup`).
- Do not deploy this verifying key for a binding election.
- zkeys and `.ptau` files are gitignored. This directory keeps the verification key, the proof, the public signals, and the witness input so `npm run circuits:verify` and `UntrustedGroth16Test` can check a real pairing without re-running the setup.

Regenerate:

```bash
npm run circuits:smoke
```

If these files are missing, verification fails with `GROTH16_KEYS_MISSING`. It does not fall back to `MockVerifier.acceptAll`.
