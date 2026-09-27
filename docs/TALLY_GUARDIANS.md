# Tally guardians

NOT FOR PROFIT. This ceremony is **NON-PRODUCTION**. It is not a Groth16 tally, not a binding-election key, and not an audit.

`opens_ballots` used to generate one P-256 operator key and store the private JWK on the Node. That threshold-1 key is gone. An election now takes a Feldman **t-of-n** guardian set. The Node never stores a tally private scalar.

## What is decided

- **Key generation** is distributed. Each guardian deals a polynomial of degree `t - 1` and publishes Feldman commitments `C_k = a_k·G` on P-256. There is no trusted dealer.
- **Shares** travel encrypted to each guardian’s transport public key (`RTv1` ECIES). The Node stores those ciphertexts and the commitments. A guardian finalizes only after every received share matches its commitments.
- **Ballots** stay hybrid: `RTv1 || ephemeral P-256 point || AES-GCM`, encrypted to the joint public key `Y = Σ C_{i,0}`.
- **Decryption** is threshold. Guardian `i` publishes `P_i = x_i·R` and a Chaum-Pedersen proof that `log_G(Y_i) = log_R(P_i)`, where `Y_i` is the Feldman verification key for index `i`. Lagrange combination of `t` partials recovers the ECDH x-coordinate. The joint scalar is not reconstructed in the tally API.
- **t - 1** partials do not open an envelope. A partial whose proof fails is rejected (`BAD_PARTIAL`), including when other partials would have been enough.

## What is not decided

Whether ballots are **aggregated homomorphically** or passed through a **mixnet** is an open product decision. Do not treat either as the design.

Both strategies are named in `apps/node/src/guardians/aggregate.mjs` and both refuse to run (`AGGREGATION_UNDECIDED`). The tally calls `getAggregator(election.tallyCeremony.aggregation)`. The only adapter that runs is `undecided`:

- it returns each ciphertext as its own decryption unit
- it does not multiply ciphertexts
- it does not shuffle them

That pass-through is what lets the Node publish a histogram of opened choices. It is not a vote for a mixnet and not a vote for homomorphic tally. A later change can `registerAggregator` with `status: 'selected'`. Until then, creating an election with `aggregation` set to anything other than `undecided` fails.

The current envelope is hybrid ECIES. A homomorphic tally would need a plaintext encoding whose product is the result (for example exponential ElGamal of a one-hot vector). A mixnet would need a verifiable shuffle in front of the same threshold decryption. Neither encoding nor shuffle ships here.

## Admin flow

Create the election with `tallyScheme: "opens_ballots"`, `threshold` (≥ 2), and `guardianCount` (2–16, and ≥ threshold). The back office at `/back-office#tally` enrolls guardians, accepts deal JSON, and accepts partial JSON.

| Step | Who | Call |
| --- | --- | --- |
| Enroll transport key | tally operator | `POST /api/elections/:id/guardians` |
| Publish deal | tally operator | `POST /api/elections/:id/guardians/deals` |
| Read encrypted shares | guardian | `GET /api/elections/:id/guardians/:index/inbox` |
| Public ceremony | anyone | `GET /api/elections/:id/tally-key` |
| Submit partials | tally operator, after cutoff | `POST /api/elections/:id/guardians/partials` |
| Post tally | tally operator | `POST /api/elections/:id/tally` |

Voting is rejected with `CEREMONY_INCOMPLETE` until every guardian has dealt and the joint key is on the election. Partials are checked against the Feldman verification key before they are stored, and checked again when the tally opens envelopes.

## Guardian CLI

From the repository root:

```bash
node apps/node/scripts/guardian.mjs init --index 1 --id alice --out alice.json
node apps/node/scripts/guardian.mjs deal --secret alice.json --threshold 2 --roster roster.json --out deal.json
node apps/node/scripts/guardian.mjs finalize --secret alice.json --deals deal1.json,deal2.json,deal3.json --threshold 2 --guardians 3 --out share.json
node apps/node/scripts/guardian.mjs partial --share share.json --election ELECTION_ID --envelopes envelopes.json --out partials.json
node apps/node/scripts/guardian.mjs verify --partial partials.json --ceremony ceremony.json --envelope 0x... --ballot-hash 0x... --election ELECTION_ID --index 1
```

`alice.json` and `share.json` are secret. `deal.json` and `partials.json` are what the admin posts (`enroll`, `post-deal`, and `post-partials` subcommands take `--base` and `--cookie`).

`roster.json` is `[{ "index": 1, "transportPublicKey": "0x04..." }, ...]`.

## Honest limits

- The group is NIST P-256 via `@noble/curves`, with WebCrypto for the hybrid envelope and for transport encryption. This is not a formal proof of the implementation.
- `t` guardians can still read every opened ballot. Threshold decryption removes the single operator key. It does not hide the tally from a quorum.
- `sum_only` is unchanged: any counts that sum to `acceptedBallots` are still accepted.
- MockVerifier and the missing Groth16 ceremony are unchanged.
- English UI copy matches this ceremony. Other locale catalogs may still describe the old threshold-1 demo key until they are translated.
