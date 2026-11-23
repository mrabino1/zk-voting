# Independent auditor tooling

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

This pack lets an observer, losing candidate, or court **export public election artifacts** and **verify tally / uniqueness invariants offline** without the Node’s private database (`apps/node/data/zk-voting.json`). The Node is allowed to be down. Canonical truth is the chain; the Node may publish a convenience JSON pack of already-public fields.

It does **not** replace a trusted-setup ceremony.

---

## Civic votes: `verify-rollup`

A civic vote is audited from Ethereum alone. Give it an RPC, the ZkVotingRollup address and the
L1 election id (`rollupElectionId`); it needs neither the Node nor the L2 operator:

```bash
node tools/auditor/cli.mjs verify-rollup --rpc "$L1_RPC" --rollup 0x… --election 4 [--from-block N]
```

It re-derives what the contract checked (`tools/auditor/rollup.mjs`):

| Check | How |
| --- | --- |
| `ballots.pubdata`, `ballots.count` | Decodes every executed batch's pubdata from its `commitBatch` calldata, counts the election's ballots once per nullifier (accepted forced ballots included, replacements counted once), and compares with the ballot count L1 stored at close. |
| `key.joint` | The joint key equals the sum of the constant terms of the guardians' Feldman commitments (dealers in good standing). |
| `floor` | **Withheld** exactly when the ballot count is below `minBallots`. |
| `result.sum`, `result.hash` | The certified counts add up to the ballot count, and `keccak256(abi.encode(chainid, rollup, electionId, counts))` matches. |
| `result.shares` | Every k-subset of the guardians who posted decryption shares (up to 64 subsets) opens the final encrypted sum to the certified counts. |

Exit status `0` when every check passes, `2` when one fails. Before the vote closes it reports the
ballots so far and skips the result checks. Nothing it reads can reveal a choice: it sees the final
sum and the shares of it, never a ballot.

---

## Polls: bundles

---

## What is in a bundle (`zk-voting.auditor.v1`)

| Field | Why it is public |
| --- | --- |
| `contracts` | Factory, inbox, election, verifier, registries |
| `roots` | Eligible root, disqualification root, `ballotSpecHash` |
| `window` | `startTime`, `cutoffTime` |
| `acceptedBallots` | Unique nullifiers that were accepted (one ballot each) |
| `disclosedBallots` | `nullifier`, `ballotHash` — **not** choices, not re-vote generations |
| `tally` | Posted per-option counts when the election is tallied |
| `coercion` | `one-ballot-per-nullifier`; `receiptsProveChoice: false` |

Never in a bundle: civil names, evidence files, trapdoors, option ids, `userId`, relayer private keys, `supersededHashes`.

---

## CLI

From the repository root (Node.js 24.7 or newer):

```bash
# Verify a JSON file (no network, no Node DB)
node tools/auditor/cli.mjs verify --file bundle.json

# Export from the Node’s *public* HTTP (not zk-voting.json)
node tools/auditor/cli.mjs export-node --base http://127.0.0.1:3000 --election 1 --out bundle.json
node tools/auditor/cli.mjs verify-node --base http://127.0.0.1:3000 --election 1

# Print a fixture that already satisfies the invariants
node tools/auditor/cli.mjs fixture
```

Root npm scripts: `npm run auditor -- verify --file bundle.json` and `npm run test:auditor`.

Node convenience route (same JSON the CLI consumes):

```http
GET /api/elections/:id/artifacts
GET /api/config
GET /api/outcomes
GET /api/outcomes/:id
```

`/api/config` includes public contract addresses when configured. It never includes the relayer key.

---

## Invariants the verifier checks

1. Unique nullifiers (one disclosed row per nullifier). Duplicate rows fail.
2. `acceptedBallots >=` that unique count (hourly disclosure may hide not-yet-public votes).
3. Tally: if `tally.questions` lists plurality aspects, each aspect’s counts must respect `acceptedBallots` (undervotes allowed; a concatenated multi-question vector is **not** a unique-voter sum). If only a legacy flat `tally.counts` vector is present, `sum(counts) == acceptedBallots`. Solidity `Tally` still assumes that single-vector invariant.
4. Disclosed rows have no `choice` / `optionId` / `userId`.
5. No linkage artifacts: non-empty `supersededHashes` or `generation != 1` fail. The pack shows one current ballot hash per nullifier.
6. Receipts cannot prove choice (`coercion.receiptsProveChoice === false` when the field is present). If `coercion.policy` is present it must be `one-ballot-per-nullifier`.
7. `startTime < cutoffTime`; NFP label; schema id. Contract addresses are included when known; Node-only packs may omit them and still check uniqueness and tally.

The Node rejects a second ballot for a nullifier (`NULLIFIER_USED`) unless re-vote is enabled for a poll, and keeps one current `ballotHash` per nullifier. Double voting remains impossible. Auditors do not see a previous hash or a marker that ties two ballots together.

---

## How this lines up with the coercion slice

Voters may change their mind **privately** on the ballot form before submit. After a nullifier is accepted they **cannot** recast. Last-vote-counts / re-vote supersession is **not** implemented. A receipt lists hashes only; it is not “I voted for X,” and it is not a second ballot.

This is **not** MACI. Full collusion-resistant messaging remains later work.

---

## Threat model (auditor vs Node)

A lying Node can omit or delay a poll's disclosure or refuse to serve `/artifacts`; a poll pack is only as good as the Node that serves it. A civic vote does not depend on the Node: `verify-rollup` reads L1 directly.

The Node also hosts `/outcomes`, which runs `verifyAuditorBundle` plus freeze-root and L1 hash checks for every election and groups them before / during / after voting from chain status. That page is a convenience monitor, not a substitute for an independent export.

---

## Token polls (`zk-voting.auditor.poll.v1`)

**NOT FOR PROFIT.** A token-poll pack is not a civic election pack. It lists the poll parameters, disclosed ballots (address, choice, signature, weight evidence), and the official result. It has no `userId` and no nullifier.

```bash
node tools/auditor/cli.mjs verify --file poll-bundle.json --offline
node tools/auditor/cli.mjs verify --file poll-bundle.json --rpc "$TOKEN_RPC_1"
```

`--offline` checks signatures, one row per address, choices, weighted math, `resultHash`, and `ballotsRoot`. `--rpc` re-derives each final weight from the token chain. Civic `verifyAuditorBundle` is unchanged. The Node route is `GET /api/polls/:id/artifacts` when `POLLS_ENABLED=1`.
