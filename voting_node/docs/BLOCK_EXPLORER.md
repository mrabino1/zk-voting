# Block explorer

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

ZK-Voting needs a **public, election-grade explorer** because the Node is not the source of truth. If the web app is down, censored, or lying, observers, losing candidates, and courts must still answer: **what happened in block N?**

This is not a general-purpose ETH explorer white-label. It is indexed around election outcomes.
It has two views:

- **Rollup batches** (civic votes): `/explorer#/rollup`, `GET /api/explorer/rollup`. Batches and
  status from the L2 operator (`/v1/batches`, `/v1/status`), without the live pending-ballot count.
  The chain of record is ZkVotingRollup's events on L1, which anyone can read with an Ethereum node.
- **Poll blocks**: `GET /api/explorer/blocks`, `/blocks/:n`, `/txs/:hash`, `/disclosure`, `/search`,
  `/nullifiers/:value`, `/elections/:id`, and `GET /api/elections/:id/summary`. The Node writes
  these to its own explorer log as polls run.

UI: Node page `/explorer` (`public/explorer.html` + `explorer.js`, vanilla JS).

---

## Why it exists

| Need | Why a normal wallet explorer is not enough |
| --- | --- |
| Audit a poll | Must group **electionId**, roots, nullifiers, reason codes — not just ERC-20 transfers. |
| Public verifiability | Anyone can check used nullifiers, roll changes, batches and their pubdata, and the certified result on L1. |
| Disqualification transparency | Mass purges cannot hide: reason **codes** are first-class rows. |
| Privacy of choice | A naive “decode calldata” UI must **not** display option ids as “the vote”. |
| Relayer reality | A civic ballot reaches L1 inside the **operator's** batch. Showing “from = voter” would be a lie. |

Without this surface, clerks would screenshot the Node admin and call it an audit trail. That is the failure mode the rest of the stack is designed against.

---

## What is visible

These are **meant** to be public. The explorer should render them in plain language.

| Object | What the public sees |
| --- | --- |
| Rollup batches | Number, time, state root, commitment, op counts, L1 transactions (commit, verify, execute). |
| Poll blocks | Number, hash, parent, timestamp, tx count. |
| Registration | `identityCommitment` (field element / bytes32) inserted into the election tree. Leaf **index** if the contract emits it. Never a legal name. |
| Vote accepted | `electionId`, `nullifier`, `ballotHash`, relayer address — **hourly from the first ballot, after the hour closes, the disclosure delay elapses, and the block meets the floor**. Timestamp is the disclosure clock, not the minute they voted. Each voter is counted once. Where the election allows it, a voter may re-vote until the deadline, with the last vote counting; otherwise a second ballot is rejected. |
| Disqualification | `identityCommitment`, `electionId`, **reason code** (and label, e.g. `NOT_RESIDENT`), `evidenceHash`, issuer role, timestamps, revoke events. |
| Roll freeze | Eligible root, disqualification root, clerk, time. |
| Tally | Per-option **counts** (after a valid tally proof), `countsHash`, operator. |
| Civic result (L1) | Final per-option totals or **Withheld**, the ballot count, the guardians' decryption shares. |
| Parameters | Start / cutoff, `ballotSpecHash`, option count, k-of-n, `minBallots`. |

Live **counts that are safe to show** before tally: number registered, number disqualified (by code). **Not** a live accepted-ballot counter. Public `acceptedBallots` is the last **published disclosure block**. A person who votes and then leaves a voting office must not be matchable to an increase in any jurisdiction on any dashboard.

### Hourly disclosure (polls)

This section applies to polls. A civic ballot appears in a batch as soon as the operator commits it (a nullifier and a hiding commitment, never a choice), so civic turnout is public at batch granularity.

Poll votes are accepted immediately so a nullifier is unique. A second ballot for the same nullifier is rejected (`NULLIFIER_USED`) unless re-vote is enabled. Double voting is impossible. Proof of those votes is public only when all of the following are true. The API enforces this; hiding it only in the page would not.

- The UTC hour has closed and `DISCLOSURE_DELAY_SECONDS` (default 1800) has elapsed. `DISCLOSURE_INTERVAL_SECONDS` stays 3600. A vote at 08:59 publishes at 09:30. A vote at 14:05 is time-ready at 15:30. A vote at **exactly** 14:00:00 is in the 14:00 hour and is time-ready at 15:30. An earlier guarantee that the same vote appears at 15:00, on the hour, is withdrawn.
- Turnout and per-block vote rows publish hourly from the first ballot. They do not wait for `RESULTS_MIN_VOTES`. Poll per-choice counts wait until the gate opens once 100 voters have cast their first ballot, or until the scheduled end. After that gate, hourly choice sums publish with the same delay. A published block stays as first published. A vote publishes choices only in the final tally.

- The block has at least `DISCLOSURE_MIN_BLOCK_VOTES` ballots (default 10). Hours under that floor merge into the next block. At election end the remainder is published if the election met the floor. If the whole election is under the floor, nothing is published until the final tally.

Ready ballots share one disclosure block. Public timestamp is the disclosure clock (hour end + delay). Order is by nullifier, not arrival. Intra-hour times (14:03 vs 14:17) are not published.

- Do **not** show “N unpublished in election E”. That still identifies the jurisdiction.
- Unpublished nullifiers and tx hashes 404 like unknown ones. Do not confirm that a sealed vote exists.
- The voter still gets an accept receipt from the Node.

Tally operators after cutoff may use the real ballot count to check `sum(counts) == acceptedBallots`. That privileged view is not a public dashboard.

### Observer snapshot (explorer + public summary)

Observers should see a **hour-bucketed update**, not a live tick. The explorer banner (`/explorer`) and `GET /api/explorer/disclosure` (also attached to `GET /api/explorer/blocks`) publish:

| Field | Meaning |
| --- | --- |
| `lastClosedHourAt` / `lastPublishedAt` | Unix time the delay has cleared through (e.g. 14:00 once the clock reaches 14:30). |
| `lastClosedHourStart` | Start of that hour (13:00 when `lastClosedHourAt` is 14:00). |
| `delaySeconds` | Extra wait after the hour. Default `1800`. |
| `resultsMinVotes` | Poll per-choice counts wait until the gate opens once this many voters have cast their first ballot, or until the scheduled end. Default `100`. Turnout does not use this gate. |
| `minBlockVotes` | Smallest disclosure block. Smaller hours merge forward. Default `10`. |
| `acceptedBallotsDisclosed` | Ballots already in a published block. Explorer total is chain-wide; election APIs are per election. Never a pending remainder. |
| `nextPublishAt` | Next disclosure clock (hour end + delay). |
| `secondsUntilNext` | Countdown to that clock. The explorer UI ticks this locally. |
| `intervalSeconds` | Default `3600`. `0` publishes immediately (tests / local demo). |

`GET /api/elections/:id/summary` is the public election snapshot: title, state, **disclosed** `acceptedBallots`, the same disclosure object, `explorerUrl`, and `resultsUrl` **only after a final tally exists**. This surface does not compute or display a winner; when a tally is posted it links to `/elections/:id/results` (that path is still **not** a voter-router page; tally JSON is on `GET /api/elections/:id`).

Choice plaintext is never a field on these responses.

---

## What is hidden

| Object | Why it is not on the explorer |
| --- | --- |
| Ballot **choice** | Encrypted / committed. `ballotHash` is not the option. Decoding ciphertext in the UI would invert the design. |
| Civil identity | Name, DOB, address, ID numbers live in the Node’s legal file (if the jurisdiction must keep them), not in events. |
| Evidence files | Only `evidenceHash` is on chain so a court can match a sealed file later. |
| Account linkage to a ballot | The ballot is relayed by the Node and batched by the operator. The explorer must not “join” anything into “this person voted for X”. There is no X. |
| Trapdoor / nullifier secret / PRF output | Witness material. Never logged. |
| “I voted for X” receipts | Forbidden in the Node; the explorer must not invent them from proofs. |

A coercer who watches the explorer learns that **someone** registered a commitment, that **a** nullifier was spent **after the hour closed**, that **N** ballots were accepted **in prior hours**, and that **K** people were disqualified under public codes. They do not learn the option. They should not be able to click a voter and see their ballot. They must not be able to watch someone leave a voting office and see which jurisdiction just ticked.

---

## Indexing rules

1. Polls: index the typed outcomes on the Node's log (`register`, `vote`, `disqualify`, `tally`, `roll_frozen`, …). Civic votes: prefer ZkVotingRollup's events (`ElectionCreated`, `VotersRegistered`, batch events, `ResultFinalized`) over calldata guesswork.
2. For a vote, store the nullifier and the ballot hash or commitment. Never decode a ciphertext into an option in the UI.
3. Label the sender of a batch as the **operator**, not a voter.
4. `identityCommitment` is shown as hex / decimal field element, not as a resolved person. Clerk tools that resolve commitments to files are **restricted** (back-office), not `/explorer`.
5. After cutoff, the explorer still serves historical blocks. Tallies do not rewrite earlier vote rows.
6. Vote events are withheld until `eventTs < floor(now / 3600) * 3600`. Dashboards show the last published snapshot (`lastClosedHourAt`, `acceptedBallotsDisclosed`) and the next publish time (`nextPublishAt` / `secondsUntilNext`), never a live tick.

---

## Failure modes to avoid

- Pretty-printing `encryptedBallot` as UTF-8 or as `optionId`.
- A “voter profile” page that lists nullifiers next to a passkey address.
- A live turnout or accepted-ballot number that increments when a person leaves a voting office.
- Hiding disqualification events behind an admin flag. The **fact** of disqualification is public process; the **ballot** is not.
- Showing mock proofs or a `MockBatchVerifier` deployment as if they were ceremony-backed.

The explorer is how the public checks the chain. If it lies, it is a bug in the same class as the Node lying about what the chain said.
