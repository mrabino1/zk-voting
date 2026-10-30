# Poll and Vote batches

Status: **plan only**. Do not write this into the contracts until Matthew confirms it. This pull request does not change `BallotInbox`, the vote circuit, deploy scripts, or the tally key.

Already coded, and not part of the plan below:

- `electionType` is the last `uint8` of `createElection` (`0` POLL, `1` VOTE). No setter.
- A VOTE cannot post a tally, a decryption, an interim hash, a disclosure, or a tally component before `cutoffTime` (`ResultsSealedUntilEnd`).
- A POLL may replace `postInterimResult` and `disclose` before cutoff. At or after cutoff each of those two hashes may be written **once**, even if a value was stored before cutoff. That write is the certified final value of that field. A second post-cutoff write reverts `ResultAlreadyFinal`. `submitDecryption` is write-once and requires a posted tally. `addTallyComponent` reverts `TallyComponentsClosed` at or after cutoff for both types. New ballots revert after cutoff for both types.

## Decided

1. POLL and VOTE use one batch record, one cadence, and visible turnout. No padded or dummy ballots.
2. Both types post one last L1 batch at the deadline, including when the last hour is short.
3. A voter may cast again, for both types, until `cutoffTime`. The latest ballot is the only one that counts. The mechanism is replace-by-nullifier. Turnout counts unique voters.
4. VOTE choices are encrypted to a public key posted on the L2. The private key is split Shamir k-of-n. Decryption releases only the aggregate total. The full private key is never published. Individual ballots stay undecryptable after that release, so the release is not a proof of one voter's choice.
5. The tally waits out a nonzero challenge window after cutoff so an omitted ballot can be added back.

## Batch format and cadence

Not code. Defaults for the later change:

| Knob | Value | Why |
| --- | --- | --- |
| Shared cadence | 1 hour (`disclosureInterval`; the app hour is 3600 seconds) | Same clock for both types. |
| Inbox batch cap | 64 ballots (`BallotInbox.MAX_VOTE_BATCH`) | Existing calldata bound. An hour may be several transactions. |
| Record | Groth16 proof, five public inputs, one ciphertext | Same bytes for POLL and VOTE. |
| Turnout | `acceptedBallots`, public the whole window | Unique voters. A replacement does not increment it. No padding. |
| Final batch | Always, at `cutoffTime` | The tail is real. A short tail shows its real row count. |
| L1 during the election | One `RollupSettlement.submitBatch` per hour, plus the final batch | Roots and the aggregate commitment. Bodies stay on the L2. |
| POLL choice publication | App gate, then a running picture | Sums wait for 100 ballots or the end, then 30 minutes. Hours under 10 merge forward. A re-vote can move a picture that was already shown. |

`RollupSettlement.computeDataHash` is `keccak256(abi.encode(batchIndex, prevStateRoot, newStateRoot))`. `submitBatch` stores `dataLength = 0`. Neither commits to ballots or to an aggregate. The later change puts the hour's ballot-set root and the aggregate commitment inside `dataHash`. An old L1 batch is not rewritten when a re-vote moves the picture. The next batch carries the new aggregate.

The JSON sequencer (chain id 27427) has no gas token. Voters pay nothing. The EVM contracts are the settlement path and the Foundry inbox.

## Replace-by-nullifier

Today `BallotInbox._checkOne` reduces public input 2 into the field and stores it in `_nullifierUsed`. A second `submitVote` or batch entry with that value reverts `NullifierUsed`, including when the ciphertext is new. `_recordAcceptance` then stores the ballot hash, appends it, updates the append-only `ballotRoot`, increments `acceptedBallots`, and emits `VoteAccepted`. The vote circuit sets public input 2 to `Poseidon(nullifierSecret, electionId)`, so it is the same value for every ballot that person casts in that election. The contract comment says this is one acceptance, not last-ballot-counts.

That revert is what changes, for POLL and for VOTE, until `cutoffTime`. After cutoff, `OutsideVotingWindow` still rejects a new ballot, except an omitted ballot brought back inside the challenge window below.

### On-chain mechanism

Public input 2 stays the voter nullifier. It is not a fresh submission id.

- First acceptance of a nullifier stores `ballotHashOf[nullifier]`, appends that nullifier to the active list, increments `acceptedBallots`, and folds the new hash into `ballotRoot`.
- A later acceptance of the same nullifier, with a new ciphertext and a new ballot hash, **overwrites** `ballotHashOf[nullifier]`. It does not revert `NullifierUsed`. It does not increment `acceptedBallots`. It removes the previous hash from `ballotRoot` and folds in the new one.
- The same proof bytes posted twice still revert. Replay protection is the stored ballot hash (or the ciphertext hash), not a permanent voter lock.
- `acceptedBallots` is the unique-voter count. It is public. There is no second turnout number.
- The append-only hash chain cannot do this. A replacement has to drop the old hash. The root is the hash of the current ordered list of ballot hashes, recomputed when one entry changes. Gas is linear in the unique count. A sparse tree can replace that recompute later. It is not required to state the rule.

The tally counts the current ciphertext only. The contract keeps the previous ciphertext hash per nullifier so the running aggregate can multiply in `Enc(new) * Enc(old)^{-1}`. The old choice leaves the product. The new choice enters. The stored body for that nullifier is the new ciphertext. The event for a replacement is `BallotReplaced(electionId, nullifier, newBallotHash)`. It does not include a voter address. It does include the nullifier, so the two ballots are publicly the same person. That link is the cost of replace-by-nullifier. Observers do not learn the choice from the event.

Last-ballot-counts removes the first-ballot lock that today protects against coercion. A buyer can demand the voter's newest opening. The contract will not offer per-ballot openings. It also will not stop a voter who kept their randomness from showing that opening themselves.

### Five public inputs

`Vote` keeps five public inputs, in this order: eligible root, disqualification root, nullifier, ballot hash, election id. `BallotInbox` keeps rejecting any other length. `submitVote` and `submitVoteBatch` keep that ABI.

The vote circuit does **not** change for this plan:

- The nullifier constraint stays `Poseidon(nullifierSecret, electionId)`. It is not mixed with `ballotHash`.
- `ballotHash` stays public input 3 (`Poseidon(choice, choiceRandomness)` in the circuit; the `AG` tag path on chain already treats that tag as the hash).
- No sixth input. The tally key, a re-vote flag, and the previous hash are not public inputs.

What the vote circuit still does not prove: that the ciphertext is ElGamal under the joint key, or that it cancels the ciphertext previously stored for this nullifier. That is a batch-transition proof. Its public instance is the previous aggregate, the new aggregate, the previous ballot hash for this nullifier, the new ballot hash, and the new ballot-set root. The nullifier is already public, so putting it in that instance does not add a new link.

`TallyPublicInputs` (seven words, version 2) stays the tally instance. Word 5 is one aggregate commitment. `circuits/tally.circom` still proves a plaintext histogram and does not match that instance. The production tally circuit proves that the decrypted product matches the posted counts, and that the decryption is of the aggregate only.

## Challenge window

A tally posted in the cutoff block can be ordered ahead of a ballot the relayer dropped. The later change refuses `submitTally`, `submitAggregateTally`, and `submitDecryption` until `cutoffTime + challengeWindow`.

- `setChallengeWindow(electionId, uint64 secondsAfterCutoff)` is the tally operator, before `startTime`.
- The value must be greater than zero. Zero reverts.
- `tallyAllowedAt(electionId)` is `cutoffTime + challengeWindow`.
- From cutoff until that instant, a ballot the relayer signed and then omitted can be included by anyone who holds the signature. The signature covers the nullifier, the ballot hash, and the ciphertext hash. It is not a voter identity. The signer must be an allowlisted relayer.
- A replacement inside the window still overwrites that nullifier. It still does not increment turnout.
- At `tallyAllowedAt` the set freezes. Further ballots revert. The one post-cutoff interim write and the one post-cutoff disclosure write stay available to the operator on the existing clock (at or after cutoff), and they remain one write each.
- This window is configuration, not a per-ballot signal. It does not hide turnout. Turnout is already public.

## Tally key (VOTE)

Not coded. Shamir sharing of the VOTE key. Not a time-lock. Not a single operator key. The joint scalar is not reconstructed on chain and is not an event argument.

- **Setup.** Distributed Feldman sharing. Each guardian deals a polynomial of degree `k - 1`. No dealer holds the joint scalar. Bounds: `n` from 2 to 16, `k >= 2`, `k <= n`. The joint public key is posted on the L2 election before `startTime`. VOTE ballots are refused until that key is posted.
- **Share distribution.** Shares are encrypted to each guardian's transport key and kept off chain. The chain stores Feldman commitments only. The operator's database must not gain a copy of a share.
- **What is encrypted.** VOTE choices are exponential ElGamal of a one-hot vector under the joint key, which is what makes `Enc(new) * Enc(old)^{-1}` a re-vote. POLL uses the same batch record. POLL's opening key is the tally operator's, so the app can revise the running picture during the window. The VOTE k-of-n key must not be that POLL key.
- **Deadline.** Only at or after `tallyAllowedAt`, guardians submit partial decryptions of the **one aggregate ciphertext**, each with a Chaum-Pedersen proof against that guardian's commitment. `k` valid partials combine, by Lagrange, to the plaintext counts. `submitDecryption` records a hash of those counts. It does not take the scalar. It does not take per-ballot openings.
- **Never publish the private key.** No function returns it, stores it, or emits it. Publishing it would open every ciphertext. After release, individual ballots stay ciphertext. A voter cannot point at the tally transaction and prove which choice was theirs. The tally output is the option totals.
- **What that does not hide.** A voter who retained the encryption randomness can still show an opening of their own ciphertext to someone else. The release does not create that proof, and it does not erase it. Receipt-freeness against a voter who kept the coins is a different ballot scheme. This plan does not add one.
- **Guardian loss.** Fewer than `k` partials means there is no VOTE result. Do not lower `k` and do not add an operator override.
- **Early collusion.** Any `k` guardians who already hold shares can decrypt the aggregate on their own machines before the deadline, if they also have the ciphertext. The contract can refuse an early partial. It cannot take a share back. Fewer than `k` cannot.

## Contract, ABI, and deployment changes

Later pull request, after this plan is confirmed. Nothing in this list is in the current diff.

| Surface | Change |
| --- | --- |
| `BallotInbox` | On a known nullifier, overwrite `ballotHashOf` and the stored ciphertext hash. Do not revert `NullifierUsed` for a new body. Do not increment `acceptedBallots`. Recompute `ballotRoot` from the current list. Emit `BallotReplaced`. Keep five public inputs. Keep the relayer check. |
| Batch transition | A proof that the aggregate moved by `Enc(new) * Enc(old)^{-1}` for that nullifier, and that the root matches the current list. Set once, same pattern as `tallyProofVerifier`. |
| `Tally` | `setChallengeWindow` / `tallyAllowedAt` as above. `submitTally` and `submitDecryption` revert before `tallyAllowedAt`. For a VOTE, store guardian partials and require `k` valid partials before the decryption hash. Do not add a scalar argument or a scalar getter. POLL tally posting stays after the window. The one post-cutoff interim write and the one post-cutoff disclosure write stay as they are on this branch. |
| Ceremony storage | A contract for deals, commitments, `k`, and `n`. `createElection`'s tuple does not grow. `electionType` is already the last field. |
| `RollupSettlement` | Put the ballot-set root and the aggregate commitment inside `dataHash`. Keep `dataLength` at 0 under the gas assumption below. The final batch is mandatory. Do not rewrite an earlier batch. |
| Vote circuit | No change. Five public inputs. Nullifier stays `Poseidon(nullifierSecret, electionId)`. |
| Tally circuit | Prove decryption of the product against `TallyPublicInputs` version 2. The witness is shares of the aggregate, not the joint scalar and not per-ballot openings. |
| Deploy scripts | Do not edit addresses or broadcast artifacts for this plan. A later release deploys the ceremony contract and the new verifier. Existing clones keep their bytecode until that release. |

No new `createElection` field.

## Gas

Assumptions, not a measurement. This repo has no Foundry gas snapshot for `submitBatch`. The civic JSON chain charges no gas.

- L1 scenario: about 250,000 gas for one settlement proof plus storage, about $10 at 10 gwei and $4,000 per ETH. Recheck ETH and the base fee before budgeting.
- Cadence: one such L1 batch per election hour, plus one final batch, plus one mirror post (about 40,000–100,000 gas) after decryption. A 10-hour election is about 11 settlement batches. A 24-hour election is about 25. The final batch is a normal short hour, not padded to 64.
- Bodies stay off L1. A 200-byte ciphertext is about 3,200 gas of calldata. Sixty-four of them are about 200,000 gas if a later decision puts bodies on L1. This plan does not.
- On the EVM inbox, a first ballot is on the order of two cold writes plus the root update, the event, and a Groth16 verify (on the order of 250,000 gas when the vote proof is checked there). A replacement is a dirty-slot overwrite of the hash and the ciphertext commitment (about 2,900 gas for the slot) plus a root recompute linear in the unique count. It does not add an `acceptedBallots` write that changes the counter. Guardians at the deadline: `k` partial transactions, then one `submitDecryption`. For `k = 3`, treat that as well under one settlement batch.
- JSON sequencer cost stays a host. The final batch is one extra seal at `cutoffTime`. Revising a published POLL picture is an app write, not another L1 transaction, unless the next hourly batch is due anyway.

## Trust

- Turnout is public for both types, as the unique `acceptedBallots` count and as `BallotReplaced` events. This plan does not hide it.
- Choice totals for a VOTE stay hidden until `k` guardians decrypt the aggregate after the challenge window. The operator does not hold that scalar, and the chain never receives it.
- The operator does hold the POLL opening key, because the running picture is revised in the clear during the window.
- `k` colluding guardians can decrypt the VOTE aggregate early, off chain. Fewer than `k` cannot. Loss below `k` means no official result.
- Individual VOTE ciphertexts are not decrypted by the release. The release is not a per-voter proof. A voter who kept ballot randomness can still open their own ciphertext.
- Replace-by-nullifier ties the old ballot and the new ballot to the same public nullifier.
- Last-ballot-counts lets a coercer demand the newest opening. The current first-ballot lock was the protection against that.
- The batch proof is what stops a stranger from replacing someone else's ciphertext. Mock verifiers stay off for a binding election.
- An omitted ballot is detectable by the voter who holds the relayer receipt, and can be forced in until `tallyAllowedAt`. A zero window is not allowed, because the tally could otherwise land in the same block as cutoff and skip that ballot.
- L1 roots do not contain ballot bodies. The L2 log has to be retained or a batch cannot be recomputed.
- Intermediate POLL publications are not a checksum of the certified tally. The one post-cutoff interim write is the certified picture. Hours shown before that can still move until cutoff.

## What the app has to do

No app code in this pull request. After the plan is confirmed:

- Sequencer: one batch record for POLL and VOTE, on the hour, and one last batch at the deadline. Do not pad. Do not drop a short batch. A second ballot before cutoff is a replacement of that nullifier, not a rejection and not a second voter.
- Explorer: turnout is the unique count and is visible. POLL choice sums are a running picture until the one post-cutoff final hash. Do not present an old hour as equal to that final hash. VOTE choices appear only as the decrypted aggregate totals. Do not request the private key. Do not draw a per-ballot opening.
- Diagnostics: no VOTE plaintext before the aggregate decryption, including for an admin. No log of a Shamir share or of the joint scalar.
- Relayer: keep five-input proofs. Submit a later ballot under the same nullifier with the new ciphertext. Sign a receipt at accept time so an omitted ballot can be forced in during the challenge window. Do not post VOTE partials or `submitDecryption` before `tallyAllowedAt`.
- Factory call: append `electionType` as the last `uint8` when talking to a factory that includes this branch.
- Guardians: post the joint key before start. Hold shares off chain. Submit partials of the aggregate only, after the window. Do not upload the scalar.

The app gate beside this (100 ballots or the scheduled end, 30 minutes, merge-forward under 10) stays an app rule. The contract does not enforce it. The certified on-chain picture is the one post-cutoff write, not the sum of the published hours.

## Out of this plan

Padding, dummy ballots, relayer-held ballots, commit-reveal, and a time-lock on the tally key are not in this plan. The joint scalar is not published. Deployed addresses and submodules stay as they are. Contract code for the sections above waits for confirmation.
