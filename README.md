# zk-voting (Republic)

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`NOT_FOR_PROFIT.md`](./NOT_FOR_PROFIT.md).

A monorepo for a **zero-knowledge, Ethereum-settled voting system**. Product name: **Republic**. Repo name: `zk-voting`.

This repository holds two tightly coupled pieces of software (and the circuits, L2, and packages that bind them):

1. A **Node application** (same operational shape as [DealPunchList](https://dealpunchlist.com) / `dealpunchlist-node`): the product surface for voters, election officials, and public observers (`apps/node`).
2. A **`smart-contracts/`** package: Solidity for Ethereum that registers voters, opens ballots, records (or commits to) votes with zero-knowledge proofs, and **enforces disqualification** so that a person who is on the roll can still be barred from a given election for jurisdiction-defined reasons.

The same **Solidity** is meant to run **on Ethereum mainnet (L1)** and on any EVM venue a jurisdiction chooses (Lighter, other L2s, Foundry Anvil). Cheap, high-volume civic activity in *this* repo lands on **Republic L2** (this repo’s civic JSON sequencer + prover, **chainId 27427**), in the same family of design as [Lighter](https://lighter.xyz): prove the operations, settle proofs and state to Ethereum. Canonical law, final tallies, and dispute-grade records can live on L1, or be mirrored there.

Republic L2 **as implemented** is an application-specific civic sequencer (JSON transactions: register / vote / disqualify / tally / userop). It is **not** a general-purpose EVM and it does **not** proxy to Anvil. Portable EVM bytecode still deploys to Anvil, Ethereum L1, Lighter’s EVM surface, and other EVM L2s. Executing that bytecode *on* 27427 is **Future**.

**Status:** this repository is an **implemented monorepo**. Circuits, shared packages, Foundry contracts, Node app, civic L2, and operator docs are in-tree. `test/unstable` is the development line. `master` is production only.

How to read this README:

- **Product intent** (privacy, disqualification, roles) is the spec for what Republic is for.
- **Implemented today** (status table, how to run, Node/L2 sections) must match the tree. If those paragraphs lie, this file is overdue.
- **Future** work is labeled. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) is the package map and Solidity/circuit interface contract.

---

## Not for profit

This software is **not a commercial product**. It exists to protect and preserve a republic driven by democracy: the people vote for representatives, and those representatives vote. A city, county, state, nation, union, cooperative, or (if a jurisdiction demanded it) a shareholder meeting should be able to run a binding election with **public verifiability** and **private ballots**.

- There is **no token**. There is **no paid tier**. There is **no vendor lock-in**.
- Nobody is to make money off this repository. Jurisdictions may run it **at cost** (hosts, paymaster gas, paper notice).
- Voter data is not a product. Gas sponsorship is not a fee.
- Every document in this repo carries a visible **NOT FOR PROFIT** label. Solidity files carry `// NOT FOR PROFIT — civic public good, not a commercial product.`

If you want to get rich, this is the wrong repository. Full charter: [`NOT_FOR_PROFIT.md`](./NOT_FOR_PROFIT.md). License: AGPL-3.0-or-later.

---

## Table of contents

- [Not for profit](#not-for-profit)
- [Purpose](#purpose)
- [Who it is for](#who-it-is-for)
- [What “zero-knowledge voting” means here](#what-zero-knowledge-voting-means-here)
- [Current status](#current-status)
- [Monorepo layout](#monorepo-layout)
- [How to run](#how-to-run)
- [Node application](#node-application)
- [Smart contracts](#smart-contracts)
- [Circuits](#circuits)
- [Shared packages](#shared-packages)
- [Chains: Ethereum L1, Republic L2, and Lighter](#chains-ethereum-l1-republic-l2-and-lighter)
- [Registration](#registration)
- [Eligibility, disqualification, and due process](#eligibility-disqualification-and-due-process)
- [Ballots and “voting on aspects”](#ballots-and-voting-on-aspects)
- [Election types and jurisdictions](#election-types-and-jurisdictions)
- [Roles](#roles-and-permissions)
- [End-to-end flows](#end-to-end-flows)
- [Privacy, coercion resistance, and public verifiability](#privacy-coercion-resistance-and-public-verifiability)
- [Security and threat model](#security-and-threat-model)
- [What this system will not do](#what-this-system-will-not-do)
- [Development](#development)
- [Roadmap](#roadmap)
- [Glossary](#glossary)
- [Related work](#related-work)
- [Legal note](#legal-and-policy-note)

---

## Purpose

Democratic processes still depend on a small set of trusted operators: who is on the roll, who was turned away, whether a ballot was counted, and whether the published result matches the ballots. Paper and proprietary machines can work. They do not, by themselves, let a voter, a losing candidate, or a court **verify** those claims without re-trusting the same operators.

This project exists to make those claims **checkable**:

- A person can **register to vote** for a jurisdiction (a city, a district, a nation, a private body that still wants an election-grade process).
- That person can **cast a ballot** on one or more questions (“aspects”) in an election.
- The public can verify that **only eligible people voted, at most once**, and that the **tally is the sum of those ballots**.
- Election officials can still **disqualify** a registered person when the law or the body’s rules require it (death, non-residency, duplicate identity, court order, already voted, and other coded reasons). Disqualification is an on-chain, auditable state change — not an invisible database flag.
- A voter’s **choice** is not published. Eligibility and “this person already voted / is barred” are.

The Node app is how humans do that work. The contracts are how Ethereum (L1 and L2) enforces it.

---

## Who it is for

| Audience | What they do here |
| --- | --- |
| **Voters** | Register, see whether they are eligible or disqualified, cast a ballot, keep a receipt that does not reveal their choice. |
| **Election officials / clerks** | Stand up an election, define the roll and the questions, apply and reverse disqualifications, publish results. |
| **Jurisdictions** | A government, a county, a nation, a union, a board — any body that needs a roll, a ballot, and a binding result. |
| **Candidates and observers** | Watch the public state: how many registered, how many disqualified (and on what coded grounds), hourly published ballot counts, the proven tally. |
| **Auditors and courts** | Reconstruct the election from chain data, proofs, and the Node’s published artifacts without trusting a vendor’s black box. |

The product is **not** limited to national general elections. The same machinery should cover a municipal referendum, a legislative internal vote, or a professional body’s election, as long as someone is willing to run the jurisdiction and accept the legal consequences.

---

## What “zero-knowledge voting” means here

Zero-knowledge is used so that the chain can check **facts about a voter** without putting the **ballot** (and, where the jurisdiction requires it, the voter’s civil identity) in the clear.

The properties we are aiming for:

1. **Eligibility.** A vote proof is only valid if the prover is in the current eligible set for that election.
2. **Disqualification.** Being registered is not enough. If the person is on the disqualification set for that election (or that question), the same circuits must reject the vote.
3. **One counted ballot per eligible person** (or one per question, depending on the election rules), via nullifiers. Each nullifier is accepted **once**. A second ballot — including a new ciphertext — is rejected (`NullifierUsed`). Double voting is impossible. Voters may change their mind privately on the ballot form **before** submit.
4. **Hidden choice.** The option selected is not an on-chain plaintext field anyone can read from the transaction.
5. **Public tally.** After the poll closes, anyone can check a proof that the published totals match the accepted ballots.
6. **Public process.** Registration events, disqualification actions, poll parameters, and final tallies are attributable to known roles (jurisdiction, clerk, registrar).

Zero-knowledge does **not** mean “nobody is in charge.” Someone still maintains the legal roll. ZK means that once that roll and the disqualification list are committed, **counting and eligibility checks are not a second trust sink**.

Privacy construction (implementation): a person uniquely identifies with a **passkey**, a **Web3 wallet**, or a **smart-card digital ID**. Several ETH addresses may be verified internally; only one is active. WebAuthn **PRF** derives a secp256k1 smart-account key **and**, under a separate domain, `(identityTrapdoor, nullifierSecret)`. The Merkle leaf is the identity commitment, never the active wallet address. The vote transaction is submitted by a **bundler**; the paymaster pays L2 gas. Public dashboards publish vote proofs **once an hour**, after that hour closes, so a person leaving a voting office cannot be matched to a live jurisdiction tick. See [Person identity](./docs/IDENTITY.md), [Passkeys](./docs/PASSKEYS.md), and [ARCHITECTURE](./docs/ARCHITECTURE.md).

---

## Current status

Code is **present** in this monorepo. Local **unit tests** use Foundry `MockVerifier` until Poseidon + a real Groth16 ceremony exist. The **first proving path is in progress**: compile / untrusted local setup / export scripts are in-tree. That is not a production ceremony.

| Area | State |
| --- | --- |
| This README | Product intent + honest stack (must match the tree) |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Implemented map + Solidity/circuit interfaces; **Future** labeled |
| Node application (`apps/node`) | Express 4 API + **vanilla JS** pages in `public/`. JSON store `apps/node/data/republic.json`. **No Vite, no React, no SQLite.** `system_actions.sh` |
| `smart-contracts/` | In-tree (Solidity 0.8.24, Foundry `via_ir = true`: factory, registries, inbox, `Tally.sol`, account, L2 settlement) |
| Circuits (`circuits/`) | In-tree (`vote.circom`, `tally.circom`, `identity.circom`; hasher **gated** as `standin-v0`; Poseidon not wired) |
| Proving path | **In progress** — `npm run circuits:status` / `compile` / `setup` / `export` / `prove`. Untrusted local ptau only. `MockVerifier` still default for `forge test`. |
| Shared packages | `@zk-voting/types`, `proof-helpers`, `chain-client` |
| Republic L2 (`l2/`) | Civic JSON sequencer + prover, chainId **27427**, JSON-RPC **:8546**, L1 `RollupSettlement`. **Not** an Anvil EVM proxy |
| Block explorer | Node `/explorer` over `l2-chain.json` + ingest API; see [`docs/BLOCK_EXPLORER.md`](./docs/BLOCK_EXPLORER.md) |
| Passkeys | WebAuthn PRF helper; demo address is `republic-local-address` (not production secp256k1). [`docs/PASSKEYS.md`](./docs/PASSKEYS.md) |
| Person identity | Passkey / Web3 / smart card; one active ETH address. [`docs/IDENTITY.md`](./docs/IDENTITY.md) |
| Tally that opens ballots | **Demo slice in-tree.** `tallyScheme=opens_ballots` encrypts choices to a P-256 tally pubkey (threshold-1 operator key, **NON-PRODUCTION**). Node decrypts accepted envelopes and rejects invented `counts[]`. Legacy `sum_only` still allows any partition of `acceptedBallots`. Not MACI / not production guardians. |
| Coercion slice | One accepted nullifier + hash-only receipts (not MACI, not last-vote-counts). |
| Independent auditor | `tools/auditor` + [`docs/AUDITOR.md`](./docs/AUDITOR.md); no Node private DB |
| Ballot types | UI: `YES_NO`, `SINGLE_CHOICE`, `MULTI_CHOICE`, `RANKED` (IRV), `MEASURE`, `ARTICLE`. |
| Voter info pages | `/elections/:id/info` and `/elections/:id/info/:questionId/:optionId` (vanilla JS) |
| Results page `/elections/:id/results` | Linked from explorer / back-office / voter SPA |
| Production deployment | None on `master` until a jurisdiction pins addresses. `master` is reserved for it. |

---

## Monorepo layout

Current layout (names can still move slightly; the invariants will not).

```text
zk-voting/
  README.md                    ← you are here (spec + how to run)
  NOT_FOR_PROFIT.md
  LICENSE                      AGPL-3.0-or-later
  CONTRIBUTING.md
  system_actions.sh            host/operator menu (DealPunchList pattern)
  package.json                 npm workspaces
  docker-compose.yml           Node + L2 host path
  docs/
    ARCHITECTURE.md            implemented map + Solidity/circuit interfaces
    OPERATOR.md
    BLOCK_EXPLORER.md
    PASSKEYS.md
    IDENTITY.md
    L2.md
    AUDITOR.md                 independent export + verify (no Node private DB)
  apps/
    node/                      Express API + vanilla JS pages (public/)
  packages/
    types/                     JSDoc: ElectionParams, VoteEnvelope, Block, Jurisdiction
    proof-helpers/             publicInputs [root, disqRoot, nullifier, ballotHash, electionId]
    chain-client/              getFactory, createElection, submitVote (viem or eth_call)
  smart-contracts/             Foundry, Solidity 0.8.24, via_ir = true
    src/
    test/                      unit, fuzz, invariant
    script/                    DeployLocal, DeployL1, DeployL2, CreateElection
  circuits/                    vote.circom, tally.circom, identity.circom, HASH_SCHEME.md
  l2/                          civic JSON sequencer, prover, genesis (chainId 27427, :8546)
  tools/auditor/               CLI: export public artifacts, verify sum/invariants
```

Invariants:

- **One repo** for the voting product, the Node host, the contracts, the circuits, and the L2.
- **`smart-contracts/`** is the Solidity home. It is not buried inside the Node app.
- The Node app talks to those contracts. It does not become a second, private source of election truth.

---

## How to run

Operator narrative: [`docs/OPERATOR.md`](./docs/OPERATOR.md). Branch policy: work on **`test/unstable`**; **`master`** is production.

### Foundry tests (`smart-contracts/`)

Requires [Foundry](https://book.getfoundry.sh/) (`foundryup`). solc **0.8.24**, optimizer on, **`via_ir = true`**, fuzz 256 runs (`foundry.toml`).

```bash
cd smart-contracts
forge test --via-ir
forge test --via-ir --fuzz-runs 256
forge test --via-ir --match-path test/invariant/*

# from repo root
npm run test:contracts
npm run test:fuzz
npm run test:invariant
```

Tests must pass with `MockVerifier`. Invariants include: a nullifier is **accepted at most once** (a second ballot, including a new ciphertext, reverts; double voting is impossible); no vote outside `[startTime, cutoffTime)`; no vote if `!rollFrozen`; `sum(counts) == acceptedBallots` after tally; factory clones do not share nullifier storage. See ARCHITECTURE.

Non-mock local deploy (fail closed until a VK is installed):

```bash
REPUBLIC_PROVING_PATH=1 forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

### Circuits (proving path in progress)

Circom 2 + snarkjs. Local powers-of-tau is **untrusted**. Exact commands:

```bash
npm run circuits:status
npm run circuits:compile    # circom vote.circom + tally.circom
npm run circuits:setup      # UNTRUSTED ptau + groth16; zkeys gitignored
npm run circuits:export     # circuits/build/*_Groth16Verifier.sol — does not overwrite VoteVerifier.sol
npm run circuits:prove      # demo witness + groth16 verify
```

Hash versions and Poseidon gate: [`circuits/HASH_SCHEME.md`](./circuits/HASH_SCHEME.md).

### Node (`apps/node`)

```bash
npm install
npm run dev                 # node --watch apps/node (Express + public/)
npm run start               # long-lived process for system_actions.sh
npm test -w apps/node
./system_actions.sh health  # GET http://127.0.0.1:3000/health
```

Details: [`apps/node/README.md`](./apps/node/README.md). Local store: JSON under `apps/node/data/` (gitignored). **Not SQLite.** The UI is vanilla JS in `apps/node/public/` (no Vite, no React).

Docker Compose (Node + L2 sequencer + prover), from the repo root:

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:3000/health
```

See [`docs/OPERATOR.md`](./docs/OPERATOR.md).

### Republic L2 (sequencer + prover)

```bash
npm run l2:sequencer        # node l2/sequencer/index.mjs   JSON-RPC :8546
npm run l2:prover           # node l2/prover/index.mjs
./l2/bin/start-local.sh     # both
```

Genesis **chainId 27427**, 2s blocks, one sequencer. Civic JSON transactions (not an Anvil EVM proxy). Settlement: L1 `RollupSettlement.submitBatch` when `L1_RPC` is configured; otherwise mock proofs under `l2/data/proofs/`. Voters do not pay gas. [`docs/L2.md`](./docs/L2.md). After Node tally, certify the **tally hash** on Ethereum when `L1_RPC` / `L1_TALLY_MIRROR_ADDRESS` / `L1_PUBLISHER_PRIVATE_KEY` are set; unset env is a no-op. [`docs/OPERATOR.md`](./docs/OPERATOR.md).

```bash
export L2_RPC_PORT=8546
export REPUBLIC_CHAIN_ID=27427
# Civic sequencer (implemented):
export REPUBLIC_L2_RPC_URL=http://127.0.0.1:8546
# Foundry Anvil for Solidity (optional contract path), default in chain-client:
export REPUBLIC_RPC_URL=http://127.0.0.1:8545
```

`@zk-voting/chain-client` still defaults `REPUBLIC_RPC_URL` to Anvil **:8545**. Point `CHAIN_RPC` at Anvil only when `BallotInbox` is actually deployed there. Do not treat `:8545` as the civic sequencer.

### Block explorer

With the Node up: open `/explorer`. Backend is the JSON log `apps/node/data/l2-chain.json` (Node writes + sequencer `POST /api/explorer/ingest`). API: `GET /api/explorer/blocks`, `/api/explorer/blocks/:n`, `/api/explorer/txs/:hash`, `GET /api/explorer/disclosure`, plus search / nullifier / per-election. Public election snapshot: `GET /api/elections/:id/summary` (disclosed turnout, last closed hour, countdown; `resultsUrl` only after a certified tally — this repo does not invent a winner here). Visible: commitments, nullifiers, ballot **hashes**, reason codes, tallies, batches. Hidden: choices, civil names, evidence files, trapdoors. Vote rows and public turnout wait until the hour that contained the vote has closed. [`docs/BLOCK_EXPLORER.md`](./docs/BLOCK_EXPLORER.md).

### Passkeys and person identity

A person identifies with a **passkey**, a **Web3 wallet**, or a **smart-card digital ID**. Many Ethereum addresses can be verified internally; **exactly one** is active. The vote Merkle leaf is still the identity commitment. [`docs/IDENTITY.md`](./docs/IDENTITY.md).

Browser WebAuthn (`residentKey`, `extensions.prf`). PRF → HKDF wraps a seed in IndexedDB. **Today** `passkey-wallet.js` labels the derived account `republic-local-address` (no secp256k1 in that helper). **Future:** wrap/derive a real secp256k1 smart-account key; UserOps bundled; `RepublicPaymaster` sponsors register/vote on an EVM. Never display a mnemonic. [`docs/PASSKEYS.md`](./docs/PASSKEYS.md).

### Independent auditor

Public artifacts only. Does **not** open the Node private DB. Docs: [`docs/AUDITOR.md`](./docs/AUDITOR.md).

```bash
npm run auditor -- fixture
npm run auditor -- verify --file bundle.json
npm run test:auditor
# from a running Node (public HTTP):
node tools/auditor/cli.mjs export-node --base http://127.0.0.1:3000 --election 1 --out bundle.json
```

### Host actions

```bash
./system_actions.sh              # interactive menu
./system_actions.sh status
./system_actions.sh deploy-dev   # pull test/unstable, install, build, restart
./system_actions.sh deploy-prod  # pull master (confirms first)
```

---

## Node application

The Node side is the human product. It should feel operationally familiar to anyone who has run `dealpunchlist-node`: a long-lived Node process, a web frontend, authenticated users, organizations (here: **jurisdictions**), admin tools, notifications, and a host script (`system_actions.sh`) that can pull a branch, build, and restart.

### What it is responsible for

- **Voter UI:** registration intake, identity/document collection as required by the jurisdiction, status (“registered”, “eligible”, “disqualified”, “ballot accepted”), ballot UI, confirmation.
- **Official UI:** create a jurisdiction and an election, define questions and options, manage the roll, record disqualifications with a reason code and evidence reference, freeze the roll, open/close voting, publish the tally.
- **Public UI:** election calendar, **hourly** published ballot counts (never a live precinct tick), explorer, tallies when posted.
- **API:** the same jobs as HTTP, so a jurisdiction’s own systems or a kiosk can be wired in without scraping the frontend.
- **Relaying:** `POST /api/elections/:id/vote` accepts a proof + ciphertext. Without `CHAIN_RPC`, the Node stores the accept in JSON (demo). With `CHAIN_RPC`, it calls EVM `BallotInbox.submitVote` via viem.
- **Proof client (Future / partial):** help the browser or a local helper build a real Groth16 witness. Today the demo path does not require a ceremony-backed proof.

### What it is not responsible for

- Being the canonical roll **when contracts are deployed**. The canonical eligible-set and disqualification-set commitments live in the contracts. **Demo path:** `CHAIN_RPC` unset — the JSON store is the operator cache and the only roll.
- Silently “fixing” a tally. If the chain rejects a proof, the UI reports failure. Do not edit `republic.json` to change counts after freeze.
- Inventing disqualification law. The app presents **coded reasons** the jurisdiction configured; clerks apply them.

### Shape (DealPunchList parallel)

| DealPunchList-node | zk-voting Node |
| --- | --- |
| Organizations / companies | Jurisdictions (nation, state, county, city, other body) |
| Users with roles | Voters, clerks, registrars, observers, admins |
| A “room” with a process | An election with a roll, a ballot, and a result |
| Requirements that get satisfied | Registration steps, eligibility checks, disqualification holds |
| Notifications | “You are registered”, “you are disqualified from X”, “polls are open”, “tally posted” |
| Hosting via `system_actions.sh` | Same: `test/unstable` for development, `master` for production |

**Implemented UI (vanilla JS, Express static):**

| Path | What |
| --- | --- |
| `/`, `/register`, `/vote/:id` | Voter pages (`public/index.html` + `app.js`). `:id` is UUID, short code, or on-chain id. |
| `/v/:shortCode`, `/e/:shortCode` | 302 to `/vote/<uuid>` |
| `/elections/:id/info` | Voter punch-list of option supporting info (`info.js`) |
| `/elections/:id/info/:questionId/:optionId` | One option + external links |
| `/admin` | Platform admin (`admin.html`) |
| `/back-office` | Clerks / registrars / officers (`back-office.html`) |
| `/explorer` | Civic L2 explorer (`explorer.html`) |
| `/elections/:id/results` | Certified plurality / IRV results |

Public election ids are UUID v4. On-chain `electionId` remains the factory `uint256`; the Node stores that mapping as `onChainElectionId`.

Every page footer: **NOT FOR PROFIT**. There is **no Vite** and **no React** in this tree.

---

## Smart contracts

Solidity on Ethereum. This is the enforcement layer. Sources live under `smart-contracts/src/` (`pragma solidity ^0.8.24`, AGPL-3.0-or-later). Exact interfaces: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

The contract set covers:

| Contract (working name) | Role |
| --- | --- |
| `JurisdictionRegistry` | Who may create elections, which chain roles exist, which reason codes are valid. |
| `VoterRegistry` | Commitments to registered persons (identity commitments / public keys), per election. Registration is not a vote. |
| `PersonRegistry` | One person (`bytes32` id, never a name): many internally verified ETH addresses, exactly one active. Not the vote leaf. |
| `DisqualificationRegistry` | Registered persons who **must not** be able to vote in a given election (or on a given question), with reason codes, effective times, and issuer. |
| `Election` / `Poll` | Parameters: questions (“aspects”), options, open/close, eligible-set root, disqualification-set root, voting rules. |
| `ElectionFactory` | Unbounded elections via EIP-1167 clones. `maxParticipants = 0` means unlimited voters. |
| `BallotInbox` | Accepts vote messages + ZK proofs. Rejects proofs that fail eligibility, disqualification, uniqueness, or time window. |
| `Tally` (`ITallyVerifier`) | Verifies the coordinator/prover’s batch proofs that the published totals match the inbox. File: `src/Tally.sol`. |
| `L1TallyMirror` | If L2 is where votes land, L1 holds the result (or a commitment to it) that courts and the Node treat as final. |
| `RollupSettlement` | L1 contract: `submitBatch` for Republic L2 state roots. |
| `RepublicMailbox` | L1/L2 message mailbox. |
| Passkey AA + paymaster | `PasskeyAccount`, factory, `RepublicPaymaster`, local `RepublicEntryPoint`. |

Exact names follow the Solidity tree. The **behaviors** are the spec:

### Registration on chain

- A jurisdiction (or its registrar role) admits a voter by publishing an **identity commitment**, not necessarily the person’s legal name, on chain.
- The Node may keep the legal file (name, address, document numbers) off-chain, encrypted, because many jurisdictions cannot put that on a public chain.
- The on-chain object is enough to prove later: “this commitment was on the roll at time T.”

### Voting on chain

- A vote is a **proof + ciphertext / commitment**, not a public `vote(optionId)`.
- The verifier checks: registered, **not disqualified**, in the voting window, well-formed ballot. A nullifier identifies the voter and is spent **once**. Replay of a used nullifier fails, even with a new `ballotHash`.
- Multiple questions in one election (“aspects”) can be one ballot or one proof per question; the election parameters say which.
- `submitVote` public inputs are `[root, disqRoot, nullifier, ballotHash, electionId]`. Relayer/bundler is `msg.sender`.

### Disqualification on chain

This is a first-class feature, not an admin footnote.

- A registered voter can be marked **ineligible to cast** (or to have a ballot counted) for a specific election, a specific question, or (if the jurisdiction allows) all current elections in that jurisdiction.
- The mark carries a **reason code** from a published catalog (see [Eligibility, disqualification, and due process](#eligibility-disqualification-and-due-process)).
- Vote circuits take the **disqualification tree / set** as a public input. A valid vote proves **non-membership** (or an equivalent “still eligible” delta) for that person. In v1 the eligible Merkle root is `registered ∩ ¬disqualified`; membership in that root is what a disqualified person cannot prove.
- Removing a disqualification (appeal granted, error, restored rights) is the same kind of auditable event, with its own actor and timestamp.
- Once a poll is frozen for tally, new disqualifications must not rewrite history. Late legal changes are a **new** election or a jurisdiction-level process off this protocol, unless the election was parameterized to allow a documented freeze/unfreeze.

Contracts must be **boring Solidity**: explicit access control, no upgrade surprise unless a jurisdiction opted into a proxy, events for every state change the Node or an auditor will need. v1 factory deploys new elections; no upgradeable `Election` proxy unless params explicitly opt in.

---

## Circuits

Circom 2, self-contained (no circomlib path in this repo). **Poseidon is the production target** (`republic.hash.poseidon-bn254-x5-t3-v1`). Until it is vendored, `Hasher()` is the gated stand-in `republic.hash.standin-v0` (`out = a + b + a*b` in `circuits/hasher/standin.circom`). **Not production Poseidon. Not for a binding election or a trusted setup.** Foundry tests keep `KeccakHasher` (`keccak-dev-v1`). The proving-path JS helpers and `StandInHasher` match the Circom stand-in so a local Groth16 proof can be produced.

| Circuit | Role |
| --- | --- |
| `circuits/vote.circom` | `Vote(levels)`: membership in the eligible tree, `nullifier = Hash(nullifierSecret, electionId)`, public `[root, disqRoot, nullifier, ballotHash, electionId]` |
| `circuits/tally.circom` | Histogram of opened option indices (`CIRCOM_TALLY_V1` public signals). **Not** the same encoding as `Tally.sol` (`TALLY_SOL_MOCK_V1` in `TallyPublicInputs.sol`). MockVerifier until a translating wrapper exists. |
| `circuits/identity.circom` | Commitment and nullifier primitives |

Compile notes, snarkjs, **exact proving-path commands**, and MockVerifier policy: [`circuits/README.md`](./circuits/README.md), [`circuits/HASH_SCHEME.md`](./circuits/HASH_SCHEME.md). Solidity trees in tests may use `KeccakHasher` implementing the same `IHasher.hashLeftRight` shape.

---

## Shared packages

npm workspaces (Node 22):

| Package | Role |
| --- | --- |
| `@zk-voting/types` | JSDoc types: `ElectionParams`, `VoteEnvelope`, `Block`, `Jurisdiction`; reason codes and election states matching Solidity |
| `@zk-voting/proof-helpers` | `serializePublicInputs` → `[root, disqRoot, nullifier, ballotHash, electionId]`; `serializeTallyPublicInputs` → TALLY_SOL_MOCK_V1; versioned `hashLeftRight` (`keccak-dev-v1` default, `standin-v0` for Circom); Keccak-256 via **viem** when installed (Node `crypto` is SHA-256 / NIST SHA-3, **not** Ethereum keccak) |
| `@zk-voting/chain-client` | `getFactory`, `createElection`, `submitVote` through viem `writeContract` / `encodeFunctionData`, else `fetch` JSON-RPC `eth_call` wrappers for views |

---

## Chains: Ethereum L1, Republic L2, and Lighter

### Why two layers (plus a named L2 in this repo)

| Layer | Job | Implemented today |
| --- | --- | --- |
| **Republic L2** (this repo, chainId **27427**) | High-volume civic actions: registration, vote messages, disqualifications, tallies. **Own sequencer + prover.** Gasless for voters. | Civic **JSON** sequencer on **:8546**. Prover writes mock proofs or calls L1 `RollupSettlement`. Not an EVM. |
| **Foundry Anvil** (dev EVM, typically **:8545**) | Run the portable Solidity stack locally (`DeployLocal`). | Yes. Separate from 27427. |
| **Lighter** ([lighter.xyz](https://lighter.xyz)) | Prior art and a possible alternate **EVM** venue. | Not operated from this repo. |
| **Ethereum mainnet (L1)** | Canonical settlement. `RollupSettlement` + optional `L1TallyMirror`. Deploy the same Solidity when the election must live where any Ethereum full node can verify it. | Contracts in-tree. No production deploy. |

Lighter’s original core is an application-specific ZK rollup (verifiable exchange operations, proofs verified on Ethereum). Lighter has also moved toward a **general-purpose EVM** surface so ordinary Solidity can be deployed beside that core. This repo’s contracts are written as **portable EVM bytecode**:

- Deploy to **Ethereum mainnet** when L1 is the required venue.
- Deploy to **Anvil / other EVM L2s** (including Lighter’s EVM) when a jurisdiction wants that operator.
- Run **Republic L2 (27427)** for the default high-throughput civic JSON path in this repo.
- **Future:** execute the same Solidity *on* 27427 (EVM or validity VM). Do not document that as present.

If a given Lighter environment is not yet suitable for these contracts, the same artifacts should still deploy to Ethereum L1 and to any other EVM L2. The product requirement is “L2 like Lighter, plus L1,” not a hard dependency on a single third-party sequencer remaining available.

Republic L2 details (genesis, sequencer, prover, settlement): [`docs/L2.md`](./docs/L2.md).

### Deployment policy

- **Development / staging elections** → Republic L2 and L1 test networks. Branch `test/unstable`.
- **Production elections** → explicit choice per jurisdiction: L2-only, L1-only, or L2 execution + L1 result mirror. Branch `master`.
- `system_actions.sh` and deploy scripts must never “accidentally” point a production jurisdiction at `test/unstable` configuration. `master` is the production line.

### What “on chain” means for an election

An election is “on chain” when:

1. Contract addresses and compiler metadata are published.
2. The roll commitment and disqualification-set commitment are on the chosen chain.
3. Ballots that count are accepted only by those contracts.
4. The tally (or a binding hash of it) is verified on that chain, and if L2, optionally copied to L1.

The Node is allowed to be down. The chain records must still be enough for an independent verifier.

---

## Registration

Registration is a **legal and operational** process that **ends** in an on-chain commitment.

### Off-chain (Node)

Typical intake (jurisdiction-configurable, not all required for every election):

- **Passkey, Web3 wallet, or smart-card digital ID** (a person may verify all three)
- Several Ethereum addresses verified internally; **exactly one active** (the roll leaf is still the identity commitment, never that address)
- Legal name, date of birth, address / residency evidence (clerk file; not on chain)
- Citizenship or membership evidence
- Government ID or an approved identity attestation
- District / precinct / constituency
- Contact channel for notices (disqualification, poll dates)
- Attestation that the person is who they claim and understands the rules

The Node stores what the jurisdiction is legally required to keep. That store is **not** the roll the circuits use.

### On-chain

- An **identity commitment** (e.g. a hash of a voter key and jurisdiction salt) is added to the `VoterRegistry` for that jurisdiction. Implementation: `Poseidon(identityTrapdoor, nullifierSecret)` in production (`poseidon-bn254-x5-t3-v1`). Until then, circuits use gated `standin-v0`; Foundry/Node tests use `keccak-dev-v1`. The leaf is **never** the wallet address and **never** a name.
- Optional: a **district leaf**, so a municipal election can require residency in that district without putting the street address on chain.
- Duplicate prevention: the jurisdiction’s uniqueness rule (national ID hash, one-person attestation, etc.) is checked before the commitment is inserted. The contracts can enforce “this uniqueness nullifier is unused,” which is stronger than a SQL unique index.

### Status the voter should see

- **Not registered**
- **Pending review** (documents in with the clerk)
- **Registered** (on the roll commitment)
- **Eligible for election E** (registered, and not disqualified for E)
- **Disqualified for election E** (registered, but a live disqualification applies)
- **Ballot recorded** (nullifier spent; the accepted `ballotHash` is what the tally uses; choice not shown)

---

## Eligibility, disqualification, and due process

**Registered ≠ allowed to vote.** That is a core requirement of this repo.

Election law (and private-body bylaws) routinely keep someone on a master list while denying them a ballot in a particular contest: they moved, they died, they are serving a sentence the jurisdiction treats as disqualifying, they already voted, a court ordered it, the registration was fraudulent, they are not in this district for this contest.

### How it will work

1. **Reason catalog (per jurisdiction).** A published list of codes, for example:

   | Code | Example meaning (illustrative, not legal advice) |
   | --- | --- |
   | `NOT_OF_AGE` | Below the voting age for this election |
   | `NOT_RESIDENT` | Not a resident of the jurisdiction or district |
   | `NOT_CITIZEN_OR_MEMBER` | Fails the body’s membership / citizenship rule |
   | `DUPLICATE_IDENTITY` | Same person already registered under another commitment |
   | `DECEASED` | Death recorded |
   | `MOVED_OUT` | Left the jurisdiction |
   | `DISTRICT_MISMATCH` | Registered, but this ballot is for another district |
   | `ALREADY_VOTED` | Ballot already accepted (also enforced by nullifier) |
   | `COURT_ORDER` | Court or competent authority barred this person |
   | `INELIGIBLE_STATUS` | Jurisdiction-specific legal status (incarceration, guardianship, etc.) |
   | `FRAUD_HOLD` | Registrar hold for suspected fraudulent registration |
   | `EXPIRED_OR_SUSPENDED` | Registration lapsed or suspended |
   | `SANCTION_OR_PROHIBITION` | Explicit legal prohibition |
   | `OTHER` | Requires a public or sealed memo reference |

   Jurisdictions add, rename, or disable codes. The protocol does not hard-code one country’s election code. Solidity `ReasonCodes.sol` uses `uint16` (`NOT_OF_AGE=1` … `OTHER=14`).

2. **On-chain record.** `{ voterCommitment, electionId or * , questionId or *, reasonCode, evidenceHash, issuer, issuedAt, expiresAt?, revokedAt? }`

3. **Eligible set for proving.** Before voting opens (and at defined refresh points), the system builds the set the circuits use:

   `eligible = registered ∩ ¬disqualified(election, question)`

   The vote proof shows membership in that set (or non-membership in the disqualification set plus membership in the registry), so a disqualified person **cannot** produce an accepting proof.

   **Node path today:** `apps/node` rebuilds `eligibleRoot` from that intersection and the vote relay rejects currently-disqualified (and unregistered) commitments when `CHAIN_RPC` is unset. Freeze snapshots those roots for the open window.

   **Remaining ZK gap:** the vote circuit still only *binds* `disqRoot`; it does not prove non-membership. `MockVerifier` still accepts any proof. Do not treat a local demo accept as circuit-enforced exclusion. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

4. **Visibility.**

   - **Public:** that a disqualification exists, which election it applies to, reason **code**, issuer role, timestamps.
   - **Restricted (Node / clerk / court):** identity file, evidence, narrative. Hash of the evidence is on chain so a court can match the file later.
   - The **ballot** is never attached to a disqualification record.

5. **Due process (product rules, enforced as far as the contracts can).**

   - A voter can see that they are disqualified and the **code**, via the Node, once the jurisdiction’s notice rules allow it.
   - Appeals are a Node + clerk workflow that ends in `revoke` or `replace` on the disqualification record.
   - No silent deletes. Revocation is an event.
   - After a poll’s **roll freeze**, disqualifications that would change who could have voted are rejected or queued for the next contest, unless the election was created with an explicit, public “late update” flag (discouraged).

6. **Who may disqualify.** Only roles the jurisdiction bound in `JurisdictionRegistry` (registrar, clerk of court, statutory officer). The Node UI is how they do it; the contract is what makes it real.

### Failure mode we are designing against

A clerk who can quietly drop a person from a private database at 7:59 p.m. That is not allowed to be the only control. If they are dropped, it is a **disqualification (or registry removal) with a reason**, or it did not happen.

---

## Ballots and “voting on aspects”

An election is not only “choose one candidate.” Officials and voters need to vote on **aspects**: questions, measures, offices, ranked choices, yes/no articles.

Each **Election** contains one or more **questions**. **Implemented in the Node UI** (`public/vote.js`):

- `SINGLE_CHOICE` — one option (plurality unless the election default is `ranked_choice`)
- `MULTI_CHOICE` — up to *k* options (always plurality)
- `YES_NO`
- `RANKED` — ordered options; voters rank them; tally is instant-runoff (IRV)
- `MEASURE` / `ARTICLE` — labeled text plus options (inherit the election method)

Ballot method is **election-level or per-question**: `plurality` (default, first past the post) or `ranked_choice` (IRV). Clerks pick the flavor when creating or editing a ballot (before roll freeze). RANKED questions always use IRV; YES_NO stays plurality.

The Node stores an IRV **round transcript** (aggregate first-preference counts per round, eliminated candidate, winner) with the tally. Individual rankings are not published. On-chain v1 does **not** add a Solidity method enum; the method lives in the canonical ballot JSON hashed into `ballotSpecHash` (type `RANKED` and/or per-question `ballotMethod`). The Groth16 / L1 tally path remains the concatenated **plurality** per-option count vector; all-ranked ballots post first-round first preferences.

The Node authors this as a structured ballot (JSON remains an advanced escape hatch). Voters mark **every aspect on one envelope**. Plurality tallies are labeled per question; a two-contest ballot is not flattened into `sum(all option counts) == acceptedBallots`. Ranked-choice questions are counted with IRV on this Node path.

Rules per question (quorum, supermajority, “eligible to vote on this aspect even if disqualified from another”) remain parameters. Disqualification can be **election-wide** or **per question** (example: eligible for a local measure, barred from a national office in the same calendar). **Per-question disqualification in circuits is Future**; v1 eligible root is `registered ∩ ¬disqualified` for the election.

The Node is the authoring tool for this ballot. The contracts store the hash of the full ballot definition so the UI cannot later show a different question than the one that was voted on. Option supporting information (blurb, body, external links) is part of that hashed JSON. The Solidity `Tally` contract still posts a single flat vector whose sum equals `acceptedBallots` (a single-contest mock invariant); multi-question certification on chain is not this slice.

---

## Election types and jurisdictions

| Kind | Example | Typical chain choice |
| --- | --- | --- |
| Local / municipal | City council, school board, local measure | L2 (Republic 27427) |
| Regional / state / province | Statewide office or referendum | L2, L1 mirror of tally |
| National | General election, national referendum | L1 certified result; L2 may still take the vote messages |
| Non-governmental | Union, cooperative, professional college | L2, optional L1 |

A **jurisdiction** is the administrative owner: it defines the roll, the reason catalog, the officers, and which elections it runs. Nested jurisdictions (nation → district → precinct) are a Node/registry concern: a precinct election must only count commitments tagged for that precinct.

---

## Roles and permissions

| Role | Node | Contracts |
| --- | --- | --- |
| **Voter** | Register, view status, vote | Submit register/vote proofs as allowed |
| **Registrar** | Approve registrations | Insert/remove registry commitments |
| **Disqualification officer** | Apply/revoke reason codes | Write `DisqualificationRegistry` |
| **Election clerk** | Create election, freeze roll, open/close | Configure `Election`, freeze roots |
| **Tally operator** | Run the prover / batch; on `opens_ballots` elections, open demo envelopes | Submit tally proofs. On SUM_ONLY they can still invent a partition of the sum. On OPENS_BALLOTS, invented partitions that only match the sum are rejected. |
| **Observer** | Read-only | Read state and verify |
| **Platform admin** | Host the Node, keys, uptime | Not an election officer unless also granted |

A **corrupt tally operator** on the legacy **SUM_ONLY** path can still post any `counts[]` that sum to `acceptedBallots` — the operator cannot add or drop ballots, but they can rearrange which option received them. That hole is why **OPENS_BALLOTS** exists: the Node decrypts ECIES envelopes under a **threshold-1 demo key** (the operator host holds it; **NON-PRODUCTION**, not a guardian ceremony) and the contract requires `histogram(openings) == counts`. They **can** stall (never submit a tally). They **cannot** make a disqualified voter’s proof succeed. Production remains homomorphic / mixnet decryption proofs plus a real Groth16 verifier. MACI-style coercion resistance is a separate gap.

### Tally encryption (honest status)

- **Demo (this slice):** each `opens_ballots` election generates a P-256 keypair at create time (`p256-ecies-aesgcm-v1`). The public key is on the election record (`tallyPubKey` / `tallyPubKeyX|Y`). The private JWK stays in the Node’s `tallyGuardians` collection and is never returned by `GET /api/elections/:id/tally-key`. Voters encrypt a packed option index to that pubkey (replacing seed-keyed AES for the posted envelope). After cutoff, `POST /tally` opens every accepted envelope and posts the derived plurality vector. Submitting a different vector whose sum still matches `acceptedBallots` fails with `INVENTED_COUNTS`.
- **On-chain:** `ElectionParams.tallyScheme` is additive (`0` keeps old tests). `submitOpenedTally` binds openings ↔ counts ↔ inbox `ballotRoot`. `Tally.sol` Groth16 inputs are versioned as `TALLY_SOL_MOCK_V1` and are **not** `tally.circom`’s public signals.
- **Not done:** Shamir / guardian threshold > 1, mixnet permutation before opening, homomorphic ciphertext product, real Groth16 tally keys, MACI last-vote-counts. Do not run a binding election on the demo key.

---

## End-to-end flows

### A. Register

1. Voter completes the Node intake for jurisdiction J (passkey create / PRF).
2. Clerk verifies documents (or an automated attestation the jurisdiction accepts).
3. Node (or voter UserOp, paymaster-sponsored) submits a registration transaction: identity commitment to `VoterRegistry`.
4. Voter sees **Registered**.

### B. Disqualify

1. Officer enters a reason code and evidence in the Node.
2. Contract appends a disqualification record and the eligible-set root is updated (immediately or at the next freeze).
3. Voter’s status becomes **Disqualified for election E** (code visible per policy).
4. Any vote proof they generate for E fails verification.

### C. Vote

1. Polls open. Eligible-set root is frozen (or the election allows a documented refresh).
2. Voter builds a ZK proof: I am in the eligible set, I am not in the disqualification set, this ciphertext is a well-formed ballot for these questions. The nullifier identifies me without naming me.
3. `BallotInbox` accepts the message (bundler is `msg.sender`). Choice is not plaintext.
4. A second vote for the same nullifier fails (`NullifierUsed`), including a later proof with a **new** `ballotHash`. Double voting is impossible. `acceptedBallots` is unique accepted nullifiers.

### D. Tally and certify

1. Poll closes. Inbox no longer accepts messages.
2. Operator processes messages and proves the tally.
3. `Tally` (`ITallyVerifier` / `src/Tally.sol`) accepts only a correct proof.
4. If the election is L2, a hash of the result can be posted to L1.
5. Node publishes the human-readable result plus verifier artifacts.

---

## Privacy, coercion resistance, and public verifiability

These three fight each other. The design chooses explicitly:

| Goal | Approach |
| --- | --- |
| **Privacy of choice** | Vote is encrypted / committed; proof talks about eligibility, not the option. |
| **Public verifiability** | Anyone can check proofs, set roots, **hourly** published inbox size, and the tally. |
| **Polling-place unlinkability** | Vote proofs and turnout ticks appear only after the hour that contained them closes. A person leaving a voting office cannot be matched to a live jurisdiction increase. |
| **Coercion resistance** | **Shipped slice (not MACI, not last-vote-counts):** one accepted nullifier. Voters may change their mind privately on the ballot form before submit; after accept they cannot recast. The Node prints a receipt of hashes only — it **cannot** prove choice (no option ids, no opening). Double voting remains impossible. **Still later:** MACI-style collusion-resistant messaging. |
| **Disqualification transparency** | Reason **codes** are public so a jurisdiction cannot hide mass purges. Personal evidence stays off-chain. |

If a jurisdiction needs a fully public roll (some do), that is a configuration: commitments can be replaced or accompanied by identified records. ZK voting still hides the **ballot**.

Unlinkability: the active Ethereum address is not the Merkle leaf; the vote tx origin is the bundler; the nullifier does not name the account. Dashboards delay vote proofs by one hour. Details: [`docs/IDENTITY.md`](./docs/IDENTITY.md), [`docs/PASSKEYS.md`](./docs/PASSKEYS.md), [`docs/BLOCK_EXPLORER.md`](./docs/BLOCK_EXPLORER.md).

---

## Security and threat model

**In scope**

- Forged eligibility (voting while unregistered or disqualified)
- Double voting
- Tally that does not match accepted ballots
- Silent roll changes after freeze
- Node lying about what the chain said
- Replay of a vote message on the wrong election or chain
- Privilege abuse that is not logged on chain

**Partially in scope**

- Coercion and vote buying (cryptographic mitigations over time; process and law still matter)
- L2 sequencer censorship (mitigate with L1 inclusion path / timeout, in the spirit of Lighter’s priority/escape design)

**Out of scope for v1**

- Replacing a nation’s identity system
- Making a dishonest registrar invent a legal person who does not exist (the registry is only as good as the jurisdiction’s identity practice; uniqueness nullifiers reduce duplicates, they do not create a global proof of personhood)
- Stopping a tally operator from **refusing to tally** (liveness), as opposed to tallying **wrong**

**Operational**

- Production secrets and deploy keys are not in git.
- `master` is the only production line.
- Contract addresses for a live election are pinned in the Node’s published election record.

---

## What this system will not do

- Guarantee that a government **must** use it, or that using it satisfies a given elections statute. That is a legal adoption question.
- Put every voter’s home address and ID number on Ethereum by default.
- Let a disqualified person vote “privately anyway.” Privacy is for the **choice**, not for bypassing the roll.
- Hide mass disqualification behind ZK. The **fact** of disqualification is meant to be visible; the **ballot** is not.
- Ship as a single-chain toy that cannot be certified on L1.
- Charge voters, sell the software, or wrap it in a token.

---

## Development

### Branches

- **`test/unstable`** — default development and staging. Almost all work happens here.
- **`master`** — production only. Promote when a build is ready to ship.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

### Host actions

`system_actions.sh` is the operator menu, adapted from the DealPunchList (`dealpunchlist-node`) pattern:

```bash
./system_actions.sh              # interactive menu
./system_actions.sh status
./system_actions.sh deploy-dev   # pull test/unstable, install, build, restart
./system_actions.sh deploy-prod  # pull master (confirms first)
```

Install / build / restart use npm workspaces, then pm2, systemd, or Compose when configured. Root `docker-compose.yml` is that Compose target:

```bash
docker compose up -d --build   # Node :3000, L2 RPC :8546
npm run compose:up             # same
```

### Tooling

- Solidity: Foundry 1.8+, solc 0.8.24, **via-ir on** (`foundry.toml`).
- Node: Node 22, npm workspaces. Frontend: vanilla JS in `apps/node/public/` (no bundler).
- Circuits: Circom 2 (optional on the host until leaving MockVerifier). `npm run circuits:status`.
- Tests: `forge test --via-ir` with MockVerifier; `npm test -w apps/node` for API tests; `npm run test:l2` for the civic sequencer; `npm run test:proof-helpers` for hash-scheme vectors.

### What is in the tree vs what remains

Present: monorepo skeleton, Solidity under `smart-contracts/`, circuits, packages, Node API + vanilla JS UI, civic JSON L2, explorer and passkey docs. Choice-free receipts and independent auditor packaging are in-tree (roadmap item 10 slice). Last-vote-counts / re-vote supersession is **not** shipped: a nullifier is accepted once.

Still ahead of a binding election (**Future**): Poseidon hasher swap, Groth16 **ceremony**, secp256k1 in the browser passkey helper, EVM execution on 27427, MACI-style collusion-resistant messaging, production tally guardians (threshold > 1) / mixnet. Do not treat `MockVerifier`, the circom `Hasher()` stand-in, a local `circuits:setup` zkey, or the threshold-1 tally operator key as production cryptography. Dedicated results, ranked-choice IRV, UUID election ids, L1 certification, and the demo opens-ballots tally are already in `test/unstable`.

---

## Roadmap

Dates are not committed. Items 1–4 are **in the tree** (with the honest caveats in Current status). Item 10 has a pragmatic in-tree slice (not full MACI). Everything else after item 4 is **Future**.

1. **Spec freeze (this README)** — purpose, monorepo, L1 + L2, registration, disqualification. **Done (kept current as code landed).**
2. **Contract interfaces** — registry, disqualification, election, inbox, tally verifier; deploy scripts for Ethereum and an EVM configured as Republic L2. **In-tree.**
3. **Node skeleton** — DealPunchList-style app: jurisdictions, users, roles, election admin, voter home. **In-tree** (vanilla JS + JSON store, not Vite/React/SQLite).
4. **Circuits + packages** — eligible vote, tally summation, JS clients. **In-tree** (Poseidon / ceremony still outstanding).
5. **First proving path** — **in progress.** Eligible-vote circuit compiles; untrusted local powers-of-tau + Groth16 setup/export/prove scripts exist (`npm run circuits:*`). `MockVerifier` still default for unit tests. Poseidon + ceremony still outstanding.
6. **Disqualification path** — same voter, after a coded disqualification, cannot obtain a valid proof against production keys. **Future** (eligible-root membership is in the circuit topology today).
7. **Multi-question ballots** — “aspects.” **Node path in-tree:** clerks author several questions (structured back-office UI; JSON is advanced), `/vote/:id` renders every aspect on one envelope, plurality results are labeled per question (`GET /api/elections/:id/results`). Ranked-choice / IRV is computed on the Node from accepted ranking envelopes (winner + round transcript). Solidity `Tally` still assumes a single flat vector; mixed ballots certify the plurality-only concatenation on L1.
8. **L1 certification** — tally or tally hash on Ethereum mainnet. **In-tree (testnet-friendly):** after Node tally, `L1TallyMirror.postResult` when L1 env is set; graceful no-op otherwise. See [`docs/OPERATOR.md`](./docs/OPERATOR.md). A live jurisdiction deploy on Ethereum mainnet (pinned addresses on `master`) is still **Future**.
9. **EVM (or validity) execution on chainId 27427** so the same bytecode runs on the civic L2. **Future.**
10. **Coercion-resistance upgrades** and independent auditor tooling. **Pragmatic slice in-tree (not full MACI, not last-vote-counts):**
   - **One accepted nullifier:** `submitVote` for a spent nullifier reverts `NullifierUsed`, including a new ciphertext. Double voting remains impossible. `acceptedBallots` is unique nullifiers, so tally `sum(counts)` is a unique-voter invariant. Voters may change their mind privately on the ballot form **before** submit; the inbox does not accept a second ballot.
   - **Receipts cannot prove choice:** the Node receipt lists `ballotHash`, nullifier, UserOp hash — never the marked options or the opening. A receipt is not “I voted for X,” and it is not a second ballot.
   - **Auditor pack:** `tools/auditor` CLI + [`docs/AUDITOR.md`](./docs/AUDITOR.md) + `GET /api/elections/:id/artifacts` export public roots, disclosed ballot hashes, tally, and contract addresses and verify sum/invariants **without** the Node private DB. Packs assert unique nullifiers and `receiptsProveChoice: false`.
   - **Still later / Future:** MACI-style encrypted message queues / key-changing; guardian / forced-reveal if a tally operator stalls. Last-vote-counts / re-vote supersession is **out of scope** for this slice.

---

## Glossary

| Term | Meaning in this repo |
| --- | --- |
| **Republic** | Product name. Civic ZK voting / tally stack in this monorepo. |
| **Jurisdiction** | The body that owns a roll and elections (government or other). |
| **Roll / registry** | The set of registered identity commitments. |
| **Eligible set** | Registered minus disqualified, for a given election/question. |
| **Disqualification** | An on-chain record that blocks voting despite registration. |
| **Aspect / question** | One decision on a ballot (office, measure, article). |
| **Nullifier** | A unique value revealed at vote time so the same person is counted once, without publishing their name. Spent at most once: a second ballot for that nullifier is rejected. Double voting is impossible. |
| **Tally proof** | A ZK proof that published totals match accepted ballots. |
| **L1** | Ethereum mainnet (or an Ethereum testnet during development). |
| **L2** | Republic L2 (chainId **27427**) by default: civic JSON sequencer in `l2/`. Lighter and other EVM L2s as portable Solidity venues. Execution off L1, security anchored to Ethereum. |
| **Passkey** | WebAuthn credential; PRF wraps the Ethereum key and (separately) the ZK trapdoor. One of three ways to identify a person (with Web3 wallet and smart-card digital ID). |
| **Person** | One Node user. Uniquely identified. Authenticators and ETH addresses cannot be shared across people. |
| **Active Ethereum address** | The single ETH address currently registered for that person’s gasless ops. Other verified addresses stay internal. Not the Merkle leaf. |

---

## Related work

This project is **not** a fork of any of the following. They are the prior art the design will learn from:

- [MACI](https://maci.pse.dev/) — on-chain polls, signup policies, collusion-resistant messaging, proven tallies.
- [Semaphore](https://semaphore.pse.dev/) — anonymous group membership proofs (a likely building block for “I am still in the eligible set”).
- [Lighter](https://lighter.xyz) — ZK rollup that settles to Ethereum; the L2 *family* this repo treats as the high-throughput venue. Republic L2 is operated from `l2/` (chainId 27427) as a **civic JSON** sequencer, not as a Lighter-hosted or Anvil-proxied EVM.
- DealPunchList / `dealpunchlist-node` — the Node/product and hosting pattern this monorepo’s application side follows.

---

## Legal and policy note

This repository describes software for running elections and for **denying a registered person a ballot** under coded rules. It is not legal advice. Disqualification reasons, notice, appeals, retention of identity files, and whether a blockchain record satisfies a given elections code are **jurisdiction-specific**. Operators must not run a binding public election on this stack without their own counsel and statutory authority.

The authors’ intent is that **eligibility and disqualification are visible as process**, while **individual political choice is not**. If a deployment inverts that (public ballots, secret purges), it is misusing this design.

**NOT FOR PROFIT.** See [`NOT_FOR_PROFIT.md`](./NOT_FOR_PROFIT.md).
