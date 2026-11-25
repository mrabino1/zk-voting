# Proposal: one audited L1 contract, many independent L2s

**NOT FOR PROFIT**: civic public good, not a commercial product.

Status: **proposal for the repository owner to review and apply in `smart-contracts/`.** No
`.sol` file was changed. The off-chain pieces that a fork's installer needs (shared settings,
network registry, guided `/setup`) are built so they can adopt this without another redesign;
see [Off-chain changes](#off-chain-changes).

Related: [`smart-contracts/docs/ROLLUP.md`](../../smart-contracts/docs/ROLLUP.md) (the current
design), [`L2-REGISTRY-AND-ELECTION-KEYS.md`](./L2-REGISTRY-AND-ELECTION-KEYS.md) (an earlier
per-L2 registry, superseded 2026-11-23 when everything moved into `ZkVotingRollup`),
[`batch-validity-circuit.md`](./batch-validity-circuit.md).

## The goal

This repository is meant to be forked the way Discourse is. Anyone forks it, deploys
`voting_node` (for example on Coolify with Postgres), and that deployment brings up **its own
new L2**, which did not exist before. One organisation may run 2, 20 or 1,000 of them, and so
may anyone else: thousands, eventually millions, of L2s.

All of them settle on, and are enforced by, **one** audited `ZkVotingRollup` on Ethereum
mainnet, whose source is public in `smart-contracts/`. Nobody's permission is needed to start
one. One L2 that misbehaves or goes offline must not affect any other.

## Why the current contract is one L2

`ZkVotingRollup` today is a single rollup (Lighter / zkSync Lite pattern), not a hub for many:

| State | Where | Effect with many forks |
| --- | --- | --- |
| One batch chain: `totalBatchesCommitted/Verified/Executed`, `executedStateRoot`, `storedBatchHashes` | `ZkVotingRollup.sol:68-73` | Every `commitBatch` must extend the previous one (`:348`). Two independent operators conflict on every batch. |
| One FIFO priority queue: `priorityRequests`, `firstPriorityRequestId` | `:61-66` | Every L1 request from every jurisdiction lands in one queue that one operator must drain in order. |
| One `desertMode` flag | `:74`, `activateDesertMode` `:439` | If the oldest request **anywhere** goes 3 days (`PRIORITY_EXPIRATION`, `:30`) without execution, anyone can freeze the **whole** contract, permanently. One abandoned fork would halt every election on Ethereum. |
| `onlyGovernor` for `setOperator` and `createJurisdiction` | `:132`, `:138` | A fork cannot start without the governor's approval. |
| `revertBatches` for any operator | `:422` | Any approved operator can roll back another's unexecuted batches. |
| Batch commitment has no rollup identity | `:357-370` | `sha256(prevRoot ‖ newRoot ‖ number ‖ timestamp ‖ sha256(pubdata) ‖ …)`. It does not bind an L2 id, the chain id or the contract address. |

The off-chain operator (`voting_node/l2/rollup/`) matches that: it consumes the whole queue,
keeps its own batch chain, and fails forever if anyone else commits (17 single-operator
assumptions, listed in the survey in this PR's description).

## Design

Keep **one contract** (audited once), and make the L2 a first-class, permissionless object
inside it. Everything that is global today becomes **per L2**.

### 1. Registering an L2 (no gatekeeper)

```solidity
struct L2 {
    address admin;            // the fork's own key: manages operators and jurisdictions of THIS L2
    uint64  createdAt;
    bool    desertMode;       // this L2 only
    // batch chain
    uint64  totalBatchesCommitted;
    uint64  totalBatchesVerified;
    uint64  totalBatchesExecuted;
    bytes32 executedStateRoot;
    // priority queue
    uint64  firstPriorityRequestId;
    uint64  totalPriorityRequests;
    uint64  totalCommittedPriorityRequests;
}

bytes32 public constant L2_ID_DOMAIN = keccak256("zk-voting/l2-id/v1");

mapping(bytes32 l2Id => L2) internal _l2s;
mapping(bytes32 l2Id => mapping(address => bool)) public isOperator;
mapping(bytes32 l2Id => mapping(uint64 => PriorityRequest)) public priorityRequests;
mapping(bytes32 l2Id => mapping(uint64 => bytes32)) public storedBatchHashes;

/// Anyone. The id is derived from msg.sender, so copying a pending transaction from the
/// mempool yields a different id: registration cannot be front-run or squatted.
function registerL2(bytes16 l2Uuid, bytes32 salt) external payable returns (bytes32 l2Id) {
    if (msg.value != REGISTRATION_BOND) revert BadBond();          // see "Spam" below
    l2Id = keccak256(abi.encode(L2_ID_DOMAIN, block.chainid, address(this), msg.sender, l2Uuid, salt));
    if (_l2s[l2Id].admin != address(0)) revert L2Exists();
    _l2s[l2Id].admin = msg.sender;
    _l2s[l2Id].createdAt = uint64(block.timestamp);
    isOperator[l2Id][msg.sender] = true;                            // a one-key fork works out of the box
    emit L2Registered(l2Id, msg.sender, l2Uuid);
}

function setOperator(bytes32 l2Id, address operator, bool active) external onlyL2Admin(l2Id);
function transferL2Admin(bytes32 l2Id, address next) external onlyL2Admin(l2Id);   // two-step, like the governor
```

The empty L2's genesis state root is the same constant for every L2 (the empty election tree),
so it is not a parameter anyone can get wrong.

### 2. Jurisdictions and elections belong to one L2

- `createJurisdiction(l2Id, jurisdictionId, admin, name)`: **the L2's admin**, not the governor.
  The stored key is `(l2Id, jurisdictionId)`, so two forks can both call their county
  `keccak256("county-of-x")` without colliding.
- `ElectionConfig` gains `bytes32 l2Id`. `createElection` checks the clerk against
  `(l2Id, jurisdictionId)` and enqueues `CREATE_ELECTION` on **that L2's** queue.
- Election ids: keep the global `uint32 electionCount` (simplest; 4.29 billion elections), and
  store `l2Of[electionId]`. Every election entry point (`registerVoters`, `disqualify`,
  `forceBallot`, `closeElection`, guardian calls, `finalizeResult`) reads the L2 from the
  election, so their signatures do not change. Alternative: per-L2 ids plus an
  `electionKey = keccak256(l2Id, localId)`; it is cleaner for the L2 state tree (which is keyed by
  election id, `ELECTION_TREE_DEPTH = 32`) but changes every signature. **Open question 2.**

### 3. Batches are per L2, and bound to it

`commitBatch(l2Id, last, next)`, `verifyBatch(l2Id, batch, proof)`,
`executeBatches(l2Id, batches, onchainOps)` and `revertBatches(l2Id, newLast)` work on
`_l2s[l2Id]`'s chain and queue only. `onlyOperator` becomes `onlyOperatorOf(l2Id)`.

The batch commitment (today `ZkVotingRollup.sol:357-370`) must bind the L2 so a valid proof for
one L2 can never be replayed on another, or on a fork of the contract on another chain:

```
commitment = sha256(l2Id ‖ block.chainid ‖ address(this) ‖ prevStateRoot ‖ newStateRoot ‖ batchNumber
                    ‖ timestamp ‖ sha256(pubdata) ‖ priorityOpsHash ‖ onchainOpsHash) & (2²⁵³ − 1)
```

The batch validity circuit (not built yet, [`batch-validity-circuit.md`](./batch-validity-circuit.md))
keeps the single public input `commitment`; only the hashing outside the circuit changes. One
verifier and one trusted-setup ceremony serve every L2.

### 4. Desert mode per L2

`activateDesertMode(l2Id)` checks **that L2's** oldest request and freezes **that L2** only.
`desertClose` takes `l2Id` and proves against that L2's `executedStateRoot`. An abandoned fork
strands its own unfinished elections (exactly as today's single rollup would) and nobody
else's. This is the property that makes "thousands of L2s on one contract" safe.

### 5. What the governor keeps

Nothing that touches an L2. Today the governor "cannot touch an election, a roll, a ballot or a
result" (`ROLLUP.md`); under this design it also cannot approve or refuse an L2, an operator or
a jurisdiction. Recommendation: **no governor at all** in the mainnet deployment, with the
verifier fixed at construction (as `batchVerifier` and `desertVerifier` already are,
`ZkVotingRollup.sol:39-40`). If a role is kept, limit it to emergency-free bookkeeping, and
document it. **Open question 1.**

### 6. Spam

Registration and per-L2 storage cost the registrant gas, which already prices out free spam.
A small refundable bond (`REGISTRATION_BOND`, returned when the admin closes an L2 with no
open elections) would additionally deter mass registration; `0` is acceptable for v1.
Unlike the single queue today, a spammed L2's queue cannot block anyone else's.
**Open question 3.**

## Off-chain changes

Already in this PR (they work today, with the current single-L2 contract):

- `voting_node/packages/chain-client/networks.json`: the networks `/setup` offers, with the one
  shared contract address per network. A fork never types a chain id or an address; it merges
  upstream to learn new deployments.
- `voting_node/packages/chain-client/install.js` and the `install` volume: `/setup` saves the
  choice (`voting.json`) and generates this deployment's node and operator keys on the server.
- `/setup` step 6, "How civic votes are counted": polls only, the built-in test chain, or a
  public network, with RPC chain-id checking and the accounts to fund. Under today's contract it
  tells the person the governor must approve their operator (`joinPolicy: "governor-approval"`).

When this proposal lands, in order:

1. `networks.json`: set `joinPolicy: "permissionless"` and the new contract address per network.
2. `/setup` step 6 gains one button, **Register this site's L2**: the node key calls
   `registerL2(l2Uuid, salt)` (both generated and kept in `voting.json`), waits for the receipt,
   and stores `l2Id`. Then **Create your jurisdiction** calls `createJurisdiction(l2Id, …)` with
   the node key as its admin and clerk. No governor, no email, no waiting.
3. `install.js` fills `ROLLUP_L2_ID` for node and l2 from `voting.json` (an explicit variable
   still wins).
4. `voting_node/l2/rollup/`: filter every L1 log and request by `l2Id`
   (`l1.mjs` `requestsBetween`, `genesis`), keep the batch chain per `l2Id`
   (`operator.mjs` `this.last`, `nextRequest`), read `desertMode(l2Id)`, key the state file by
   `(rollup, l2Id)`, and compute the commitment with the new prefix.
5. `apps/node/src/rollup/`: pass `l2Id` in `createElection`; check that the L2 operator at
   `L2_URL` reports the same `l2Id` before sending ballots; bind ballots to
   `{chainId, rollup, l2Id}`.
6. Docs: `ROLLUP.md`, `L2_VPS_SETUP.md`, `forking.md`, `ARCHITECTURE.md` and
   `ROLLING_UPDATES.md` stop saying "ask the governor for a jurisdiction" and "one operator".

Several L2s on one host is then just several deployments, each with its own `install` volume.

## Migration

None needed: no `ZkVotingRollup` is deployed on a public network yet (root `README.md`,
"Canonical contract address"). Apply this before the first mainnet deployment.
`DeployLocal.s.sol` registers one L2 for the built-in test chain and writes its `l2Id` into
`deployments/local.json`, so the local stack keeps working unchanged.

## Tests to add (Foundry)

- Two L2s commit, verify and execute interleaved batches; neither can commit to, revert, or
  execute the other's chain.
- A proof valid for L2 A fails for L2 B, for the same L2 on another contract address, and on
  another chain id.
- L2 A's expired request lets anyone freeze A; B keeps working; `desertClose` on A cannot touch B.
- `registerL2` from a copied transaction (different `msg.sender`) yields a different id.
- Jurisdiction ids collide across L2s without conflict; a clerk of A cannot create an election in B.
- Invariant: for every L2, `firstPriorityRequestId ≤ totalCommittedPriorityRequests ≤ totalPriorityRequests`
  and `totalBatchesExecuted ≤ totalBatchesVerified ≤ totalBatchesCommitted`.

## Open questions for the owner

1. Keep a governor at all on mainnet? If yes, which powers, and are they time-locked?
2. Global `uint32` election ids with `l2Of[]` (no signature changes) or per-L2 ids with an
   election key (cleaner state tree, every signature changes)?
3. Registration bond: `0`, or a small refundable amount?
4. Should an L2 admin be able to hand the L2 to a new admin (`transferL2Admin`)? Recommended yes,
   two-step, so a fork can rotate a compromised or lost key before it holds funds.
5. Per-L2 gas: today the node and operator each need ETH. Should `registerL2` let the admin name
   a separate payer for batches, so one funded account can serve several of its own L2s?
