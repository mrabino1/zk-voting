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
| Vote accepted | `electionId`, `nullifier`, `ballotHash`, relayer address. Inbox `acceptedBallots` counter. |
| Disqualification | `identityCommitment`, `electionId`, **reason code** (and label, e.g. `NOT_RESIDENT`), `evidenceHash`, issuer role, timestamps, revoke events. |
| Roll freeze | Eligible root, disqualification root, clerk, time. |
| Tally | Per-option **counts** (after a valid tally proof), `countsHash`, operator. |
| Rollup batch (L1) | `batchIndex`, `prevStateRoot`, `newStateRoot`, `dataHash`, prover. Anyone can re-hash posted calldata. |
| Parameters | Start / cutoff, `maxParticipants` (0 = unlimited), `treeDepth`, `ballotSpecHash`, verifier address. |

Live **counts that are safe to show** before tally: number registered, number disqualified (by code), number of accepted ballots. Not a running “who is winning” decoded from ciphertexts.

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

A coercer who watches the explorer learns that **someone** registered a commitment, that **a** nullifier was spent, that **N** ballots were accepted, and that **K** people were disqualified under public codes. They do not learn the option. They should not be able to click a voter’s passkey address and see their ballot.

---

## Indexing rules

1. Prefer **contract events** (`VoterRegistered`, `VoteAccepted`, `Disqualified`, `TallyPosted`, `ElectionCreated`, rollup `submitBatch`) over calldata guesswork.
2. For `VoteAccepted`, store `nullifier` + `ballotHash` + `relayer`. Do not ABI-decode `encryptedBallot` into an option enum in the UI.
3. Treat `msg.sender` as **relayer** for inbox calls. Label it that way.
4. `identityCommitment` is shown as hex / decimal field element, not as a resolved person. Clerk tools that resolve commitments to files are **restricted** (back-office), not `/explorer`.
5. After cutoff, the explorer still serves historical blocks. Tallies do not rewrite earlier vote rows.

---

## Failure modes to avoid

- Pretty-printing `encryptedBallot` as UTF-8 or as `optionId`.
- A “voter profile” page that lists nullifiers next to a passkey address.
- Hiding disqualification events behind an admin flag. The **fact** of disqualification is public process; the **ballot** is not.
- Showing MockVerifier “accept: true” proofs as if they were ceremony-backed Groth16 on `master`.

The explorer is how the public checks the chain. If it lies, it is a bug in the same class as the Node lying about what the chain said.
