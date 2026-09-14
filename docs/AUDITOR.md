# Independent auditor tooling

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

This pack lets an observer, losing candidate, or court **export public election artifacts** and **verify tally / uniqueness invariants offline** without the Node’s private database (`apps/node/data/republic.json`). The Node is allowed to be down. Canonical truth is the chain; the Node may publish a convenience JSON pack of already-public fields.

This is roadmap item 9’s auditor slice. It does **not** replace a Groth16 ceremony or Poseidon hasher.

---

## What is in a bundle (`republic.auditor.v1`)

| Field | Why it is public |
| --- | --- |
| `contracts` | Factory, inbox, election, verifier, registries |
| `roots` | Eligible root, disqualification root, `ballotSpecHash` |
| `window` | `startTime`, `cutoffTime` |
| `acceptedBallots` | Unique nullifiers that count (last ballot per nullifier) |
| `disclosedBallots` | `nullifier`, `ballotHash`, `generation`, superseded hashes — **not** choices |
| `tally` | Posted per-option counts when the election is tallied |
| `coercion` | `last-ballot-counts`; `receiptsProveChoice: false` |

Never in a bundle: civil names, evidence files, trapdoors, option ids, `userId`, relayer private keys.

---

## CLI

From the repository root (Node 22):

```bash
# Verify a JSON file (no network, no Node DB)
node tools/auditor/cli.mjs verify --file bundle.json

# Export from the Node’s *public* HTTP (not republic.json)
node tools/auditor/cli.mjs export-node --base http://127.0.0.1:3000 --election 1 --out bundle.json
node tools/auditor/cli.mjs verify-node --base http://127.0.0.1:3000 --election 1

# Export from chain JSON-RPC (VoteAccepted / VoteSuperseded logs)
node tools/auditor/cli.mjs export-chain \
  --rpc http://127.0.0.1:8545 \
  --factory 0x… \
  --election 1 \
  --out bundle.json

# Print a fixture that already satisfies the invariants
node tools/auditor/cli.mjs fixture
```

Root npm scripts: `npm run auditor -- verify --file bundle.json` and `npm run test:auditor`.

Node convenience route (same JSON the CLI consumes):

```http
GET /api/elections/:id/artifacts
GET /api/config
```

`/api/config` includes public contract addresses when configured. It never includes the relayer key.

---

## Invariants the verifier checks

1. Unique **current** nullifiers (last-ballot-counts: one row per nullifier).
2. `acceptedBallots >=` that unique count (hourly disclosure may hide not-yet-public votes).
3. If `tally.counts` is present, `sum(counts) == acceptedBallots`.
4. A nullifier’s current `ballotHash` is not in its `supersededHashes`.
5. Disclosed rows have no `choice` / `optionId` / `userId`.
6. Receipts cannot prove choice (`coercion.receiptsProveChoice === false` when the field is present).
7. `startTime < cutoffTime`; NFP label; schema id. Contract addresses are included when known (chain export / configured Node); Node-only demo packs may omit them and still check uniqueness and tally.

Same-ciphertext replay is a contract / Node reject (`NullifierUsed`). Auditors see only the surviving `ballotHash`.

---

## How this lines up with last-ballot-counts

Inside `[startTime, cutoffTime)` a voter may submit a **new** proof and ciphertext for the same nullifier. The previous `ballotHash` is marked superseded and cannot be replayed. `acceptedBallots` still counts **people**, not submissions. A receipt lists hashes only; it is not “I voted for X.”

This is **not** MACI. A coercer who holds the voter’s secrets can still race last-write until cutoff. Full collusion-resistant messaging remains later work.

---

## Threat model (auditor vs Node)

A lying Node can omit or delay disclosure (hourly policy) or refuse to serve `/artifacts`. It cannot make `sum(counts) != inbox.acceptedBallots` succeed on chain, and it cannot invent a choice that is not in the ciphertext. Prefer `export-chain` when a JSON-RPC endpoint is available; use `export-node` as a convenience over already-public HTTP.
