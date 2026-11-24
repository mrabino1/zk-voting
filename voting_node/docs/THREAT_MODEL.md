# Threat model

**NOT FOR PROFIT** — civic public good. Not a commercial product.

Anything that lets people run a binding vote will be attacked. This file maps what an adversary
can and cannot do to a **civic vote on ZkVotingRollup**, to the **Node** that fronts it, and to
**token polls**. Design of the rollup: [`smart-contracts/docs/ROLLUP.md`](../../smart-contracts/docs/ROLLUP.md).
If this file disagrees with the contracts, the contracts win.

---

## What an authoritarian adversary wants

1. **Change a result**: a different count on L1, or a result for a contest that never happened.
2. **Learn how someone voted**, or let a coercer check.
3. **Stop a vote** (censor ballots, stall the operator, keep the result from being finalized).
4. **Change the roll quietly**: drop voters, add ghosts, disqualify without a public record.
5. **Confuse the public record** without touching L1: fake pages, look-alike contracts, a rogue Node.
6. **Capture keys** (governor, jurisdiction admin, clerk, operator, Node admin, guardians).

---

## Civic votes on the rollup

### Closed by the contract

| Attack | Control |
| --- | --- |
| Operator invents or alters a result | L1 decrypts only the final accumulator; `finalizeResult` checks every total against k guardians' Chaum-Pedersen shares and that totals sum to the ballot count. |
| Operator adds, drops or edits a roll entry | Roll changes enter only through the L1 priority queue from the jurisdiction's registrar and officer; each batch must prove it applied them. |
| Operator censors a ballot | The voter can `forceBallot` through L1; the operator must include priority requests. |
| Operator stops serving the queue | After 3 days anyone calls `activateDesertMode()`; closed elections finish, open ones can be `desertClose`d from the last proven state. |
| Ballot that votes twice or for two options | Each option ciphertext carries a 0/1 proof and the vector a sum-to-one proof; one ballot per nullifier. |
| Partial or interim decryption | There is no entry point for it. Pubdata holds a nullifier and a hiding commitment, never a decryptable ciphertext. |
| Tiny electorate de-anonymized by the sum | Below `minBallots` the result is **Withheld** and never decrypted. |
| Governor rewrites an election | The governor manages operators and jurisdictions only; it cannot touch an election, roll, ballot or result. |
| Clerk of one body creates an election for another | `createElection` checks `isClerk[jurisdictionId]`. |
| Roll change after the start | Registrations and disqualifications are refused after `startTime`. |
| Forged guardian message relayed by the Node | Guardian messages are signed under their Baby Jubjub identity key or prove themselves. |

### Residual (the operator and officials must keep these in mind)

| Risk | Why it remains | Mitigation |
| --- | --- | --- |
| **No batch validity circuit yet** | Only `MockBatchVerifier` exists, on chain 31337 | No public-chain civic vote until the circuit and its ceremony exist. The operator refuses a real verifier. |
| **Eligibility not proven** | Roll membership is not yet proven in zero knowledge | The Node gates ballots with one blind vote pass per voter on the roll and persists a poll book; a hostile Node operator could still issue extra passes. |
| k colluding guardians + the operator | The operator sees ciphertexts; with the key it could decrypt them | Choose guardians from independent bodies; k high enough. The honest-threshold assumption of every encrypted-ballot system. |
| Fewer than k guardians show up | The result cannot be decrypted | Pick n > k; guardians keep their key files backed up. |
| Turnout timing | Batch pubdata shows how many ballots each batch carried | Public by design; no choice leaks. Voters who worry can cast later or from another network. |
| Desert mode on an open election | The accumulator is never public, so an open election may stay `Halted` | Secrecy chosen over liveness, on purpose. |
| Captured clerk key | It can create elections and name officers for its jurisdiction | The jurisdiction admin rotates clerks with `setClerk`; keep the Node key funded but small. |
| Captured governor | Can add a hostile operator (it still cannot forge a valid batch) or create look-alike jurisdictions | Multisig with two-step handover. |
| Look-alike contract | Anyone can deploy a copy | Check the address against the root README on `master`, a signed release and zk-voting.org. |
| Civic revoting off | Nothing yet proves the sender owns a nullifier | A revote could overwrite another voter's ballot, so it is refused (`NULLIFIER_USED`). |

---

## The Node

| Attack | Control |
| --- | --- |
| Link a ballot to a person | The ballot request has no cookie, session or commitment; the vote pass is blind; spent passes and the poll book are unlinked hash sets with coarse timestamps; the vote route is not access-logged. See [`OPERATOR.md`](./OPERATOR.md#ballot-unlinkability). |
| Second pass after a restart | The poll book (`votePassIssued`) persists who took a pass. |
| Client-chosen ids | `id`, `uuid` and `localElectionId` in a create request are ignored; UUID v5 binds Node, jurisdiction and local sequence. |
| Ambiguous `/elections/:ref` | 409 `ELECTION_ID_COLLISION` rather than the first match. |
| Captured clerk rewrites About / FAQ / home | Unscoped CMS pages and the site title are `platform_admin` only. |
| `ALLOW_DEV_LOGIN` on a public host | Ignored when `NODE_ENV=production`. |
| Officer roster for phishing | Public `/api/jurisdictions` returns names only. |
| Anvil test keys on a public chain | Refused at start off chain 31337 (node and operator). |
| Mock proofs on a public chain | `ZK_VOTING_ALLOW_MOCK_PROOFS` is refused off chain 31337. |

Residual: a hostile Node operator can lie to its own visitors (pages, receipts it shows) and can
issue extra vote passes while eligibility is not proven. It cannot change a certified civic result
on L1. Courts and observers read L1.

---

## Polls

Polls are counted on the Node; a hostile Node operator can affect a poll in ways it cannot affect a
civic vote. `opens_ballots` polls need t-of-n guardians to open ballots (**NON-PRODUCTION** P-256
Feldman). Sealed ranked choice exposes individual rankings (not identities) to the guardians who
open them ([`POLLS.md`](./POLLS.md)). Polls are labelled as weaker privacy in the app.

---

## Token polls (signal only)

**NOT FOR PROFIT.** These rows cover ERC-20 weighted polls. They are not binding elections. See [`POLLS.md`](./POLLS.md).

| Threat | Handling |
| --- | --- |
| Flash loans | Borrowed and repaid inside one transaction, so no end-of-block balance changes. Weight is 0. |
| Multi-block borrowing | The borrower must hold until close. The lender’s tokens do not vote while they are lent. Documented limit of any token-weighted poll. |
| Buying during the poll | Allowed. The buyer must hold through close. The seller’s vote drops by what they sold. |
| Double counting (move-and-revote, ping-pong) | `finalWeight(a) ≤ balance(a, closeBlock)`. Distinct addresses sum to at most supply at close. No nullifier. |
| Sybil | Not relevant. Splitting tokens across addresses does not raise total weight. The UI leads with weight. |
| Whale dominance | Inherent to token weighting. Stated as signal only. |
| Forged ballot | EIP-712 or ERC-1271 signature from the holding address. |
| Signature replay | Domain binds `pollDomain`, token, `ballotSpecHash`, and the Node's chain id (`CHAIN_ID`, 27427 by default). One ballot per address. |
| Deanonymization | Public mode is public on purpose. Address-hiding is not offered. |
| Lying RPC | Auditor re-derives weights on an independent RPC. Block hashes are pinned. A second archive RPC, if set, must agree. |
| Reorgs | Tally waits until the close block is finalized and re-checks hashes. |
| Operator edits the tally | Final weights are a pure function of public chain data and public ballots. |
| Rebasing / fee-on-transfer / balance changes without `Transfer` | Weights read `balanceOf` at touched blocks and check the close balance. Drift is flagged `TOKEN_DRIFT`. Rebasing tokens are unsupported. |
| Spam ballots | `minBallotWeight` defaults to 1 base unit, so a zero balance cannot vote. |
| Relay censorship | The voter gets a receipt or a rejection code. |
| Last-block games | Moves in `closeBlock` reduce weight like any other move. |
