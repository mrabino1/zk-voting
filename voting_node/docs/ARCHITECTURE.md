# ARCHITECTURE

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`NOT_FOR_PROFIT.md`](./NOT_FOR_PROFIT.md).

The map of the system: components, data flows, and where each rule is enforced. Product intent
lives in the [README](../README.md). The contract design and every rule ZkVotingRollup enforces
are in [`smart-contracts/docs/ROLLUP.md`](../../smart-contracts/docs/ROLLUP.md); if this file
disagrees with the code, the code wins and this file is overdue.

---

## Components

```
 browser (vanilla JS)                     Node (apps/node)                    L2 operator (l2/rollup)          Ethereum L1
 ─────────────────────                    ────────────────                    ───────────────────────          ───────────
 passkey wallet: nullifier secret ─┐      users, rolls, CMS, polls
 encryptBallot + 0/1 + sum proofs ─┼────► POST /vote (no cookies) ──────────► POST /v1/ballots ─────────────► commitBatch / verifyBatch /
 blind vote pass ◄──────────────────┘      POST /vote-pass (signed in)        state tree, mempool, receipts      executeBatches
                                          rollup client + tick ─────────────────────────────────────────────► createElection, registerVoters,
                                            (Node account = jurisdiction clerk)                                closeElection, finalizeResult,
 guardian CLI (guardian:rollup) ─────────► relays signed guardian messages ─────────────────────────────────► commitGuardian, postDecryptionShares
                                                                                                             ZkVotingRollup (one per chain)
```

| Component | What it is | State |
| --- | --- | --- |
| **ZkVotingRollup** (`../smart-contracts/src`) | The one L1 contract: jurisdictions, elections, guardian keys (Feldman DKG over Baby Jubjub), priority queue, batch chain, desert mode, threshold decryption of the final sum. Libraries `Guardians`, `Ops`, `StateTree`, `BabyJub`, `PoseidonT3`; verifiers `Groth16Verifier`, `DesertVerifier`, `MockBatchVerifier` (31337 only). | L1 storage |
| **L2 operator** (`l2/rollup`) | Follows the priority queue, checks ballot proofs, builds batches (pubdata byte for byte as the contract parses it), commits, verifies and executes them; serves receipts and the desert proof. | `rollup-operator.json` on `l2-data` |
| **Node** (`apps/node`) | Express 4 API + vanilla JS pages. Identity, registration, back office, CMS, polls, explorer, outcomes. For civic votes: publishes, syncs the roll, relays guardian messages and ballots, closes and finalizes on a tick (`ROLLUP_TICK_SECONDS`). | Postgres (`DATABASE_URL`) or JSON under `DATA_DIR` |
| **Shared crypto** (`apps/node/public/ballot-crypto.js`) | Exponential ElGamal on Baby Jubjub, ballot proofs, guardian messages; used by the browser, the Node, the operator and the guardian CLI. | — |
| **Packages** | `@zk-voting/chain-client` (rollup ABIs), `proof-helpers` (poll proof inputs, hashes), `types`. | — |
| **Circuits** (`circuits/`) | Circom poll circuits (`vote.circom`, `tally.circom`, `identity.circom`), untrusted local keys, ceremony tooling. The rollup's batch circuit is **not built**. | — |

---

## Civic vote: data flow

1. **Publish.** The clerk's draft becomes `createElection` on L1 from the Node account. L1 assigns
   `rollupElectionId`.
2. **Key ceremony.** Guardians post signed Feldman commitments (relayed by the Node), exchange
   encrypted shares through the Node's mailbox, and can dispute a bad share on L1. Anyone calls
   `finalizeKey`; a CREATE_ELECTION priority op carries the joint key into L2 state.
3. **Roll.** Until `startTime` the Node tick sends registrations (`registerVoters`) and
   disqualifications (`disqualify`) as priority requests. The operator must include them.
4. **Ballot.** The browser fetches `/rollup/ballot-context`, derives
   `nullifier = Poseidon(nullifierSecret, rollupElectionId)` from the passkey wallet, encrypts one
   ciphertext per option with 0/1 proofs and a sum-to-one proof, and posts it with a blind vote
   pass and no cookies. The Node checks the pass, reserves the nullifier, relays to the operator
   with `L2_BALLOT_TOKEN`, and stores only a receipt. The operator verifies the proofs, adds the
   ciphertexts to the election's encrypted accumulator, and puts a nullifier and a hiding
   commitment in the next batch's pubdata.
5. **Close.** After the cutoff `closeElection` (anyone; normally the tick) enqueues CLOSE; when
   that batch executes, L1 stores the final accumulator and ballot count.
6. **Result.** Below `minBallots` → **Withheld**. Otherwise guardians post one decryption share per
   option with a Chaum-Pedersen proof; `finalizeResult` checks the totals for any k of them and
   that they sum to the ballot count.

Liveness: a refused ballot can be `forceBallot`ed through L1; an operator that ignores the queue
for 3 days lets anyone `activateDesertMode()`.

## Poll: data flow

Polls never touch L1. The browser builds the poll proof (Groth16 over `vote.circom`, mock keys in
development), encrypts the ballot (AG envelope; sealed ranking envelope for ranked questions),
and posts it with a vote pass. The Node checks the proof (`voteProof.mjs`) and that it names the
open-window roots (`relay.mjs`: `ELIGIBLE_ROOT_MISMATCH`, `DISQUALIFICATION_ROOT_MISMATCH`), keeps
one ballot per nullifier, discloses hourly, and tallies at the end (plurality, IRV; guardian
partials on `opens_ballots` polls). The poll proof's `electionId` is the Node's `localElectionId`.

---

## Identity and privacy construction

```
passkey (WebAuthn, device-bound)
    │
    ├─ PRF ──► HKDF ──► account seed (wrapped in IndexedDB; signs the voter's own operations)
    │
    └─ PRF ──► HKDF ──► (identityTrapdoor, nullifierSecret)      separate domain
                          │
                          Poseidon(trapdoor, nullifierSecret) = identityCommitment   → the roll
                          Poseidon(nullifierSecret, electionId) = nullifier          → one ballot
```

- The roll leaf is the identity commitment, never a wallet address or a name.
- The ballot request carries no session, user id or commitment. The **vote pass** is an RSA blind
  signature (`votePass.mjs`, `public/vote-pass.js`): the Node checks eligibility on
  `POST /vote-pass`, signs a blinded token, and later sees only the unblinded token on
  `POST /vote`. Spent passes and the **poll book** (who took a pass, `votePassIssued`) are
  unlinked hash sets with coarse timestamps.
- Receipts list hashes only and cannot prove a choice. A civic receipt follows the ballot from
  `pending` to `committed` to `executed` on L1.
- Civic eligibility is not yet proven in zero knowledge (the batch circuit will); until then the
  vote pass is the gate.

Details: [`IDENTITY.md`](./IDENTITY.md), [`PASSKEYS.md`](./PASSKEYS.md),
[`OPERATOR.md` — Ballot unlinkability](./OPERATOR.md#ballot-unlinkability).

### Person (unique) vs one active Ethereum address

A Node user is one **person**. They may bind up to 5 emails (exactly one
primary), several Web3 wallets (signature-verified), up to 5 smart cards,
up to 5 driver’s licenses or passports, and up to 5 passkeys. Several ETH
addresses can be internally verified; exactly one is **active**.
A voter **requests** election registration; a registrar or clerk of that
election’s jurisdiction **approves** before the commitment is on the roll.
Authenticators and addresses cannot belong to two people. Officers may
revoke an expired card or license. Each person sets a vote PIN (hashed;
scrambled phone keypad at ballot submit). The vote leaf stays `identityCommitment`.
Details: [`IDENTITY.md`](./IDENTITY.md). Brief for officials: [`how_voters_privacy_is_protected.md`](./how_voters_privacy_is_protected.md).

### Hourly public disclosure (polling-place unlinkability)

Votes are **accepted immediately** (one ballot per nullifier; a second ballot
is rejected unless re-vote is enabled). Public proof of those votes — explorer rows, jurisdiction
`acceptedBallots`, any dashboard turnout tick — waits for these server-side
checks, from the first ballot:

- The UTC hour has closed and `DISCLOSURE_DELAY_SECONDS` (default **1800**)
  has elapsed. A vote at 08:59 publishes at **09:30**. An earlier note that a
  14:05 vote appears at 15:00 is replaced by **15:30**, once the block floor
  is also met. Turnout is public from the first ballot.
- Poll per-choice counts wait until the gate opens once 100 voters have cast their first ballot, or until the scheduled
  end (`RESULTS_MIN_VOTES`, default **100**). After that gate, hourly choice
  sums publish with the same delay. A published block stays as first published.
  A vote publishes choices only in the final tally.

- The disclosure block has at least `DISCLOSURE_MIN_BLOCK_VOTES` ballots
  (default **10**). Smaller hours merge forward. A remainder publishes at
  election end when the election met that floor; a short election publishes
  at the final tally.

- Do not leak a pending-per-election count (that still identifies the
  jurisdiction).
- Do not publish original intra-hour timestamps. Ready hours are lumped into
  a disclosure block, timestamped at the disclosure clock (hour end + delay),
  ordered by nullifier (not arrival).
- Default interval is 3600 seconds (`DISCLOSURE_INTERVAL_SECONDS`). Tests
  and local instant demo may set the interval to `0` (and the choice gate and
  block floor to their test defaults).

This applies to polls. A civic vote has no interim disclosure: L1 decrypts only the final sum.

---

## Identifiers

| Id | Where | Meaning |
| --- | --- | --- |
| `id` | Node | UUID v5 bound to (Node, jurisdiction, local sequence); legacy v4 still resolves |
| `shortCode` | Node | 10-character code for `/v/:code` links |
| `localElectionId` | Node | Numeric local sequence; the poll proof's `electionId` |
| `rollupElectionId` | L1 | A civic vote's id on ZkVotingRollup, assigned on publish |
| `jurisdictionId` | L1 | bytes32 jurisdiction on the rollup (`ROLLUP_JURISDICTION_ID`) |

`GET /api/elections/:id` accepts the UUID, short code or `localElectionId`; an ambiguous ref is a
409 `ELECTION_ID_COLLISION`.

---

## Eligible set (polls)

**`eligible = registered ∩ ¬currently-disqualified`**, in registration order. The Node rebuilds the
eligible tree on register, disqualify and revoke; `POST /api/elections/:id/freeze` snapshots it
(`frozenEligibleRoot`) together with the disqualification chain. While frozen, poll ballots must
prove against that snapshot unless the poll allows late updates.

For a civic vote, the roll lives in the rollup's L2 state and is fixed at `startTime`; the Node
does not freeze it.

### Poll circuit constraint plan

`vote.circom` requires both:

1. Merkle inclusion of `Hash(trapdoor, nullifierSecret)` under public `root`
   (the eligible set).
2. Non-membership of that same leaf under public `disqRoot`.

`disqRoot` is an indexed chain, not an event log. Sorted currently-disqualified
commitments `v0 < v1 < … < vLast` become leaves

```text
Hash(0, v0), Hash(v0, v1), …, Hash(vLast, 0)
```

The empty set is the one leaf `Hash(0, 0)`. The private witness is one link
`(disqLow, disqNext)` plus its Merkle path. The circuit enforces
`disqLow < leaf` and (`disqNext == 0` or `leaf < disqNext`). A disqualified
leaf is a boundary of that chain, so no witness satisfies the range check.
Reason codes stay on the `Disqualified` event and the officer mapping; they
are not hashed into the chain.

The Node builds the same chain with `keccak-dev-v1`; the circuit builds it with Poseidon. Those roots differ: do not mix them.

### Remaining ZK gap

- The rollup's batch validity circuit (with recursive ballot-proof and roll-membership
  verification) is not built; L1 settles only against `MockBatchVerifier` on chain 31337.
- Poll proofs use **untrusted** local keys until the phase-2 ceremony runs.

### Passkey wallet

1. Create WebAuthn credential (`residentKey: required`, `extensions.prf`).
2. `prf.eval` **account** salt → HKDF → encrypt a generated 32-byte seed
   (AES-GCM) and store the blob in IndexedDB + server credential id.
3. `prf.eval` **identity** salt → HKDF → `(identityTrapdoor, nullifierSecret)`.
   Separate domain from the account key ([`PASSKEYS.md`](./PASSKEYS.md)).
4. Signing: get account PRF, unwrap seed, HMAC-sign, immediately drop plaintext
   from memory. **Today** this is not a secp256k1 UserOp signature.
5. Fallback if PRF is unavailable: still create the passkey for login, and
   keep an encrypted key wrapped with a key derived from the assertion
   signature (documented as weaker). Never display a mnemonic. Never use
   that account key as the trapdoor.

---

## Pages

| Path | Files |
| --- | --- |
| `/`, `/register`, `/vote/:id` | `public/index.html` + `app.js`, `register.js`, `vote.js` (with `vote-flow.js`, `rollup-vote.js`), `router.js` |
| `/elections/:id/results` | `results.js`, `rollup-results.js` (civic results from L1) |
| `/elections/:id/info[/:q/:o]` | `info.js` |
| `/receipt`, `/outcomes`, `/outcomes/verify` | receipt and outcomes portals |
| `/admin`, `/site-admin` | platform administration |
| `/back-office` | `back-office.html` + `back-office.js` (clerk, registrar, disqualification, **Guardians and tally**) |
| `/explorer` | `explorer.html` + `explorer.js` (poll blocks; `#/rollup` for rollup batches) |
| `/setup` | first-run setup |
| `/office/pages`, `/office/site` | CMS |
| `/docs` | self-hosting docs |
| `/api` | bot API docs |

No bundler, no React. Every page footer carries **NOT FOR PROFIT**.

---

## Tooling

- Foundry (`forge test` in `../smart-contracts`), solc 0.8.24.
- Node.js 24.7+, npm workspaces. `npm test` runs the Node, packages, L2, contracts, auditor, docs
  and setup suites.
- `scripts/get-gas-economics.sh --measure` prices one civic vote on L1.

---

## What not to do

- Do not put legal names, dates of birth or addresses on chain.
- Do not publish or log a choice, a per-ballot ciphertext, or a partial sum of a civic vote.
- Do not add fees, tokens or skimmable ETH.
- Do not deploy a rollup per jurisdiction; there is one per chain.
- Do not patch out the refusals of mock proofs and Anvil keys off chain 31337.
