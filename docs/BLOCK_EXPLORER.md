# Block explorer

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

Republic needs a **public, election-grade explorer** because the Node is not the source of truth. If the web app is down, censored, or lying, observers, losing candidates, and courts must still answer: **what happened in block N?**

This is not a general-purpose ETH explorer white-label. It is indexed around election outcomes on Republic L2 (chainId **27427**) and, when used, L1 settlement / tally-mirror transactions.

UI: Node SPA `/explorer`. HTTP: `GET /api/explorer/blocks`, `GET /api/explorer/blocks/:n`, `GET /api/explorer/txs/:hash`. Backend reads L2 JSON-RPC (`eth_getBlockByNumber`, `eth_getLogs`) plus the factory / registry / inbox / tally / rollup ABIs.

---

## Why it exists

| Need | Why a normal wallet explorer is not enough |
| --- | --- |
| Audit a poll | Must group **electionId**, roots, nullifiers, reason codes — not just ERC-20 transfers. |
| Public verifiability | Anyone can check inbox size, used nullifiers, freeze events, tally posts, rollup `dataHash`. |
| Disqualification transparency | Mass purges cannot hide: reason **codes** are first-class rows. |
| Privacy of choice | A naive “decode calldata” UI must **not** display option ids as “the vote”. |
| Relayer reality | `tx.from` is usually the **bundler**, not the voter. Showing “from = voter EOA” would be a lie. |

Without this surface, clerks would screenshot the Node admin and call it an audit trail. That is the failure mode the rest of the stack is designed against.

---

## What is visible

These are **meant** to be public. The explorer should render them in plain language.

| Object | What the public sees |
| --- | --- |
| Blocks | Number, hash, parent, timestamp, state root, sequencer address, tx count. |
| Registration | `identityCommitment` (field element / bytes32) inserted into the election tree. Leaf **index** if the contract emits it. Never a legal name. |
| Vote accepted | `electionId`, `nullifier`, `ballotHash`, `generation`, relayer address — **only after the hour that contained the vote has closed**. Timestamp is the hour boundary, not the minute they voted. A later ballot for the same nullifier is `VoteSuperseded` / generation > 1; only the last hash counts. |
| Disqualification | `identityCommitment`, `electionId`, **reason code** (and label, e.g. `NOT_RESIDENT`), `evidenceHash`, issuer role, timestamps, revoke events. |
| Roll freeze | Eligible root, disqualification root, clerk, time. |
| Tally | Per-option **counts** (after a valid tally proof), `countsHash`, operator. |
| Rollup batch (L1) | `batchIndex`, `prevStateRoot`, `newStateRoot`, `dataHash`, prover. Anyone can re-hash posted calldata. |
| Parameters | Start / cutoff, `maxParticipants` (0 = unlimited), `treeDepth`, `ballotSpecHash`, verifier address. |

Live **counts that are safe to show** before tally: number registered, number disqualified (by code). **Not** a live accepted-ballot counter. Public `acceptedBallots` is the last **hourly snapshot**. A person who votes and then leaves a voting office must not be matchable to an increase in any jurisdiction on any dashboard.

### Hourly disclosure (polling-place unlinkability)

Votes are accepted immediately so a nullifier’s **current** ballot is unique. A replacement ciphertext for the same nullifier is last-ballot-counts (the old hash cannot be replayed). Proof of those votes is public only once the UTC hour that contained them has closed (`DISCLOSURE_INTERVAL_SECONDS`, default 3600).

- At 14:23, only events with timestamp `< 14:00` are public. A 14:05 vote appears at 15:00.
- All votes from that hour are lumped into **one** disclosure block. Public timestamp is the hour end. Order is by nullifier, not arrival. Intra-hour times (14:03 vs 14:17) are not published.
- Do **not** show “N unpublished in election E”. That still identifies the jurisdiction.
- Unpublished nullifiers and tx hashes 404 like unknown ones. Do not confirm that a sealed vote exists.
- L2 `pending` and `eth_getTransactionByHash` omit sealed votes. The voter still gets an accept receipt from the Node.

Tally operators after cutoff may use the real inbox size to certify `sum(counts) == acceptedBallots`. That privileged view is not a public dashboard.

---

## What is hidden

| Object | Why it is not on the explorer |
| --- | --- |
| Ballot **choice** | Encrypted / committed. `ballotHash` is not the option. Decoding ciphertext in the UI would invert the design. |
| Civil identity | Name, DOB, address, ID numbers live in the Node’s legal file (if the jurisdiction must keep them), not in events. |
| Evidence files | Only `evidenceHash` is on chain so a court can match a sealed file later. |
| Passkey / smart-account linkage to a ballot | The UserOp that registered may show a passkey account; the vote tx is submitted by the bundler. The explorer must not “join” those into “this address voted for X”. There is no X. |
| Trapdoor / nullifier secret / PRF output | Witness material. Never logged. |
| “I voted for X” receipts | Forbidden in the Node; the explorer must not invent them from proofs. |

A coercer who watches the explorer learns that **someone** registered a commitment, that **a** nullifier was spent **after the hour closed**, that **N** ballots were accepted **in prior hours**, and that **K** people were disqualified under public codes. They do not learn the option. They should not be able to click a voter’s passkey address and see their ballot. They must not be able to watch someone leave a voting office and see which jurisdiction just ticked.

---

## Indexing rules

1. Prefer **contract events** (`VoterRegistered`, `VoteAccepted`, `Disqualified`, `TallyPosted`, `ElectionCreated`, rollup `submitBatch`) over calldata guesswork.
2. For `VoteAccepted` / `VoteSuperseded`, store `nullifier` + `ballotHash` + `generation` + `relayer`. Do not ABI-decode `encryptedBallot` into an option enum in the UI.
3. Treat `msg.sender` as **relayer** for inbox calls. Label it that way.
4. `identityCommitment` is shown as hex / decimal field element, not as a resolved person. Clerk tools that resolve commitments to files are **restricted** (back-office), not `/explorer`.
5. After cutoff, the explorer still serves historical blocks. Tallies do not rewrite earlier vote rows.
6. Vote events are withheld until `eventTs < floor(now / 3600) * 3600`. Dashboards show the last published snapshot and the next publish time, never a live tick.

---

## Failure modes to avoid

- Pretty-printing `encryptedBallot` as UTF-8 or as `optionId`.
- A “voter profile” page that lists nullifiers next to a passkey address.
- A live turnout or accepted-ballot number that increments when a person leaves a voting office.
- Hiding disqualification events behind an admin flag. The **fact** of disqualification is public process; the **ballot** is not.
- Showing MockVerifier “accept: true” proofs as if they were ceremony-backed Groth16 on `master`.

The explorer is how the public checks the chain. If it lies, it is a bug in the same class as the Node lying about what the chain said.
