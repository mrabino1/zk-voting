# Poll and Vote batches

Status: **plan only**. Do not write the sections below into the contracts until Matthew confirms them. This pull request does not change `BallotInbox`, the vote circuit, deploy scripts, or the tally key.

Already coded, and not part of the plan below:

- `electionType` is the last `uint8` of `createElection` (`0` POLL, `1` VOTE). No setter.
- A VOTE cannot post a tally, a decryption, an interim hash, a disclosure, or a tally component before `cutoffTime` (`ResultsSealedUntilEnd`).
- A POLL may replace `postInterimResult` and `disclose` before cutoff. At or after cutoff each of those two hashes may be written **once**, even if a value was stored before cutoff, and only after a tally is posted (`FinalBeforeTally`). That write is the certified final value of that field. A second post-cutoff write reverts `ResultAlreadyFinal`. `submitDecryption` is write-once and requires a posted tally. `addTallyComponent` reverts `TallyComponentsClosed` at or after cutoff for both types. New ballots revert after cutoff for both types.

## Decided

1. POLL and VOTE use one batch record, one cadence, and visible turnout. No padded or dummy ballots.
2. Both types post one last L1 batch at the deadline, including when the last hour is short.
3. A voter may cast again, for both types, until `cutoffTime`. The latest ballot is the only one that counts. Each ballot spends its own submission id. Turnout counts unique voters. A published hour is not revised.
4. VOTE choices are encrypted to a public key posted on the L2. The private key is split Shamir k-of-n. Decryption releases only the aggregate total. The full private key is never published. Individual ballots stay undecryptable after that release, so the release is not a proof of one voter's choice. POLL hourly sums use a separate guardian key, described under "Tally key".
5. The tally waits out a nonzero challenge window after cutoff so an omitted ballot can be added back. That window is planned code. It is not written.

## Batch format and cadence

Not code. Defaults for the later change:

| Knob | Value | Why |
| --- | --- | --- |
| Shared cadence | 1 hour (`disclosureInterval`; the app hour is 3600 seconds) | Same clock for both types. |
| Inbox batch cap | 64 ballots (`BallotInbox.MAX_VOTE_BATCH`) | Existing calldata bound. An hour may be several transactions. |
| Record | Groth16 proof, five public inputs, one ciphertext | Same bytes for POLL and VOTE. |
| Turnout | `acceptedBallots`, public the whole window | Unique voters. A replacement does not increment it. No padding. |
| Final batch | Always, at `cutoffTime` | The tail is real. A short tail shows its real row count. |
| L1 during the election | One `RollupSettlement.submitBatch` per hour, plus the final batch | That hour's ballot-set root and that hour's aggregate, the running total that leaves re-vote deltas out. Bodies stay on the L2. `postInterimResult` is not this record. |
| POLL choice publication | App gate, then a sealed hour | Sums wait for 100 ballots or the end, then 30 minutes. Hours under 10 merge forward. A published hourly block never changes. A re-vote's replacement is reflected only in the certified final tally. |

`postInterimResult` (`Tally.sol` lines 199–206) stores one hash, `_interimHash`. Before cutoff a POLL may replace that slot on every call. It is not a per-hour record. The per-hour guarantee is a `RollupSettlement` batch. `submitBatch` appends one `batchIndex` and does not rewrite an earlier one.

`RollupSettlement.computeDataHash` is `keccak256(abi.encode(batchIndex, prevStateRoot, newStateRoot))`. `submitBatch` stores `dataLength = 0`. Neither commits to ballots or to an aggregate today. The later change puts that hour's ballot-set root and that hour's aggregate commitment inside `dataHash`. The hour's aggregate is the one that leaves re-vote deltas out, defined below. A published hourly block never changes. A re-vote's replacement is reflected only in the certified final tally.

The JSON sequencer (chain id 27427) has no gas token. Voters pay nothing. The EVM contracts are the settlement path and the Foundry inbox.

## Re-vote, without a public nullifier

Today `BallotInbox._checkOne` reduces public input 2 into the field and stores it in `_nullifierUsed`. A second `submitVote` or batch entry with that value reverts `NullifierUsed`, including when the ciphertext is new. `_recordAcceptance` stores the ballot hash, appends it, updates the append-only `ballotRoot`, increments `acceptedBallots`, and emits `VoteAccepted`. The vote circuit sets public input 2 to `Poseidon(nullifierSecret, electionId)`, so it is the same value for every ballot that person casts in that election. The contract comment says this is one acceptance, not last-ballot-counts.

That permanent voter lock is what changes, for POLL and for VOTE, until `cutoffTime`. After cutoff, `OutsideVotingWindow` still rejects a new ballot, except an omitted ballot brought back inside the challenge window below.

The plan does **not** reuse one public nullifier for both ballots. It does **not** emit `BallotReplaced(electionId, nullifier, newBallotHash)`. A stranger must not be able to match the two ballots.

### On-chain mechanism

Public input 2 becomes a **submission id**: `Poseidon(nullifierSecret, electionId, ballotHash)`. It is spent once. The same proof posted twice still reverts `NullifierUsed`. A new choice has a new ballot hash, so it has a new submission id, the spent-key check does not fire, and the ballot is accepted. The contract does not keep a voter-to-ballot map. It does not store the previous submission id. It does not emit an event that names both.

There are two aggregates. They are not the same product.

- **Hourly POLL total.** This product is a running total. A first ballot multiplies `Enc(choice)` into it. A re-vote does not. The delta is left out. Decrypting a product that included `Enc(new) * Enc(old)^{-1}` can show a negative count on the old option, and that negative count is itself the news that someone switched. Each published hour is the difference between two posted running totals. An hour with fewer than 10 ballots is not published on its own; those ballots merge into the next posted total. Guardians decrypt that difference, and the published hour is then left as posted.
- **Final tally product.** First ballots and re-vote deltas both go into this other product. `Enc(new) * Enc(old)^{-1}` equals `Enc(new - old)`. Only this product is decrypted for the certified final tally.

Last-ballot-counts is that final product, proved in private:

- The counted ciphertext is exponential ElGamal of a one-hot vector.
- First ballot from a person: the device outputs a re-randomized `Enc(choice)` for both products. The unique-count step of one stays inside that proof. The sequencer's batch proof multiplies those contributions into the posted totals.
- Later ballot: the device outputs a re-randomized encryption of zero for the hourly product and a re-randomized `Enc(new - old)` for the final product. The unique-count step of zero stays inside that proof. The new ciphertext is appended. The old ciphertext stays in history and is not labeled as replaced. That proof does not publish the previous or next voter count, or the previous or next hourly total. The step is visible only as part of the batch's next count.
- The private witness shows either that this secret has no earlier ciphertext in the ballot set, or the opening of the actual previous ciphertext and that the same secret opens both. The previous index is not a public input. The nullifier secret is not a public input. A stranger who does not know the secret cannot cancel someone else's ciphertext.
- `acceptedBallots` stays the unique-voter count. The batch proof's public instance carries the previous unique count and the next unique count for the whole batch, plus the previous and next value of each product for the whole batch. Those words are batch inputs, not vote inputs, and they are not outputs of one voter's proof. Observers see that a new submission was accepted. They do not see which earlier row it replaced, and they do not see a negative option count in the hour.

### Who builds the proof

The sequencer builds this from per-ballot proofs. Each voter's device proves, in private, that its submission is either a first ballot or a valid replacement, and outputs a re-randomized contribution for each product. The batch prover never receives the nullifier secret or the prior opening.

The device is the only party that holds `nullifierSecret` and, on a re-vote, the opening of that voter's earlier ciphertext. Those values stay in the device proof. The device does not send the secret, the prior index, or the prior opening to the relayer, the operator, the guardians, or the sequencer. The relayer receives the same package as any other ballot: the five public inputs, the new ciphertext, and the per-ballot proof. That proof's public output is the re-randomized contribution for each product. It has no previous submission id.

The sequencer is the party that binds those contributions to the posted previous totals, once, inside one batch proof. A proof per ballot would publish, for a re-vote, that the next voter count and the next hourly total equal the previous ones, and two voters who each started from the same posted total would clash. The public previous and next values belong to the batch.

The device submits through the same relayer path as the first ballot, with no account attached. The proof does not link the re-vote. A reused connection can still tie the two deliveries together outside the proof. That is a property of the transport, not of the witness.

A published hourly block never changes. A re-vote's replacement is reflected only in the certified final tally.

Last-ballot-counts removes the first-ballot lock that today protects against coercion. A buyer can demand the voter's newest opening. The contract will not offer per-ballot openings. It also will not stop a voter who kept their randomness from showing that opening themselves.

### Circuit and the five public inputs

`Vote` keeps five public inputs, in the same positions: eligible root, disqualification root, nullifier, ballot hash, election id. `BallotInbox` keeps rejecting any other length. `submitVote` and `submitVoteBatch` keep that ABI. There is no sixth vote input.

What changes inside the vote circuit:

- The constraint on public input 2 is no longer `Poseidon(nullifierSecret, electionId)`. It is `Poseidon(nullifierSecret, electionId, ballotHash)`.
- `ballotHash` stays public input 3 (`Poseidon(choice, choiceRandomness)` in the circuit; the `AG` tag path on chain already treats that tag as the hash). Mixing it into the submission id does not add a public field.
- Eligibility, the disqualification root, and the election id are unchanged.
- The tally key, a re-vote flag, and the previous ballot hash are not added to this list. A public previous hash, or a reused nullifier, would link the two ballots.

What the vote circuit does not prove: that the ciphertext is ElGamal under the joint key, or that it cancels a prior ballot. The device's per-ballot proof does that, as specified above, and its public output is a re-randomized contribution for each product. The batch-transition circuit is the one the sequencer builds from those proofs. Its public instance is the batch's previous and next hourly product, the batch's previous and next final product, the batch's previous unique count, the batch's next unique count, and the ballot-set root. The instance does not include a voter id, the nullifier secret, the cancelled index, or a per-ballot statement that the hourly total was left unchanged.

`TallyPublicInputs` (seven words, version 2) stays the tally instance. Word 5 is one aggregate commitment. `circuits/tally.circom` still proves a plaintext histogram and does not match that instance. The production tally circuit proves that the decrypted product matches the posted counts, and that the decryption is of the aggregate only.

## Challenge window

Status: planned, awaiting approval.

Not written. A tally posted in the cutoff block can be ordered ahead of a ballot the relayer dropped. The planned check replaces the cutoff comparison in `_authorize` (today `if (block.timestamp < p.cutoffTime) revert ElectionNotClosed()`):

```solidity
if (block.timestamp < p.cutoffTime + _challengeWindow[electionId]) revert ChallengeWindowOpen(electionId);
```

`setChallengeWindow(uint256 electionId, uint64 secondsAfterCutoff)` is planned beside it:

- Caller is the tally operator.
- It must be called before `startTime`. At or after `startTime` it reverts.
- `secondsAfterCutoff == 0` reverts. A zero window is not stored.
- It writes `_challengeWindow[electionId]` once.
- `tallyAllowedAt(electionId)` is `cutoffTime + _challengeWindow[electionId]`.

`submitTally`, `submitAggregateTally`, and `submitDecryption` take that path through `_authorize`, so they wait out the window. The one post-cutoff interim write and the one post-cutoff disclosure write already require a posted tally, so they cannot land before the tally does.

- From cutoff until `tallyAllowedAt`, a ballot the relayer signed and then omitted can be included by anyone who holds the signature. The signature covers the submission id, the ballot hash, and the ciphertext hash. It is not a voter identity. The signer must be an allowlisted relayer.
- A replacement inside the window is a new submission id. The batch proof keeps the replaced ballot private. Turnout still does not increment for a replacement.
- At `tallyAllowedAt` the set freezes. Further ballots revert.
- The window is one configuration write, not a per-ballot signal. It does not hide turnout. Turnout is already public.

## Tally key

Not coded. Shamir sharing. Not a time-lock. The joint scalar is not reconstructed on chain and is not an event argument. POLL and VOTE do not share a key.

- **Setup.** Distributed Feldman sharing. Each guardian deals a polynomial of degree `k - 1`. No dealer holds the joint scalar. Bounds: `n` from 2 to 16, `k >= 2`, `k <= n`. Each election type gets its own joint public key, posted on the L2 before `startTime`. Ballots of that type are refused until its key is posted.
- **Share distribution.** Shares are encrypted to each guardian's transport key and kept off chain. The chain stores Feldman commitments only. The operator's database must not gain a copy of a share.
- **What is encrypted.** Choices are exponential ElGamal of a one-hot vector under that type's joint key, which is what makes `Enc(new) * Enc(old)^{-1}` a re-vote. POLL hourly sums are decrypted by a guardian k-of-n key separate from the VOTE key. The operator holds no opening key and never decrypts a single ballot. The POLL guardians decrypt the published hour only, and that hour is the difference between two posted running totals of the hourly product. That product leaves re-vote deltas out, so a published hour cannot show a negative count.
- **POLL hourly.** After the gate (100 ballots or the end), 30 minutes after each hour closes, POLL guardians submit partials of that hour's hourly product. These are not `submitDecryption` and do not touch the certified result.
- **Deadline.** Only at or after `tallyAllowedAt`, guardians submit partial decryptions of the final product, the one that includes re-vote deltas, each with a Chaum-Pedersen proof against that guardian's commitment. `k` valid partials combine, by Lagrange, to the plaintext counts. `submitDecryption` records a hash of those counts. It does not take the scalar. It does not take per-ballot openings.
- **Never publish the private key.** No function returns it, stores it, or emits it. Publishing it would open every ciphertext. After release, individual ballots stay ciphertext. A voter cannot point at the tally transaction and prove which choice was theirs. The tally output is the option totals.
- **What that does not hide.** A voter who retained the encryption randomness can still show an opening of their own ciphertext to someone else. The release does not create that proof, and it does not erase it. Receipt-freeness against a voter who kept the coins is a different ballot scheme. This plan does not add one.
- **Guardian loss.** Fewer than `k` partials means there is no result for that key. Do not lower `k` and do not add an operator override.
- **Early collusion.** Any `k` guardians who already hold shares of a key can decrypt that key's ciphertext on their own machines before its scheduled release, if they also have the ciphertext. For a published POLL hour that release is the gate in the POLL hourly bullet. For the final product it is `tallyAllowedAt`. The contract can refuse a partial before that release. It cannot take a share back. Fewer than `k` cannot. The POLL guardians cannot open the VOTE aggregate, and the VOTE guardians cannot open the POLL aggregate.

## Contract, ABI, and deployment changes

Later pull request, after this plan is confirmed. Nothing in this list is in the current diff. The challenge-window check quoted above is in this list and is not written.

| Surface | Change |
| --- | --- |
| `BallotInbox` | Spend the submission id once. Accept a second, different submission from the same person until cutoff. Do not key storage by the voter nullifier. Do not emit a replacement event. Append the new ciphertext commitment. Each ballot carries a per-ballot proof whose public output is a re-randomized contribution for each product. The sequencer's batch proof applies those contributions to both products and to the unique count. A re-vote's hourly contribution leaves the hourly plaintext unchanged and changes only the final product. Keep five public inputs. Keep the relayer check. |
| Batch transition | The sequencer builds this from per-ballot proofs. Each voter's device proves, in private, that its submission is either a first ballot or a valid replacement, and outputs a re-randomized contribution for each product. The batch prover never receives the nullifier secret or the prior opening. Verify the batch's hourly product in and out, the batch's final product in and out, the batch's previous unique count, the batch's next unique count, and the ballot-set root. The replaced ballot stays in the voter's witness. Set once, same pattern as `tallyProofVerifier`. |
| `Tally` | `setChallengeWindow` as specified under "Challenge window", rejecting 0 and reverting at or after `startTime`. `_authorize` uses `ChallengeWindowOpen` instead of comparing only to `cutoffTime`. Store guardian partials of the final product and require `k` valid partials before the decryption hash. POLL hourly partials are a separate path: they are not `submitDecryption` and they do not touch the certified result. Do not add a scalar argument or a scalar getter. The one post-cutoff interim write and the one post-cutoff disclosure write stay as they are on this branch, including `FinalBeforeTally`. |
| Ceremony storage | A contract for deals, commitments, `k`, and `n`, with a separate ceremony per election type. `createElection`'s tuple does not grow. `electionType` is already the last field. |
| `RollupSettlement` | Put that hour's ballot-set root and that hour's aggregate (the running total that leaves re-vote deltas out) inside `dataHash`. The final product, which includes those deltas, is not written into an earlier hour. Keep `dataLength` at 0 under the gas assumption below. The final batch is mandatory. Do not rewrite an earlier batch. |
| Vote circuit | Public input 2 becomes `Poseidon(nullifierSecret, electionId, ballotHash)`. Still five words. No new public input. |
| Tally circuit | Prove decryption of the final product against `TallyPublicInputs` version 2. The witness is shares of that product, not the joint scalar and not per-ballot openings. A published POLL hour is a separate decrypt of the difference between two posted running totals, and it is not `submitDecryption`. |
| Deploy scripts | Do not edit addresses or broadcast artifacts for this plan. A later release deploys the ceremony contract and the new verifier. Existing clones keep their bytecode until that release. |

No new `createElection` field.

## Gas

Assumptions, not a measurement. This repo has no Foundry gas snapshot for `submitBatch`. The civic JSON chain charges no gas.

- L1 scenario: about 250,000 gas for one settlement proof plus storage, about $10 at 10 gwei and $4,000 per ETH. Recheck ETH and the base fee before budgeting.
- Cadence: one such L1 batch per election hour, plus one final batch, plus one mirror post (about 40,000–100,000 gas) after decryption. A 10-hour election is about 11 settlement batches. A 24-hour election is about 25. The final batch is a normal short hour, not padded to 64.
- Bodies stay off L1. A 200-byte ciphertext is about 3,200 gas of calldata. Sixty-four of them are about 200,000 gas if a later decision puts bodies on L1. This plan does not.
- On the EVM inbox, a first ballot is on the order of two cold writes plus the root update, the event, and a Groth16 verify (on the order of 250,000 gas when the vote proof is checked there). A re-vote is a new submission id, so it is another cold write, not an overwrite of a public nullifier slot. The unique counter moves only when the sequencer's batch proof adds a step from a per-ballot proof. Guardians at the deadline: `k` partial transactions for the final product, then one `submitDecryption`. POLL hourly partials are separate transactions and are not `submitDecryption`. For `k = 3`, treat one key as well under one settlement batch.
- JSON sequencer cost stays a host. The final batch is one extra seal at `cutoffTime`. A published hour is not revised in place.

## Trust

- Turnout is public for both types, as the unique `acceptedBallots` count. This plan does not hide it. It also does not publish which submission replaced which.
- Choice totals for a VOTE stay hidden until `k` guardians decrypt the aggregate after the challenge window. The operator does not hold that scalar, and the chain never receives it.
- POLL hourly sums are decrypted by a guardian k-of-n key separate from the VOTE key. The operator holds no opening key and never decrypts a single ballot.
- `k` colluding guardians of one key can decrypt that key's aggregate early, off chain. Fewer than `k` cannot. Loss below `k` means no official result for that key.
- Individual ciphertexts are not decrypted by the release. The release is not a per-voter proof. A voter who kept ballot randomness can still open their own ciphertext.
- A published hourly block never changes. A re-vote's replacement is reflected only in the certified final tally.
- Last-ballot-counts lets a coercer demand the newest opening. The current first-ballot lock was the protection against that.
- The voter's per-ballot proof is what stops a stranger from cancelling someone else's ciphertext. The sequencer's batch proof checks those proofs and keeps the replaced ballot off the batch public inputs. Mock verifiers stay off for a binding election.
- An omitted ballot is detectable by the voter who holds the relayer receipt, and can be forced in until `tallyAllowedAt`. A zero window is rejected, because the tally could otherwise land in the same block as cutoff and skip that ballot.
- L1 roots do not contain ballot bodies. The L2 log has to be retained or a batch cannot be recomputed.

## What the app has to do

No app code in this pull request. After the plan is confirmed:

- Sequencer: one batch record for POLL and VOTE, on the hour, and one last batch at the deadline. Do not pad. Do not drop a short batch. Build the batch proof from per-ballot proofs. A second ballot before cutoff is a new submission id plus a re-randomized contribution, not a rejection and not a second voter. The sequencer does not receive the nullifier secret or the prior opening.
- Explorer: turnout is the unique count and is visible. A published hourly block never changes. A re-vote's replacement is reflected only in the certified final tally. VOTE choices appear only as the decrypted aggregate totals. Do not request the private key. Do not draw a per-ballot opening. Do not index a replacement event. There is not one.
- Diagnostics: no plaintext of a single ballot, including for an admin. No log of a Shamir share or of the joint scalar. No log that ties one submission id to a prior one.
- Relayer: five-input proofs, with public input 2 equal to `Poseidon(nullifierSecret, electionId, ballotHash)`. Sign a receipt at accept time so an omitted ballot can be forced in during the challenge window. Do not post partials or `submitDecryption` before `tallyAllowedAt`.
- Factory call: append `electionType` as the last `uint8` when talking to a factory that includes this branch.
- Guardians: two ceremonies, one for POLL hourly sums and one for the VOTE aggregate. Post each joint key before start. Hold shares off chain. POLL guardians submit partials of each published hour's hourly product after that hour's gate. Those partials are not `submitDecryption` and do not touch the certified result. Partials of the final product wait until after the window, and `submitDecryption` records that final tally. Do not upload the scalar. The operator does not hold a share.

The app gate beside this (100 ballots or the scheduled end, 30 minutes, merge-forward under 10) stays an app rule. The contract does not enforce it. Once an hour is published, the app leaves it. The certified final tally is a separate object.

## Out of this plan

Padding, dummy ballots, relayer-held ballots, commit-reveal, and a time-lock on the tally key are not in this plan. The joint scalar is not published. A public nullifier is not reused across a voter's ballots. Deployed addresses and submodules stay as they are. Contract code for the sections above, including the challenge window, waits for confirmation.
