# Token polls (ERC-20 weighted signal)

**NOT FOR PROFIT** — civic public good, not a commercial product. AGPL-3.0-or-later. ZK-Voting issues **no token** and does not sell one. This feature **reads** one ERC-20 on **Ethereum mainnet** (chain id 1) as vote weight. An optional `SignalVotes` contract exists for an operator who wants a dedicated token. The Node does not deploy it. Results are **signal only** and **non-binding**. They trigger no on-chain action.

Phase 1 ships behind `POLLS_ENABLED=1`. With the flag unset there are no poll HTTP routes and no poll nav entry. `balance_hold` may still post `poll_params`, `poll_vote`, and `poll_tally` on the civic L2. `erc20_votes` does not.

Every poll reads one host token: `VOTING_TOKEN_ADDRESS`. Production accepts chain id **1** only. Any other chain id leaves polls disabled (`not_ethereum_l1`). The Node never sends a token transaction. If the address is unset or not an address, polls stay disabled and `/admin#deployment` shows that message. Creating a poll is on that host admin page, not the civic back office. A deployment is one mode: this ERC-20, or civic elections with no ERC-20. `pollParamsHash` commits the token address, the chain id, and the weight source that were in force when the poll was scheduled.

## Two weight sources

| `weightSource` | What counts | Credential |
| --- | --- | --- |
| `balance_hold` (default) | Minimum end-of-block `balanceOf` from the vote block through close | The address that holds the tokens |
| `erc20_votes` | `getPastVotes(voter, snapshotBlock)` | Delegated voting power at one finalized Ethereum block |

`erc20_votes` requires `CLOCK_MODE` to contain `mode=blocknumber`. The snapshot is the latest finalized block at schedule time, or an explicit past finalized block. Undelegated balances are zero. Delegation after the snapshot does not count. One ballot per address still holds. The turnout denominator is total supply at the snapshot (`supplyReference: "snapshot"`).

The snapshot leaf is Poseidon(`address`, `weight`), sorted by address, depth 16, scheme `zk-voting.hash.poseidon-bn254-x5-t3-v1` (the civic hasher). The Node checks the inclusion path directly. There is no Groth16 ceremony for this circuit. The address, the weight, and the choice are public. This is not a secret ballot.

`VOTING_TOKEN_START_BLOCK` is required for a real RPC so `DelegateChanged` and `DelegateVotesChanged` are not scanned from genesis. The replayed logs must match `getPastVotes` or the snapshot fails. The in-memory test chain does not use that setting.

Delegation is `delegate(address)` on the token. The holder pays the gas in their own wallet. The Node does not send it. Signing a ballot stays an EIP-712 signature and includes `snapshotRoot` only in this mode.

## Polling, not an executive

This follows the MakerDAO **governance polling** shape: one fixed window, one question, plurality or ranked-choice IRV. It is not the continuous executive / “hat” model. There is no token lock, no spell, and no execution.

ZK-Voting is stricter than a single snapshot. **Final weight is the minimum end-of-block `balanceOf` from the vote block through the close block.** Tokens that leave reduce the vote, down to removal at zero. Tokens that arrive after the vote never raise it. `closeBlock` is the last token-chain block whose timestamp is before `cutoffTime`.

## Holding is the only credential

A token poll has **no** ZK-Voting account, passkey, PIN, registration roll, eligible root, nullifier, or disqualification check. The voter signs an EIP-712 `TokenPollBallot` with the address that holds the tokens (ERC-1271 for a contract wallet). That signature proves control of the address. It is not identity verification.

One ballot per address. It cannot be changed. Every poll includes an Abstain option. Quorum and pass threshold default to none. Phase 1 privacy is `public_weighted` only. That is a public weighted signal, not an anonymous ballot. Approval voting is phase 2.

Only the platform super admin creates, edits, or schedules a poll. A tally operator (or a platform operator) posts the official tally after close. There is **no live provisional tally**.

## Double counting

`finalWeight(address) ≤ balanceOf(address, closeBlock)`. Summed over distinct addresses, participation is at most the token supply at close. Moving the same tokens to a second address and voting again cannot count them twice. A flash loan that is borrowed and repaid inside one transaction does not change any end-of-block balance, so its weight is zero.

`balance_hold` has no delegation. The address that **holds** the tokens is the one that votes. `erc20_votes` counts delegated power instead, and only at the snapshot. Tokens sitting in a staking contract or a liquidity pool cannot vote unless that contract delegates or signs the ballot. The UI says so.

## Privacy

| | Civic election | Token poll (phase 1) |
| --- | --- | --- |
| Credential | Identity commitment | Token balance, or delegated votes at a snapshot |
| Choice | Hidden (receipt cannot prove it) | Public after the disclosure hour |
| Address | Not the voter id | Public by design |
| Weight | One person | Minimum balance held through close, or `getPastVotes` |
| Zero knowledge | Eligibility without publishing the choice | Poseidon membership of a public `(address, weight)` leaf. Not ballot secrecy |

Address-hiding weighted voting conflicts with hold-through-close, because the tally must watch that address until close. It is not offered.

## Where the token lives

ZK-Voting L2 (chainId **27427**) is a civic JSON sequencer, not an EVM. It cannot hold an ERC-20, and `erc20_votes` does not post to it. Production reads Ethereum mainnet through `TOKEN_RPC_1`. An optional `TOKEN_RPC_1_2` must agree with the first when both are set. The Node never writes to Ethereum. Chain id 31337 is allowed only when `NODE_ENV` is not `production`, for the in-memory fixture. Every other chain id is refused. Tests do not use a public testnet or a live RPC.

## Math

Weights are uint256 base units: `bigint` in memory, decimal strings in JSON. Each poll stores `weighting`:

| `weighting` | Counted weight |
| --- | --- |
| `gross` (default) | The final token weight, unchanged |
| `quadratic` | The integer square root of the whole tokens (`gross / 10^decimals`), rounded down. Dust under one token counts as zero |

Participation and turnout stay in gross units, so turnout is still a share of supply. `quadratic` also publishes `grossCounts` beside the counted `counts`. Abstain is recorded and is left out of the majority.

A plurality poll's `decisionRule` is `simple_majority`: one option wins only when its counted weight is strictly more than half of the non-abstain counted weight (`2 × weight > nonAbstain`). A lead that is short of that is `NO_MAJORITY`. An equal top is `TIE`. Ranked-choice polls still run weighted IRV on the same counted weight. IRV tie breaks match civic IRV (`firstPlaceTieWinner`, `lastPlaceTieEliminated`) without changing `computeIrv`. Outcome order: quorum, then tie, then no majority, then no ballots, then threshold, otherwise a winner.

`pollParamsHash` commits `weighting`, `decisionRule`, the summary, the body, and the tags along with the token and the weight source.

`resultHash` is keccak256 of the canonical result without `resultHash`, `tallyAt`, `tallyBy`, or `l1TxHash`. `ballotsRoot` is a keccak Merkle root of canonical ballot rows sorted by voter.

## Auditor

`zk-voting.auditor.poll.v1` is a separate pack from the civic `zk-voting.auditor.v1`. `tools/auditor verify --offline` checks signatures, one address, choices, the math, `resultHash`, and `ballotsRoot`. With `--rpc` it re-derives every final weight. See [`AUDITOR.md`](./AUDITOR.md).

## L1 mirror (follow-up)

`L1TallyMirror.postResult` keys a **uint256** civic election id. A token poll id is a string, so writing a poll result into that slot would change the existing mirror contract. Phase 1 skips the mirror (`l1Mirror: "skipped"`). Anchoring a poll `resultHash` is a later change.

## Threats

Flash loans, rented tokens, whales, lying RPCs, reorgs, rebasing tokens, and operator tally edits are listed in [`THREAT_MODEL.md`](./THREAT_MODEL.md). Rebasing tokens (balances that move with no `Transfer`) are unsupported; preflight warns. The tally refuses to run until the close block is finalized.

## What phase 1 does not change

No change to `ElectionParams`, the Vote circuit, `BallotInbox`, `Tally`, `VoterRegistry`, civic `vote` validation, or `computeIrv`. Civic elections stay on their existing path.
