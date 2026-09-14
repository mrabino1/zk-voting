# ARCHITECTURE

**NOT FOR PROFIT** — civic public good. Not a commercial product. See `/NOT_FOR_PROFIT.md`.

This file is the **interface contract** for every package in this monorepo.
If code disagrees with this file, the code is wrong.

Product name: **Republic**. Repo name: `zk-voting`.

---

## Purpose

Replace (if a jurisdiction demanded it) every city / county / state / federal
election **and** every publicly traded company's shareholder vote with one
stack that:

1. Lets an **unbounded** number of elections exist (contract factory).
2. Lets an **unbounded** number of people vote in each election (Merkle tree,
   `maxParticipants = 0` means unlimited).
3. Has a **start time** and a **cutoff time**.
4. Lets a person **register** (they obtain a public smart-account address)
   but **obfuscates** that address from the ballot so no individual can be
   linked to an outcome.
5. Settles on **our own L2** with **our own prover**, gasless for voters
   (paymaster / relayer). Ethereum L1 is the court-grade settlement layer.

---

## Privacy construction (the implementation)

A voter never casts a plaintext `vote(optionId)` from an identified key.

```
passkey (WebAuthn, device-bound)
    │
    ├─ PRF / hmac-secret ──► HKDF ──► secp256k1 smart account   (public address)
    │                                    used only to authorize a UserOp
    │                                    UserOp is submitted by the bundler
    │                                    paymaster pays L2 gas  (gasless voter)
    │
    └─ PRF ──► HKDF ──► (trapdoor, nullifierSecret)
                         │
                         poseidon(trapdoor, nullifierSecret) = identityCommitment
                         │
                         inserted into the election Merkle tree at registration
```

When they vote:

- Circuit proves: "I know a trapdoor whose commitment is in the eligible
  tree, I am **not** in the disqualification tree, this ballot is well-formed."
- Reveals `nullifier = poseidon(nullifierSecret, electionId)` so they cannot
  vote twice. The nullifier is **unlinkable** to the smart-account address
  and to the civil identity.
- Ballot is an **ElGamal / hashed commitment** ciphertext posted with the
  proof. Choice is not a public field.
- The L2 transaction origin is the **bundler**, not the voter. The
  passkey-bound address is therefore not sitting next to the ballot in
  the same transaction.

A coercer who sees the public address learns only that the person registered.
They cannot read the choice. The Node **must not** print "I voted for X".

### Hourly public disclosure (polling-place unlinkability)

Votes are **accepted immediately** (nullifier uniqueness). Public proof of
those votes — explorer rows, jurisdiction `acceptedBallots`, any dashboard
turnout tick — is published **only after the hour that contained the vote
has closed** (UTC). At 14:23, only events with timestamp `< 14:00` are
public; a 14:05 vote appears at 15:00.

- Do not leak a pending-per-election count (that still identifies the
  jurisdiction).
- Do not publish original intra-hour timestamps. Votes of that hour are
  lumped into **one disclosure block**, timestamped at the hour boundary,
  ordered by nullifier (not arrival).
- Default interval is 3600 seconds (`DISCLOSURE_INTERVAL_SECONDS`). Tests
  and local instant demo may set `0`.

Hasher note: production circuits use Poseidon. Solidity trees in v1 use a
swappable `IHasher`. Tests may use keccak256 via `KeccakHasher` so Foundry
tests do not need a trusted setup. The interface is identical.

### Person (unique) vs one active Ethereum address

A Node user is one **person**. They may bind passkey, Web3 wallet, and
smart-card digital ID. Several ETH addresses can be internally verified;
exactly one is **active** (gasless ops). Authenticators and addresses cannot
belong to two people. The vote leaf stays `identityCommitment`. Details:
[`IDENTITY.md`](./IDENTITY.md).

---

## Monorepo layout (owners)

```
zk-voting/
  README.md                          (docs agent)
  NOT_FOR_PROFIT.md
  LICENSE                            (AGPL-3.0-or-later)
  system_actions.sh
  package.json                       (workspaces)
  docs/ARCHITECTURE.md               (this file)
  docs/IDENTITY.md
  smart-contracts/                   (Foundry)
    foundry.toml
    src/
      interfaces/                   (shared, do not drift)
      ElectionFactory.sol
      Election.sol
      JurisdictionRegistry.sol
      VoterRegistry.sol
      PersonRegistry.sol
      DisqualificationRegistry.sol
      BallotInbox.sol
      TallyVerifier.sol
      ReasonCodes.sol
      hasher/
      tree/
      zk/
      account/                      (passkey AA + paymaster)
      l2/                           (rollup settlement)
    test/                           (unit, fuzz, invariant, handler)
    script/                         (deploy L1, L2, anvil)
  circuits/                         (circom vote + tally)
  l2/                               (sequencer, prover, genesis, explorer backend)
  apps/node/                        (DealPunchList-shaped Node: API + SPA)
  packages/
    types/
    proof-helpers/
    chain-client/
```

---

## Solidity 0.8.24 — exact interfaces

All contracts: `pragma solidity ^0.8.24;`
SPDX: `AGPL-3.0-or-later`
First comment after SPDX: `// NOT FOR PROFIT — civic public good, not a commercial product.`

### Roles (bytes32)

```
REGISTRAR_ROLE
CLERK_ROLE
DISQUALIFICATION_OFFICER_ROLE
TALLY_OPERATOR_ROLE
RELAYER_ROLE
PLATFORM_ADMIN_ROLE
```

### `ElectionParams`

```solidity
struct ElectionParams {
    string title;
    string metadataURI;
    uint64 startTime;          // unix seconds, inclusive
    uint64 cutoffTime;        // unix seconds, exclusive
    uint32 maxParticipants;    // 0 = unlimited
    uint8 treeDepth;          // 16..32; 32 => ~4e9 leaves
    bytes32 ballotSpecHash;    // keccak256 of canonical ballot JSON
    address clerk;
    address registrar;
    address disqualificationOfficer;
    address tallyOperator;
    address verifier;         // IGroth16Verifier
    uint8 questionCount;
    bytes32 jurisdictionId;
}
```

### `IElectionFactory`

```solidity
function createElection(ElectionParams calldata params)
    external returns (uint256 electionId, address election);
function getElection(uint256 electionId) external view returns (address);
function electionCount() external view returns (uint256);
function implementation() external view returns (address);
```

Factory uses EIP-1167 clones of `Election`. Anyone with `CLERK_ROLE` on
`JurisdictionRegistry` for that `jurisdictionId` may create. Platform admin
may also create (bootstrap).

Events: `ElectionCreated(uint256 indexed id, address election, bytes32 jurisdictionId, uint64 start, uint64 cutoff)`.

### `IElection`

Minimal proxy that owns per-election roots and points at inbox/registry.

```solidity
function params() external view returns (ElectionParams memory);
function eligibleRoot() external view returns (bytes32);
function disqualificationRoot() external view returns (bytes32);
function freezeRoll() external;          // clerk, before or at start
function rollFrozen() external view returns (bool);
function participantCount() external view returns (uint256);
function state() external view returns (uint8);
// 0=Created 1=RollFrozen 2=Open 3=Closed 4=Tallied
```

Time: `block.timestamp < startTime` → not open. `>= cutoffTime` → closed.
`maxParticipants != 0` → registry insert reverts at cap.

### `IVoterRegistry`

```solidity
function register(uint256 electionId, uint256 identityCommitment) external;
function registerWithProof(...) external; // optional path
function isRegistered(uint256 electionId, uint256 identityCommitment) external view returns (bool);
function merkleRoot(uint256 electionId) external view returns (bytes32);
function merklePath(uint256 electionId, uint256 leafIndex) /* test helper, not production leak of PII */;
```

`register` is called by `REGISTRAR_ROLE` or by a voter UserOp after the Node
has approved documents off-chain. The **leaf is the identity commitment**,
never the wallet address, never a name.

### `PersonRegistry`

```solidity
function verifyAddress(bytes32 personId, address account) external;
function setActive(bytes32 personId, address account) external;
function isVerified(bytes32 personId, address account) external view returns (bool);
function activeAddress(bytes32 personId) external view returns (address);
function personOf(address account) external view returns (bytes32);
```

`personId` is bytes32 (never a legal name). A person may have many internally
verified addresses and **exactly one** active address. `personOf` is globally
unique (`AlreadyOwned`). This is not the vote leaf; see [`IDENTITY.md`](./IDENTITY.md).

### `IDisqualificationRegistry`

```solidity
function disqualify(uint256 electionId, uint256 identityCommitment, uint16 reasonCode, bytes32 evidenceHash) external;
function revoke(uint256 electionId, uint256 identityCommitment, bytes32 evidenceHash) external;
function isDisqualified(uint256 electionId, uint256 identityCommitment) external view returns (bool);
function merkleRoot(uint256 electionId) external view returns (bytes32);
```

Reason codes live in `ReasonCodes.sol` as `uint16` constants matching the README catalog
(`NOT_OF_AGE=1`, `NOT_RESIDENT=2`, ... `OTHER=14`).

After `rollFrozen`, new disqualifications revert unless `lateUpdateAllowed` (default false).

### `IBallotInbox`

```solidity
function submitVote(
    uint256 electionId,
    uint256[2] calldata a,
    uint256[2][2] calldata b,
    uint256[2] calldata c,
    uint256[] calldata publicInputs, // [root, nullifier, ballotHash, electionId]
    bytes calldata encryptedBallot
) external;

function nullifierUsed(uint256 electionId, uint256 nullifier) external view returns (bool);
function acceptedBallots(uint256 electionId) external view returns (uint256);
```

Rejects when: verifier returns false; nullifier used; outside window; roll not frozen;
election mismatch; disqualification root in the proof does not match.

Relayer/bundler is the `msg.sender`. That is intentional.

### `IGroth16Verifier`

```solidity
function verifyProof(
    uint256[2] calldata a,
    uint256[2][2] calldata b,
    uint256[2] calldata c,
    uint256[] calldata input
) external view returns (bool);
```

`MockVerifier` (tests / local L2): owner can `setAccept(bool)`.
`VoteVerifier` is the generated/production verifier (can start as a
well-formed stub that checks input length and pairing-shaped points).

### `ITallyVerifier`

```solidity
function submitTally(
    uint256 electionId,
    uint256[] calldata counts, // per option, concatenated per question
    uint256[2] calldata a,
    uint256[2][2] calldata b,
    uint256[2] calldata c
) external;
function tally(uint256 electionId) external view returns (uint256[] memory);
```

Tally operator only. Must prove `sum(counts) == acceptedBallots` (circuit)
and option bounds. Mock path: if MockVerifier.accept, also require
`sum(counts) == inbox.acceptedBallots(electionId)`.

### Incremental Merkle tree

`src/tree/IncrementalMerkleTree.sol` — library, depth 16–32, zeros
precomputed, `IHasher.hashLeftRight(uint256, uint256)`.

### Account abstraction (passkey, gasless)

`src/account/PasskeyAccount.sol` — ERC-4337-style account whose owner is a
P-256 / WebAuthn public key. Signature is a WebAuthn assertion.

`src/account/PasskeyAccountFactory.sol` — `createAccount(bytes32 credIdHash, uint256 pubX, uint256 pubY, bytes32 salt)`.

`src/account/RepublicPaymaster.sol` — sponsors UserOps that call
`BallotInbox`, `VoterRegistry.register`, or `PasskeyAccountFactory`.
Voters do not hold the L2 gas token.

`src/account/RepublicEntryPoint.sol` — minimal EntryPoint sufficient for
local L2 (validate, paymaster, execute). Not a full eth-infinitism copy;
keep it small and auditable.

### L2 settlement

`src/l2/RollupSettlement.sol` (deployed on L1):

```solidity
function submitBatch(
    uint64 batchIndex,
    bytes32 prevStateRoot,
    bytes32 newStateRoot,
    bytes32 dataHash,
    uint256[2] a, uint256[2][2] b, uint256[2] c
) external;
function stateRoot() external view returns (bytes32);
function batchCount() external view returns (uint64);
```

Only the Republic prover/sequencer addresses. Batches are public; anyone
can re-derive `dataHash` from posted calldata.

`src/l2/L1TallyMirror.sol` — copies a tallied election result hash from L2
to L1 for court-grade records.

---

## Tests (Foundry)

`smart-contracts/test/`:

- `ElectionFactory.t.sol` — unbounded creates, clone isolation, access.
- `ElectionLifecycle.t.sol` — start/cutoff, freeze, cap, states.
- `VoterRegistry.t.sol` — insert, cap, duplicates.
- `PersonRegistry.t.sol` — many verified addresses, one active, cannot steal.
- `Disqualification.t.sol` — codes, revoke, frozen roll.
- `BallotInbox.t.sol` — happy path with MockVerifier, double-vote, window.
- `PrivacyUnlinkability.t.sol` — asserting wallet address ≠ leaf; nullifier
  uniqueness; msg.sender is relayer.
- `Paymaster.t.sol` — gasless path.
- `RollupSettlement.t.sol` — batch progression.
- `fuzz/FactoryFuzz.t.sol` — random params, start < cutoff, etc.
- `fuzz/VoteFuzz.t.sol` — random nullifiers, windows, caps.
- `invariant/VotingInvariant.t.sol` + `invariant/Handler.sol`

**Invariants (must hold):**

1. `acceptedBallots <= participantCount` (or == registered eligible who voted).
2. A nullifier is used at most once per election.
3. No vote is accepted outside `[startTime, cutoffTime)`.
4. No vote is accepted if `!rollFrozen`.
5. If `maxParticipants > 0`, `participantCount <= maxParticipants`.
6. `electionCount` equals number of successful `createElection`.
7. After tally, `sum(counts) == acceptedBallots`.
8. Disqualified commitment cannot produce an accepted vote when the mock
   verifier is in "check disqualification set" mode (handler simulates this).
9. Factory clones never share nullifier storage.

Use `forge test` (unit) and `forge test --fuzz-runs 256` locally.
Invariants: `forge test --match-path test/invariant/*`.

---

## Deployment scripts

`smart-contracts/script/`:

- `DeployLocal.s.sol` — anvil: factory, registries, mock verifier, paymaster, rollup.
- `DeployL1.s.sol` — Ethereum (or sepolia) settlement + optional factory.
- `DeployL2.s.sol` — Republic L2: factory + election stack + paymaster.
- `CreateElection.s.sol` — given factory address + JSON params, create one.

Broadcast JSON is gitignored. Scripts print addresses to stdout as
`name=0x...` for the Node app to ingest.

---

## Circuits

`circuits/vote.circom` — membership + nullifier + ballot commitment.
`circuits/tally.circom` — sum of encrypted ballots / plaintext homomorphic
sum for the mock path.
`circuits/README.md` — how to run `circom` + snarkjs when the trusted setup
is available. Until then, MockVerifier is the local path.

---

## Republic L2 (`/l2`)

App-specific ZK rollup (Lighter-shaped: prove the operations, settle on L1).

- `l2/genesis.json` — chainId `27427` (Republic), period 2s, 1 sequencer.
- `l2/sequencer/index.mjs` — JSON-RPC subset + block production. Can proxy
  to Anvil for EVM execution in dev.
- `l2/prover/index.mjs` — for each batch, compute new state root, produce a
  proof (real groth16 when keys exist; mock proof `{accept:true}` in dev),
  call `RollupSettlement.submitBatch`.
- `l2/config.json` — endpoints, addresses.
- `l2/README.md` — operator instructions, **NOT FOR PROFIT**.

Gas: voters never pay. Sequencer/paymaster is funded by the jurisdiction
(at cost). No token.

---

## Node app (`apps/node`) — DealPunchList shape

Long-lived Node process, web UI + HTTP API, `system_actions.sh` restarts it.
SQLite for local (file `apps/node/data/republic.sqlite`). Jurisdictions are
the DealPunchList "organizations". Elections are the "rooms". Officer roles
(`clerk`, `registrar`, `disqualification_officer`, `tally_operator`) are
granted per jurisdiction via `POST /api/jurisdictions/:id/roles`.
`platform_admin` is a global override and may act in every jurisdiction.

### HTTP

```
GET  /health
GET  /api/elections
POST /api/elections                 (clerk of that jurisdiction)
GET  /api/elections/:id
POST /api/elections/:id/register    (after passkey; registrar of that jurisdiction may register another person)
POST /api/elections/:id/vote        (relays UserOp / proof)
POST /api/elections/:id/disqualify   (officer of that jurisdiction)
POST /api/elections/:id/tally
POST /api/jurisdictions/:id/roles   (platform_admin; per-jurisdiction officer grants)
DELETE /api/jurisdictions/:id/roles
GET  /api/me
POST /api/auth/passkey/register/begin
POST /api/auth/passkey/register/finish
POST /api/auth/passkey/login/begin
POST /api/auth/passkey/login/finish
GET  /api/explorer/blocks
GET  /api/explorer/blocks/:n
GET  /api/explorer/txs/:hash
POST /api/explorer/ingest          (L2 sequencer; votes already delayed on L2)
GET  /api/config                    (includes hourly disclosure + identity policy)
GET  /api/identity/methods
POST /api/identity/web3/challenge
POST /api/identity/web3/verify
POST /api/identity/smart-card/challenge
POST /api/identity/smart-card/verify
GET  /api/me/identity
POST /api/me/eth-accounts            (many internally verified; first becomes active)
POST /api/me/eth-accounts/active
POST /api/persons/:id/person-key     (registrar; keccak256 civil-file token)
POST /api/persons/:id/methods
POST /api/persons/:id/eth-accounts
POST /api/persons/:id/eth-accounts/active
```

A person identifies with a **passkey, Web3 wallet, or smart-card digital ID**.
Many ETH addresses may be verified internally; only one is active. The
Merkle leaf remains the identity commitment ([`IDENTITY.md`](./IDENTITY.md)).

### Pages (SPA, Vite + React, served by Express)

Inspired by DealPunchList operational UX (organizations → jurisdictions,
admin tools, notifications) and Inertia-style passkey-held wallets
(WebAuthn PRF wraps the Ethereum key; no seed phrase shown).

- `/` — voter home (consumer)
- `/vote/:id` — ballot (passkey)
- `/register` — intake (passkey / Web3 / smart-card; one active ETH address)
- `/admin` — platform admin (hosts, keys, jurisdictions)
- `/back-office` — clerks / registrars / disqualification officers
- `/explorer` — Republic L2 block explorer (every block's outcomes)
- `/elections/:id/results`

No commercialization copy. Footer on every page: **NOT FOR PROFIT**.

### Passkey wallet (Inertia-style)

1. Create WebAuthn credential (`residentKey: required`, `extensions.prf`).
2. `prf.eval` first output → HKDF → encrypt a generated secp256k1 key
   (or derive it). Store wrapped key in IndexedDB + server credential id.
3. Signing a UserOp: get PRF, unwrap key, sign, immediately drop plaintext
   key from memory.
4. Fallback if PRF is unavailable: still create the passkey for login, and
   keep an encrypted key wrapped with a key derived from the assertion
   signature (documented as weaker). Never display a mnemonic.

---

## Block explorer

Must answer: what happened in block N? Registration inserts (commitments
only), votes accepted (nullifiers + ballot hashes, **not** choices),
disqualifications (reason codes), tally posts, rollup batches.

Vote rows and public turnout are **hourly**. A person leaving a voting
office must not be matchable to a live jurisdiction increase. See
[`docs/BLOCK_EXPLORER.md`](./BLOCK_EXPLORER.md).

UI: `/explorer` in the Node app. Backend may read L2 JSON-RPC
`eth_getBlockByNumber` plus contract event logs.

---

## Tooling

- Solidity: Foundry 1.8+, solc 0.8.24, via-ir off unless needed.
- Node: Node 22, npm workspaces.
- Tests must pass with `forge test` using MockVerifier.
- `npm test` in `apps/node` for API tests.

---

## What not to do

- Do not put legal names, DOB, or addresses on chain.
- Do not emit the selected option in an event.
- Do not add fees, tokens, or admin-skimmable ETH except gas sponsorship.
- Do not use upgradeable proxies for Election unless the params explicitly
  opt in (v1: no upgrades; factory deploys new elections).
