# Sealed VOTE: hold, then reveal

POLL is unchanged. A VOTE does not use `BallotInbox` or `Tally` for ballots or results. Four contracts next to that path hold the ballots off chain until `cutoffTime`, then accept them in batches, and release a k-of-n tally key only after cutoff and only after a Wesolowski opening checks.

`Vote` stays at five public inputs, in the same order: eligible root, disqualification root, nullifier, ballot hash, election id. The vote circuit is not modified. Relayer-only submission and one aggregate tally (no per-ballot openings) stay. The sealed path does not need a sixth input. The time-lock and the threshold key sit outside the vote proof.

What the sealed path does change, and why: the tally key for a VOTE is a BN254 G1 point from the guardian ceremony, not the P-256 point described on `ElectionParams.tallyPubKeyX` / `tallyPubKeyY`. Feldman checks use the alt-bn128 precompiles. A P-256 key cannot be the joint commitment those checks add. `createElection` may leave both pubkey words at zero. If either word is non-zero, `SealedVoteKey.finalize` requires it to equal the joint point. Ballots are encrypted to `SealedVoteKey.publicKey` after finalize. The sealed tally proof's key word is the hash of that BN254 point.

Re-voting is not part of this path. One nullifier is spent once. A second ciphertext with the same nullifier reverts `NullifierUsed`. The earlier note `sealed-vote-batching-scope.md` is superseded.

No deploy script in this repo constructs these contracts. No submodule moves.

## Turnout

Before `cutoffTime` the sealed inbox has no accepted ballot, no nullifier bit, no hash-chain root, and no ballot event. `acceptedBallots` stays 0. `reveal` and `forceInclude` revert `TooEarly(electionId)` in the external function, before the reentrancy lock, so a refused call writes nothing. `BallotInbox.submitVote` and `submitVoteBatch` revert `SealedBallotNotAccepted(electionId)` the same way for a VOTE, before and after cutoff. POLL never takes that branch.

At or after cutoff the relayer calls `reveal` with the ballots it held. Each call carries at most `MAX_REVEAL_BATCH` (32) ballots, the same five-input proofs, and the ciphertext bytes (at most `MAX_BALLOT_BYTES`, 32 KiB). Several transactions may be required. The first successful reveal is the first on-chain count. `SealedBallotsRevealed(electionId, added, count)` is that signal. There is no `VoteAccepted` on this inbox.

### What the relayer still sees

The relayer sees every ciphertext, the running count, and arrival times off chain. The operator sees the same if the operator runs the relayer. That view is not on this chain, and this chain cannot hide it from the party holding the bytes. Voters should treat the relayer as able to count turnout and to read whatever the ciphertext format does not hide. The contract hides that count from everyone else, including an operator who does not also hold the off-chain ballots.

A transaction sent before cutoff reverts and stores nothing. Its calldata is still public. The relayer must not broadcast ballots, shares, or an opening before cutoff. An indexer must not treat a reverted call, or a mempool payload, as turnout.

### Omission

The relayer can drop a ballot. Mitigation is a receipt signed when the relayer accepts the ballot off chain, plus `forceInclude` after cutoff and before the sealed tally marks the set.

The receipt body is:

```text
keccak256(abi.encode(
    "SEALED-VOTE-RECEIPT",
    block.chainid,
    sealedInbox,
    electionId,
    nullifier,          // publicInputs[2] mod r
    ballotHash,         // bytes32(publicInputs[3])
    keccak256(ciphertext)
))
```

`r` is the BN254 scalar field `21888242871839275222246405745257275088548364400416034343698204186575808495617`. `receiptHash` returns the EIP-191 digest of that body (`"\x19Ethereum Signed Message:\n32" || body`). The relayer signs that digest with raw ECDSA. `ecrecover` checks a low `s` and `v` in {27, 28}. The signer must be `ElectionFactory.isRelayer`. Anyone who holds the signature may call `forceInclude`. The signature covers the nullifier, the ballot hash, and the ciphertext hash. It is not a voter identity.

After the reveal, an omitted ballot is detectable: the holder of a receipt compares `nullifierUsed(electionId, nullifier)` and finds it false. `forceInclude` then lands the ballot. It reverts `AlreadyTallied` once `noteTallied` has run, and `NullifierUsed` if the same nullifier was already revealed with any body.

`setChallengeWindow(electionId, secondsAfterCutoff)` is the inclusion period. The tally operator sets it before `startTime`. `tallyAllowedAt` is `cutoffTime + challengeWindow`. `reveal` and `forceInclude` open at cutoff. `submitTally`, `submitAggregateTally`, `submitDecryption`, `postInterimResult`, and `disclose` wait until `tallyAllowedAt`. A window of 0 means the tally can be posted in the same block as cutoff and can be ordered ahead of `forceInclude`. A production election that wants a real inclusion period sets a non-zero window before start. The window is one configuration write, not a per-ballot signal.

`noteTallied` is only the address stored in `setSealedTally`, and only at or after cutoff. A mis-pointed tally cannot freeze the inbox while voting is open. `setSealedTally` and `setChallengeWindow` are writable again until `startTime`, then `SetupClosed`.

## Early decryption

Two gates, both enforced by reverting before any share or scalar is stored.

1. Threshold. `SealedVoteKey` is Feldman k-of-n on BN254. `k >= 2`, `n` is from `k` through `MAX_GUARDIANS` (16), guardians are non-zero and unique. Each guardian submits `k` points `a_j * G` (generator `(1, 2)`). The contract adds them into joint commitments `C_j`. The joint public key is `C_0`. A share at 1-based index `idx` must satisfy `share * G = sum_j idx^j * C_j`. `release` interpolates the first `k` accepted shares in guardian order and stores the scalar. `ShareAccepted` logs the index, not the share. `KeyReleased` logs the election id, not the scalar. `releasedScalar` returns 0 until `release`.

2. Time-lock. `WesolowskiTimeLock` stores `y = x^(2^T) mod N` only when `pi^l * x^r ≡ y (mod N)`, with `2^T = q*l + r` and `l` the challenge prime, and only when `block.timestamp >= cutoffTime`. `submitShare` and `release` also require `isOpen`. Before cutoff they revert `TooEarly`. After cutoff, before a valid opening, they revert `TimeLockClosed`. Neither write on that revert.

`submitDecryption` on `SealedVoteTally` reverts `TooEarly` before `tallyAllowedAt`, `KeyNotReleased` until `release`, `DecryptionBeforeTally` until a tally is posted, and `ResultAlreadyFinal` on a second call. The shared `Tally` methods revert `SealedVoteUsesOtherTally` for a VOTE at every time, before the reentrancy lock. There is no decryption function on `Tally` for a VOTE.

The on-chain decryption is still a hash the tally operator posts. It is not a proof that the hash opens the ciphertexts. That matches `Tally.submitDecryption`. The new enforcement is that the scalar is not stored, and shares are not stored, until both gates pass.

### What this assumes

Honest threshold. Each dealer knows their own polynomial. They do not know the joint scalar unless `k` evaluation shares are exchanged. The contract does not transport those shares. If `k` guardians exchange shares off chain and the relayer gives them the ciphertexts, they can decrypt before cutoff. The time-lock does not erase a share a guardian already holds. Do not exchange evaluation shares, and do not call `submitShare`, before cutoff and before the opening is valid. A reverted `submitShare` still publishes the share in calldata.

The operator is not given a share. The operator alone cannot decrypt. Fewer than `k` shares do not determine the scalar.

A guardian who commits a point they will not open can block `release`. `reset` exists only before `startTime`. Finish the ceremony and confirm the guardians can open their shares before `startTime`. After start, a bad deal cannot be replaced.

Wesolowski assumptions:

- `N` is an odd composite, at least 3, and its prime factors were destroyed at setup. They are unknown to every participant, including the operator. Anyone who factors `N` skips the sequential squarings.
- This verifier takes a modulus that fits in one EVM word (at most 256 bits). A 256-bit modulus is not a long-term production delay. Production must use a modulus whose factors are unknown and a `T` that the fastest assumed machine cannot finish before `cutoffTime`, or replace `WesolowskiTimeLock` with a beacon verifier. The Foundry tests use a tiny factorable modulus so the delay is a few squarings. That modulus must not be deployed.
- `T` is from 1 to 255. `x` is in `[2, N)`. The opening is accepted only at or after cutoff.
- The challenge is a 128-bit odd integer from `keccak256(abi.encode(x, y, T, i))` for `i` in `0..511`, accepted after twelve Miller-Rabin rounds (bases 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37). That is not a general primality proof. Soundness of the proof wants a prime challenge.

`configure` on the time-lock reverts `ConfigureClosed` at or after `startTime`, and `AlreadyConfigured` on a second call. A second opening reverts `AlreadyOpen`.

## Freeze after close

On the shared `Tally`, for a POLL: `submitDecryption`, `postInterimResult`, and `disclose` are write-once at or after cutoff (`ResultAlreadyFinal`). `submitDecryption` requires a posted tally (`DecryptionBeforeTally`). Before cutoff a POLL may still replace an interim hash or a disclosure hash. `tallyComponentAt` reverts `TallyComponentOutOfRange`.

On `SealedVoteTally` the same three hashes are write-once, and only once `tallyAllowedAt` has been reached. There is no pre-close replacement, because every result call reverts `TooEarly` until then.

`L1TallyMirror` still refuses a certified VOTE result before cutoff and accepts the hash after cutoff. That hash is not a ballot count. The sealed inbox is the count.

## Unchanged POLL surface

`BallotInbox` and `Tally` keep their function signatures. For `electionType == 0` the new branches are skipped. POLL ballots still land during the open window, still emit `VoteAccepted` / `VoteBatchAccepted`, and still tally on `Tally`. Do not point a POLL at the sealed contracts (`NotVote`).

`createElection`'s params tuple is unchanged from the election-type work. `electionType` is the last `uint8` (`0` POLL, `1` VOTE). There is no setter. `Election.electionType()` and `ElectionFactory.electionType(uint256)` are the getters. An unknown id reverts `UnknownElection`.

## App handoff

Construct the four contracts against the same factory. Wire one VOTE's inbox, key, and time-lock before `startTime`. This repository's deploy scripts do not do that.

### Relayer

- Keep VOTE ballots off chain through cutoff. Do not call `BallotInbox.submitVote` or `submitVoteBatch` for a VOTE (`SealedBallotNotAccepted`). Do not send `reveal`, `forceInclude`, `submitOpening`, or `submitShare` before cutoff.
- When a ballot is accepted off chain, sign `receiptHash(electionId, nullifier, ballotHash, ciphertext)` with a key that `isRelayer` is true for. Give the voter the signature, the proof, the five public inputs, and the ciphertext.
- At or after cutoff, `reveal` in batches of at most 32. Proofs are the same five-input Groth16 proofs as POLL. The roll must already be frozen and the eligible root published. Further reveals revert `AlreadyTallied` after the sealed tally posts.
- Encrypt to the BN254 point from `SealedVoteKey.publicKey` after `finalize`, not to a zero params key and not to a P-256 key.

### Guardians and operator

Before `startTime`, tally operator:

- `SealedVoteInbox.setSealedTally(electionId, sealedTally)`
- `SealedVoteInbox.setChallengeWindow(electionId, seconds)` with a non-zero window if omitted ballots must have time to land
- `SealedVoteKey.configure(electionId, k, guardians)`
- each guardian `submitDeal(electionId, comX, comY)` of length `k`
- `SealedVoteKey.finalize(electionId)`
- `WesolowskiTimeLock.configure(electionId, N, x, T)` with the assumptions above
- `SealedVoteTally.setTallyProofVerifier` once, from the super-admin

`reset` if a deal is wrong, still before start. Confirm shares open before start.

At or after cutoff, anyone may `submitOpening(electionId, y, pi)`. Then each of `k` guardians `submitShare`. Then anyone may `release`. The scalar is public via `releasedScalar` only after that.

After `tallyAllowedAt`, the tally operator `submitTally` or `submitAggregateTally`. Counts must sum to `SealedVoteInbox.acceptedBallots`. The proof instance is `TallyPublicInputs` version 2 (seven words). Word 6 is `keccak256(abi.encodePacked(bytes32(keyX), bytes32(keyY)))` of the ceremony point, then reduced mod `r` inside `TallyPublicInputs.instance`. `circuits/tally.circom` does not emit this instance; the installed verifier has to. Then `submitDecryption(electionId, plaintextHash)` once. Interim and disclosure hashes are also one write each, after the window, and are optional.

### Indexer and API

Before cutoff, for a VOTE, `acceptedBallots`, `ballotRoot`, `nullifierUsed`, and `ballotHashOf` on both inboxes stay at their empty values. No `VoteAccepted`, `VoteBatchAccepted`, or `SealedBallotsRevealed`. Do not display turnout, rows, or an interim count. Do not infer a count from reverted transactions.

After reveal, index `SealedBallotsRevealed(electionId, added, count)`. Choice totals come from `SealedVoteTally.tally` after `TallyPosted`, not from `Tally`. `Tally` reverts `SealedVoteUsesOtherTally` for every VOTE result call. Decryption display waits for `AggregateDecrypted` on the sealed tally, which cannot precede key release.

`ShareAccepted` is not a ballot. Do not read shares out of storage or out of pre-close calldata. After `KeyReleased`, `releasedScalar` is the tally private key.

The sequencer that creates elections must pass `electionType` as the last `uint8` of the `createElection` tuple. A client that still ends that tuple at `tallyScheme` does not match this factory. Hiding VOTE turnout in the API is not a substitute for holding the ballots off chain.

## ABI

Selectors below are `forge inspect` method identifiers and error selectors. Existing `BallotInbox` and `Tally` function signatures are unchanged. New errors on those contracts:

| Error | Selector |
| --- | --- |
| `SealedBallotNotAccepted(uint256)` on `BallotInbox` | `0x56b179b9` |
| `SealedVoteUsesOtherTally(uint256)` on `Tally` | `0xd429b570` |

No new events on `BallotInbox` or `Tally`. No new fields on `ElectionParams`.

### `SealedVoteInbox(address factory_)`

| Function | Selector |
| --- | --- |
| `setChallengeWindow(uint256,uint64)` | `0xfc0913a2` |
| `tallyAllowedAt(uint256) → uint256` | `0xcd684e96` |
| `reveal(uint256,uint256[2][],uint256[2][2][],uint256[2][],uint256[][],bytes[])` | `0x838e44f9` |
| `forceInclude(uint256,uint256[2],uint256[2][2],uint256[2],uint256[],bytes,bytes)` | `0x75761a38` |
| `setSealedTally(uint256,address)` | `0x2a495fac` |
| `noteTallied(uint256)` | `0xc9eaf339` |
| `acceptedBallots(uint256) → uint256` | `0x04ac45f1` |
| `nullifierUsed(uint256,uint256) → bool` | `0xe78ffc96` |
| `ballotHashOf(uint256,uint256) → bytes32` | `0xbcc93e8e` |
| `ballotRoot(uint256) → bytes32` | `0x66bc12ff` |
| `ballotHashAt(uint256,uint256) → bytes32` | `0x36fb0a8a` |
| `isTallied(uint256) → bool` | `0xeb269b53` |
| `sealedTally(uint256) → address` | `0x38d4eca8` |
| `challengeWindow(uint256) → uint64` | `0xed2c6d36` |
| `receiptHash(uint256,uint256,bytes32,bytes) → bytes32` | `0x38647e91` |
| `ballotHashOfCiphertext(bytes) → uint256` | `0x57902b97` |
| `MAX_REVEAL_BATCH() → uint256` | `0x79e6a4f5` |
| `MAX_BALLOT_BYTES() → uint256` | `0x6fd9265f` |
| `factory() → address` | `0xc45a0155` |

Events: `SealedBallotsRevealed(uint256,uint256,uint256)` topic `0xb12f10d60dfcc7f634e4dfe29066d8ef36598b2aa6242adb83f2e06a867fa396`; `ChallengeWindowSet(uint256,uint64)`; `SealedTallySet(uint256,address)`; `SealedTallyMarked(uint256)`. `electionId` is indexed on each.

Errors used by callers: `TooEarly(uint256)`, `NotVote()`, `NotRelayer()`, `NotTallyOperator()`, `SetupClosed()`, `AlreadyTallied()`, `EmptyBatch()`, `BatchTooLarge()`, `BatchLengthMismatch()`, `BadSignature()`, `NullifierUsed()`, `InvalidProof()`, `InvalidPublicInputs()`, `RollNotFrozen()`, plus the same root and hash mismatches as `BallotInbox`.

### `WesolowskiTimeLock(address factory_)`

| Function | Selector |
| --- | --- |
| `configure(uint256,uint256,uint256,uint256)` | `0x022fc225` |
| `submitOpening(uint256,uint256,uint256)` | `0x1940feb3` |
| `isOpen(uint256) → bool` | `0x4d6861a6` |
| `lockOf(uint256) → (uint256 n, uint256 x, uint256 t, uint256 y, bool open)` | `0x632a4861` |
| `verify(uint256,uint256,uint256,uint256,uint256) → bool` | `0x8554d92c` |
| `expMod(uint256,uint256,uint256) → uint256` | `0xad69caa5` |
| `challenge(uint256,uint256,uint256) → uint256` | `0x1fc6e296` |

Events: `TimeLockConfigured(uint256,uint256,uint256,uint256)`, `TimeLockOpened(uint256,uint256)`. `electionId` is indexed.

Errors: `TooEarly(uint256)`, `ConfigureClosed()`, `AlreadyConfigured()`, `AlreadyOpen()`, `NotConfigured()`, `BadLock()`, `BadOpening()`, `NoPrime()`, `NotTallyOperator()`.

### `SealedVoteKey(address factory_, address timeLock_)`

| Function | Selector |
| --- | --- |
| `configure(uint256,uint64,address[])` | `0x464a9fdd` |
| `submitDeal(uint256,uint256[],uint256[])` | `0xe0576c6f` |
| `finalize(uint256)` | `0x05261aea` |
| `reset(uint256)` | `0x310bd74b` |
| `submitShare(uint256,uint256)` | `0x6d638b12` |
| `release(uint256)` | `0x37bdc99b` |
| `publicKey(uint256) → (uint256 x, uint256 y)` | `0x8940aebe` |
| `isComplete(uint256) → bool` | `0x3a0be1a6` |
| `isReleased(uint256) → bool` | `0x73962b26` |
| `releasedScalar(uint256) → uint256` | `0x6884940a` |
| `threshold(uint256) → (uint64 k, uint64 n)` | `0x31eb7a1a` |
| `shareCount(uint256) → uint256` | `0x30a0b0e4` |
| `scalarMulG(uint256) → (uint256 x, uint256 y)` | `0xc42a7f22` |
| `MAX_GUARDIANS() → uint256` | `0x422c1d37` |

Events: `CeremonyConfigured(uint256,uint64,uint64)`, `DealSubmitted(uint256,address)`, `CeremonyFinalized(uint256,uint256,uint256)`, `CeremonyReset(uint256)`, `ShareAccepted(uint256,uint256)`, `KeyReleased(uint256)`. `electionId` is indexed. `DealSubmitted` also indexes the guardian. `ShareAccepted` does not include the share. `KeyReleased` does not include the scalar.

Errors: `TooEarly(uint256)`, `TimeLockClosed(uint256)`, `BadShare()`, `NeedMoreShares(uint256,uint256)`, `NotGuardian()`, `BadCeremony()`, `DealMissing()`, `AlreadyDealt()`, `KeyMismatch()`, `SetupClosed()`, `DuplicateGuardian()`, `AlreadyReleased()`, `NotVote()`.

### `SealedVoteTally(address factory_, address inbox_, address key_)`

| Function | Selector |
| --- | --- |
| `setTallyProofVerifier(address)` | `0x2051f7c1` |
| `submitTally(uint256,uint256[],uint256[2],uint256[2][2],uint256[2])` | `0x322d214d` |
| `submitAggregateTally(uint256,uint256[],bytes32,uint256[2],uint256[2][2],uint256[2])` | `0x2181cdd6` |
| `submitDecryption(uint256,bytes32)` | `0xd15960d8` |
| `postInterimResult(uint256,bytes32)` | `0x3612c957` |
| `disclose(uint256,bytes32)` | `0xc20b5464` |
| `tally(uint256) → uint256[]` | `0xed8b6b31` |
| `isTallied(uint256) → bool` | `0xeb269b53` |
| `decryptionHash(uint256) → bytes32` | `0x10537d68` |
| `interimResult(uint256) → bytes32` | `0xa6beb517` |
| `disclosureHash(uint256) → bytes32` | `0x39380266` |
| `aggregateHash(uint256) → bytes32` | `0x94856caa` |
| `tallyProofVerifier() → address` | `0x4559c1cf` |
| `MAX_TALLY_OPTIONS() → uint256` | `0xa30af302` |

Events, same signatures as `ITallyVerifier`: `TallyPosted(uint256,bytes32,uint256)`, `AggregateTallyPosted(uint256,bytes32,bytes32,bytes32,uint256)`, `AggregateDecrypted(uint256,bytes32)`, `InterimResultPosted(uint256,bytes32)`, `DisclosurePosted(uint256,bytes32)`, plus `TallyProofVerifierSet(address)`.

Errors beyond the shared tally errors: `TooEarly(uint256)`, `KeyNotReleased(uint256)`, `CeremonyIncomplete(uint256)`, `NotVote()`. Shared ones reused here include `DecryptionBeforeTally(uint256)`, `ResultAlreadyFinal(uint256)`, `CountMismatch()`, `EmptyCommitment()`, `AlreadyTallied()`, `InvalidProof()`.
