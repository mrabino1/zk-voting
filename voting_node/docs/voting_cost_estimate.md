# Expected cost to operate ZK-Voting

**NOT FOR PROFIT** — civic public good. Not a commercial product. Jurisdictions run this **at cost** (hosts, L1 gas). There is no token, no paid tier, and no voter fee. See [`NOT_FOR_PROFIT.md`](./NOT_FOR_PROFIT.md).

**As of:** 23 November 2026, branch `rollup-redesign`. Gas figures are **measured** with
`forge test --gas-report` on ZkVotingRollup; dollars are **estimates** at stated prices.
Recompute with current prices:

```bash
./scripts/get-gas-economics.sh --measure --voters 10000 --ballots 6000 --options 3 --guardians 3
```

Voters pay **nothing**. Polls run on the Node and cost **no gas**. Only civic votes touch
Ethereum, and only after a public ZkVotingRollup deployment exists (see Known limits in the
root README: the batch circuit is not built, so today civic votes run on the local chain only).

---

## 1. Hosting

One small Linux VM with Docker runs the whole stack (Node, L2 operator, Postgres).

| Size | VM | **Estimate** / month |
| --- | --- | --- |
| Demo, club, school | 1–2 vCPU, 1–2 GB | ~$5–20 |
| Town or county | 2–4 vCPU, 4–8 GB | ~$20–80 |

Disk: Postgres plus the operator's state file; a few GB for most jurisdictions. The local chain
(`local-l1` profile) is for testing and is not needed on a public chain.

---

## 2. Ethereum L1: who pays for what

| Account | Pays for |
| --- | --- |
| **Node account** (`ROLLUP_PRIVATE_KEY`, the jurisdiction's clerk) | publishing the election, guardian key-ceremony relays, roll sync, close, decryption-share relays, finalize |
| **Operator** (`OPERATOR_PRIVATE_KEY`) | committing, verifying and executing batches |
| **Shared, once per chain** | deploying ZkVotingRollup and its verifiers |

### Measured gas per call

Median execution gas from the contract tests (3 options, 3 guardians, k = 2). Add 21,000 gas of
intrinsic cost per transaction.

| Call | Median gas | When |
| --- | ---: | --- |
| `createElection` | 384,796 | once per election |
| `commitGuardian` | 1,542,908 | once per guardian |
| `finalizeKey` | 287,128 | once per election |
| `registerVoters` | ~4,950 per voter + calldata | roll sync, before the start (346,611 for 70 voters) |
| `commitBatch` | 105,077 | per batch, plus 16 gas per pubdata byte (69 bytes per ballot) |
| `verifyBatch` | 39,722 | per batch, **mock verifier**; a real proof is budgeted at ~250,000 |
| `executeBatches` | 67,956 | per batch (up to 375,628) |
| `closeElection` | 85,421 | once, after the cutoff |
| `postDecryptionShares` | 3,596,243 | once per guardian, k needed; scales with the option count |
| `finalizeResult` | 260,755 | once (up to 2,009,302) |
| `forceBallot` | 58,011 | only when the operator refuses a ballot |
| `activateDesertMode` / `desertClose` | 48,957 / 813,437 | only if the operator stops serving the queue |

One-time deploy of ZkVotingRollup, `Guardians`, `DesertVerifier` and the batch verifier: about
9.3 million gas (size-based floor).

---

## 3. One civic vote

Model from `get-gas-economics.sh`: 10,000 voters on the roll, 6,000 ballots, 12 hours open,
3 options, 3 guardians, k = 2, a 250,000-gas allowance per batch proof.

| Part | Gas | At 2 gwei, $3,000/ETH | At 20 gwei |
| --- | ---: | ---: | ---: |
| Publish and key ceremony | 5.4 M | ~$32 | ~$324 |
| Roll: 10,000 voters | 54.6 M | ~$328 | ~$3,278 |
| Ballot pubdata: 6,000 × 69 bytes | 6.6 M | ~$40 | ~$397 |
| Batches, fewest (24 full batches of 256) | 12.6 M | ~$76 | ~$757 |
| Close | 0.6 M | ~$4 | ~$38 |
| Decrypt the sum and finalize | 7.5 M | ~$45 | ~$451 |
| **Total, full batches** | **87.4 M** | **~$525** | **~$5,246** |

What drives the bill:

- **The roll.** Enqueueing each voter costs about 5,500 gas; it is the largest line for any
  realistic roll. It is paid once per election.
- **How the operator batches.** Ballots wait up to `L2_BATCH_MAX_WAIT_SECONDS` (default **600**
  off the local chain) for a fuller batch; a full batch, a waiting roll change or close, or an
  approaching cutoff seals at once. With the default, a 12-hour vote has at most 72 ballot batches
  (~38 M gas), instead of the 4,320 (~2.3 billion gas, ~$13,600 at 2 gwei) that sealing every
  10 seconds could reach. The cost is that a receipt reaches "committed" up to 10 minutes later.
- **Guardians and options.** Each guardian's commitment costs ~1.5 M gas and each decryption share
  ~1.2 M gas per option.
- **Ballots** themselves are cheap: ~1,100 gas of pubdata each.

---

## 4. Email (AWS SES)

### SES — what the Node sends (**repo fact**)

When `SES_FROM_ADDRESS` and `AWS_REGION` are set ([configuration](./self-hosting/configuration.md)):

| Mail | Who | Attachment |
| --- | --- | --- |
| 6-digit MFA OTP | Every non-dev sign-in (primary email) | no |
| Vote PIN reset OTP | Forgot-PIN | no |
| Terms of Use PDF | First accept of a given PDF hash (`already_sent_this_hash` otherwise) | yes — raw MIME; SESv2 Simple **cannot** attach (`apps/node/src/mailer.mjs`) |
| Optional hash-only vote receipt PDF | After accept, if the voter emails it | yes, locked PDF |
| Official outcome PDF | After cutoff + final tally; opt-in subscription | yes, locked PDF |

Unset SES → Node still records accepts and **captures** mail in-process (tests). No AWS bill.

There is **no** SES price in this repo. Figures below are **AWS list** as of the [SES pricing page](https://aws.amazon.com/ses/pricing/) fetched 20 September 2026. **Market-variable.** New accounts may land on **Essentials** ($0.16 / 1,000 under 10M) rather than à la carte ($0.10 / 1,000). Attachments: **$0.12 / GB**.

### SES monthly $ (**estimate**)

Assume à la carte **$0.10 / 1,000** plus **$0.16 / 1,000** as an Essentials column. Count ~**3–6 emails per person** in an election month (register MFA, later login MFA, one Terms PDF, optional receipt, one outcome PDF). PDF attachments are tens of KB, not MB — attachment line is **pennies** at these volumes.

| Volume | Emails / month (order of mag.) | À la carte | Essentials | Attachments |
| --- | --- | --- | --- | --- |
| **Small** — ~2,000 people, one poll | ~8k–12k | **~$1** | **~$1.50–2** | **≪ $1** |
| **Medium** — ~50,000 people | ~150k–300k | **~$15–30** | **~$25–50** | **~$0.50–2** |
| Quiet month, officers only | hundreds | **≪ $1** | **≪ $1** | ~0 |

Dedicated IPs, Virtual Deliverability Manager, and Mail Manager are **optional AWS add-ons** this app does not require. Skip them unless deliverability staff asks. Dedicated IP list: **$24.95 / IP / month** (à la carte page).

---

## Token polls (phase 1)

**NOT FOR PROFIT.** Phase 1 posts **no EVM transactions**. Voters pay **$0**. Figures below are **estimates**. Archive-RPC spend is **market-variable**.

| Item | Estimate | Note |
| --- | --- | --- |
| Ballot acceptance | 1 `eth_blockNumber` + 1 `balanceOf` (+1 ERC-1271 `eth_call`) | **Estimate.** Voter pays $0. The Node reads the token chain. |
| Tally per ballot | 2 paged `eth_getLogs` + 1 `balanceOf` per touched block + 1 at close | **Estimate.** Holders who do not move tokens are about 3 calls. Archive RPC is **market-variable**, about $0 to a few dollars per poll. |

The host token is `VOTING_TOKEN_ADDRESS` on Ethereum mainnet (chain id 1). Reads only: no transaction and no spend. `erc20_votes` also reads `getPastVotes` and delegation logs from `VOTING_TOKEN_START_BLOCK`. The holder pays gas only if they send `delegate` themselves. Tests use an in-memory ERC-20 on a local chain and do not spend RPC quota.

---

