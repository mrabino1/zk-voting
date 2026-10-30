# SUPERSEDED

This note is not the spec. The sealed VOTE path that followed it is [sealed-vote-hold.md](sealed-vote-hold.md). Ballots stay off chain until cutoff and are revealed then. Turnout is not knowable on chain before that. Re-voting was not adopted. `NullifierUsed` still spends a nullifier once. The text below is the earlier scope and is kept only as history.

# Sealed batches, re-votes, and the tally key

Status: **superseded**. Do not implement this note.

Already on this branch, and not waiting on this note:

- `submitDecryption`, `postInterimResult`, and `disclose` are write-once at or after `cutoffTime`. A POLL may still replace an interim hash or a disclosure hash **before** cutoff. `submitDecryption` also requires a posted tally.

## Decided

1. POLL and VOTE use one batch format and one cadence.
2. A voter may cast again, for **both** types, until `cutoffTime`. The latest ballot is the only one that counts.
3. That second ballot **replaces** today's `NullifierUsed` revert. The revert stays only as replay protection for one identical submission.
4. Published POLL blocks are a **running picture**. A later re-vote may change sums that were already shown. Those sums are not required to equal the certified tally.
5. The certified tally at close is **final**. It counts each voter's last ballot and does not publicly link one voter's ballots.
6. VOTE choices are encrypted to a public key posted on the L2. The private key is split Shamir k-of-n among guardians. Decrypt and publish choices only at the deadline.
7. Both types post one last L1 batch at the deadline, even when the hour is short. No padded or dummy ballots.

Two turnout questions are still open. They are at the end of this note. Nothing else in this list is optional.

## Batch format and cadence

Proposed defaults for the later change, not code:

| Knob | Value | Why |
| --- | --- | --- |
| Shared cadence | 1 hour (`disclosureInterval` / the app hour) | Same clock the app already uses for disclosure. |
| Inbox batch cap | 64 ballots (`BallotInbox.MAX_VOTE_BATCH`) | Existing calldata bound. An hour may contain several transactions. |
| Final batch | Always, at `cutoffTime` | Covers the tail. No padding. A short tail shows its real row count. |
| L1 during the election | One `RollupSettlement.submitBatch` per hour, plus the final batch | Roots and the aggregate commitment. Ballot bodies stay on the L2. |
| POLL choice publication | The app gate, then a running picture | Sums wait for 100 ballots or the end, then 30 minutes. Hours under 10 merge forward. After publication, a re-vote can still move the picture. |

A batch body is an ordered list of the same record for both types: Groth16 proof, the five vote public inputs, and one ciphertext. POLL and VOTE differ in who can open that ciphertext (section "Tally key").

`RollupSettlement` today stores `dataLength = 0`. `computeDataHash` is `keccak256(abi.encode(batchIndex, prevStateRoot, newStateRoot))`. It does not commit to ballots or to an aggregate. A later change folds the hour's ballot-set root and the running aggregate commitment into `dataHash`. Bodies stay off L1 under the gas assumption below. An old L1 batch is not rewritten when a re-vote moves the running picture. The next batch, and the app's published view, carry the new aggregate.

The JSON sequencer (chain id 27427) has no gas token. Voters still pay nothing. The EVM contracts are the settlement path and the Foundry inbox.

## What replaces `NullifierUsed`

Today, in `BallotInbox._checkOne`, public input 2 is reduced into the field and stored in `_nullifierUsed`. A second `submitVote` or batch entry with that same value reverts `NullifierUsed`, including when the ciphertext is new. `_recordAcceptance` then stores only the ballot hash, appends it, updates `ballotRoot`, increments `acceptedBallots`, and emits `VoteAccepted`. The ciphertext bytes are not kept. The vote circuit sets that public input to `Poseidon(nullifierSecret, electionId)`, so it is the same value for every ballot that person casts in that election. The contract comment says this is not last-ballot-counts.

That lock is the thing that changes, for POLL and for VOTE, until `cutoffTime`. After cutoff, `OutsideVotingWindow` still rejects every new ballot of either type. Re-votes do not continue past the deadline.

Keeping `NullifierUsed` as a voter lock rejects the second ballot, so it cannot implement this decision. Overwriting a storage slot keyed by that same public value would accept the second ballot, but anyone could match the two transactions by the nullifier. Adding every ciphertext into one sum would accept the second ballot and would not link the voter, but both choices would count. None of those three match "last ballot counts" and "no public link" together.

### On-chain mechanism

Public input 2 becomes a **submission id**: `Poseidon(nullifierSecret, electionId, ballotHash)`. It is still spent once. The same proof posted twice still reverts `NullifierUsed`. A new choice has a new ballot hash, so it has a new submission id, the spent-key check does not fire, and the ballot is accepted. The contract does not keep a voter-to-ballot map, and it does not emit the previous submission id.

Last-ballot-counts is the running aggregate, not the spent key:

- The counted ciphertext is exponential ElGamal of a one-hot vector under the election's tally key. `Enc(new) * Enc(old)^{-1}` equals `Enc(new - old)`. The hybrid P-256 ECDH plus AES-GCM envelope used by the current guardian demo is not homomorphic, so it cannot be the counted body.
- First ballot from a person: the contract multiplies `Enc(choice)` into the running aggregate.
- Later ballot: the contract multiplies in the delta only. The previous choice drops out of the product. The new ciphertext is appended for audit. The old ciphertext stays in history and is not deleted.
- The batch-transition proof, not `BallotInbox`'s nullifier map, enforces "this voter has only one current choice." Private witness shows either that this secret has no earlier ciphertext in the ballot set, or the opening of the actual previous ciphertext and that the same secret opens both. The previous index is not a public input. A stranger who does not know the secret cannot cancel someone else's ciphertext.
- On-chain state after each accepted batch is the new aggregate commitment, the appended submission, and the ballot-set root. Observers see that the aggregate moved. They do not see which earlier row was cancelled.

`acceptedBallots` as it exists today counts submissions, because it increments on every acceptance. Whether the **published** turnout number stays that way or becomes a unique-voter count is an open decision below. The aggregate math does not depend on that choice.

### Circuit and the five public inputs

`Vote(levels)` keeps five public inputs, in this order: eligible root, disqualification root, nullifier, ballot hash, election id. `BallotInbox` rejects any other length. `submitVote` and `submitVoteBatch` keep that ABI.

What changes inside the vote circuit:

- The nullifier constraint is no longer `Poseidon(nullifierSecret, electionId)`. It is `Poseidon(nullifierSecret, electionId, ballotHash)`.
- `ballotHash` stays `Poseidon(choice, choiceRandomness)` and stays public input 3. The `AG` prefix path already treats that tag as the hash.
- Eligibility, the disqualification gap, and the election id are unchanged.
- No sixth vote input. The tally key, a re-vote flag, and the previous ballot root are not added to this list. Putting any of them there would publish a handle that links the two ballots, or would change the five-input ABI.

What the vote circuit does **not** prove: that the ciphertext is ElGamal under the joint key, or that it cancels a prior ballot. That is a new batch-transition circuit. Its public instance is the previous aggregate, the new aggregate, and the ballot-set root. It does not include a voter id or the cancelled index. If Matthew chooses unique-voter turnout, this instance also carries the previous and next unique counts. Those two words wait on that decision. They are not vote public inputs.

`TallyPublicInputs` (seven words, version 2) stays the tally instance. Word 5 is already one aggregate commitment, not a list of openings. `circuits/tally.circom` still proves a plaintext histogram and does not match that instance. The production tally circuit has to prove that the decrypted product matches the posted counts. That is part of the later change.

### POLL blocks are a running picture

The app gate is unchanged: publish choice sums after 100 ballots or the scheduled end, then wait 30 minutes (`DISCLOSURE_DELAY_SECONDS` 1800), and merge an hour with fewer than 10 new submissions forward (`DISCLOSURE_MIN_BLOCK_VOTES` 10). The contract does not enforce that gate. Before cutoff, this branch still allows the operator to replace the interim hash.

Once a block's sums have been shown, they are still a running picture:

- A re-vote later updates the displayed histogram (previous choice leaves, new choice enters), including sums that were already published.
- The update is the new histogram only. It does not name a ballot, a submission id, or a voter, and it does not say which earlier row changed.
- An hour that is only replacements still merges forward when it has fewer than 10 new submissions, so one switch is not forced out as its own tick. When the merged picture is published, or when an already published picture is revised, the totals may move by one. That is an aggregate fact.
- A published block's sums are **not** promised to equal the certified tally. Later re-votes are allowed to move them. The old promise that each sealed hour's counts add up to the final tally does not hold for intermediate blocks.
- The L1 batch that anchored the previous aggregate is left in place. The app view moves. The chain does not edit that batch.

At `cutoffTime` the picture stops moving. New ballots revert. The interim hash, the disclosure hash, and the decryption hash are write-once from this branch. The certified tally is that frozen latest-only aggregate.

This drops the coercion slice in the current `BallotInbox` comment. A buyer can ask for the newest opening. That follows from last-ballot-counts. It is not a separate option.

### Certified tally and the final L1 batch

At the deadline the running aggregate contains each voter's last choice and no earlier choice. The tally proof binds the posted counts to that aggregate (`TallyPublicInputs` word 5) and to the ballot-set root. For a VOTE, guardians decrypt that one aggregate, not each ballot, and only then. `submitDecryption` records the plaintext hash once, and only after the tally is posted.

The final L1 batch is required even when the last hour is short. Its `dataHash` binds the final aggregate commitment and the final ballot-set root. It does not bind a voter-to-ballot map, and it does not list which submission replaced which. `L1TallyMirror` then receives one result hash for that certified tally. Earlier hourly L1 batches remain as history of earlier running aggregates. They are not the certified result, and they are not edited to match it. VOTE choice publication on the mirror stays sealed until cutoff, which this branch already enforces for a certified post.

## Tally key (VOTE)

Not coded here. The lock is Shamir sharing of the VOTE key, not a time-lock and not a single operator key.

- **Setup.** Distributed Feldman sharing (Shamir with public commitments). Each guardian deals a polynomial of degree `k - 1`. No dealer holds the joint scalar. Bounds, matching the app: `n` from 2 to 16, `k >= 2`, `k <= n`. The joint public key is `tallyPubKeyX` / `tallyPubKeyY` on the L2 election before `startTime`. Ballots are refused until that key is posted.
- **Share distribution.** Shares are encrypted to each guardian's transport key and kept off chain. The chain stores Feldman commitments only. The operator's database must not gain a copy of a share.
- **What is encrypted.** VOTE choices use exponential ElGamal to that joint key, which is also what makes the re-vote delta work. POLL uses the same batch record, but the opening key is the tally operator's (threshold 1), so the app can revise the running picture during the window. The same k-of-n key must not be used for both, or a quorum that can revise a POLL could open a VOTE early.
- **Deadline.** Only at or after `cutoffTime`, each guardian submits a partial decryption of the **one aggregate ciphertext**, plus a Chaum-Pedersen proof against that guardian's commitment. `k` valid partials combine with Lagrange coefficients. The joint scalar is not reconstructed and is not an argument to `submitDecryption`.
- **Guardian loss.** If fewer than `k` guardians can produce a partial, there is no VOTE result. Do not lower `k` and do not add an operator override. Share refresh can be a later ceremony.
- **What threshold does not do.** Any `k` guardians can combine partials on their own machines before the deadline. The contract can refuse an early partial. It cannot take a share back.

## Contract, ABI, and deployment changes

Later pull request, after this scope is accepted. Nothing here is in the current diff except the freeze at the top.

| Surface | Change |
| --- | --- |
| `BallotInbox` | Spend the submission id once. Accept a second, different submission from the same person until cutoff. Append the ciphertext (or its commitment) and multiply the delta into the running aggregate. Do not store a link from the new submission to the old one. Keep five public inputs. |
| New batch verifier | Verify the transition (aggregate in, aggregate out, ballot-set root, private prior). Set once, same pattern as `tallyProofVerifier`. |
| `Tally` | For VOTE, store guardian partials and accept them only at or after cutoff. Require `k` valid partials before the decryption hash. POLL tally posting stays on today's clock. The posted hash stays write-once after cutoff. |
| Ceremony storage | A new contract for deals, commitments, `k`, and `n`, so `createElection`'s tuple does not grow again. `electionType` is already the last field of that tuple on this branch. |
| `L1TallyMirror` | One result hash per election, at the deadline, for the last-ballot tally. Hourly objects are settlement batches, not extra mirror rows. |
| `RollupSettlement` | Put the ballot-set root and the running aggregate inside `dataHash`. Keep `dataLength` at 0 under the gas assumption below. The final batch is mandatory. Do not rewrite an earlier batch. |
| Vote circuit | Nullifier constraint becomes the submission id. No new public input. |
| Batch circuit | New. ElGamal shape, private prior, delta. Unique-count words only if that open decision says so. |
| Tally circuit | Prove decryption of the product against `TallyPublicInputs` version 2. |
| Deployments | Do not edit script addresses or broadcast artifacts for this scope. A later release deploys the ceremony contract and the new verifiers. Existing clones keep their current bytecode until that release. |

`createElection` on this branch already appends `uint8 electionType` (`0` POLL, `1` VOTE). No further ABI change ships with this note.

## Gas

Assumptions, not a measurement. This repo has no Foundry gas snapshot for `submitBatch`. The civic JSON chain charges no gas.

- L1 scenario from the existing cost note: about 250,000 gas for one real proof plus storage, about $10 at 10 gwei and $4,000 per ETH. Recheck ETH and the base fee before budgeting.
- Cadence assumption: **one** such L1 batch per election hour, plus **one** final batch at the deadline, plus **one** `L1TallyMirror` post (about 40,000–100,000 gas) after decryption.
- A 10-hour election is about 11 settlement batches (about $110 in that scenario) plus the mirror post. A 24-hour election is about 25 batches (about $250). The final batch is a normal short hour, not padded to 64.
- Ballot bodies are not in those numbers. Calldata is 16 gas per nonzero byte. A 200-byte ciphertext is about 3,200 gas. Sixty-four of them are about 200,000 gas extra if a later decision puts bodies on L1. This scope leaves bodies on the L2.
- On an EVM inbox, a first ballot is on the order of two cold storage writes (20,000 gas each) plus the root update, the event, and a Groth16 verify on the order of 250,000 gas if the vote proof is checked there. A re-vote writes a new submission slot and updates the aggregate in place (a dirty slot, about 2,900 gas). It does not clear the old ciphertext. Guardians at the deadline: `k` partial transactions, then one `submitDecryption`. For `k = 3`, treat that as well under one settlement batch.
- JSON sequencer cost stays a host. The final batch is one extra seal at `cutoffTime`. Revising a published POLL picture is an app write, not another L1 transaction, unless the next hourly batch is due anyway.

## Trust

- Choice totals for a VOTE stay hidden until `k` guardians decrypt the aggregate at the deadline. The operator does not hold that scalar.
- The operator does hold the POLL opening key, because the running picture is revised in the clear during the window.
- `k` colluding guardians can decrypt a VOTE early, off chain. Fewer than `k` cannot. Loss below `k` means no official result.
- The batch proof is what stops a stranger from cancelling someone else's ciphertext. Mock verifiers stay off for a binding election.
- Last-ballot-counts lets a coercer demand the newest opening. The current first-ballot lock was the protection against that.
- L1 roots do not contain ballot bodies. The L2 log has to be retained or a batch cannot be recomputed.
- Feldman commitments let guardians detect a bad deal. They do not stop a guardian from leaking a share.
- Intermediate POLL publications are not a checksum of the certified tally. Only the final aggregate is.

## Open decisions

Contract work stays paused until these are answered. They are not chosen here.

### Does VOTE turnout wait for the 100-ballot gate?

POLL choice sums already wait for 100 ballots or the scheduled end. This question is only the VOTE **turnout** figure (how many ballots or voters), not the VOTE choices. Choices stay sealed until the deadline either way.

| Option | What is published | Tradeoff |
| --- | --- | --- |
| No wait | VOTE turnout is shown as soon as ballots are accepted, to every reader, including an admin. | The app and the chain tell the same story. A quiet hour shows a small increment. Someone leaving a polling place can be matched to that increment more easily. |
| Same gate as POLL sums | The app withholds the VOTE turnout figure until 100 ballots or the scheduled end. | Early size stays off the dashboard. It does **not** bind a chain reader. Today `acceptedBallots`, `VoteAccepted`, and `ballotRoot` are public for the whole window. Hiding the figure on chain means a later contract change that this note does not start. |

### Does published turnout count unique voters?

Replacements can be hidden inside a block either way: the public batch does not label a row as a re-vote and does not point at the previous submission. The question is what number is shown.

| Option | The number | Tradeoff |
| --- | --- | --- |
| Submissions | Every accepted proof increments it, including a replacement. This matches today's `acceptedBallots`. | Easy to tie to the event log. The number is larger than the number of people when anyone votes twice. A block's row count and the turnout number move together, so a re-vote is visible as an extra row even if it is not labeled. |
| Unique voters | A first ballot increments it. A replacement does not. The batch proof can output the count without revealing which row was the replacement or which earlier ballot it cancelled. | The published number matches "one person, one current choice." It will not match a raw count of `VoteAccepted` events. Checking it requires the batch proof, not just the log. |

The running aggregate and the certified tally are the same under both options. Only the published turnout number changes.

## What the app has to do

No app code in this pull request. After the scope is accepted, and after the open turnout questions are answered:

**PR 115** (sequencer, explorer import, diagnostics, relayer) currently seals a VOTE so that turnout, rows, and partial totals stay hidden, and it does not send `electionType` in `createElection` (`PASS_ELECTION_TYPE_ON_CHAIN` is false).

- Sequencer: same batch record for POLL and VOTE, on the hour, and one last batch at the deadline. Do not pad. Do not drop a short batch. A second ballot before cutoff is a delta, not a rejection.
- Explorer: POLL choice sums are the running picture. Revising them after a re-vote is required. Do not present an old hour's sums as equal to the certified tally. VOTE choices appear only after deadline decryption. Do not pair a voter with a choice, and do not draw a line between two submissions.
- Diagnostics: no VOTE plaintext before the deadline, including for a platform admin. No log line that ties a submission id to a prior one. Turnout display follows the open decisions above.
- Relayer: keep five-input proofs. Submit a later ballot as a new submission id plus a delta. Refuse VOTE partials and VOTE decryption posts before cutoff.
- Factory call: when the deployment that includes this branch is the one the app talks to, append `electionType` as the last `uint8` and turn the flag on. Until then the app tuple still ends at `tallyScheme`.
- Guardians: post the joint key before start. Accept partials only at the deadline. Decrypt the aggregate, not each ballot. Do not store shares on the node.

**POLL live counts** (the gate implemented beside 115):

- Keep 100 ballots or scheduled end, the 30-minute delay, and merge-forward under 10.
- Treat a published block as revisable. A later re-vote changes the displayed sums. Do not publish a named correction.
- The certified result at close is a new final object, not "the sum of the hours."
- The interim hash on chain may move before cutoff and must be left alone after it.

## Out of this note

Padding, dummy ballots, relayer-held ballots, and commit-reveal are not proposed. A time-lock around the tally key is not proposed. Whether VOTE turnout waits for the 100-ballot gate, and whether the published turnout counts unique voters, are the open items above. Deployed addresses and submodules stay as they are.
