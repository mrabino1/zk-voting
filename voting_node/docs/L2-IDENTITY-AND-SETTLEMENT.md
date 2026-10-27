# L2 identity, election keys, and anti-disruption

NOT FOR PROFIT — civic public good.

Anyone can run their own L2, and each L2 can run as many elections as it wants.
This page explains how they stay unique, how votes reach L1, and what stops
other people from disrupting them. The L1 contract changes are a proposal in
`docs/proposals/L2-REGISTRY-AND-ELECTION-KEYS.md` (repo root). Matthew applies
them by hand in `smart-contracts/`.

## Identity

| Name | What it is | Unique where | Code |
|---|---|---|---|
| `L2_UUID` | Random UUID chosen by the operator | Human label | `l2/identity.mjs` `mintUuid` |
| `L2_SALT` | 32 random bytes, **secret until L1 registration** | — | `mintSalt` |
| `l2Id` | `keccak256(abi.encode(L2_ID_DOMAIN, operator, bytes16(L2_UUID), L2_SALT))` | Globally (L1 registry) | `computeL2Id` |
| `electionUuid` | The Node election id (UUID) | Per L2, enforced by the sequencer | `state.mjs` `_assertAdmitted` |
| `electionKey` | `keccak256(abi.encode(ELECTION_KEY_DOMAIN, l1ChainId, l2Id, bytes16(electionUuid)))` | Globally | `computeElectionKey` |

`operator` is the address of `L1_SUBMITTER_PRIVATE_KEY`. Domain tags are
`keccak256("zk-voting/l2-id/v1")`, `"zk-voting/election-key/v1"`,
`"zk-voting/state-root/v1"`, `"zk-voting/vote-batch/v1"`. All hashes use
`abi.encode` over static words, so Solidity computes the same values
(tests cross-check with viem: `l2/test/identity-admission.test.mjs`).

Two L2s can reuse the same election UUID: their `l2Id`s differ, so the
`electionKey`s differ. The same L2 cannot open a UUID twice.

## Setup (operator)

The guided setup does all of this for you: `./setup.sh` (step 6) asks for `L1_RPC`
and `L1_SUBMITTER_PRIVATE_KEY` (hidden), mints `L2_UUID`, `L2_SALT` and
`L2_ADMIN_SECRET` when they are missing (kept on every re-run), derives and pins
`L2_OPERATOR_ADDRESS` and `L2_ID`, and checks the submitter balance with a warning
when it is low or empty. It writes them to `voting_node/.env` and never prints a secret.
The `/setup` page (step "L2 identity and L1 funding") shows the public half from
`GET /api/l2/identity?funding=1`. By hand:

```bash
npm run l2:identity -- init            # prints L2_UUID, L2_SALT, L2_ADMIN_SECRET (store as secrets)
# set L1_SUBMITTER_PRIVATE_KEY (secret) and L1_RPC
npm run l2:identity -- show            # l2Id, operator; pin L2_ID and L2_OPERATOR_ADDRESS
npm run l2:identity -- check-funding   # balance vs. batch cost
```

Env (`voting_node/.env.example`): `L1_SUBMITTER_PRIVATE_KEY` (secret), `L1_RPC`,
`L1_SUBMITTER_MIN_BATCHES` (20), `L1_SUBMITTER_GAS_PER_BATCH` (250000),
`L2_UUID`, `L2_SALT` (secret), `L2_ID`, `L2_OPERATOR_ADDRESS`,
`L2_ADMIN_SECRET` (secret), `L2_ADMISSION` (`strict` in Compose),
`L2_WRITE_RATE_PER_MIN`, `L2_CIVIC_RPC`, `L2_REGISTRY_ADDRESS` (TBD).
`./setup.sh` collects these; `/setup` shows the public ones and the funding level.

## Who pays

- Voters pay nothing on the L2. There is no gas and no token.
- The operator's `L1_SUBMITTER_PRIVATE_KEY` pays L1 gas for each batch. Keep a
  little ETH on it, not a lot.
- The prover checks the balance at start and every 5 minutes
  (`l2/prover/funding.mjs`): `ok`, `low` (warn), `empty` (cannot pay for one
  batch: the prover holds batches, the cursor does not move, nothing is lost).
- `GET /api/l2/identity?funding=1` shows the same check.

## Admission (strict mode)

The L2 is free to use, so the sequencer must refuse what the operator did not
approve (`l2/sequencer/state.mjs` `_assertAdmitted`):

1. Admin txs (`election_open`, `register`, `disqualify`, `tally`, `party_*`,
   `poll_params`, `poll_tally`) need `auth.mac = HMAC-SHA256(L2_ADMIN_SECRET,
   domain | chainId | L2_UUID | canonical body)` (`l2/adminAuth.mjs`). A MAC for
   another L2 or a changed body fails. Exact replays have the same tx hash and
   are dropped. Do not include keys that `stripForbidden` removes (for example
   `name`); the MAC is checked on the stripped body.
2. `election_open` needs a UUID that does not exist yet on this L2.
3. `register`, `vote`, `disqualify`, `tally`, `userop` need an opened election UUID.
4. A `vote` must name an `eligibleRoot` the operator approved for that
   election (in `election_open` or a `register`). Votes are anonymous, so
   "approved" means "proves membership in the approved set", and the existing
   nullifier index stops double votes.
5. A `userop` needs a `sender` in the election's `approvedSenders`. Raw
   non-JSON bytes have no election and are rejected.

The prover re-checks rules 1–3 on every batch (`l2/prover/admission.mjs`) and
fails closed. `L2_WRITE_RATE_PER_MIN` adds a per-client write budget on the
RPC (off by default because the Node relays all votes from one address; turn
it on when `:8546` is public). `L2_ADMISSION=open` keeps the old behaviour for
local tests only.

## Settlement

Each batch now carries `settlement`:

```
prev  = last accepted root (cursor.lastSettlementRoot, or genesis)
new   = keccak256(abi.encode(STATE_DOMAIN, l2Id, prev, keccak(publicData)))
data  = keccak256(abi.encode(uint64 batchIndex, prev, new))   // RollupSettlement today
```

`publicData` includes `identity {l2Uuid, l2Id, l1ChainId}` and
`elections [{electionUuid, electionKey, votes, registered, tally}]`, so every
batch says which L2 and which elections it moves. With the proposed registry,
the batch digest also binds `l1ChainId` and the registry address.

Upgrade note: a live L1 deployment that had accepted batch 0 under the old
values has a different `stateRoot`; start a fresh RollupSettlement (or the
proposed registry) before submitting under the new scheme.

## Dashboard: outcome from L2 or L1

`GET /api/l2/:l2Id/elections/:electionUuid/results?source=auto|local|l2|l1`

- `local`: this Node's store (only when `:l2Id` is this L2).
- `l2`: `zkv_l2Identity` (checks the `l2Id` matches) then `zkv_getElection`
  on `L2_CIVIC_RPC`: opened block, eligibility roots, counts, tally hashes.
- `l1`: `resultOf(electionKey)` on `L1_TALLY_MIRROR_ADDRESS`. Until the
  canonical addresses exist this returns 503 `l1-addresses-tbd` with the
  computed `electionKey`.
- `auto` tries local, then L2, then L1.

New L2 RPC methods: `zkv_l2Identity`, `zkv_getElection(uuid)`, `zkv_listElections`.

## Anti-disruption summary and tradeoffs

| Attack | Defence | Tradeoff |
|---|---|---|
| Squat an L2 id on L1 / front-run registration | `l2Id` includes `msg.sender` and a secret salt; registry derives it from `msg.sender` | Lose the key, lose the id (rotate submitter is allowed, the id stays) |
| Squat an election on L1 | `openElection` only by the submitter of the owning `l2Id`; key includes `l2Id` | One L1 tx per election |
| Forge a batch for someone else's L2 | Registry accepts batches for `l2Id` only from its submitter | Submitter key is a hot key: keep little ETH on it |
| Replay a batch (same or other chain/L2) | `batchIndex == next`, `prev == last root`, digest binds chainId + registry + l2Id | Batches must be strictly sequential |
| Spam the free L2 | Strict admission: HMAC admin writes, opened UUIDs only, approved roots/senders only; optional per-IP rate limit | Shared `L2_ADMIN_SECRET` between Node and sequencer; leak = admin forgery until rotated |
| Spam L1 with fake L2s | Each registration costs gas; optional bond in the proposal | A bond excludes poor operators; default 0 |
| Spam an election with junk electionKeys in a batch | Registry requires `electionOwner[key] == l2Id` | Elections must be opened on L1 before votes settle |
| Operator runs out of ETH | Funding check warns, then holds batches | Votes still collect on L2; settlement waits |

Residual risk: the operator itself can censor or fake an L2 until real
validity proofs replace `mockMode`; observers can still rebuild from L2 data.
