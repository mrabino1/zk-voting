# Smart-Contract Audit — `smart-contracts/` — 2026-10-24 (GrokBot)

> **Disclaimer.** This is an automated plus AI-assisted review by GrokBot. It is **not** a substitute for an audit by a professional security firm. It does not certify the code, give legal assurance, or approve the system for a binding election. Findings may be incomplete, and some severities are judgement calls. Every Critical and High finding should be independently confirmed and re-tested after a fix.

## 1. Scope

| Item | Value |
|---|---|
| Repository | `mrabino1/zk-voting` |
| Branch | `test/unstable` |
| Commit audited | [`b1cef6f7273226d023e82e66878d9a80be6a0e39`](https://github.com/mrabino1/zk-voting/commit/b1cef6f7273226d023e82e66878d9a80be6a0e39) (the `test/unstable` tip at review start; the later tip `13b6a9a4` only moves three root `.md` files into `docs/` and leaves `smart-contracts/` byte-identical) |
| Path | `smart-contracts/` (the request said `smart-contract/`; the real directory is `smart-contracts/`) |
| In-scope sources | `src/**` — 46 files, **3,048 nSLOC** (per Aderyn); 2,827 nSLOC excluding `src/interfaces/` |
| Deploy scripts reviewed | `script/*.sol` — 7 files, 632 lines |
| Tests reviewed | `test/**` — 42 files, 6,524 lines |

### 1.1 Files and nSLOC

| File | nSLOC | File | nSLOC |
|---|---:|---|---:|
| `src/BallotInbox.sol` | 162 | `src/account/PasskeyAccount.sol` | 81 |
| `src/Clones.sol` | 14 | `src/account/PasskeyAccountFactory.sol` | 30 |
| `src/DisqualificationRegistry.sol` | 202 | `src/account/RepublicEntryPoint.sol` | 99 |
| `src/Election.sol` | 81 | `src/account/RepublicPaymaster.sol` | 78 |
| `src/ElectionFactory.sol` | 199 | `src/account/WebAuthn.sol` | 62 |
| `src/ElectionIdentity.sol` | 19 | `src/hasher/HashScheme.sol` | 26 |
| `src/ExternalPartyRegistry.sol` | 197 | `src/hasher/KeccakHasher.sol` | 12 |
| `src/IdentityCommitment.sol` | 32 | `src/hasher/PoseidonHasher.sol` | 13 |
| `src/JurisdictionRegistry.sol` | 88 | `src/hasher/PoseidonT3.sol` | 55 |
| `src/PersonRegistry.sol` | 62 | `src/hasher/StandInHasher.sol` | 12 |
| `src/ReasonCodes.sol` | 22 | `src/l2/L1TallyMirror.sol` | 190 |
| `src/Roles.sol` | 14 | `src/l2/RepublicMailbox.sol` | 52 |
| `src/Tally.sol` | 149 | `src/l2/RollupSettlement.sol` | 95 |
| `src/VoterRegistry.sol` | 164 | `src/tree/DisqualificationSet.sol` | 63 |
| `src/zk/Groth16VerifierAdapter.sol` | 33 | `src/tree/EligibleSet.sol` | 112 |
| `src/zk/MockVerifier.sol` | 121 | `src/tree/IncrementalMerkleTree.sol` | 60 |
| `src/zk/TallyPublicInputs.sol` | 26 | `src/zk/VoteVerifier.sol` | 202 |
| `src/interfaces/*` (12 files) | 221 | | |

Scripts: `CertifyL1.s.sol`, `CreateElection.s.sol`, `DeployGuard.sol`, `DeployL1.s.sol`, `DeployL2.s.sol`, `DeployLocal.s.sol`, `PrintAddresses.s.sol`.

## 2. Methodology and tools

1. Manual line-by-line review of every contract, interface, library, deploy script and test in `smart-contracts/`. The review was cross-read against `README.md`, `implementation.md`, `docs/how_voters_privacy_is_protected.md`, `docs/ARCHITECTURE.md`, `circuits/vote.circom` (public-signal order only) and the browser client's ballot-hash code.
2. Build and test with Foundry using the repo's `foundry.toml` settings (via-IR, optimizer 200, fuzz 256 runs, invariant 64 runs × depth 32).
3. Static analysis with Slither and Aderyn. All output was triaged by hand (see §8).
4. Proof-of-concept Foundry tests written in a **scratch copy outside the repository**. No contract, script or test file in the repo was changed. The PoC sources are quoted in the relevant findings.

| Tool | Version |
|---|---|
| Foundry `forge` | 1.8.6 (commit `6bad0a66`) |
| solc (project) | 0.8.24, `via_ir = true`, optimizer runs 200 |
| Slither | 0.11.6 (102 detectors) |
| Aderyn | 0.6.8 (88 detectors) |
| forge-std | v1.16.2 |
| Python (tool venv) | 3.13.5 |

Severity scale: **Critical** means direct loss of funds or control, or a forged election outcome, with no special privilege needed. **High** means outcome integrity, voter privacy or liveness is broken under realistic default configuration, or by a single trusted role. **Medium** means conditional or role-gated integrity or liveness risk. **Low** is a hardening or defensive issue. **Info** covers style, gas and documentation notes.

## 3. Executive summary

The election core (factory → clone `Election` → `VoterRegistry` / `DisqualificationRegistry` → `BallotInbox` → `Tally`) is cleanly structured. Nullifier uniqueness, voting-window checks, the roll freeze and the binding of four of the five Groth16 public inputs (roots, election id, ballot hash) are enforced and well tested. The invariant suite holds.

The main risks are in five areas.

- **The account-abstraction layer is broken.** `WebAuthn.verify` accepts any signature, and it never binds the UserOp hash. Separately, `PasskeyAccount` lets *any* secp256k1 key claim the backup-signer slot. Either bug lets anyone drain or control any passkey account. Both were reproduced with a PoC (C-01, C-02).
- **The proving path cannot work end to end.**
  - The on-chain tally is checked against the *vote* verifier with a 6-word mock instance (H-01).
  - The deploy scripts default to an accept-all `MockVerifier` (H-02).
  - `keccak256(encryptedBallot)` is ≥ the BN254 field modulus for about 82% of ballots, so real Groth16 verification rejects them (H-05).
  - L1 settlement verifies no proof (H-06).
- **Scalability.** Every registration rebuilds the full eligible tree. Per-registration gas grows linearly: about 11.2M gas at 400 voters with the keccak dev hasher, and roughly 100× worse with Poseidon. That contradicts "`maxParticipants = 0` means unlimited" (H-03).
- **The external-party veto is not bound to the proof.** A vetoed voter can bypass it by passing any other commitment. The required on-chain `identityCommitment` also links a ballot to a roll entry (H-04).
- **Centralization.** Factory admins can rewire the inbox and tally modules at any time with no events. Officers can move roots mid-vote. The first L1 certification wins and cannot be corrected (M-01–M-05).

Many of the proving-path gaps are acknowledged as "in progress" in the README. They are listed here because the contracts and deploy scripts do not *enforce* the stated limits. For example, `DeployL2` silently inherits the accept-all mock.

## 4. Severity summary

| Severity | Count |
|---|---:|
| Critical | 2 |
| High | 6 |
| Medium | 8 |
| Low | 10 |
| Informational | 6 |
| **Total** | **32** |

| ID | Title | Severity |
|---|---|---|
| C-01 | `WebAuthn.verify` accepts any signature and ignores `userOpHash` | Critical |
| C-02 | Any secp256k1 key can claim `ethBackupSigner` and take over a `PasskeyAccount` | Critical |
| H-01 | On-chain tally is not cryptographically bound (wrong verifier and instance) | High |
| H-02 | Deploy scripts (incl. `DeployL2`) default to accept-all `MockVerifier`; `VoteVerifier` can never verify | High |
| H-03 | O(n) gas per registration (O(n²) total) bricks large rolls; "unlimited" is not achievable | High |
| H-04 | External-party gates use an unbound, caller-supplied `identityCommitment` (bypass and deanonymization) | High |
| H-05 | `ballotHash = keccak256(ciphertext)` exceeds the BN254 field for ~82% of ballots | High |
| H-06 | `RollupSettlement` verifies nothing as deployed; no way to set a verifier | High |
| M-01 | Roots can change mid-vote (late disqualification, no root history) | Medium |
| M-02 | Election creator chooses any verifier; permissionless creation when no jurisdiction registry is set | Medium |
| M-03 | Factory admin powers: silent module rewiring, irrevocable roles, no events | Medium |
| M-04 | `BallotInbox._requireNotTallied` fails open | Medium |
| M-05 | `L1TallyMirror`: first post wins, unverified against L2, no correction path | Medium |
| M-06 | `OPENS_BALLOTS` tally is bounded by block gas (~40–50k ballots) | Medium |
| M-07 | External parties can be added, toggled or rewired mid-election; stale rejections persist | Medium |
| M-08 | Paymaster `alwaysSponsor = true` by default; EntryPoint has no gas accounting | Medium |
| L-01 | Unprotected `initialize` on implementation contracts | Low |
| L-02 | Missing events on state-changing admin or lifecycle functions | Low |
| L-03 | `publicInputs.length < 5` accepts extra inputs; redundant ballot-hash comparison | Low |
| L-04 | `JurisdictionRegistry` role hygiene (overwrite, stale officers, no revoke) | Low |
| L-05 | `VoterRegistry` / `PersonRegistry` global roles with no revoke | Low |
| L-06 | Commitments and nullifiers are not range-checked against the scalar field | Low |
| L-07 | `RepublicMailbox` locks ETH; `forceInclude` is event-only | Low |
| L-08 | Constructor argument order guessed by `_looksLikeHasher` heuristic | Low |
| L-09 | `PasskeyAccount` secp256k1 path: malleable `s`, double hash interpretation | Low |
| L-10 | `DeployGuard` is an off-chain guard only | Low |
| I-01 | No ERC-20 token-poll snapshot logic exists (N/A) | Info |
| I-02 | `PersonRegistry` publicly links addresses to person ids | Info |
| I-03 | Unbounded `_ballotHashList` | Info |
| I-04 | Client nullifier derivation (keccak) differs from circuit (Poseidon) | Info |
| I-05 | Static-analysis hygiene (immutables, unused constant, floating pragma, return-bomb) | Info |
| I-06 | Docs consistency notes | Info |

---

## 5. Findings

### C-01 — `WebAuthn.verify` accepts any signature and ignores `userOpHash`

- **Severity:** Critical
- **Location:** [`src/account/WebAuthn.sol:28-45`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/account/WebAuthn.sol#L28-L45), [`src/account/WebAuthn.sol:75-94`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/account/WebAuthn.sol#L75-L94), [`src/account/PasskeyAccount.sol:101-108`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/account/PasskeyAccount.sol#L101-L108)

**Description.** `verify` first tries the RIP-7212 precompile. If that fails, it returns `rs[0] != 0 && pubX != 0` as a "fallback for chains without RIP-7212". The fallback is unconditional. It fires when the precompile is absent (the staticcall to an empty account succeeds with zero output), and *also* when the precompile is present and rejects the signature. `rs[0] != 0` is already required at line 36, so for any account with `pubX != 0` the function returns `true` for any input.

In addition, the signed message is `sha256(authenticatorData || sha256(clientDataJSON))`. `_containsChallenge` only checks that the substring `"challenge"` appears, and `PasskeyAccount._isValidSignature` never passes `userOpHash` into the check. So even a genuine P-256 signature is not bound to the operation, nonce, chain or EntryPoint, and can be replayed for any `callData`.

**Impact.** Anyone can submit a UserOp for any `PasskeyAccount` and call `execute(dest, value, data)`. That drains its ETH or performs any action as the account, such as registering in `PersonRegistry` flows, sponsoring calls, or burning its nonce. This affects every passkey account on every chain.

**Proof (scratch PoC, passes):**
```solidity
function testPoC_WebAuthnForgeryDrainsAccount() public {
    PasskeyAccount acct = _victim(); // createAccount(keccak256("cred"), 0x1234, 0x5678, 0) + 5 ETH
    uint256[2] memory rs = [uint256(1), uint256(1)];
    bytes memory sig = abi.encode(new bytes(37), string('{"challenge":"x"}'), rs);
    UserOp[] memory ops = new UserOp[](1);
    ops[0] = _op(address(acct), 0, sig); // callData = execute(attacker, 5 ether, "")
    vm.prank(attacker);
    entryPoint.handleOps(ops);
    assertEq(attacker.balance, 5 ether);
}
```

**Recommendation.**
- Remove the fallback entirely. If the precompile is unavailable, return `false`, or use a vetted Solidity P-256 verifier such as daimo-eth `p256-verifier` or OpenZeppelin `P256`.
- Check that the precompile returned exactly 32 bytes equal to `1`.
- Parse `clientDataJSON` and require `"type":"webauthn.get"`, and `challenge == base64url(userOpHash)`.
- Check the UP/UV flags in `authenticatorData`.
- Enforce low-`s`.

### C-02 — Any secp256k1 key can claim `ethBackupSigner` and take over a `PasskeyAccount`

- **Severity:** Critical
- **Location:** [`src/account/PasskeyAccount.sol:110-135`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/account/PasskeyAccount.sol#L110-L135) (notably lines 130–133)

**Description.** Any 65-byte signature takes the secp256k1 path. If `ethBackupSigner == address(0)`, the recovered address is stored as the backup signer and the signature is accepted. The NatSpec says "Production civic accounts leave this at zero", which is exactly the vulnerable state.

**Impact.** The first party to send a self-signed 65-byte UserOp becomes the permanent backup signer. They can execute arbitrary calls and lock the legitimate passkey owner out of the secp256k1 path forever. This is account takeover, independent of C-01.

**Proof (scratch PoC, passes):**
```solidity
function testPoC_BackupSignerHijack() public {
    PasskeyAccount acct = _victim();
    (address evil, uint256 pk) = makeAddrAndKey("evil");
    UserOp memory op = _op(address(acct), 0, "");
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, entryPoint.getUserOpHash(op));
    op.signature = abi.encodePacked(r, s, v);
    UserOp[] memory ops = new UserOp[](1); ops[0] = op;
    entryPoint.handleOps(ops);
    assertEq(acct.ethBackupSigner(), evil);
    assertEq(attacker.balance, 5 ether);
}
```

**Recommendation.**
- Set the backup signer only in the constructor or `createAccount`, and include it in the CREATE2 salt or args.
- Alternatively, allow it to be set only via `execute` from the account itself after a valid passkey signature.
- Never use trust-on-first-use. Remove the `\x19Ethereum Signed Message` fallback, or choose exactly one format.

### H-01 — On-chain tally is not cryptographically bound (wrong verifier and instance)

- **Severity:** High
- **Location:** [`src/Tally.sol:56-87`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/Tally.sol#L56-L87), [`src/Tally.sol:90-129`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/Tally.sol#L90-L129), [`src/Tally.sol:151-166`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/Tally.sol#L151-L166), [`src/zk/TallyPublicInputs.sol:1-30`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/zk/TallyPublicInputs.sol#L1-L30), [`src/zk/Groth16VerifierAdapter.sol:24`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/zk/Groth16VerifierAdapter.sol#L24)

**Description.** `submitTally` and `submitOpenedTally` verify against `p.verifier`, the election's *vote* verifier. They pass a 6-word `TALLY_SOL_MOCK_V1` instance, which `TallyPublicInputs` itself says does not match `circuits/tally.circom`.

- With `Groth16VerifierAdapter`, whose constructor requires exactly 5 inputs and whose `verifyProof` returns `false` on any other length, no tally can ever be posted.
- With `MockVerifier(acceptAll)`, the tally operator can post any `counts` vector that sums to `acceptedBallots`.
- Under `OPENS_BALLOTS`, the `openings` are operator-supplied and not proven against the stored ciphertexts. Only the histogram consistency and the sum are checked.

**Impact.**
- On the real proving path, tally liveness is permanently broken.
- On the mock path, the result is whatever the tally operator says, subject only to the sum.

The README acknowledges the encoding mismatch (`README.md` "Not the same encoding as `Tally.sol`"), but the contract offers no separate tally-verifier slot and no guard against posting with the mock.

**Proof.** Inspection: `_authorize` returns `p.verifier` (line 165). The adapter returns `false` when `input.length != publicInputCount` (`Groth16VerifierAdapter.sol:36`). The existing tests (`Tally.t.sol`) pass only under `MockVerifier`.

**Recommendation.**
- Add a per-election (or factory-level, immutable once created) `tallyVerifier` whose instance matches `tally.circom` public signals.
- Bind `ballotRoot(electionId)` and the tally public key into that instance.
- Until then, refuse `submitTally` when the verifier is a known mock, and gate on a `productionReady` flag.

### H-02 — Deploy scripts default to accept-all `MockVerifier`; `VoteVerifier` can never verify

- **Severity:** High
- **Location:** [`script/DeployLocal.s.sol:79-85`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/script/DeployLocal.s.sol#L79-L85), [`script/DeployLocal.s.sol:136-140`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/script/DeployLocal.s.sol#L136-L140), [`script/DeployL2.s.sol:1-26`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/script/DeployL2.s.sol#L1-L26), [`src/zk/MockVerifier.sol:37`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/zk/MockVerifier.sol#L37), [`src/zk/MockVerifier.sol:143-153`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/zk/MockVerifier.sol#L143-L153), [`src/zk/VoteVerifier.sol:69-123`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/zk/VoteVerifier.sol#L69-L123)

**Description.**
- `_useMockVerifier()` returns `true` unless `REPUBLIC_PROVING_PATH=1` or `REPUBLIC_USE_MOCK_VERIFIER=0`. `DeployL2` inherits `DeployLocal`.
- `MockVerifier.acceptAll` defaults to `true`, and its `owner` (the deployer) can deny specific nullifiers.
- `VoteVerifier`'s VK constants are all zero and `verifyingKeyHash` has no setter. It therefore either delegates to the mock or reverts `VerifierNotConfigured`.

**Impact.** An L2 deployment with default environment variables accepts any "proof" that copies the published roots. Anyone can cast any number of votes using fresh nullifiers, and the mock owner can censor chosen nullifiers. The README states MockVerifier is for tests, but nothing on-chain or in the L2 script prevents it from reaching a live chain.

**Recommendation.**
- Make `DeployL2` (and any non-anvil chain id) *require* an explicit real verifier address and fail closed.
- Add `isMock()` to `MockVerifier` and have `ElectionFactory.createElection` reject mock verifiers on production chain ids.
- Remove `VoteVerifier`'s mock delegation, or make the VK immutable and non-zero.

### H-03 — O(n) gas per registration (O(n²) total) bricks large rolls

- **Severity:** High
- **Location:** [`src/VoterRegistry.sol:68-96`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/VoterRegistry.sol#L68-L96), [`src/VoterRegistry.sol:135-171`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/VoterRegistry.sol#L135-L171), [`src/tree/EligibleSet.sol:1-112`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/tree/EligibleSet.sol#L1-L112), [`src/DisqualificationRegistry.sol:187-226`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/DisqualificationRegistry.sol#L187-L226)

**Description.** Every `register` calls `_publishEligibleRoot`. That collects all leaves, makes two external `isDisqualified` calls per voter, and recomputes the whole eligible tree (`EligibleSet.rootOf`). `DisqualificationRegistry._publishChain` does the same, plus an O(k²) insertion sort, plus another `rebuildEligibleRoot`.

**Impact.** Registration cost grows linearly with the roll size. With the keccak dev hasher it costs about 27k gas per existing voter, so a single registration exceeds a 30M block gas limit at roughly 1,100 voters. `PoseidonT3.hashLeftRight` costs about 99k gas, versus a few hundred for keccak, so with the production hasher the ceiling is in the tens of voters. Disqualifications hit the same wall. This contradicts `README.md` ("`maxParticipants = 0` means unlimited voters") and makes realistic elections impossible on-chain.

**Proof (scratch PoC, measured):**

| Registered voters before call | `register` gas |
|---:|---:|
| 1 | 1,223,345 (first-time storage init) |
| 10 | 624,342 |
| 50 | 1,694,025 |
| 100 | 3,036,128 |
| 200 | 5,742,917 |
| 400 | 11,239,376 |

`PoseidonT3.hashLeftRight(1,2)` measured at 98,879 gas.

**Recommendation.**
- Keep the eligible set as an *incremental* tree. Insert on register; on disqualification, update one leaf to a sentinel, which costs O(depth).
- Alternatively, keep the registered tree incremental and prove "not disqualified" only via the disqualification non-membership proof the circuit already has, and drop the rebuilt intersection tree.
- Publish roots lazily, once at `freezeRoll`, or let the root be computed off-chain and posted with a validity proof.

### H-04 — External-party gates use an unbound, caller-supplied `identityCommitment`

- **Severity:** High
- **Location:** [`src/BallotInbox.sol:84-109`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/BallotInbox.sol#L84-L109), [`src/BallotInbox.sol:163-171`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/BallotInbox.sol#L163-L171), [`src/ExternalPartyRegistry.sol:201-229`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/ExternalPartyRegistry.sol#L201-L229)

**Description.** `submitVoteWithClearance` takes `identityCommitment` as a plain argument and passes it to `assertCastAllowed`. The commitment is not among the Groth16 public inputs, and nothing ties it to the nullifier or the eligible leaf being proven.

**Impact.**
1. **Bypass.** A voter vetoed by, say, a felony or deceased oracle passes any non-rejected value (e.g. `1`) and votes. Under `MUST_ATTEST`, they can pass *someone else's* attested commitment.
2. **Deanonymization.** An honest voter who passes their real commitment publishes `(identityCommitment, nullifier, ballotHash)` in one transaction. The commitment is public in `VoterRegistered` events, so this links the ballot to a roll entry.

The second point contradicts `docs/how_voters_privacy_is_protected.md` ("The vote POST does not accept `identityCommitment`", "Public ballot row is `{ nullifier, ballotHash, electionId, relayer }`").

**Proof (scratch PoC, passes):** a commitment is rejected by a `MODE_VETO` party, `isRejected(commitment) == true`, and then `inbox.submitVoteWithClearance(id, a, b, c, inputs, enc, /*identityCommitment*/ 1, ids)` is accepted (`acceptedBallots == 1`).

**Recommendation.** Do not take the commitment on-chain. Instead, either:
- apply party vetoes *before* `freezeRoll` by folding them into the disqualification set, which is already proven in-circuit; or
- add a circuit-proven non-membership in a per-election "rejected" tree, with its root as a sixth public input.

For `MUST_ATTEST`, prove membership in an attested-set root in-circuit.

### H-05 — `ballotHash = keccak256(ciphertext)` exceeds the BN254 field for ~82% of ballots

- **Severity:** High (liveness of the real proving path)
- **Location:** [`src/BallotInbox.sol:184-202`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/BallotInbox.sol#L184-L202), [`src/l2/RollupSettlement.sol:89-96`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/l2/RollupSettlement.sol#L89-L96)

**Description.** `_requireBoundInstance` requires `publicInputs[3] == uint256(keccak256(encryptedBallot))`. `circuits/vote.circom` declares `ballotHash` as a public *field* signal, and snarkjs-generated verifiers reject any public input ≥ r. The browser client (`apps/node/public/passkey-wallet.js`) uses the raw keccak and never reduces it or retries.

`RollupSettlement` has the same problem: it passes `uint256(dataHash)` and the raw state roots as Groth16 inputs.

**Impact.** With a real verifier, about 81% of honestly constructed ballots fail with `InvalidProof`, and their voters cannot vote unless the client re-encrypts until the hash is < r.

**Proof (scratch PoC):** 822 of 1,000 sample ciphertext hashes were ≥ r. Analytically, P(h ≥ r) = 1 − r/2²⁵⁶ ≈ 0.811.

**Recommendation.** Bind `ballotHash = uint256(keccak256(ct)) % r` (or `>> 3`, or a Poseidon hash of the ciphertext limbs) on both the contract and client sides. Do the same for `dataHash` and the roots in settlement, or split each into two 128-bit limbs.

### H-06 — `RollupSettlement` verifies nothing as deployed; no way to set a verifier

- **Severity:** High
- **Location:** [`src/l2/RollupSettlement.sol:39-53`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/l2/RollupSettlement.sol#L39-L53), [`src/l2/RollupSettlement.sol:76-109`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/l2/RollupSettlement.sol#L76-L109), [`script/DeployL1.s.sol:27`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/script/DeployL1.s.sol#L27)

**Description.**
- `DeployL1` constructs `RollupSettlement(admin, sequencer, prover, batchVerifier, false)` with `batchVerifier` defaulting to zero. The check `if (!mockMode && batchVerifier != address(0))` then skips proof verification.
- `batchVerifier` has no setter, and `grantRole` is a no-op.
- `dataHash` commits only to `(batchIndex, prevRoot, newRoot)`. It does not commit to transaction data, so there is no data availability.

**Impact.** The sequencer or prover can post any state root to L1. `CertifyL1` reads `stateRoot()` as the L2 anchor, so certification inherits an unverified root.

**Recommendation.**
- Require a non-zero verifier when `!mockMode` (revert in the constructor).
- Commit `dataHash` to the batch's transaction data (blob or calldata hash).
- Add a challenge or finality window.
- Either implement `grantRole` properly or remove it.

### M-01 — Roots can change mid-vote (late disqualification, no root history)

- **Severity:** Medium
- **Location:** [`src/DisqualificationRegistry.sol:129-133`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/DisqualificationRegistry.sol#L129-L133), [`src/DisqualificationRegistry.sol:170-172`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/DisqualificationRegistry.sol#L170-L172), [`src/Election.sol:75-79`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/Election.sol#L75-L79), [`src/BallotInbox.sol:190-195`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/BallotInbox.sol#L190-L195)

**Description.** The clerk can set `lateUpdateAllowed`. The officer can then disqualify or revoke during `OPEN`, which republishes both roots. `BallotInbox` accepts only the *current* roots, and there is no root history.

**Impact.**
- Every in-flight proof becomes invalid after each late update, so the officer can grief or time-target voters.
- A revoked disqualification lets a voter in mid-election, and a new one excludes them without notice.
- Either registry can call `setRoots` at any time.

**Recommendation.**
- Forbid root changes once `block.timestamp >= startTime`.
- Alternatively, keep a bounded history of valid roots, and make late changes emit an event and pass through a timelock.

### M-02 — Election creator chooses any verifier; permissionless creation when no jurisdiction registry is set

- **Severity:** Medium
- **Location:** [`src/ElectionFactory.sol:169-192`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/ElectionFactory.sol#L169-L192), [`src/ElectionFactory.sol:219-230`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/ElectionFactory.sol#L219-L230)

**Description.**
- `params.verifier` is caller-supplied and unvalidated.
- If `jurisdictionRegistry == address(0)`, which is the case at construction until an admin sets it, anyone can create an election with `clerk = msg.sender`.

**Impact.** Fake elections can be created under any `jurisdictionId`, with an accept-all verifier and attacker-chosen staff. They appear in factory events and explorers alongside real ones, and `L1TallyMirror` keys only partly mitigate this.

**Recommendation.**
- Keep an allowlist of verifiers per hash scheme.
- Require `jurisdictionRegistry != 0` to create elections, or set it in the constructor.
- Validate `params.jurisdictionId` membership.

### M-03 — Factory admin powers: silent module rewiring, irrevocable roles, no events

- **Severity:** Medium (centralization)
- **Location:** [`src/ElectionFactory.sol:76-114`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/ElectionFactory.sol#L76-L114), [`src/ElectionFactory.sol:129-135`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/ElectionFactory.sol#L129-L135)

**Description.**
- `setModules` / `wireModules` are duplicates. They can repoint `inbox` / `tally` / registries at any time, have no zero checks and emit no events.
- `setImplementation`, `setPartyRegistryImplementation` and `setJurisdictionRegistry` emit no events.
- `grantRole` can grant any role, including `PLATFORM_SUPER_ADMIN_ROLE`, has no revoke and emits no event.
- `revokeAdmin` does not clear super-admin.
- There is no admin transfer and no two-step handover.

**Impact.** A single admin key can swap the tally or inbox mid-election. `BallotInbox._requireNotTallied` reads `factory.tallyVerifier()` dynamically. Monitoring tools would not see these changes.

**Recommendation.**
- Make modules set-once (or timelocked), with events.
- Add `revokeRole` and two-step admin transfer.
- Forbid granting super-admin via `grantRole`.
- Put admin behind a multisig and timelock.

### M-04 — `BallotInbox._requireNotTallied` fails open

- **Severity:** Medium
- **Location:** [`src/BallotInbox.sol:136-144`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/BallotInbox.sol#L136-L144)

**Description.** If the `tallyVerifier()` call fails, returns short data, returns zero, or `isTallied` reverts, the check silently passes.

**Impact.** Combined with M-03 (tally module swapped or unset), ballots can be accepted after a tally was posted. The cutoff check is the only other guard, and the tally itself requires `block.timestamp >= cutoff`, so in the current code the impact is limited to misconfiguration.

**Recommendation.** Read the tally address from the election clone (immutable per election) and revert on failure.

### M-05 — `L1TallyMirror`: first post wins, unverified against L2, no correction path

- **Severity:** Medium
- **Location:** [`src/l2/L1TallyMirror.sol:115-120`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/l2/L1TallyMirror.sol#L115-L120), [`src/l2/L1TallyMirror.sol:143-200`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/l2/L1TallyMirror.sol#L143-L200), [`src/l2/L1TallyMirror.sol:226-236`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/l2/L1TallyMirror.sol#L226-L236)

**Description.**
- `postResult` / `postCertifiedResult` are write-once (`AlreadyPosted`).
- `l2StateRoot` and `totalBallots` are not checked against `RollupSettlement`.
- `_canReadFactory` checks `code.length` of an *L2* factory address *on L1*. That is normally empty, so the election, jurisdiction and ballot-spec checks are skipped. If an unrelated L1 contract happens to sit at that address (same deployer and nonce), calls can revert or return garbage.
- `tallyOperator` stays zero in that case, so only publishers can post.

**Impact.** The break-glass admin or any jurisdiction publisher can front-run or squat the certification slot with a wrong result, and nobody can correct it.

**Recommendation.**
- Verify against a settled L2 state root, with a storage proof of the `Tally` result or a message via the bridge.
- Add a dispute window and a governance-controlled supersede path with events.
- Drop the `code.length` heuristic.

### M-06 — `OPENS_BALLOTS` tally is bounded by block gas

- **Severity:** Medium
- **Location:** [`src/Tally.sol:90-129`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/Tally.sol#L90-L129), [`src/Tally.sol:175-190`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/Tally.sol#L175-L190)

**Description.** `submitOpenedTally` takes `openings[]` of length `acceptedBallots`, hashes it, and builds a histogram in memory in one transaction.

**Impact.** At roughly 600–700 gas per opening (calldata plus loop), elections above about 40–50k ballots cannot be tallied under a 30M gas limit.

**Recommendation.** Use chunked or merkleized openings with a running accumulator, or a succinct tally proof.

### M-07 — External parties can be added, toggled or rewired mid-election; stale rejections persist

- **Severity:** Medium
- **Location:** [`src/ExternalPartyRegistry.sol:75-125`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/ExternalPartyRegistry.sol#L75-L125), [`src/ExternalPartyRegistry.sol:127-156`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/ExternalPartyRegistry.sol#L127-L156), [`src/BallotInbox.sol:156-161`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/BallotInbox.sol#L156-L161)

**Description.**
- Staff can `addParty`, `setPartyActive` or `setPartyOperator` at any time, including during `OPEN`. Adding any active party makes plain `submitVote` revert (`ClearanceRequired`), and adding a `MUST_ATTEST` party makes attestations mandatory mid-vote.
- A deactivated party's rejections remain in `_rejectionCount`. `clearRejection` requires an active operator, so a voter rejected by a now-paused party stays blocked.

**Recommendation.**
- Freeze the party set at `freezeRoll`.
- Count rejections per active party, or decrement on deactivation.
- Allow clearing by staff.

### M-08 — Paymaster `alwaysSponsor = true` by default; EntryPoint has no gas accounting

- **Severity:** Medium
- **Location:** [`src/account/RepublicPaymaster.sol:29`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/account/RepublicPaymaster.sol#L29), [`src/account/RepublicPaymaster.sol:88-90`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/account/RepublicPaymaster.sol#L88-L90), [`src/account/RepublicEntryPoint.sol:71-129`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/account/RepublicEntryPoint.sol#L71-L129)

**Description.**
- With the default, any UserOp to any target is "sponsored".
- The EntryPoint never charges or refunds anything, so the paymaster deposit is unused and the bundler pays all gas.
- One failing op reverts the whole batch.
- `callGasLimit == 0` means "all gas".
- Slither flags a return-bomb in `_execute` (line 119).

**Impact.** The bundler or relayer can be griefed into paying for arbitrary calls, including C-01 drains. A single bad op censors a whole batch.

**Recommendation.**
- Default `alwaysSponsor = false` and restrict sponsorship to `BallotInbox` / `VoterRegistry` / account-factory selectors.
- Isolate per-op failures with try/catch.
- Cap returndata copy.
- Account gas or rate-limit per sender.

### L-01 — Unprotected `initialize` on implementation contracts

- **Location:** [`src/Election.sol:44-62`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/Election.sol#L44-L62), [`src/ExternalPartyRegistry.sol:65-74`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/ExternalPartyRegistry.sol#L65-L74)

The implementations can be initialized by anyone. Clones are unaffected and there is no `delegatecall` or `selfdestruct`, so impact is low, but explorers may show a confusing "election". Lock the implementation in its constructor.

### L-02 — Missing events on state-changing admin or lifecycle functions

- **Location:** [`src/Election.sol:69-79`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/Election.sol#L69-L79), [`src/ElectionFactory.sol:76-114`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/ElectionFactory.sol#L76-L114), [`src/VoterRegistry.sol:62-66`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/VoterRegistry.sol#L62-L66), [`src/DisqualificationRegistry.sol:129-133`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/DisqualificationRegistry.sol#L129-L133)

`freezeRoll`, `setRoots`, `setLateUpdateAllowed`, module setters and `grantRole` emit nothing. These are core audit-trail events for an election. Add them.

### L-03 — `publicInputs.length < 5` accepts extra inputs; redundant ballot-hash comparison

- **Location:** [`src/BallotInbox.sol:67`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/BallotInbox.sol#L67), [`src/BallotInbox.sol:95`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/BallotInbox.sol#L95), [`src/BallotInbox.sol:199`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/BallotInbox.sol#L199)

Use `!= 5`. The two operands of the `&&` at line 199 are the same comparison, so drop one.

### L-04 — `JurisdictionRegistry` role hygiene

- **Location:** [`src/JurisdictionRegistry.sol:43-60`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/JurisdictionRegistry.sol#L43-L60), [`src/JurisdictionRegistry.sol:77-97`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/JurisdictionRegistry.sol#L77-L97), [`src/JurisdictionRegistry.sol:107`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/JurisdictionRegistry.sol#L107)

- `createJurisdiction` silently overwrites an existing id, and the old clerk keeps clerk rights.
- `setClerk` and `revokeClerk` do not clear officers the clerk granted.
- `grantRole` has no revoke.

Revert on existing id; cascade or explicitly manage officer lists; add revoke.

### L-05 — `VoterRegistry` / `PersonRegistry` global roles with no revoke

- **Location:** [`src/VoterRegistry.sol:62-66`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/VoterRegistry.sol#L62-L66), [`src/VoterRegistry.sol:193-204`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/VoterRegistry.sol#L193-L204), [`src/PersonRegistry.sol:42-50`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/PersonRegistry.sol#L42-L50)

`REGISTRAR_ROLE` is global across all elections, and the admin is implicitly a registrar for every election. There is no revoke and no event. Scope roles per election and add revocation.

### L-06 — Commitments and nullifiers are not range-checked against the scalar field

- **Location:** [`src/VoterRegistry.sol:68-84`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/VoterRegistry.sol#L68-L84), [`src/DisqualificationRegistry.sol:87-106`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/DisqualificationRegistry.sol#L87-L106), [`src/BallotInbox.sol:77-79`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/BallotInbox.sol#L77-L79)

A commitment ≥ r (or ≥ 2²⁵² where the circuit uses `LessThan`) can be registered but never proven. Nullifier aliasing (`n` vs `n + r`) is prevented only by the real verifier's field check. Under `MockVerifier` both values are accepted as distinct. Require `< r` at registration and in the inbox.

### L-07 — `RepublicMailbox` locks ETH; `forceInclude` is event-only

- **Location:** [`src/l2/RepublicMailbox.sol:41-45`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/l2/RepublicMailbox.sol#L41-L45), [`src/l2/RepublicMailbox.sol:60-66`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/l2/RepublicMailbox.sol#L60-L66)

`sendToL2` is `payable` with no withdraw or bridge credit (also flagged by Slither and Aderyn). `forceInclude` has no on-chain enforcement. Make it non-payable or credit the value; document `forceInclude` as advisory or enforce it in settlement.

### L-08 — Constructor argument order guessed by `_looksLikeHasher`

- **Location:** [`src/VoterRegistry.sol:206-212`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/VoterRegistry.sol#L206-L212), [`src/DisqualificationRegistry.sol:150-156`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/DisqualificationRegistry.sol#L150-L156)

The constructors probe `hashLeftRight(0,0)` to decide which argument is the hasher. A factory exposing a compatible selector, or a reverting hasher, would mis-wire the contract. Use a fixed argument order.

### L-09 — `PasskeyAccount` secp256k1 path: malleable `s`, double hash interpretation

- **Location:** [`src/account/PasskeyAccount.sol:119-127`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/account/PasskeyAccount.sol#L119-L127)

There is no low-`s` check. Both the raw `userOpHash` and the EIP-191-wrapped hash are accepted. The nonce prevents replay, so impact is low beyond C-02. Use OpenZeppelin `ECDSA.recover` with one format.

### L-10 — `DeployGuard` is an off-chain guard only

- **Location:** [`script/DeployGuard.sol:14-45`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/script/DeployGuard.sol#L14-L45)

The deploy-once protection relies on environment variables and a JSON record, and `FORCE_REDEPLOY=1` bypasses it. There is no on-chain singleton registry, so a second "official" stack can be deployed and the chain of record split. Record canonical addresses on-chain (e.g. in `L1TallyMirror`) and have off-chain tools verify them.

### I-01 — No ERC-20 token-poll snapshot logic exists (N/A)

No ERC-20 balance snapshot or token-weighted poll code exists in `smart-contracts/src`. `README.md` states "There is no token". Snapshot and flash-loan analysis is therefore not applicable. If token polls (`docs/POLLS.md`) move on-chain, they will need `ERC20Votes`-style checkpoints taken at a block before creation.

### I-02 — `PersonRegistry` publicly links addresses to person ids

- **Location:** [`src/PersonRegistry.sol:51-75`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/PersonRegistry.sol#L51-L75)

`verifyAddress` / `setActive` permanently publish address → `personId`, with no unverify. This is not on the vote path, but it is a public identity graph. Consider storing only commitments.

### I-03 — Unbounded `_ballotHashList`

- **Location:** [`src/BallotInbox.sol:204-213`](https://github.com/mrabino1/zk-voting/blob/b1cef6f7273226d023e82e66878d9a80be6a0e39/smart-contracts/src/BallotInbox.sol#L204-L213)

The list grows without bound. Reads are indexed (`ballotHashAt`), so there is no DoS. `_ballotRoot` is a sequential hash chain, which is fine for append-only use.

### I-04 — Client nullifier derivation differs from circuit (out of contract scope)

`apps/node/public/passkey-wallet.js` derives `nullifier = keccak256(nullifierSecret ‖ keccak256(String(electionId)))`, while the circuit uses Poseidon. This is noted for the proving-path team and is not a contract defect.

### I-05 — Static-analysis hygiene

- 12 state variables could be `immutable` (Slither `immutable-states`).
- `ExternalPartyRegistry.MODE_VETO` is unused.
- Pragmas float (`^0.8.24`).
- `RollupSettlement.grantRole` is an empty stub (compiler warning).
- `_looksLikeHasher` can be `view`/`pure`.

### I-06 — Docs consistency

| Doc claim | Code reality | Finding |
|---|---|---|
| "`maxParticipants = 0` means unlimited voters" (README) | Registration gas makes rolls above ~1k (keccak) or tens (Poseidon) impossible | H-03 |
| "Vote POST does not accept `identityCommitment`" (privacy doc) | `submitVoteWithClearance` requires it on-chain | H-04 |
| "`MockVerifier` … unit tests" (README) | `DeployL2` defaults to it | H-02 |
| `tally.circom` ≠ `Tally.sol` encoding (README, acknowledged) | No separate tally verifier exists | H-01 |
| Nullifier at most once, window, roll freeze, sum == accepted (README invariants) | Enforced and fuzzed; confirmed | — |
| Eligible = registered ∩ ¬disqualified (README) | Enforced (at O(n) cost) | H-03 |

---

## 6. Area checklist

| Area | Result |
|---|---|
| Access control and admin powers | Issues: M-03, L-04, L-05, M-02 |
| Upgradeability | No proxies or upgrades. EIP-1167 clones with bytecode verified correct (`Clones.sol`). Implementation init is open (L-01). Mutable factory modules act as de-facto upgrades (M-03). |
| Reentrancy | No exploitable reentrancy. External calls go to trusted modules; Slither's `reentrancy-*` results are benign (§8). |
| Integer and precision | Solidity 0.8 checked math. Field-range issues: H-05, L-06. |
| Events | Missing on key functions (L-02). |
| Input validation | L-03, L-06, M-02 |
| Nullifier and one-vote rule | Correct per election (`_nullifierUsed[electionId][nullifier]`); invariants pass. Aliasing only under the mock (L-06). |
| Merkle and eligibility | Logic correct; scalability broken (H-03); mid-vote root churn (M-01). |
| Groth16 binding of the 5 public inputs | root, disqRoot, ballotHash and electionId are bound; nullifier is used as the key. Field overflow (H-05). Commitment not bound for gates (H-04). |
| MockVerifier in production paths | H-02 |
| Disqualification | Indexed chain with gap proof; late updates (M-01); O(k²) sort (H-03). |
| ElectionFactory | M-02, M-03 |
| L1 certification and settlement | H-06, M-05 |
| Deploy-once guards | Off-chain only (L-10) |
| ERC-20 token-poll snapshot | N/A (I-01) |
| Front-running and MEV | Votes are relayer-submitted and carry no value to steal; nullifier front-running only re-submits the same ballot. L1 certification squatting (M-05). |
| DoS and gas griefing | H-03, M-06, M-08, M-01 |
| Timestamp dependence | The window uses `block.timestamp`; ±seconds of sequencer skew is acceptable. Slither `timestamp` results are triaged as expected. |
| Centralization | §9 |

## 7. Test and coverage results

**`forge test`** (full suite, repo settings, real `git clone` of `test/unstable`): **349 passed, 0 failed, 0 skipped (349 total)** across 39 suites.

- Fuzz (256 runs) and invariant suites pass. `VotingInvariant` ran 64 runs × 2,048 calls with 0 reverts, and holds `nullifierUnique`, `nullifierOnceOnlyPerElection_doubleVoteRejected` and `tallySumsIfPosted`.
- `UntrustedGroth16Test.testRealSmokeProofVerifiesAndRejectsTamper` and `UntrustedVote20Test.testUntrustedVote20ProofVerifiesAndRejectsTamper` **pass** against the real `circuits/fixtures/untrusted/*` files. In an earlier run on a partial mirror of `smart-contracts/` only, these two failed with `vm.exists: path not allowed` because `../circuits/fixtures` was absent. That was an environment artifact, not a code defect.
- **Gap:** no test drives a *real* Groth16 proof through `BallotInbox.submitVote` or `Tally`. The real-proof tests call the verifier directly with `ballotHash = 7`. That is why H-01 and H-05 are not caught.
- **Gap:** no test exercises `PasskeyAccount` with a WebAuthn signature that *should fail*, which is why C-01 is not caught. The same goes for the backup-signer first-use path (C-02).

**`forge coverage --ir-minimum`:** not feasible at this commit. The compiler failed with `Yul exception: Variable ... is 1 too deep in the stack` under the coverage (minimal-IR) pipeline. No coverage figures are reported. Fixing the stack depth, e.g. by splitting the large `ElectionParams` struct reads, would make coverage measurable.

**Audit PoCs** (scratch copy, not committed): 6 of 6 pass — `testPoC_WebAuthnForgeryDrainsAccount`, `testPoC_BackupSignerHijack`, `testPoC_VetoBypassWithUnboundCommitment`, `testPoC_RegistrationGasGrowth`, `testPoC_PoseidonHashGas`, `testPoC_BallotHashFieldOverflow`.

## 8. Tool triage

### Slither 0.11.6 — 99 results (src only; tests, scripts and lib filtered)

| Detector | Count | Triage |
|---|---:|---|
| `locked-ether` (Medium) | 1 | **Valid** → L-07 |
| `uninitialized-local` (Medium) | 4 | False positive: counters and accumulators intentionally zero-initialized (`VoterRegistry` l.152/161, `DisqualificationSet` l.41, `L1TallyMirror` l.150 `tallyOperator`). The last one is relevant context for M-05. |
| `unused-return` (Medium) | 3 | FP: `insert` index unused by design. The `_looksLikeHasher` probes are relevant to L-08. |
| `calls-loop` (Low) | 15 | **Valid** as gas/DoS → H-03 |
| `missing-zero-check` (Low) | 19 | Mostly admin setters → folded into M-03 and L-04 |
| `reentrancy-benign` / `reentrancy-events` (Low) | 6 | Benign: calls go to trusted factory-wired modules; no value transfer or state reuse |
| `timestamp` (Low) | 6 | Expected (voting window) |
| `return-bomb` (Low) | 1 | **Valid** → M-08 |
| `shadowing-local` (Low) | 6 | Cosmetic |
| `assembly`, `low-level-calls`, `too-many-digits`, `cyclomatic-complexity`, `unindexed-event-address` (Info) | 25 | Reviewed; Poseidon constants and verifier assembly are expected |
| `unused-state` | 1 | Valid → I-05 |
| `immutable-states` (Opt.) | 12 | Valid → I-05 |

Slither did **not** detect C-01, C-02, H-01, H-02, H-04, H-05 or H-06. All of these are semantic and protocol issues.

### Aderyn 0.6.8 — 3 "High", 18 "Low"

| Aderyn ID | Triage |
|---|---|
| H-1 `abi.encodePacked` hash collision (`PasskeyAccountFactory.sol:47`) | FP: creationCode ‖ `abi.encode(...)`, so there is one dynamic element and no ambiguity |
| H-2 Locks Ether (`RepublicMailbox`) | Valid → L-07 |
| H-3 State change after external call (Disqualification, Factory, Tally, VoterRegistry, L1TallyMirror, RollupSettlement) | Not exploitable: callees are trusted modules or view calls. Noted for M-03 (mutable modules). |
| L-1 Centralization risk | Valid → §9 |
| L-2 Costly operations in loop | Valid → H-03 |
| L-3 `ecrecover` malleability | Valid → L-09 |
| L-10 State change without event | Valid → L-02 |
| L-11 Address set without checks | → M-03 |
| L-14 Uninitialized local | FP (as Slither) |
| L-15 Floating pragma, L-12 immutables, L-18 unused state | → I-05 |
| Others (literal constants, single-use modifiers, PUSH0, public-not-external, unused error) | Style, no action |

## 9. Centralization notes

| Role | Powers | Risk |
|---|---|---|
| Factory admin / super-admin | Rewire inbox, tally and registries at any time; swap implementations; grant any role (incl. super-admin) irrevocably; set jurisdiction registry | Single key can alter in-flight elections silently (M-03) |
| Election clerk | Freeze roll; allow late roll updates; add parties (as staff) | Mid-vote gating and root churn (M-01, M-07) |
| Disqualification officer | Disqualify or revoke (also during OPEN if allowed) | Targeted exclusion; proof invalidation (M-01) |
| Registrar (global) | Register commitments in *any* election | Cross-election roll stuffing (L-05) |
| Tally operator | Posts counts; under mock, any counts with the correct sum | Outcome control (H-01) |
| External-party operators | Veto or attest per commitment | Bypassable (H-04), sticky rejections (M-07) |
| MockVerifier owner | Toggle accept-all, deny nullifiers | Censorship or forgery if deployed (H-02) |
| Rollup sequencer / prover / admin | Post arbitrary L2 roots | No validity (H-06) |
| L1TallyMirror admin / publishers | First-post-wins certification | Squatting, no correction (M-05) |
| Paymaster admin | Withdraw deposit, toggle sponsorship | Low |

The recommendation is to put all admin roles behind a multisig with a timelock, make per-election wiring immutable at creation, and emit events for every privileged change.

## 10. Out of scope

- Circom circuits (`circuits/`), trusted setup or ceremony, and the soundness of `vote_lib.circom`. Only the public-signal order was checked.
- The Node app, relayer, sequencer (`l2/`), browser wallet and guardian (Feldman) tally key ceremony, except where cited in I-04 and H-05.
- `lib/` dependencies (forge-std).
- The economic and legal design of elections, and off-chain identity proofing.
- Gas optimization beyond DoS-relevant growth.
- Deployment on any live network.

## 11. Disclaimer

This report was produced by GrokBot using automated tools (Foundry, Slither, Aderyn) plus AI-assisted manual review of commit `b1cef6f7`. It is **not** a substitute for a professional audit firm's review. No guarantee is made that all vulnerabilities were found, and severities are judgement calls. Do not use this code for a binding public election until the Critical and High findings are fixed and the system has been independently audited, including the circuits and trusted setup.
