# ARCHITECTURE

**NOT FOR PROFIT** — civic public good. Not a commercial product. See `/NOT_FOR_PROFIT.md`.

Product name: **ZK-Voting** by default (renameable in site admin). Repo name: `zk-voting`.

This file is two things:

1. **Implemented today** — what is actually in the tree on `test/unstable`.
2. **Interface contract** — Solidity ABIs, circuit public inputs, and event shapes that packages must keep aligned.

**Future** work is labeled as such. Do not describe Future as if it were running.

| If this disagrees with… | Then |
| --- | --- |
| The tree in an **Implemented** section | This file is wrong. Update the docs. |
| Solidity / circuit **interface** text | The **code** is wrong (or the interface section is overdue). |
| A **Future** paragraph | The code is not expected to match yet. |

Product intent (why ZK-Voting exists, privacy construction, disqualification) lives in the root [`README.md`](../README.md). This file is the map of packages and interfaces.

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
| Node API | Express 4, Node 22, `apps/node/src/*.mjs`. Personal API keys (`Authorization: Bearer rk_…`) call the published bot catalog. |
| Bot docs | `GET /api` (HTML), `GET /api/openapi.json`, `GET /api/llms.txt`, repo `docs/BOT_API.md` and `llms.txt`. |
| Node store | JSON files: `apps/node/data/zk-voting.json` and `apps/node/data/l2-chain.json` (gitignored). **No SQLite.** |
| ZK-Voting L2 | Civic JSON sequencer + prover. JSON-RPC subset on **127.0.0.1:8546**. Tx types: `register`, `vote`, `disqualify`, `tally`, `userop`. **Does not proxy to Anvil.** |
| Foundry / Anvil | Solidity tests and `DeployLocal` / `DeployL1` / `DeployL2` against an EVM (`anvil` default **:8545**). Separate from the civic sequencer. |
| Circuits | Circom 2: `vote.circom` (Vote 20), `tally.circom`, `identity.circom`. Hasher is Poseidon(2). Ceremony is not done. |
| Verifier | Foundry + local path: `MockVerifier`. `VoteVerifier` is a structural stub until a ceremony. |
| Explorer | Node `/explorer` over `l2-chain.json`, filled by Node writes and `POST /api/explorer/ingest`. |
| Ballot types | Node UI/API: `YES_NO`, `SINGLE_CHOICE`, `MULTI_CHOICE`, `MEASURE`, `ARTICLE`, `RANKED` (IRV on the Node path). |
| Passkey helper | `public/passkey-wallet.js`: WebAuthn + PRF wrap. Demo address is `zk-voting-local-address` (SHA-256 of seed). Production secp256k1 Ethereum addresses are **Future** in that helper (it does not ship a curve implementation). |

Two local paths, both real:

1. **Demo civic path (default):** Node JSON store + ZK-Voting L2 JSON sequencer (`:8546`) + explorer ingest. No EVM required.
2. **Contract path (optional):** set `CHAIN_RPC` + `BALLOT_INBOX_ADDRESS` + `RELAYER_PRIVATE_KEY` so the Node relays `BallotInbox.submitVote` through viem to an EVM (typically Anvil on `:8545`). `@zk-voting/chain-client` still defaults `ZK_VOTING_RPC_URL` to `http://127.0.0.1:8545` (Anvil), not the civic sequencer.

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
`zk-voting-local-address` until a secp256k1 library is wired. Production
Ethereum address derivation remains keccak256 of the uncompressed pubkey.

When they vote:

- Circuit proves: "I know a trapdoor whose commitment is in the eligible
  tree, I am **not** in the disqualification tree, this ballot is well-formed."
- Reveals `nullifier = poseidon(nullifierSecret, electionId)` so they are counted
  once. That nullifier is accepted **once**. A second `submitVote`, including a
  new ciphertext, reverts `NullifierUsed`. Voters may change their mind
  privately on the ballot form **before** submit. The nullifier is **unlinkable**
  to the smart-account address and to the civil identity. (Circom `Hasher()` is
  a stand-in until Poseidon.)
- Ballot is an **ElGamal / hashed commitment** ciphertext posted with the
  proof. Choice is not a public field.
- On the civic sequencer, the transaction origin is the sequencer / bundler
  field, not the voter. On an EVM inbox call, `msg.sender` is the relayer.

A coercer who sees the public address learns only that the person registered.
They cannot read the choice. The Node **must not** print "I voted for X".
The receipt is hashes only (nullifier, `ballotHash`). It cannot open the
ciphertext. After accept, the default is to download the locked PDF or copy
the proof on the device. Emailing is opt-in (explicit address plus `optIn`):
the message carries the election and holder token only — no nullifier, no
ballot hash, no attachment — and nothing about the send is stored. The PDF uses PDF Standard Security
so it cannot be edited (print and copy remain allowed). The Node records
SHA-256 of the exact bytes; `/receipt` accepts the proof or the file and
rejects a modified PDF. A public `/receipt` portal answers whether the ballot
counted, plus disclosed turnout (after the hour, the disclosure delay, the
results gate, and the block floor) — never a candidate or option. A holder token
on the receipt can confirm a count before that publication; looking up public
hashes still waits for disclosure. Double voting remains impossible. A separate public `/outcomes`
portal monitors every election before, during, and after voting from chain
status, running the same auditor pack plus freeze-root and L1 checks. During
the open window it still does not invent unofficial option counts. After
`cutoffTime` has passed and a tally is posted, the Node issues a locked
**official outcome PDF** (option counts, start, end) with a required QR and
SHA-256 / HMAC authenticity page; `/outcomes/verify` checks the file was not
changed. Subscribing to that PDF is opt-in on `/me`; casting a ballot never
creates a subscription (see `docs/OPERATOR.md`, "Ballot unlinkability"). This is
**not** MACI and
**not** last-vote-counts: a coercer who can force the first (and only) submit
still wins that ballot.

### Hourly public disclosure (polling-place unlinkability)

Votes are **accepted immediately** (each nullifier **once**; a second ballot is
rejected). Public proof of those votes — explorer rows, jurisdiction
`acceptedBallots`, any dashboard turnout tick — waits for three server-side
checks:

- The UTC hour has closed and `DISCLOSURE_DELAY_SECONDS` (default **1800**)
  has elapsed. A vote at 08:59 publishes at **09:30**. An earlier note that a
  14:05 vote appears at 15:00 is replaced by **15:30**, and only if the next
  two checks also pass.
- The results gate is open: `RESULTS_MIN_VOTES` ballots (default **100**) or
  the scheduled end, whichever is earlier. A certified tally also opens it.
- The disclosure block has at least `DISCLOSURE_MIN_BLOCK_VOTES` ballots
  (default **10**). Smaller hours merge forward. A remainder publishes at
  election end when the election met that floor; a short election publishes
  at the certified tally.

- Do not leak a pending-per-election count (that still identifies the
  jurisdiction).
- Do not publish original intra-hour timestamps. Ready hours are lumped into
  a disclosure block, timestamped at the disclosure clock (hour end + delay),
  ordered by nullifier (not arrival).
- Default interval is 3600 seconds (`DISCLOSURE_INTERVAL_SECONDS`). Tests
  and local instant demo may set the interval to `0` (and the gate and block
  floor to their test defaults).

Hasher note: the vote circuit, proof-helpers, browser `poseidon.js`, Solidity `PoseidonHasher`, and the demo passkey leaf share Poseidon(2) (`zk-voting.hash.poseidon-bn254-x5-t3-v1`). Unit-test Merkle trees stay `KeccakHasher` (`keccak-dev-v1`). The stand-in bilinear mix is legacy and not included. Poseidon wiring is not a ceremony. See [`circuits/HASH_SCHEME.md`](../circuits/HASH_SCHEME.md).

### Person (unique) vs one active Ethereum address

A Node user is one **person**. They may bind up to 5 emails (exactly one
primary), several Web3 wallets (signature-verified), up to 5 smart cards,
up to 5 driver’s licenses or passports, and up to 5 passkeys. Several ETH
addresses can be internally verified; exactly one is **active** (gasless ops).
A voter **requests** election registration; a registrar or clerk of that
election’s jurisdiction **approves** before the commitment is on the roll.
Authenticators and addresses cannot belong to two people. Officers may
revoke an expired card or license. Each person sets a vote PIN (hashed;
scrambled phone keypad at ballot submit). The vote leaf stays `identityCommitment`.
Details: [`IDENTITY.md`](./IDENTITY.md). Commander brief (design vs demo): [`../how_voters_privacy_is_protected.md`](../how_voters_privacy_is_protected.md).

---

## Monorepo layout (owners)

```
zk-voting/
  README.md                          (product intent + how to run)
  how_voters_privacy_is_protected.md (commander privacy brief)
  NOT_FOR_PROFIT.md
  LICENSE                            (AGPL-3.0-or-later)
  system_actions.sh
  package.json                       (workspaces)
  docker-compose.yml                 (Node + L2 host path)
  docs/ARCHITECTURE.md               (this file)
  docs/IDENTITY.md
  docs/THREAT_MODEL.md               (election identity / L1 adversary map)
  docs/L2.md
  docs/OPERATOR.md
  docs/BLOCK_EXPLORER.md
  docs/PASSKEYS.md
  docs/AUDITOR.md
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
  circuits/                         (circom vote + tally + identity; HASH_SCHEME.md; proving-path scripts)
  l2/                               (civic JSON sequencer, prover, genesis)
  apps/node/                        (Express API + vanilla JS pages)
  tools/auditor/                    export + verify public artifacts
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
    bytes32 tallyPubKeyX;      // P-256 X; 0 = no encryption key (legacy)
    bytes32 tallyPubKeyY;
    uint8 tallyScheme;        // 0=SUM_ONLY 1=OPENS_BALLOTS
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

Factory uses EIP-1167 clones of `Election`. Only `JurisdictionRegistry`
**clerks** (not registrars / tally officers) for that `jurisdictionId`
may create. Platform admin may also create (bootstrap). A clerk of A
cannot mint an election that claims B’s `jurisdictionId` by putting
themselves in `params.clerk`. Production deploys **must** call
`ElectionFactory.setJurisdictionRegistry`.

Events: `ElectionCreated(uint256 indexed electionId, address indexed election, bytes32 indexed jurisdictionId, uint64 startTime, uint64 cutoffTime)`.

### Election identifiers (off-chain vs on-chain)

These are **two different ids**. Do not put a UUID into a `uint256` circuit
input or `BallotInbox.submitVote`.

| Field | Where | Shape |
| --- | --- | --- |
| `id` | Node API, SPA `/vote/:id`, clerk links | UUID v5 bound to factory + on-chain id + jurisdiction (legacy records may be v4) |
| `shortCode` | `/v/:shortCode`, `/e/:shortCode`, optional API `:id` | 10 url-safe chars, unique per Node |
| `onChainElectionId` | `ElectionFactory`, registries, BallotInbox, Groth16 `electionId` | `uint256`, factory `++electionCount` |
| `certificationId` | L1 `L1TallyMirror` slot | `keccak256(abi.encode(DOMAIN, factory, electionId, jurisdictionId))` |

A public UUID is an alias, not the proof of identity. Two jurisdictions
(or a honest Node and a nefarious fork) can *advertise* the same UUID.
L1 does **not** key by that UUID. It keys by the shared `ElectionFactory`
address, the factory uint256, and the `jurisdictionId` baked into
`Election.params`. A copied UUID therefore lands in a different L1 slot —
or, if the attacker also claims the honest factory + id + jurisdiction,
they must be a publisher for that body and `AlreadyPosted` keeps the first
certified tally. Outcome verification recomputes UUID v5 from those fields;
a copied id fails `publicIdMatchesScope`.

`GET/POST /api/elections/:id` accepts UUID, short code, or the decimal
on-chain id (and any leftover non-UUID fixture ids). Short HTTP routes
302 to `/vote/<uuid>`. New elections mint a scoped UUID v5 plus a short
code; the Node stores `onChainElectionId` as the mapping. Client-supplied
`id` / `uuid` / `factoryAddress` / `onChainElectionId` bodies are ignored.
Local demos allocate a sequential integer so proofs still have a uint256
when the factory is not invoked, and bind the UUID to `nodeId` + jurisdiction
so two demo forks do not collide. On-chain ids come only from
`ElectionFactory.createElection` (or the local allocator), never from the
client — a copied uint256 would be an L1 slot claim.

The factory is **not** changed: it still returns `(uint256 electionId, address)`.

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
function isEligible(uint256 electionId, uint256 identityCommitment) external view returns (bool);
function merkleRoot(uint256 electionId) external view returns (bytes32); // registration roll, includes DQ
function eligibleCount(uint256 electionId) external view returns (uint256);
function rebuildEligibleRoot(uint256 electionId) external returns (bytes32);
function leafIndexOf(uint256 electionId, uint256 identityCommitment) external view returns (uint256);
function participantCount(uint256 electionId) external view returns (uint256);
```

`register` is called by `REGISTRAR_ROLE` or by a voter UserOp after the Node
has approved documents off-chain. The **leaf is the identity commitment**,
never the wallet address, never a name. `merkleRoot` is the append-only
registration roll. `Election.eligibleRoot` is the intersection below.
`rebuildEligibleRoot` is only for the disqualification registry.

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
function ballotRoot(uint256 electionId) external view returns (bytes32);
function ballotHashAt(uint256 electionId, uint256 index) external view returns (bytes32);
```

Public inputs **must** be length ≥ 5, same order as `@zk-voting/proof-helpers`
`serializePublicInputs` and `circuits/vote.circom`:

`[root, disqRoot, nullifier, ballotHash, electionId]`

Rejects when: verifier returns false; nullifier already used (`NullifierUsed`),
including a new `ballotHash`; outside window; roll not frozen; election mismatch;
eligible / disqualification root in the proof does not match;
`ballotHash` does not match the ciphertext. A canonical `EG` ballot hashes the ordered option vector with Poseidon. Any other ciphertext is `keccak256(encryptedBallot) mod r`.

A nullifier is accepted **once**. `acceptedBallots` counts unique nullifiers.
Double voting is impossible. Event: `VoteAccepted`. Relayer/bundler is
`msg.sender`. That is intentional.

### `IGroth16Verifier`

```solidity
function verifyProof(
    uint256[2] calldata a,
    uint256[2][2] calldata b,
    uint256[2] calldata c,
    uint256[] calldata input
) external view returns (bool);
```

`MockVerifier` (tests / local L2 default): owner can `setAccept(bool)`.
`VoteVerifier` is the generated/production verifier (zero VK until a ceremony;
delegates to `mockVerifier` only while unconfigured). `ZK_VOTING_PROVING_PATH=1`
deploys `VoteVerifier` with no mock fallback. `Groth16VerifierAdapter` wraps a
snarkjs-exported verifier (`circuits/build/`) onto `IGroth16Verifier`.
Unconfigured key still checks input length and pairing-shaped points.

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
function submitOpenedTally(
    uint256 electionId,
    uint256[] calldata counts,
    uint256[] calldata openings, // option index per accepted ballot
    uint256[2] a, uint256[2][2] b, uint256[2] c
) external;
function tally(uint256 electionId) external view returns (uint256[] memory);
function isTallied(uint256 electionId) external view returns (bool);
```

Tally operator only. After cutoff.

**`tallyScheme == 0` (SUM_ONLY, default / legacy demo):** any `counts` with
`sum(counts) == inbox.acceptedBallots(electionId)` may be posted. Invented
partitions that only match the sum **succeed**. Existing Foundry tests use this
path.

**`tallyScheme == 1` (OPENS_BALLOTS):** `submitTally` reverts (`OpeningsRequired`).
`submitOpenedTally` requires `openings.length == acceptedBallots` and
`histogram(openings) == counts`. Invented vectors that only match the sum
**revert**. Off-chain, `t` guardians threshold-decrypt P-256 ECIES envelopes
(Feldman verification keys, Chaum-Pedersen partials) and the Node derives
those openings. The on-chain check does not itself decrypt; it
binds the posted histogram to an openings vector and to `ballotRoot`.

Public inputs for `Tally.sol` are **TALLY_SOL_MOCK_V1** (`TallyPublicInputs.sol`):
`[version=1, electionId, acceptedCount, countsHash, ballotRoot, openingsHash]`.
That is **not** the same array as `circuits/tally.circom` (`[total, electionId, counts…, acceptedCount]` for the default `Tally(8,4)`). MockVerifier remains the local path until a translating Groth16 wrapper exists.

Demo tally encryption is a **Feldman t-of-n** guardian ceremony
(`p256-feldman-dkg-v1`, Chaum-Pedersen partials). Labeled **NON-PRODUCTION**.
Ballot aggregation — homomorphic product or mixnet — is an open product
decision and is not selected; see [`TALLY_GUARDIANS.md`](./TALLY_GUARDIANS.md).
Do not pretend MACI coercion-resistance is done.

### Incremental Merkle tree

`src/tree/IncrementalMerkleTree.sol` — library, depth 16–32, zeros
precomputed, `IHasher.hashLeftRight(uint256, uint256)`.

### Account abstraction (passkey, gasless)

`src/account/PasskeyAccount.sol` — ERC-4337-style account whose owner is a
P-256 / WebAuthn public key. Signature is a WebAuthn assertion.

`src/account/PasskeyAccountFactory.sol` — `createAccount(bytes32 credIdHash, uint256 pubX, uint256 pubY, bytes32 salt)` (WebAuthn only), or `createAccountWithBackupSigner(credIdHash, pubX, pubY, ethBackupSigner, salt)` for an immutable secp256k1 backup key. WebAuthn assertions must carry `challenge = base64url(userOpHash)`, `type = webauthn.get` and the UP flag, and require the P-256 precompile at `0x100` (no fallback).

`src/account/ZkVotingPaymaster.sol` — sponsors UserOps that call
`BallotInbox`, `VoterRegistry.register`, or `PasskeyAccountFactory`.
Voters do not hold the L2 gas token.

`src/account/ZkVotingEntryPoint.sol` — minimal EntryPoint sufficient for
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

Only the ZK-Voting prover/sequencer addresses. Batches are public; anyone
can re-derive `dataHash` from posted calldata.

`src/l2/L1TallyMirror.sol` — copies a tallied election result hash from L2
to L1 for court-grade records. The canonical slot is **not** the public
UUID and **not** a bare `uint256`:

```solidity
function postCertifiedResult(Certification calldata cert) external;
// cert.factory, electionId, jurisdictionId, publicIdHash, ballotSpecHash, resultHash, …
function certificationIdOf(address factory, uint256 electionId, bytes32 jurisdictionId)
    external pure returns (bytes32);
```

`certificationId = keccak256(abi.encode(DOMAIN, factory, electionId, jurisdictionId))`.
`publicIdHash` (`keccak256` of the advertised UUID string) is stored as an
attribute so a copied UUID can be detected (`publicIdCollision`) without
letting the copier occupy the honest slot.

Legacy `postResult(uint256 electionId, bytes32 resultHash, uint256 totalBallots, bytes32 l2StateRoot)`
remains for unpinned mirrors and old scripts. After `setL2Factory`, that
uint256 path reverts `UseIdentityPost` — two factories must not share
`resultHashOf[1]`. Pin `setL2Factory` to the shared ElectionFactory so a
rogue factory cannot certify on the official mirror. Grant
`setJurisdictionPublisher` per body rather than a global publisher when a
jurisdiction operator posts. After pin, `_canPost` ignores global
`publishers[]` (admin is break-glass). `setL2Factory` cannot be zeroed or
replaced once set. When the factory is on the same chain, the mirror
checks `Election.params().jurisdictionId`.

Only `admin`, a per-jurisdiction publisher, or (when the factory is
readable on that chain) the election’s `tallyOperator`. Unpinned mirrors
still honor `publishers[]` for legacy tests. A second post for the same
identity reverts `AlreadyPosted`. The Node
(`POST /api/elections/:id/tally` and `POST /api/elections/:id/certify-l1`)
and `script/CertifyL1.s.sol` call this when L1 env is set; they no-op
when it is not. CI must not supply mainnet keys.

`src/l2/ZkVotingMailbox.sol` — L1/L2 message mailbox for the rollup.

---

## Tests (Foundry)

`smart-contracts/test/`:

- `ElectionFactory.t.sol` — unbounded creates, clone isolation, access.
- `ElectionLifecycle.t.sol` — start/cutoff, freeze, cap, states.
- `Tally.t.sol` — SUM_ONLY vs OPENS_BALLOTS; invented partitions fail when openings are required.
- `VoterRegistry.t.sol` — insert, cap, duplicates.
- `PersonRegistry.t.sol` — many verified addresses, one active, cannot steal.
- `Disqualification.t.sol` — codes, revoke, frozen roll.
- `BallotInbox.t.sol` — happy path with MockVerifier, double-vote (same and different ciphertext), window.
- `CoercionResistance.t.sol` — second ballot reverts; on-chain state is nullifier + hash only.
- `PrivacyUnlinkability.t.sol` — asserting wallet address ≠ leaf; nullifier
  uniqueness; msg.sender is relayer.
- `Paymaster.t.sol` — gasless path.
- `RollupSettlement.t.sol` — batch progression.
- `L1TallyMirror.t.sol` — `postResult`, publisher ACL, AlreadyPosted, packed counts hash.
- `ElectionIdentity.t.sol` — jurisdiction-bound factory creates; L1 slots separate copied UUIDs and two factories with the same uint256.
- `fuzz/FactoryFuzz.t.sol` — random params, start < cutoff, etc.
- `fuzz/VoteFuzz.t.sol` — random nullifiers, windows, caps.
- `fuzz/RegistryFuzz.t.sol`
- `invariant/VotingInvariant.t.sol` + `invariant/Handler.sol`

**Invariants (must hold):**

1. `acceptedBallots <= participantCount` (or == registered eligible who voted).
2. A nullifier is **accepted** at most once per election. A second ballot,
   including a later different `ballotHash`, reverts. Double voting is
   impossible. `acceptedBallots` equals unique spent nullifiers.
3. No vote is accepted outside `[startTime, cutoffTime)`.
4. No vote is accepted if `!rollFrozen`.
5. If `maxParticipants > 0`, `participantCount <= maxParticipants`.
6. `electionCount` equals number of successful `createElection`.
7. After tally, `sum(counts) == acceptedBallots`.
8. A coded disqualification drops that commitment from `eligibleRoot`.
   An inclusion witness for the disqualified leaf does not verify against
   the published root. `BallotInbox` rejects a proof whose public root is
   still the registration roll. `MockVerifier` enforces the inclusion check
   when a test arms the witness; `acceptAll` alone does not.
9. Factory clones never share nullifier storage.

`foundry.toml` sets `via_ir = true`, solc **0.8.24**, fuzz **256** runs.
Use `forge test --via-ir` (or the root `npm run test:contracts`, which already
passes `--via-ir`). Invariants: `forge test --via-ir --match-path test/invariant/*`.

---

## Deployment scripts

`smart-contracts/script/`:

- `DeployLocal.s.sol` — Anvil EVM: factory, registries, mock verifier, paymaster, rollup.
- `DeployL1.s.sol` — Ethereum (or sepolia) settlement + optional factory.
- `DeployL2.s.sol` — same election stack targeting an EVM configured as ZK-Voting L2 (not the civic JSON sequencer).
- `CreateElection.s.sol` — given factory address + JSON params, create one.
- `CertifyL1.s.sol` — `L1TallyMirror.postResult` from `COUNTS` / `RESULT_HASH`. Wrapper: `script/certify_l1.sh` (no-op if L1 env unset).
- `PrintAddresses.s.sol`, `anvil_deploy.sh` — local helpers (`RPC_URL` default `http://127.0.0.1:8545`).

Broadcast JSON is gitignored. Scripts print addresses to stdout as
`name=0x...` for the Node app to ingest.

---

## Circuits

`circuits/vote.circom` — membership + nullifier + ballot commitment.
Public instance: `[root, disqRoot, nullifier, ballotHash, electionId]`.
`circuits/tally.circom` — plaintext histogram of opened option indices
(`Tally(nBallots, nOptions)`). Public signals are **CIRCOM_TALLY_V1** (outputs
first): `[total, electionId, counts…, acceptedCount]`. Solidity `Tally.sol`
uses a separately versioned mock instance (`TallyPublicInputs`). Do not wire a
generated circuit verifier to `Tally.sol` without a translator. MockVerifier
is the local Foundry path.
`circuits/HASH_SCHEME.md` — Poseidon vote circuit, keccak unit tests, legacy stand-in, untrusted Groth16 fixture.
`circuits/identity.circom` — Poseidon `Hasher()`, commitment, nullifier.
`circuits/README.md` — exact `circom` + snarkjs commands. Proving path is
**in progress**. Local `npm run circuits:setup` is UNTRUSTED. Phase-2
contribute / verify / beacon / export tooling is `docs/CEREMONY.md`. Running
it does not complete a ceremony. Until a real ceremony, MockVerifier is the
Foundry unit-test path. `ZK_VOTING_PROVING_PATH=1`
is the fail-closed integration flag.

---

## ZK-Voting L2 (`/l2`) — civic JSON sequencer

**Implemented:** an application-specific civic rollup (Lighter-shaped:
prove the operations, settle on L1). Plain Node. No Docker. **Not** an
Anvil proxy and **not** a general-purpose EVM.

- `l2/genesis.json` — chainId `27427` (ZK-Voting), period 2s, 1 sequencer.
- `l2/sequencer/index.mjs` — mempool, blocks when there is work plus an hourly heartbeat, hourly sealed votes.
- `l2/archive/` — hourly S3/R2 attic for sealed hours (on by default; no prune without a bucket or `file://` sink). Gzip block and proof objects.
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

## Node app (`apps/node`)

Long-lived Node 22 process, web UI + HTTP API, `system_actions.sh` restarts it.
Officer roles (`clerk`, `registrar`, `disqualification_officer`, `tally_operator`)
are granted per jurisdiction via `POST /api/jurisdictions/:id/roles`.
`platform_admin` is a global override and may act in every jurisdiction.

**Store:** JSON file `apps/node/data/zk-voting.json` (gitignored). Native
addons such as `better-sqlite3` are **not** used. A jurisdiction owns
its elections.

**UI:** vanilla JS modules and HTML in `apps/node/public/`. Express
`express.static` + a GET fallback that serves `admin.html` / `back-office.html`
/ `explorer.html` / `index.html` for clean paths `/admin`, `/back-office`,
`/explorer`, `/`. Requests to `*.html` 301 to the path without the suffix.
There is no Vite dev server and no React build. `npm run build` in this package
is a no-op log line. Jurisdictions fork this Node and pin one ElectionFactory.

### HTTP (implemented)

```
GET  /health
GET  /api/health
GET  /api/config                    (hourly disclosure + identity policy + shared factory pin)
GET  /api/pages                     (published CMS pages + nav + overlays)
GET  /api/pages/:slug
GET  /api/site
GET  /api/office/pages              (clerk / platform_admin)
POST /api/office/pages
PATCH /api/office/pages/:id
DELETE /api/office/pages/:id
GET  /api/office/site
PATCH /api/office/site              (title/tagline/contracts: platform_admin)
GET  /api/elections
POST /api/elections                 (clerk of that jurisdiction)
GET  /api/elections/:id             (UUID, shortCode, or on-chain uint256)
GET  /api/elections/:id/results     (public; certified plurality/IRV after tally; empty before)
GET  /api/elections/:id/summary     (public hour-bucket snapshot; resultsUrl after tally)
GET  /api/elections/:id/info
GET  /api/elections/:id/info/:questionId/:optionId
PATCH /api/elections/:id            (clerk of that jurisdiction; questions + option metadata until freeze)
PUT  /api/elections/:id             (same as PATCH)
GET  /api/elections/:id/ballots     (published vote rows only)
GET  /api/elections/:id/envelopes   (tally_operator of that jurisdiction; after cutoff; ciphertext; rankingPayload on ranked ballots)
GET  /api/elections/:id/registrations
GET  /api/elections/:id/registration-requests
POST /api/elections/:id/register    (voter: pending civil review; registrar/clerk of that jurisdiction: insert now; registrar may register another person)
POST /api/elections/:id/freeze      (clerk of that jurisdiction)
POST /api/elections/:id/vote        (relays proof; JSON store and/or CHAIN_RPC)
POST /api/elections/:id/disqualify   (officer of that jurisdiction)
POST /api/elections/:id/disqualify/revoke
POST /api/elections/:id/revoke
POST /api/elections/:id/tally       (tally operator of that jurisdiction; plurality/IRV and/or opens_ballots; L1 postResult if env set)
GET  /api/elections/:id/tally-key   (public Feldman ceremony; no shares)
POST /api/elections/:id/guardians   (tally operator; enroll transport key)
POST /api/elections/:id/guardians/deals
GET  /api/elections/:id/guardians/:index/inbox
POST /api/elections/:id/guardians/partials   (after cutoff; proved partials)
POST /api/elections/:id/certify-l1  (tally operator of that jurisdiction; retry L1; no-op if L1 env unset)
GET  /api/elections/:id/l1          (public countsHash + L1 tx if posted)
GET  /api/elections/:id/artifacts   (public auditor pack; no private DB fields)
GET  /api/outcomes                  (public monitor: every election before/during/after)
GET  /api/outcomes/:id              (verification + certified outcome after tally)
GET  /api/outcomes/reports          (issued official outcome PDFs)
GET  /api/outcomes/reports/:id
GET  /api/outcomes/reports/:id/pdf  (locked official PDF; X-Pdf-Protected)
POST /api/outcomes/verify           (drop PDF or report id; pdfUnmodified)
GET  /api/me/outcome-subscriptions  (opt-in; casting a ballot never subscribes)
PUT  /api/me/outcome-subscriptions/:electionId
GET  /api/admin/outcome-report-template
PATCH /api/admin/outcome-report-template  (letterhead/intro; QR+hash always on)
POST /api/admin/outcome-report-template/preview
POST /api/jurisdictions/:id/roles   (platform_admin; per-jurisdiction officer grants)
DELETE /api/jurisdictions/:id/roles
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
POST /api/me/eth-accounts            (signature-verified; first becomes active)
POST /api/me/eth-accounts/active
POST /api/me/pin/keypad
POST /api/me/pin
POST /api/me/pin/verify
POST /api/me/pin/forgot
POST /api/pin/forgot
GET  /api/me/credentials
GET  /api/office/credentials
POST /api/persons/:id/methods/:methodId/revoke
POST /api/integrations/credentials/status
POST /api/me/eth-accounts/active
POST /api/persons/:id/person-key     (registrar; keccak256 civil-file token)
POST /api/persons/:id/methods
POST /api/persons/:id/eth-accounts
POST /api/persons/:id/eth-accounts/active
GET  /api/explorer/blocks
GET  /api/explorer/blocks/:n
GET  /api/explorer/txs/:hash
GET  /api/explorer/disclosure       (last closed hour, disclosed turnout, countdown)
GET  /api/explorer/nullifiers/:value
GET  /api/explorer/search
GET  /api/explorer/elections/:id
POST /api/explorer/ingest          (L2 sequencer; `EXPLORER_INGEST_SECRET` required outside tests)
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
bound open-window roots are accepted in the local JSON store so the explorer
and UI can run a demo. The vote POST does not carry `identityCommitment`.
Per-leaf exclusion is `store.assertCanVote` (a roll helper), not a field on
the ballot request. Those accepts still wait for hourly public disclosure
unless the interval is `0`.

A person identifies with **email, Ethereum (signature), a smart-card reader, a driver’s license or passport, or a passkey**. Every path completes with email MFA via AWS SES when configured.
Each person also sets a **vote PIN** used on a scrambled keypad at ballot submit.
Many ETH addresses may be verified internally; only one is active. The
Merkle leaf remains the identity commitment ([`IDENTITY.md`](./IDENTITY.md)).

### Eligible set

Product rule: **`eligible = registered ∩ ¬currently-disqualified`**, in
registration order. Node freeze roots and `Election.eligibleRoot` use that
same incremental tree (depth from the election, `zk-voting.hash.keccak-dev-v1`
on the Node and in Foundry).

| Path | What publishes the eligible root |
| --- | --- |
| Node | `rebuildEligibleTree` on register, disqualify, and revoke. `POST /api/elections/:id/freeze` copies it to `frozenEligibleRoot`. While the roll is frozen and `lateUpdateAllowed` is false, votes bind to that snapshot. |
| Chain | `VoterRegistry.merkleRoot` stays the append-only registration roll (disqualified commitments remain). Each register republishes `Election.eligibleRoot` from the intersection and, if unset, the empty disqualification sentinel. `disqualify` / `revoke` rebuild that eligible root and the indexed disqualification chain. After `freezeRoll`, those writes revert unless `lateUpdateAllowed`. |

`BallotInbox` requires `publicInputs[0] == eligibleRoot` and
`publicInputs[1] == disqualificationRoot`. A membership witness for a
disqualified commitment hashes to the registration roll, not to the published
eligible root, so the inbox rejects it (`EligibleRootMismatch`) even when
`MockVerifier.acceptAll` is true.

`POST /api/elections/:id/vote` accepts the relay envelope:
`encryptedBallot`, `proof`, `publicInputs` (or the same signals flattened),
`nullifier`, election id, `ballotHash`, plus a one-use blind-signed
`votePass` (`{ token, signature }`). The SPA sends it with
`credentials: "omit"`, so no session cookie rides with the ballot; the pass is
obtained earlier from `POST /api/elections/:id/vote-pass` (PIN and external
clearance are checked there). No `userOpHash` is sent or stored, and a
plaintext ballot is refused (`PLAINTEXT_BALLOT`) unless the non-production
`ZKV_ALLOW_PLAINTEXT_BALLOTS=1` is set.

`stripBallotPii` / `sanitizeVoteBody` drop banned keys before relay. A client
that also sends `answers`, `identityCommitment`, `address`, `credentialId`,
`userId`, or `choice` is still accepted; those keys are ignored and never
stored. The SPA does not send them.

| `code` | Meaning |
| --- | --- |
| `ELIGIBLE_ROOT_MISMATCH` / `DISQUALIFICATION_ROOT_MISMATCH` | Proof roots do not match the open-window set |
| `NULLIFIER_USED` | This nullifier already voted |

`store.assertCanVote` still throws when a caller that already holds a leaf
asks the roll helper:

| `code` | Meaning |
| --- | --- |
| `DISQUALIFIED` | Commitment is currently disqualified (`reasonCode` / `reasonName` included) |
| `NOT_REGISTERED` | Commitment is not on the registration roll |
| `IDENTITY_COMMITMENT_REQUIRED` | The helper was called without a leaf |

The HTTP vote route does not call that helper. The leaf is never stored on
the vote or envelope.

### Circuit constraint plan

`vote.circom` requires both:

1. Merkle inclusion of `Hash(trapdoor, nullifierSecret)` under public `root`
   (the eligible set).
2. Non-membership of that same leaf under public `disqRoot`.

`disqRoot` is an indexed chain, not an event log. Sorted currently-disqualified
commitments `v0 < v1 < … < vLast` become leaves

```text
Hash(0, v0), Hash(v0, v1), …, Hash(vLast, 0)
```

The empty set is the one leaf `Hash(0, 0)`. The private witness is one link
`(disqLow, disqNext)` plus its Merkle path. The circuit enforces
`disqLow < leaf` and (`disqNext == 0` or `leaf < disqNext`). A disqualified
leaf is a boundary of that chain, so no witness satisfies the range check.
Reason codes stay on the `Disqualified` event and the officer mapping; they
are not hashed into the chain.

The Node builds the same chain with `keccak-dev-v1`. The circuit and a
`PoseidonHasher` deployment build it with Poseidon. Those roots differ.
Foundry unit tests use `KeccakHasher` and arm `MockVerifier` to evaluate the
same gap.

`MockVerifier.armInclusionWitness` checks inclusion under `publicInputs[0]`.
`armNonMembershipWitness` checks the gap under `publicInputs[1]`. After a
coded disqualification the disqualified witness returns false and
`submitVote` reverts `InvalidProof`. Unarmed proofs still follow `acceptAll`.
Both witnesses must be exactly `witnessTreeDepth` levels long (set with
`setWitnessTreeDepth`, 16–32), as in the fixed-depth circuit. A shorter path
would let an internal node pass as a leaf or chain link.

### Remaining ZK gap

- Unarmed `MockVerifier` does not evaluate the witness. A dummy proof that
  copies the published roots still verifies. The committed Vote(20) Groth16
  verifying key is **UNTRUSTED** (known entropy, no ceremony).
- Soundness of the gap is relative to a well-formed chain. An officer who
  leaves a person out of the chain publishes a root that does not bar them.
  That is the same roll trust as `eligibleRoot`.
- Do not mix a keccak chain root with a Poseidon proof.

### Pages (vanilla JS, served by Express)

Voter and officer pages cover registration, jurisdiction admin, and
notifications. The passkey-held wallet wraps the Ethereum key with WebAuthn
PRF; no seed phrase is shown.

| Path | Files | Status |
| --- | --- | --- |
| `/`, `/register`, `/vote/:id` | `public/index.html` + `app.js` / `register.js` / `vote.js` / `router.js` | Implemented. `:id` is UUID, short code, or on-chain id. |
| `/v/:shortCode`, `/e/:shortCode` | Node 302 + SPA vote route | Implemented |
| `/elections/:id/info` | `public/info.js` | Implemented (option supporting info) |
| `/elections/:id/info/:questionId/:optionId` | `public/info.js` | Implemented |
| `/admin` | `public/admin.html` + `admin.js` | Implemented. URL is `/admin`, not `/admin.html`. |
| `/back-office` | `public/back-office.html` + `back-office.js` | Implemented |
| `/explorer` | `public/explorer.html` + `explorer.js` | Implemented |
| `/office/pages`, `/office/site` | `public/cms.js` | Clerk CMS; pin shared factory |
| `/p/:slug` | published custom pages | Implemented |
| `/elections/:id/results` | `public/results.js` | Implemented certified plurality / IRV |

No commercialization copy. Footer on every page: **NOT FOR PROFIT**.

Question types the ballot UI renders: `YES_NO`, `SINGLE_CHOICE`, `MULTI_CHOICE`, `MEASURE`, `ARTICLE`, `RANKED`.
`RANKED` is instant-runoff (IRV) on the Node: voters rank options; the tally stores a winner and round transcript. Individual rankings stay in the operator envelope.

`ballotSpecHash` is keccak256 of the canonical ballot JSON `{ title, questions }`.
IRV is hashed via type `RANKED` and/or per-question `ballotMethod: "ranked_choice"` (election-level plurality is the default and is omitted so `{ id, label }` hashes stay stable). On-chain v1 does **not** add a method enum to `ElectionParams`.

### Passkey wallet

1. Create WebAuthn credential (`residentKey: required`, `extensions.prf`).
2. `prf.eval` **account** salt → HKDF → encrypt a generated 32-byte seed
   (AES-GCM) and store the blob in IndexedDB + server credential id.
3. `prf.eval` **identity** salt → HKDF → `(identityTrapdoor, nullifierSecret)`.
   Separate domain from the account key ([`PASSKEYS.md`](./PASSKEYS.md)).
4. Signing: get account PRF, unwrap seed, HMAC-sign, immediately drop plaintext
   from memory. **Today** this is not a secp256k1 UserOp signature.
5. Fallback if PRF is unavailable: still create the passkey for login, and
   keep an encrypted key wrapped with a key derived from the assertion
   signature (documented as weaker). Never display a mnemonic. Never use
   that account key as the trapdoor.

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
- `npm run test:proof-helpers` for hash-scheme / stand-in Merkle vectors.
- `npm test -w apps/node` for API tests (`NODE_ENV=test node --test`).
- `npm run test:l2` for civic sequencer tests.
- `npm run test:auditor` for the independent verifier (no Node DB).
- Optional: `npm run circuits:test` (Groth16 only if circom+snarkjs are installed, or if `ZK_VOTING_PROVING_PATH=1`).

---

## What not to do

- Do not put legal names, DOB, or addresses on chain.
- Do not emit the selected option in an event.
- Do not add fees, tokens, or admin-skimmable ETH except gas sponsorship.
- Do not use upgradeable proxies for Election unless the params explicitly
  opt in (v1: no upgrades; factory deploys new elections).
- Do not claim Vite, React, SQLite, or an Anvil-backed EVM L2 in docs
  unless those land in the tree.
