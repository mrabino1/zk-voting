# Token polls (ERC-20 weighted signal)

**NOT FOR PROFIT** — civic public good, not a commercial product. AGPL-3.0-or-later. ZK-Voting issues **no token**. This feature **reads** a third-party ERC-20 balance as vote weight. It does not create, sell, or wrap a token. Results are **signal only** and **non-binding**. They trigger no on-chain action.

Phase 1 ships behind `POLLS_ENABLED=1`. With the flag unset there are no poll HTTP routes, no poll nav entry, and the civic L2 rejects `poll_params`, `poll_vote`, and `poll_tally`.

Every poll reads one host token: `VOTING_TOKEN_ADDRESS` on `VOTING_TOKEN_CHAIN_ID` (default **1**, Ethereum mainnet). The Node only reads `balanceOf`. It does not send a transaction and it does not spend tokens. If `VOTING_TOKEN_ADDRESS` is unset or not an address, polls stay disabled and the back office shows that message. `pollParamsHash` still commits the token address and chain id that were in force when the poll was scheduled.

## Polling, not an executive

This follows the MakerDAO **governance polling** shape: one fixed window, one question, plurality or ranked-choice IRV. It is not the continuous executive / “hat” model. There is no token lock, no spell, and no execution.

ZK-Voting is stricter than a single snapshot. **Final weight is the minimum end-of-block `balanceOf` from the vote block through the close block.** Tokens that leave reduce the vote, down to removal at zero. Tokens that arrive after the vote never raise it. `closeBlock` is the last token-chain block whose timestamp is before `cutoffTime`.

## Holding is the only credential

A token poll has **no** ZK-Voting account, passkey, PIN, registration roll, eligible root, nullifier, or disqualification check. The voter signs an EIP-712 `TokenPollBallot` with the address that holds the tokens (ERC-1271 for a contract wallet). That signature proves control of the address. It is not identity verification.

One ballot per address. It cannot be changed. Every poll includes an Abstain option. Quorum and pass threshold default to none. Phase 1 privacy is `public_weighted` only. Approval voting is phase 2.

Only the platform super admin creates, edits, or schedules a poll. A tally operator (or a platform operator) posts the official tally after close. There is **no live provisional tally**.

## Double counting

`finalWeight(address) ≤ balanceOf(address, closeBlock)`. Summed over distinct addresses, participation is at most the token supply at close. Moving the same tokens to a second address and voting again cannot count them twice. A flash loan that is borrowed and repaid inside one transaction does not change any end-of-block balance, so its weight is zero.

Delegation and vote proxies are out of scope. The address that **holds** the tokens is the one that votes. Tokens sitting in a staking contract or a liquidity pool cannot vote unless that contract signs the ballot. The UI says so.

## Privacy

| | Civic election | Token poll (phase 1) |
| --- | --- | --- |
| Credential | Identity commitment | Token balance |
| Choice | Hidden (receipt cannot prove it) | Public after the disclosure hour |
| Address | Not the voter id | Public by design |
| Weight | One person | Minimum balance held through close |

Address-hiding weighted voting conflicts with hold-through-close, because the tally must watch that address until close. It is not offered.

## Where the token lives

ZK-Voting L2 (chainId **27427**) is a civic JSON sequencer, not an EVM. It cannot hold an ERC-20. Production reads Ethereum mainnet through `TOKEN_RPC_1`. An optional `TOKEN_RPC_1_2` must agree with the first when both are set. The Node never writes to Ethereum. Tests use an in-memory ERC-20 on a local chain id, not a public testnet and not a live RPC.

## Math

Weights are uint256 base units: `bigint` in memory, decimal strings in JSON. Plurality sums final weights per option. Weighted IRV uses the same tie breaks as civic IRV (`firstPlaceTieWinner`, `lastPlaceTieEliminated`) without changing `computeIrv`. Majority is `2 × top > continuing`, in integers. Outcome order: quorum, then no ballots, then tie, then threshold, otherwise a winner.

`resultHash` is keccak256 of the canonical result without `resultHash`, `tallyAt`, `tallyBy`, or `l1TxHash`. `ballotsRoot` is a keccak Merkle root of canonical ballot rows sorted by voter.

## Auditor

`republic.auditor.poll.v1` is a separate pack from the civic `republic.auditor.v1`. `tools/auditor verify --offline` checks signatures, one address, choices, the math, `resultHash`, and `ballotsRoot`. With `--rpc` it re-derives every final weight. See [`AUDITOR.md`](./AUDITOR.md).

## L1 mirror (follow-up)

`L1TallyMirror.postResult` keys a **uint256** civic election id. A token poll id is a string, so writing a poll result into that slot would change the existing mirror contract. Phase 1 skips the mirror (`l1Mirror: "skipped"`). Anchoring a poll `resultHash` is a later change.

## Threats

Flash loans, rented tokens, whales, lying RPCs, reorgs, rebasing tokens, and operator tally edits are listed in [`THREAT_MODEL.md`](./THREAT_MODEL.md). Rebasing tokens (balances that move with no `Transfer`) are unsupported; preflight warns. The tally refuses to run until the close block is finalized.

## What phase 1 does not change

No change to `ElectionParams`, the Vote circuit, `BallotInbox`, `Tally`, `VoterRegistry`, civic `vote` validation, or `computeIrv`. Civic elections stay on their existing path.
