# Poll and Vote batches

Status: sealed-vote batching from this document is in this diff, except deploy scripts and the app. When no settlement is linked, the inbox still increments `acceptedBallots` on each acceptance so an election that never enters the batch path keeps a unique count. When a settlement is linked, only an hourly batch and the supplementary batch write that count. The final batch does not. `rollupSettlement` unset means `_authorize` does not read `_supplementaryPosted`. When it is set, tally, decryption, and final partials require the flag.

Already coded, and not part of the plan below:

- `electionType` is the last `uint8` of `createElection` (`0` POLL, `1` VOTE). No setter.
- A VOTE cannot post a tally, a decryption, an interim hash, a disclosure, or a tally component before `cutoffTime` (`ResultsSealedUntilEnd`).
- A POLL may replace `postInterimResult` and `disclose` before cutoff. At or after cutoff each of those two hashes may be written **once**, even if a value was stored before cutoff, and only after a tally is posted (`FinalBeforeTally`). That write is the certified final value of that field. A second post-cutoff write reverts `ResultAlreadyFinal`. `submitDecryption` is write-once and requires a posted tally. `addTallyComponent` reverts `TallyComponentsClosed` at or after cutoff for both types. New ballots revert after cutoff for both types.

## Decided

1. POLL and VOTE use one batch record, one cadence, and visible turnout. No padded or dummy ballots.
2. Both types post one last L1 batch at the deadline, including when the last hour is short.
3. A voter may cast again, for both types, until `cutoffTime`. The latest ballot is the only one that counts. Each ballot spends its own submission id. Turnout counts unique voters. A published hour is not revised.
4. VOTE choices are encrypted to a public key posted on the L2. The private key is split Shamir k-of-n. Decryption releases only the aggregate total. The full private key is never published. Individual ballots stay undecryptable after that release, so the release is not a proof of one voter's choice. POLL hourly sums use a separate guardian key, described under "Tally key".
5. The tally waits out a nonzero challenge window after cutoff so an omitted ballot can be added back. That window is in this diff.

## Batch format and cadence

Defaults for the contracts in this diff:

| Knob | Value | Why |
| --- | --- | --- |
| Shared cadence | 1 hour (`disclosureInterval`; the app hour is 3600 seconds) | Same clock for both types. |
| Inbox batch cap | 64 ballots (`BallotInbox.MAX_VOTE_BATCH`) | Existing calldata bound. An hour may be several transactions. |
| Record | Groth16 proof, five public inputs, one ciphertext | Same bytes for POLL and VOTE. |
| Turnout | `acceptedBallots`, public the whole window, last step at `tallyAllowedAt` | Unique voters. A replacement does not increment it. No padding. The unique count is written only at batch time. The final batch carries no turnout step. |
| Final batch | Always, at `cutoffTime` | The tail is real. A short tail shows its real row count. The final batch carries no turnout step. It writes the product and the root at `cutoffTime` and defers the unique-count write. |
| L1 during the election | One `RollupSettlement.submitBatch` per hour, plus the final batch, plus exactly one supplementary batch at `tallyAllowedAt`, empty if nothing was forced in | That hour's ballot-set root and that hour's aggregate, the running total that leaves re-vote deltas out. Bodies stay on the L2. `postInterimResult` is not this record. |
| POLL choice publication | App gate, then a sealed hour | Sums wait for 100 ballots or the end, then 30 minutes. Hours under 10 merge forward. A published hourly block never changes. A re-vote's replacement is reflected only in the certified final tally. |

`postInterimResult` (`Tally.sol` lines 199–206) stores one hash, `_interimHash`. Before cutoff a POLL may replace that slot on every call. It is not a per-hour record. The per-hour guarantee is a `RollupSettlement` batch. `submitBatch` appends one `batchIndex` and does not rewrite an earlier one.

`RollupSettlement.computeDataHash` is `keccak256(abi.encode(batchIndex, prevStateRoot, newStateRoot))`. `submitBatch` stores `dataLength = 0`. Neither commits to ballots or to an aggregate today. The later change puts that hour's ballot-set root and that hour's aggregate commitment inside `dataHash`. The hour's aggregate is the one that leaves re-vote deltas out, defined below. A published hourly block never changes. A re-vote's replacement is reflected only in the certified final tally.

The JSON sequencer (chain id 27427) has no gas token. Voters pay nothing. The EVM contracts are the settlement path and the Foundry inbox.

## Re-vote, without a public nullifier

Today `BallotInbox._checkOne` reduces public input 2 into the field and stores it in `_nullifierUsed`. A second `submitVote` or batch entry with that value reverts `NullifierUsed`, including when the ciphertext is new. `_recordAcceptance` stores the ballot hash, appends it, updates the append-only `ballotRoot`, increments `acceptedBallots`, and emits `VoteAccepted`. The vote circuit sets public input 2 to `Poseidon(nullifierSecret, electionId)`, so it is the same value for every ballot that person casts in that election. When a settlement is linked, the unique count is written only at batch time. The final batch does not write it. When no settlement is linked, each acceptance still increments the count.

That permanent voter lock is what changes, for POLL and for VOTE, until `cutoffTime`. After cutoff, `OutsideVotingWindow` still rejects a new ballot, except an omitted ballot that was cast before cutoff and is brought back inside the challenge window below. A new re-vote after cutoff is rejected. Re-voting is allowed only until the deadline.

The plan does **not** reuse one public nullifier for both ballots. It does **not** emit `BallotReplaced(electionId, nullifier, newBallotHash)`. A stranger must not be able to match the two ballots.

### On-chain mechanism

Public input 2 becomes a **submission id**: `Poseidon(nullifierSecret, electionId, ballotHash)`. It is spent once. The same proof posted twice still reverts `NullifierUsed`. A new choice has a new ballot hash, so it has a new submission id, the spent-key check does not fire, and the ballot is accepted. The contract does not keep a voter-to-ballot map. It does not store the previous submission id. It does not emit an event that names both.

There are two aggregates. They are not the same product.

- **Hourly POLL total.** This product is a running total. A first ballot multiplies `Enc(choice)` into it. A re-vote does not. The delta is left out. Decrypting a product that included `Enc(new) * Enc(old)^{-1}` can show a negative count on the old option, and that negative count is itself the news that someone switched. Each published hour is the difference between two posted running totals. An hour with fewer than 10 ballots is not published on its own; those ballots merge into the next posted total. Here, ballots means first ballots. The turnout merge-forward rule counts all submissions. Guardians decrypt that difference, and the published hour is then left as posted.
- **Final tally product.** First ballots and re-vote deltas both go into this other product. `Enc(new) * Enc(old)^{-1}` equals `Enc(new - old)`. Only this product is decrypted for the certified final tally.

Last-ballot-counts is that final product, proved in private:

- The counted ciphertext is exponential ElGamal of a one-hot vector.
- First ballot from a person: the device outputs a re-randomized `Enc(choice)` for both products. The unique-count step of one stays inside that proof. The sequencer's batch proof multiplies those contributions into the posted totals.
- Later ballot: the device outputs a re-randomized encryption of zero for the hourly product and a re-randomized `Enc(new - old)` for the final product. The unique-count step of zero stays inside that proof. The new ciphertext is appended. The old ciphertext stays in history and is not labeled as replaced. That proof does not publish the previous or next voter count, or the previous or next hourly total. The step is visible only as part of the batch's next count.
- The private witness shows either that this secret has no earlier ciphertext in the ballot set, or the opening of the actual previous ciphertext and that the same secret opens both. The previous index is not a public input. The nullifier secret is not a public input. A stranger who does not know the secret cannot cancel someone else's ciphertext.
- `acceptedBallots` stays the unique-voter count. The batch proof's public instance carries the previous unique count and the next unique count for the whole batch, plus the previous and next value of each product for the whole batch. Those words are batch inputs, not vote inputs, and they are not outputs of one voter's proof. Observers see that a new submission was accepted. They do not see which earlier row it replaced, and they do not see a negative option count in the hour. The sequencer learns whether each ballot is a first vote or a re-vote, but not which ballot it replaces. Publicly this shows only through turnout, which merges forward when an hour has fewer than 10 submissions. The final batch at `cutoffTime` carries no turnout step. Its step and any merged-forward remainder are published once, in the supplementary batch at `tallyAllowedAt`. If that combined step is still under 10 submissions it is published as is; this is the one place a small step can show.

### Who builds the proof

The sequencer builds this from per-ballot proofs. Each voter's device proves, in private, that its submission is either a first ballot or a valid replacement, and outputs a re-randomized contribution for each product. The batch prover never receives the nullifier secret or the prior opening.

The device is the only party that holds `nullifierSecret` and, on a re-vote, the opening of that voter's earlier ciphertext. Those values stay in the device proof. The device does not send the secret, the prior index, or the prior opening to the relayer, the operator, the guardians, or the sequencer. The relayer receives the same package as any other ballot: the five public inputs, the new ciphertext, and the per-ballot proof. That proof's public output is the re-randomized contribution for each product. The bound root is a public input of the per-ballot proof. It is not one of the vote circuit's five public inputs. The proof has no previous submission id.

The sequencer is the party that binds those contributions to the posted previous totals, once, inside one batch proof. A proof per ballot would publish, for a re-vote, that the next voter count and the next hourly total equal the previous ones, and two voters who each started from the same posted total would clash. The public previous and next values belong to the batch.

Two first-ballot proofs from the same secret in one batch must not both count. A per-ballot proof binds to the root posted at the last hourly batch. The batch proof catches duplicate first ballots within that batch. A batch is the whole hour, across all its inbox transactions, and is proved once. A proof whose bound root goes stale is re-made against the new root, as a first ballot or a replacement according to the ballot set at that root. A re-vote in the same hour as the first vote is held by the device and re-proved by the device as a replacement against the next hourly root. The sequencer does not hold it and learns nothing new from the hold. The app shows that re-vote as pending until the next hour's batch includes it, and warns the voter at hold time. If the device does not return before `tallyAllowedAt`, the held re-vote does not count and the earlier ballot stands. A re-vote held in the final hour is re-proved against the final batch root and carried by the supplementary batch. It counts as cast before cutoff because its relayer receipt is dated before `cutoffTime`. There is no public linking tag. A proof whose bound root is not the last hourly batch root is rejected. A forced-in ballot is the exception: it is checked against the root named in its relayer receipt, and the supplementary batch proof re-checks duplicates and replacements against the later roots.

The device submits through the same relayer path as the first ballot, with no account attached. The proof does not link the re-vote. A reused connection can still tie the two deliveries together outside the proof. That is a property of the transport, not of the witness.

A published hourly block never changes. A re-vote's replacement is reflected only in the certified final tally.

Last-ballot-counts removes the first-ballot lock that today protects against coercion. A buyer can demand the voter's newest opening. The contract will not offer per-ballot openings. It also will not stop a voter who kept their randomness from showing that opening themselves.

### Circuit and the five public inputs

`Vote` keeps five public inputs, in the same positions: eligible root, disqualification root, nullifier, ballot hash, election id. `BallotInbox` keeps rejecting any other length. `submitVote` and `submitVoteBatch` keep that ABI. There is no sixth vote input. The bound root is a public input of the per-ballot proof. It is not one of the vote circuit's five public inputs.

What changes inside the vote circuit:

- The constraint on public input 2 is no longer `Poseidon(nullifierSecret, electionId)`. It is `Poseidon(nullifierSecret, electionId, ballotHash)`. This tree's Poseidon permutation takes two inputs (`t = 3`), so the circuit computes that id as `Poseidon(Poseidon(nullifierSecret, electionId), ballotHash)`.
- `ballotHash` stays public input 3 (`Poseidon(choice, choiceRandomness)` in the circuit; the `AG` tag path on chain already treats that tag as the hash). Mixing it into the submission id does not add a public field.
- Eligibility, the disqualification root, and the election id are unchanged.
- The tally key, a re-vote flag, and the previous ballot hash are not added to this list. A public previous hash, or a reused nullifier, would link the two ballots.

What the vote circuit does not prove: that the ciphertext is ElGamal under the joint key, or that it cancels a prior ballot. The device's per-ballot proof does that, as specified above, and its public output is a re-randomized contribution for each product. The batch-transition circuit is the one the sequencer builds from those proofs. Its public instance is the batch's previous and next hourly product, the batch's previous and next final product, the batch's previous unique count, the batch's next unique count, and the ballot-set root. The instance does not include a voter id, the nullifier secret, the canceled index, or a per-ballot statement that the hourly total was left unchanged.

`TallyPublicInputs` (seven words, version 2) stays the tally instance. Word 5 is one aggregate commitment. `circuits/tally.circom` still proves a plaintext histogram and does not match that instance. The production tally circuit proves that the decrypted product matches the posted counts, and that the decryption is of the aggregate only.

## Challenge window

Status: in this diff.

A tally posted in the cutoff block can be ordered ahead of a ballot the relayer dropped. The check in `_authorize` is:

```solidity
if (block.timestamp < p.cutoffTime + _challengeWindow[electionId]) revert ChallengeWindowOpen(electionId);
```

`setChallengeWindow(uint256 electionId, uint64 secondsAfterCutoff)` is beside it:

- Caller is the tally operator.
- It must be called before `startTime`. At or after `startTime` it reverts.
- `secondsAfterCutoff == 0` reverts. A zero window is not stored.
- It writes `_challengeWindow[electionId]` once.
- `tallyAllowedAt(electionId)` is `cutoffTime + _challengeWindow[electionId]`.

`submitTally`, `submitAggregateTally`, and `submitDecryption` take that path through `_authorize`, so they wait out the window. The one post-cutoff interim write and the one post-cutoff disclosure write already require a posted tally, so they cannot land before the tally does. They also require the supplementary batch below.

At `tallyAllowedAt` the set freezes. The sequencer then posts exactly one supplementary batch, empty if nothing was forced in. It updates only the final product and the unique count, with no hourly block changes. The final batch at `cutoffTime` carries no turnout step. Its step and any merged-forward remainder are published once, in this supplementary batch. `submitTally`, `submitAggregateTally`, `submitDecryption` and the guardians' final partials require that batch to be posted and use the product it leaves. `RollupSettlement` records the post in `_supplementaryPosted[electionId]`. `_authorize` reads that flag when `rollupSettlement` is set. An election that never linked a settlement does not take this path.

`SUPPLEMENTARY_GRACE` is 1 hour, the same length as one hourly batch. If the sequencer has not posted the supplementary batch within that grace after `tallyAllowedAt`, anyone may post it with a valid batch proof. One hour is long enough for an honest sequencer to land the batch and short enough that a stall cannot hold the tally for longer than one missed hour.

- From cutoff until `tallyAllowedAt`, a ballot the relayer signed and then omitted can be included by anyone who holds the signature. The signature covers the submission id, the ballot hash, and the ciphertext hash. It is not a voter identity. The signer must be an allowlisted relayer. Force-in is accepted while `block.timestamp < tallyAllowedAt`. At or after it, the call reverts. Each forced-in ballot is checked against the root named in its relayer receipt. The supplementary batch proof re-checks duplicates and replacements against the later roots.
- A forced-in omitted ballot may itself be a replacement cast before cutoff. It is still a new submission id. Re-voting is allowed only until the deadline. The window does not accept a re-vote whose relayer receipt is dated after `cutoffTime`.
- Further ballots revert once the set has frozen.
- The window is one configuration write, not a per-ballot signal. It does not hide turnout. Turnout is already public.

## Tally key

On chain in this diff: Feldman public keys, the `k` and `n` bounds, and the Chaum-Pedersen check on a guardian partial. Shamir sharing itself stays off chain. Not a time-lock. The joint scalar is not reconstructed on chain and is not an event argument. POLL and VOTE do not share a key.

- **Setup.** Distributed Feldman sharing. Each guardian deals a polynomial of degree `k - 1`. No dealer holds the joint scalar. Bounds: `n` from 2 to 16, `k >= 2`, `k <= n`. Each election type gets its own joint public key, posted on the L2 before `startTime`. Ballots of that type are refused until its key is posted.
- **Share distribution.** Shares are encrypted to each guardian's transport key and kept off chain. The chain stores Feldman commitments only. The operator's database must not gain a copy of a share.
- **What is encrypted.** Choices are exponential ElGamal of a one-hot vector under that type's joint key, which is what makes `Enc(new) * Enc(old)^{-1}` a re-vote. POLL hourly sums are decrypted by a guardian k-of-n key separate from the VOTE key. The operator holds no opening key and never decrypts a single ballot. The POLL guardians decrypt the published hour only, and that hour is the difference between two posted running totals of the hourly product. That product leaves re-vote deltas out, so a published hour cannot show a negative count.
- **POLL hourly.** After the gate (100 ballots or the end), 30 minutes after each hour closes, POLL guardians submit partials of that hour's hourly product. These are not `submitDecryption` and do not touch the certified result.
- **Deadline.** Only at or after `tallyAllowedAt`, and only after the supplementary batch is posted, guardians submit partial decryptions of the final product, the one that includes re-vote deltas, each with a Chaum-Pedersen proof against that guardian's commitment. `k` valid partials combine, by Lagrange, to the plaintext counts. `submitDecryption` records a hash of those counts. It does not take the scalar. It does not take per-ballot openings. Until a ceremony is posted for that election, `submitDecryption` stays the write-once hash it is on an election with no guardians.
- **Never publish the private key.** No function returns it, stores it, or emits it. Publishing it would open every ciphertext. After release, individual ballots stay ciphertext. A voter cannot point at the tally transaction and prove which choice was theirs. The tally output is the option totals.
- **What that does not hide.** A voter who retained the encryption randomness can still show an opening of their own ciphertext to someone else. The release does not create that proof, and it does not erase it. Receipt-freeness against a voter who kept the coins is a different ballot scheme. This plan does not add one.
- **Guardian loss.** Fewer than `k` partials means there is no result for that key. Do not lower `k` and do not add an operator override.
- **Early collusion.** Any `k` guardians who already hold shares of a key can decrypt that key's ciphertext on their own machines before its scheduled release, if they also have the ciphertext. For a published POLL hour that release is the gate in the POLL hourly bullet. For the final product it is `tallyAllowedAt`. The contract can refuse a partial before that release. It cannot take a share back. Fewer than `k` cannot. The POLL guardians cannot open the VOTE aggregate, and the VOTE guardians cannot open the POLL aggregate.

## Contract, ABI, and deployment changes

The challenge-window check, the supplementary batch, and the ceremony partials are in this diff. Deploy scripts in this list are not.

| Surface | Change |
| --- | --- |
| `BallotInbox` | Spend the submission id once. Accept a second, different submission from the same person until cutoff. Do not key storage by the voter nullifier. Do not emit a replacement event. Append the new ciphertext commitment. Each ballot carries a per-ballot proof whose public output is a re-randomized contribution for each product. The sequencer's batch proof applies those contributions to both products and to the unique count. A re-vote's hourly contribution leaves the hourly plaintext unchanged and changes only the final product. Keep five public inputs. Keep the relayer check. |
| Batch transition | The sequencer builds this from per-ballot proofs. Each voter's device proves, in private, that its submission is either a first ballot or a valid replacement, and outputs a re-randomized contribution for each product. The batch prover never receives the nullifier secret or the prior opening. Each per-ballot proof binds to the root posted at the last hourly batch. The batch proof catches duplicate first ballots from the same secret in that batch. A proof whose bound root is not the last hourly batch root is rejected. A proof whose bound root goes stale is re-made against the new root, as a first ballot or a replacement according to the ballot set at that root. A batch is the whole hour, across all its inbox transactions, and is proved once. A re-vote in the same hour as the first vote is held by the device and re-proved by the device as a replacement against the next hourly root. If the device does not return before `tallyAllowedAt`, the held re-vote does not count and the earlier ballot stands. In the final hour, the held re-vote is re-proved against the final batch root and carried by the supplementary batch. It counts as cast before cutoff because its relayer receipt is dated before `cutoffTime`. A forced-in ballot is checked against the root named in its relayer receipt, and the supplementary proof re-checks duplicates and replacements against the later roots. Verify the batch's hourly product in and out, the batch's final product in and out, the batch's previous unique count, the batch's next unique count, and the ballot-set root. The replaced ballot stays in the voter's witness. Set once, same pattern as `tallyProofVerifier`. |
| `Tally` | `setChallengeWindow` as specified under "Challenge window", rejecting 0 and reverting at or after `startTime`. `_authorize` uses `ChallengeWindowOpen` instead of comparing only to `cutoffTime`. Store guardian partials of the final product and require `k` valid partials before the decryption hash. POLL hourly partials are a separate path: they are not `submitDecryption` and they do not touch the certified result. Do not add a scalar argument or a scalar getter. The one post-cutoff interim write and the one post-cutoff disclosure write stay as they are on this branch, including `FinalBeforeTally`. The supplementary batch, the grace, and the `_supplementaryPosted` check are specified under "Challenge window". That batch is not the one post-cutoff interim write. |
| POLL hourly partials | Stored and checked on `Tally` in `_hourlyPartial[electionId][hourIndex][guardian]`, with the Chaum-Pedersen proof stored beside the partial. The check is against that guardian's ceremony commitment and against that hour's hourly product. This path is separate from the one post-cutoff interim write. It does not write `_interimHash` and it does not call `postInterimResult` or `submitDecryption`. |
| Ceremony storage | A contract for deals, commitments, `k`, and `n`, with a separate ceremony per election type. `createElection`'s tuple does not grow. `electionType` is already the last field. |
| `RollupSettlement` | Put that hour's ballot-set root and that hour's aggregate (the running total that leaves re-vote deltas out) inside `dataHash`. The final product, which includes those deltas, is not written into an earlier hour. Keep `dataLength` at 0 under the gas assumption below. The final batch is mandatory and carries no turnout step. Do not rewrite an earlier batch. Record the supplementary batch in `_supplementaryPosted[electionId]`, as specified under "Challenge window". |
| Vote circuit | Public input 2 becomes `Poseidon(nullifierSecret, electionId, ballotHash)`. Still five words. No new public input. The bound root is a public input of the per-ballot proof, not of this circuit. |
| Tally circuit | Prove decryption of the final product against `TallyPublicInputs` version 2. The witness is shares of that product, not the joint scalar and not per-ballot openings. A published POLL hour is a separate decrypt of the difference between two posted running totals, and it is not `submitDecryption`. |
| Deploy scripts | Do not edit addresses or broadcast artifacts for this plan. A later release deploys the ceremony contract and the new verifier. Existing clones keep their bytecode until that release. |

No new `createElection` field.

## Gas

Assumptions, not a measurement. This repo has no Foundry gas snapshot for `submitBatch`. The civic JSON chain charges no gas.

- L1 scenario: about 250,000 gas for one settlement proof plus storage, about $10 at 10 gwei and $4,000 per ETH. Recheck ETH and the base fee before budgeting.
- Cadence: one such L1 batch per election hour, plus the final batch, plus the supplementary batch under "Challenge window", plus one mirror post (about 40,000–100,000 gas) after decryption. A 10-hour election is about 12 settlement batches. A 24-hour election is about 26. The final batch is a normal short hour, not padded to 64, and it carries no turnout step.
- Bodies stay off L1. A 200-byte ciphertext is about 3,200 gas of calldata. Sixty-four of them are about 200,000 gas if a later decision puts bodies on L1. This plan does not.
- On the EVM inbox, a first ballot is on the order of two cold writes plus the root update, the event, and a Groth16 verify (on the order of 250,000 gas when the vote proof is checked there). A re-vote is a new submission id, so it is another cold write, not an overwrite of a public nullifier slot. The unique counter moves only when the sequencer's batch proof adds a step from a per-ballot proof. Guardians at the deadline: `k` partial transactions for the final product, then one `submitDecryption`. POLL hourly partials are separate transactions and are not `submitDecryption`. For `k = 3`, treat one key as well under one settlement batch.
- JSON sequencer cost stays a host. The final batch is one extra seal at `cutoffTime`. It writes the product and the root and carries no turnout step. The unique-count write is published once, in the supplementary batch at `tallyAllowedAt`. A published hour is not revised in place.

## Trust

- Turnout is public for both types, as the unique `acceptedBallots` count. This plan does not hide it. It also does not publish which submission replaced which. An hour's turnout step publishes only with 10 or more submissions. Otherwise it merges forward. An hour with a single re-vote must not reveal that it was a re-vote. The final batch at `cutoffTime` carries no turnout step. Its step and any merged-forward remainder are published once, in the supplementary batch at `tallyAllowedAt`. If that combined step is still under 10 submissions it is published as is; this is the one place a small step can show. In that step, submissions minus the turnout step shows how many of those last submissions were re-votes. Submissions minus the turnout step reveals each hour's re-vote total.
- Choice totals for a VOTE stay hidden until `k` guardians decrypt the aggregate after the challenge window. The operator does not hold that scalar, and the chain never receives it.
- POLL hourly sums are decrypted by a guardian k-of-n key separate from the VOTE key. The operator holds no opening key and never decrypts a single ballot.
- `k` colluding guardians of one key can decrypt that key's aggregate early, off chain. Fewer than `k` cannot. Loss below `k` means no official result for that key.
- Individual ciphertexts are not decrypted by the release. The release is not a per-voter proof. A voter who kept ballot randomness can still open their own ciphertext.
- A published hourly block never changes. A re-vote's replacement is reflected only in the certified final tally. The supplementary batch is the one under "Challenge window".
- Last-ballot-counts lets a coercer demand the newest opening. The current first-ballot lock was the protection against that.
- The voter's per-ballot proof is what stops a stranger from canceling someone else's ciphertext. The sequencer's batch proof checks those proofs and keeps the replaced ballot off the batch public inputs. Mock verifiers stay off for a binding election.
- An omitted ballot is detectable by the voter who holds the relayer receipt, and can be forced in until `tallyAllowedAt`. A zero window is rejected, because the tally could otherwise land in the same block as cutoff and skip that ballot.
- L1 roots do not contain ballot bodies. The L2 log has to be retained or a batch cannot be recomputed.

## What the app has to do

No app code in this pull request. After the plan is confirmed:

- Sequencer: one batch record for POLL and VOTE, on the hour, and one last batch at the deadline. Do not pad. Do not drop a short batch. Build the batch proof from per-ballot proofs. A second ballot before cutoff is a new submission id plus a re-randomized contribution, not a rejection and not a second voter. The sequencer does not receive the nullifier secret or the prior opening. Post the supplementary batch at `tallyAllowedAt`. After `SUPPLEMENTARY_GRACE`, anyone may post it.
- Voter device: hold a same-hour re-vote and re-prove it against the next hourly root. Show it as pending until that batch includes it. Warn at hold time that if the device does not return before `tallyAllowedAt`, the held re-vote does not count and the earlier ballot stands. App code for that warning is out of scope here.
- Explorer: turnout is the unique count and is visible. A published hourly block never changes. A re-vote's replacement is reflected only in the certified final tally. VOTE choices appear only as the decrypted aggregate totals. Do not request the private key. Do not draw a per-ballot opening. Do not index a replacement event. There is not one.
- Diagnostics: no plaintext of a single ballot, including for an admin. No log of a Shamir share or of the joint scalar. No log that ties one submission id to a prior one.
- Relayer: five-input proofs, with public input 2 equal to `Poseidon(nullifierSecret, electionId, ballotHash)`. Sign a receipt at accept time so an omitted ballot can be forced in during the challenge window. Do not post partials of the final product, or `submitDecryption`, before `tallyAllowedAt`.
- Factory call: append `electionType` as the last `uint8` when talking to a factory that includes this branch.
- Guardians: two ceremonies, one for POLL hourly sums and one for the VOTE aggregate. Post each joint key before start. Hold shares off chain. POLL guardians submit partials of each published hour's hourly product after that hour's gate. Those partials are not `submitDecryption` and do not touch the certified result. Partials of the final product wait until after the window, and `submitDecryption` records that final tally. Do not upload the scalar. The operator does not hold a share.

The app gate beside this (100 ballots or the scheduled end, 30 minutes, merge-forward under 10) stays an app rule. The contract does not enforce it. Once an hour is published, the app leaves it. The certified final tally is a separate object.

## Out of this plan

Padding, dummy ballots, relayer-held ballots, commit-reveal, and a time-lock on the tally key are not in this plan. The joint scalar is not published. A public nullifier is not reused across a voter's ballots. Deployed addresses and submodules stay as they are. App code for the pending re-vote warning is out of scope here.
