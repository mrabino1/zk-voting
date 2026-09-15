# ARCHITECTURE

**NOT FOR PROFIT** — civic public good. Not a commercial product. See `/NOT_FOR_PROFIT.md`.

Product name: **Republic**. Repo name: `zk-voting`.

This file is two things:

1. **Implemented today** — what is actually in the tree on `test/unstable`.
2. **Interface contract** — Solidity ABIs, circuit public inputs, and event shapes that packages must keep aligned.

**Future** work is labeled as such. Do not describe Future as if it were running.

| If this disagrees with… | Then |
| --- | --- |
| The tree in an **Implemented** section | This file is wrong. Update the docs. |
| Solidity / circuit **interface** text | The **code** is wrong (or the interface section is overdue). |
| A **Future** paragraph | The code is not expected to match yet. |

Product intent (why Republic exists, privacy construction, disqualification) lives in the root [`README.md`](../README.md). This file is the map of packages and interfaces.

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

**Implemented today:** the civic JSON sequencer + prover in `l2/` (chainId
**27427**) posts batch hashes to L1 `RollupSettlement`. It is **not** a
general-purpose EVM. Portable Solidity still deploys to Foundry Anvil,
Ethereum L1, and other EVM L2s. Running that same bytecode *as execution*
on 27427 is **Future**.

---

## Implemented stack (today)

| Layer | What is in the tree |
| --- | --- |
| Node UI | Vanilla JS + HTML/CSS in `apps/node/public/`. Express serves `public/` (and `dist/` if present). **No Vite. No React.** |
| Node API | Express 4, Node 22, `apps/node/src/*.mjs`. |
| Node store | JSON files: `apps/node/data/republic.json` and `apps/node/data/l2-chain.json` (gitignored). **No SQLite.** |
| Republic L2 | Civic JSON sequencer + prover. JSON-RPC subset on **127.0.0.1:8546**. Tx types: `register`, `vote`, `disqualify`, `tally`, `userop`. **Does not proxy to Anvil.** |
| Foundry / Anvil | Solidity tests and `DeployLocal` / `DeployL1` / `DeployL2` against an EVM (`anvil` default **:8545**). Separate from the civic sequencer. |
| Circuits | Circom 2: `vote.circom`, `tally.circom`, `identity.circom`. Hasher is a labeled Poseidon **stand-in**. |
| Verifier | Foundry + local path: `MockVerifier`. `VoteVerifier` is a structural stub until a ceremony. |
| Explorer | Node `/explorer` over `l2-chain.json`, filled by Node writes and `POST /api/explorer/ingest`. |
| Ballot types | Node UI/API: `YES_NO`, `SINGLE_CHOICE`, `MULTI_CHOICE`. Clerk hint also mentions `MEASURE` as a labeled question. **`RANKED` is Future.** |
| Passkey helper | `public/passkey-wallet.js`: WebAuthn + PRF wrap. Demo address is `republic-local-address` (SHA-256 of seed). Production secp256k1 Ethereum addresses are **Future** in that helper (it does not ship a curve implementation). |

Two local paths, both real:

1. **Demo civic path (default):** Node JSON store + Republic L2 JSON sequencer (`:8546`) + explorer ingest. No EVM required.
2. **Contract path (optional):** set `CHAIN_RPC` + `BALLOT_INBOX_ADDRESS` + `RELAYER_PRIVATE_KEY` so the Node relays `BallotInbox.submitVote` through viem to an EVM (typically Anvil on `:8545`). `@zk-voting/chain-client` still defaults `REPUBLIC_RPC_URL` to `http://127.0.0.1:8545` (Anvil), not the civic sequencer.

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

**Today’s browser helper** follows that shape but labels the derived account
`republic-local-address` until a secp256k1 library is wired. Production
Ethereum address derivation remains keccak256 of the uncompressed pubkey.

When they vote:

- Circuit proves: "I know a trapdoor whose commitment is in the eligible
  tree, I am **not** in the disqualification tree, this ballot is well-formed."
- Reveals `nullifier = poseidon(nullifierSecret, electionId)` so they cannot
  vote twice. The nullifier is **unlinkable** to the smart-account address
  and to the civil identity. (Circom `Hasher()` is a stand-in until Poseidon.)
- Ballot is an **ElGamal / hashed commitment** ciphertext posted with the
  proof. Choice is not a public field.
- On the civic sequencer, the transaction origin is the sequencer / bundler
  field, not the voter. On an EVM inbox call, `msg.sender` is the relayer.

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
  README.md                          (product intent + how to run)
  NOT_FOR_PROFIT.md
  LICENSE                            (AGPL-3.0-or-later)
  system_actions.sh
  package.json                       (workspaces)
  docker-compose.yml                 (Node + L2 host path)
  docs/ARCHITECTURE.md               (this file)
  docs/IDENTITY.md
  docs/L2.md
  docs/OPERATOR.md
  docs/BLOCK_EXPLORER.md
  docs/PASSKEYS.md
  smart-contracts/                   (Foundry)
    foundry.toml                     (solc 0.8.24, via_ir = true, fuzz 256)
    src/
      interfaces/                   (shared, do not drift)
      ElectionFactory.sol
      Election.sol
      JurisdictionRegistry.sol
      VoterRegistry.sol
      PersonRegistry.sol
      DisqualificationRegistry.sol
      BallotInbox.sol
      Tally.sol                     (implements ITallyVerifier)
      ReasonCodes.sol
      hasher/
      tree/
      zk/                           (MockVerifier, VoteVerifier stub)
      account/                      (passkey AA + paymaster)
      l2/                           (RollupSettlement, L1TallyMirror, mailbox)
    test/                           (unit, fuzz, invariant, handler)
    script/                         (DeployLocal, DeployL1, DeployL2, CreateElection)
  circuits/                         (circom vote + tally + identity)
  l2/                               (civic JSON sequencer, prover, genesis)
  apps/node/                        (Express API + vanilla JS pages)
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

From `src/Roles.sol`:

```
PLATFORM_ADMIN_ROLE
REGISTRAR_ROLE
CLERK_ROLE
DISQUALIFICATION_OFFICER_ROLE
TALLY_OPERATOR_ROLE
RELAYER_ROLE
SEQUENCER_ROLE
PROVER_ROLE
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

Events: `ElectionCreated(uint256 indexed electionId, address indexed election, bytes32 indexed jurisdictionId, uint64 startTime, uint64 cutoffTime)`.

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
function inbox() external view returns (address);
function voterRegistry() external view returns (address);
function disqualificationRegistry() external view returns (address);
function setRoots(bytes32 eligibleRoot_, bytes32 disqualificationRoot_) external;
function bumpParticipantCount() external;
```

Time: `block.timestamp < startTime` → not open. `>= cutoffTime` → closed.
`maxParticipants != 0` → registry insert reverts at cap.

### `IVoterRegistry`

```solidity
function register(uint256 electionId, uint256 identityCommitment) external;
function isRegistered(uint256 electionId, uint256 identityCommitment) external view returns (bool);
function merkleRoot(uint256 electionId) external view returns (bytes32);
function leafIndexOf(uint256 electionId, uint256 identityCommitment) external view returns (uint256);
function participantCount(uint256 electionId) external view returns (uint256);
```

`register` is called by `REGISTRAR_ROLE` or by a voter UserOp after the Node
has approved documents off-chain. The **leaf is the identity commitment**,
never the wallet address, never a name.

**Future (not in `IVoterRegistry`):** `registerWithProof`, a production
`merklePath` helper (do not leak PII).

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
function reasonCodeOf(uint256 electionId, uint256 identityCommitment) external view returns (uint16);
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
    uint256[] calldata publicInputs, // [root, disqRoot, nullifier, ballotHash, electionId]
    bytes calldata encryptedBallot
) external;

function nullifierUsed(uint256 electionId, uint256 nullifier) external view returns (bool);
function acceptedBallots(uint256 electionId) external view returns (uint256);
function ballotHashOf(uint256 electionId, uint256 nullifier) external view returns (bytes32);
```

Public inputs **must** be length ≥ 5, same order as `@zk-voting/proof-helpers`
`serializePublicInputs` and `circuits/vote.circom`:

`[root, disqRoot, nullifier, ballotHash, electionId]`

Rejects when: verifier returns false; nullifier used; outside window; roll not frozen;
election mismatch; eligible / disqualification root in the proof does not match;
`ballotHash` does not match `keccak256(encryptedBallot)`.

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

`MockVerifier` (tests / local L2 settlement): owner can `setAccept(bool)`.
`VoteVerifier` is the generated/production verifier stub (checks input length
and pairing-shaped points; unconfigured key delegates to mock or reverts).

### `ITallyVerifier` (implemented by `Tally.sol`)

There is **no** `TallyVerifier.sol`. The contract is `src/Tally.sol`.

```solidity
function submitTally(
    uint256 electionId,
    uint256[] calldata counts, // per option, concatenated per question
    uint256[2] calldata a,
    uint256[2][2] calldata b,
    uint256[2] calldata c
) external;
function tally(uint256 electionId) external view returns (uint256[] memory);
function isTallied(uint256 electionId) external view returns (bool);
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
local EVM (validate, paymaster, execute). Not a full eth-infinitism copy;
keep it small and auditable.

These contracts run on an **EVM** (Anvil, L1, other L2s). The civic JSON
sequencer does not execute them.

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

`src/l2/RepublicMailbox.sol` — L1/L2 message mailbox for the rollup.

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
- `fuzz/RegistryFuzz.t.sol`
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

`foundry.toml` sets `via_ir = true`, solc **0.8.24**, fuzz **256** runs.
Use `forge test --via-ir` (or the root `npm run test:contracts`, which already
passes `--via-ir`). Invariants: `forge test --via-ir --match-path test/invariant/*`.

---

## Deployment scripts

`smart-contracts/script/`:

- `DeployLocal.s.sol` — Anvil EVM: factory, registries, mock verifier, paymaster, rollup.
- `DeployL1.s.sol` — Ethereum (or sepolia) settlement + optional factory.
- `DeployL2.s.sol` — same election stack targeting an EVM configured as Republic L2 (not the civic JSON sequencer).
- `CreateElection.s.sol` — given factory address + JSON params, create one.
- `PrintAddresses.s.sol`, `anvil_deploy.sh` — local helpers (`RPC_URL` default `http://127.0.0.1:8545`).

Broadcast JSON is gitignored. Scripts print addresses to stdout as
`name=0x...` for the Node app to ingest.

---

## Circuits

`circuits/vote.circom` — membership + nullifier + ballot commitment.
Public instance: `[root, disqRoot, nullifier, ballotHash, electionId]`.
`circuits/tally.circom` — sum of encrypted ballots / plaintext homomorphic
sum for the mock path.
`circuits/identity.circom` — `Hasher()` stand-in, commitment, nullifier.
`circuits/README.md` — how to run `circom` + snarkjs when the trusted setup
is available. Until then, MockVerifier is the local path.

---

## Republic L2 (`/l2`) — civic JSON sequencer

**Implemented:** an application-specific civic rollup (Lighter-shaped:
prove the operations, settle on L1). Plain Node. No Docker. **Not** an
Anvil proxy and **not** a general-purpose EVM.

- `l2/genesis.json` — chainId `27427` (Republic), period 2s, 1 sequencer.
- `l2/sequencer/index.mjs` — mempool, ~2s blocks, hourly sealed votes.
- `l2/rpc/server.mjs` — JSON-RPC subset (`eth_chainId`, `eth_getBlockByNumber`,
  `eth_sendRawTransaction` as hex-encoded civic JSON, …). Bind **:8546**.
- `l2/prover/index.mjs` — for each batch, compute new state root, produce a
  proof (real groth16 when keys exist; mock `{a,b,c}` placeholder in dev),
  call `RollupSettlement.submitBatch` when `L1_RPC` + settlement address +
  key are set; otherwise write `l2/data/proofs/batch-N.json`.
- `l2/config.json` — endpoints, placeholder contract addresses.
- `l2/README.md` — operator instructions, **NOT FOR PROFIT**.

Civic `eth_sendRawTransaction` payload is UTF-8 JSON hex, for example:

```json
{"type":"vote","electionId":"1","nullifier":"0x…","ballotHash":"0x…","eligibleRoot":"0x…","disqualificationRoot":"0x…"}
```

**Future:** proxying EVM execution to Anvil so Foundry-deployed contracts
run unchanged on 27427. That is not in this tree.

Gas: voters never pay. Sequencer/paymaster is funded by the jurisdiction
(at cost). No token. `eth_getBalance` is `0` for ordinary voter addresses;
sequencer / paymaster report a fake sponsored balance for tooling.

---

## Node app (`apps/node`) — DealPunchList shape

Long-lived Node 22 process, web UI + HTTP API, `system_actions.sh` restarts it.

**Store:** JSON file `apps/node/data/republic.json` (gitignored). Native
addons such as `better-sqlite3` are **not** used. Jurisdictions are the
DealPunchList "organizations". Elections are the "rooms".

**UI:** vanilla JS modules and HTML in `apps/node/public/`. Express
`express.static` + a GET fallback that serves `admin.html` / `back-office.html`
/ `explorer.html` / `index.html`. There is no Vite dev server and no React
build. `npm run build` in this package is a no-op log line.

### HTTP (implemented)

```
GET  /health
GET  /api/health
GET  /api/config                    (hourly disclosure + identity policy)
GET  /api/elections
POST /api/elections                 (clerk)
GET  /api/elections/:id
GET  /api/elections/:id/info
GET  /api/elections/:id/info/:questionId/:optionId
PATCH /api/elections/:id            (clerk; questions + option metadata until freeze)
PUT  /api/elections/:id             (same as PATCH)
GET  /api/elections/:id/ballots     (published vote rows only)
GET  /api/elections/:id/envelopes   (tally_operator; after cutoff; ciphertext only)
GET  /api/elections/:id/registrations
POST /api/elections/:id/register    (after passkey)
POST /api/elections/:id/freeze      (clerk)
POST /api/elections/:id/vote        (relays proof; JSON store and/or CHAIN_RPC)
POST /api/elections/:id/disqualify   (officer)
POST /api/elections/:id/disqualify/revoke
POST /api/elections/:id/revoke
POST /api/elections/:id/tally
GET  /api/me
GET  /api/session
GET  /api/me/identity
GET  /api/notifications
POST /api/notifications/:id/read
POST /api/auth/passkey/register/begin
POST /api/auth/passkey/register/finish
POST /api/auth/passkey/login/begin
POST /api/auth/passkey/login/finish
POST /api/auth/web3/challenge       (returning-user wallet login)
POST /api/auth/web3/login
POST /api/auth/logout
POST /api/auth/dev-login            (ALLOW_DEV_LOGIN or NODE_ENV=test)
GET  /api/auth/session
GET  /api/identity/methods
POST /api/identity/web3/challenge
POST /api/identity/web3/verify
POST /api/identity/smart-card/challenge
POST /api/identity/smart-card/verify
POST /api/me/eth-accounts            (many internally verified; first becomes active)
POST /api/me/eth-accounts/active
POST /api/persons/:id/person-key     (registrar; keccak256 civil-file token)
POST /api/persons/:id/methods
POST /api/persons/:id/eth-accounts
POST /api/persons/:id/eth-accounts/active
GET  /api/explorer/blocks
GET  /api/explorer/blocks/:n
GET  /api/explorer/txs/:hash
GET  /api/explorer/nullifiers/:value
GET  /api/explorer/search
GET  /api/explorer/elections/:id
POST /api/explorer/ingest          (L2 sequencer; votes already delayed on L2)
GET  /api/reason-codes
GET  /api/roles
GET  /api/jurisdictions
POST /api/jurisdictions
POST /api/jurisdictions/:id/roles
POST /api/admin/roles
POST /api/admin/grant
GET  /api/users                     (platform_admin)
PATCH /api/users/:id
```

Without `CHAIN_RPC`, votes that pass the election window, nullifier check, and
Node eligibility (`identityCommitment` registered and not currently disqualified)
are accepted in the local JSON store so the explorer and UI can run a demo.
Those accepts still wait for hourly public disclosure unless the interval is `0`.

A person identifies with a **passkey, Web3 wallet, or smart-card digital ID**.
Many ETH addresses may be verified internally; only one is active. The
Merkle leaf remains the identity commitment ([`IDENTITY.md`](./IDENTITY.md)).

### Eligible set on the Node path

Product rule: **`eligible = registered ∩ ¬currently-disqualified`** (registration
order). The Node rebuilds `eligibleRoot` on register, disqualify, and revoke.
`POST /api/elections/:id/freeze` snapshots `frozenEligibleRoot` and
`frozenDisqualificationRoot` — those are the roots for the open window unless
the election was created with `lateUpdateAllowed` (discouraged).

When `CHAIN_RPC` is unset, `POST /api/elections/:id/vote` requires
`identityCommitment` and rejects with:

| `code` | Meaning |
| --- | --- |
| `DISQUALIFIED` | Commitment is currently disqualified (`reasonCode` / `reasonName` included) |
| `NOT_REGISTERED` | Commitment is not on the registration roll |
| `IDENTITY_COMMITMENT_REQUIRED` | Node path cannot enforce eligibility without the leaf |
| `ELIGIBLE_ROOT_MISMATCH` / `DISQUALIFICATION_ROOT_MISMATCH` | Proof roots do not match the open-window set |

`identityCommitment` is checked then discarded. It is never stored on the
vote or envelope.

### ZK non-membership gap (not fixed in this layer)

`vote.circom` binds `disqRoot` as a public input; it does **not** prove
non-membership in the disqualification tree. Cryptographic exclusion of a
disqualified person depends on membership in a correctly rebuilt eligible
root. `MockVerifier` still accepts any proof. **Node enforcement is the
product control until a non-membership (or equivalent) constraint exists and
a production hasher/verifier replaces the mock.** This layer does not
replace MockVerifier or Poseidon.

### Pages (vanilla JS, served by Express)

Inspired by DealPunchList operational UX (organizations → jurisdictions,
admin tools, notifications) and Inertia-style passkey-held wallets
(WebAuthn PRF wraps the Ethereum key; no seed phrase shown).

| Path | Files | Status |
| --- | --- | --- |
| `/`, `/register`, `/vote/:id` | `public/index.html` + `app.js` / `register.js` / `vote.js` / `router.js` | Implemented |
| `/elections/:id/info` | `public/info.js` | Implemented (option supporting info) |
| `/elections/:id/info/:questionId/:optionId` | `public/info.js` | Implemented |
| `/admin` | `public/admin.html` + `admin.js` | Implemented |
| `/back-office` | `public/back-office.html` + `back-office.js` | Implemented |
| `/explorer` | `public/explorer.html` + `explorer.js` | Implemented |
| `/elections/:id/results` | Linked from explorer and back-office | **Not a voter-SPA route yet.** `index.html` shows “page not found”. Tally data is on `GET /api/elections/:id` and the explorer. **Future:** a dedicated results view. |

No commercialization copy. Footer on every page: **NOT FOR PROFIT**.

Question types the ballot UI renders: `YES_NO`, `SINGLE_CHOICE`, `MULTI_CHOICE`.
**`RANKED` is Future.** Do not document ranked choice as if the UI tabulated it.

### Passkey wallet (Inertia-style)

1. Create WebAuthn credential (`residentKey: required`, `extensions.prf`).
2. `prf.eval` first output → HKDF → encrypt a generated 32-byte seed
   (AES-GCM) and store the blob in IndexedDB + server credential id.
3. Signing: get PRF, unwrap seed, HMAC-sign, immediately drop plaintext
   from memory. **Today** this is not a secp256k1 UserOp signature.
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

UI: `/explorer` in the Node app. **Implemented backend:** JSON log
`apps/node/data/l2-chain.json`, Node `explorer.append` / `recordVote`, and
sequencer `POST /api/explorer/ingest`. The civic sequencer also exposes
`eth_getBlockByNumber` on `:8546`. The Node explorer does **not** ABI-decode
generic EVM logs.

---

## Tooling

- Solidity: Foundry 1.8+, solc 0.8.24, **`via_ir = true`** in `foundry.toml`.
- Node: Node 22, npm workspaces.
- Tests must pass with `forge test --via-ir` using MockVerifier.
- `npm test -w apps/node` for API tests (`NODE_ENV=test node --test`).
- `npm run test:l2` for civic sequencer tests.

---

## What not to do

- Do not put legal names, DOB, or addresses on chain.
- Do not emit the selected option in an event.
- Do not add fees, tokens, or admin-skimmable ETH except gas sponsorship.
- Do not use upgradeable proxies for Election unless the params explicitly
  opt in (v1: no upgrades; factory deploys new elections).
- Do not claim Vite, React, SQLite, or an Anvil-backed EVM L2 in docs
  unless those land in the tree.
