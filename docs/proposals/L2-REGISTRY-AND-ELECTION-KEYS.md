# Proposal: L2 registry, election keys, and per-L2 settlement

Status: **proposal for Matthew to apply by hand in `smart-contracts/`.** No file
in `smart-contracts/` was changed. The off-chain side (sequencer, prover, Node)
already computes the same hashes: `demo/l2/identity.mjs`, cross-checked with
viem in `demo/l2/test/identity-admission.test.mjs`.

NOT FOR PROFIT — civic public good.

## Why

Today `RollupSettlement` holds one chain of roots for one L2, and
`L1TallyMirror` keys results by `uint256 electionId`. The model is "anyone runs
an L2, each L2 runs unlimited elections", so L1 needs:

1. A global, unsquattable id per L2 (`l2Id`).
2. A global key per election: `electionKey = H(l1ChainId, l2Id, electionUuid)`.
3. A separate root chain per `l2Id`, writable only by that L2's submitter.
4. Results keyed by `electionKey`, valid only against a root settled for the same `l2Id`.

Also: the current prover's `dataHash`/`prevStateRoot` never matched
`RollupSettlement.submitBatch` (`DataHashMismatch` at `RollupSettlement.sol:118`,
`PrevRootMismatch` at `:117`). That is fixed off-chain; no contract change is
needed for it.

## Hashes (must match `demo/l2/identity.mjs`)

```solidity
bytes32 constant L2_ID_DOMAIN        = keccak256("zk-voting/l2-id/v1");
bytes32 constant ELECTION_KEY_DOMAIN = keccak256("zk-voting/election-key/v1");
bytes32 constant STATE_DOMAIN        = keccak256("zk-voting/state-root/v1");   // off-chain root derivation
bytes32 constant BATCH_DOMAIN        = keccak256("zk-voting/vote-batch/v1");

l2Id        = keccak256(abi.encode(L2_ID_DOMAIN, operator, bytes16 l2Uuid, bytes32 salt));
electionKey = keccak256(abi.encode(ELECTION_KEY_DOMAIN, block.chainid, l2Id, bytes16 electionUuid));
dataHash    = keccak256(abi.encode(uint64 batchIndex, prevStateRoot, newStateRoot)); // same as RollupSettlement.computeDataHash
batchDigest = keccak256(abi.encode(BATCH_DOMAIN, block.chainid, address(this), l2Id,
                                   uint64 batchIndex, prevStateRoot, newStateRoot, dataHash));
```

`operator` is `msg.sender` at registration. Copying a UUID and salt from the
mempool gives a squatter a different `l2Id`, so registration cannot be
front-run and no commit-reveal is needed. The salt keeps the id unguessable
until registration.

## 1. New file: `smart-contracts/src/l2/ZkVotingL2Registry.sol`

```solidity
// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

interface IBatchVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs
    ) external view returns (bool);
}

/// @title ZkVotingL2Registry
/// @notice NOT FOR PROFIT — civic public good. One registry for every zk-voting L2.
///         Each L2 has its own root chain; each election key belongs to exactly one L2.
contract ZkVotingL2Registry {
    error AlreadyRegistered();
    error UnknownL2();
    error NotSubmitter();
    error ZeroAddress();
    error ElectionExists();
    error ElectionNotOwned(bytes32 electionKey);
    error BadBatchIndex();
    error PrevRootMismatch();
    error DataHashMismatch();
    error InvalidProof();
    error BondTooLow();
    error VerifierRequired();

    event L2Registered(bytes32 indexed l2Id, address indexed submitter, bytes16 l2Uuid, bytes32 genesisRoot);
    event SubmitterRotated(bytes32 indexed l2Id, address indexed oldSubmitter, address indexed newSubmitter);
    event ElectionOpened(bytes32 indexed electionKey, bytes32 indexed l2Id, bytes16 electionUuid);
    event VoteBatchDeposited(
        bytes32 indexed l2Id,
        uint64 indexed batchIndex,
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 dataHash,
        bytes32 batchDigest,
        bytes32[] electionKeys
    );

    bytes32 public constant L2_ID_DOMAIN = keccak256("zk-voting/l2-id/v1");
    bytes32 public constant ELECTION_KEY_DOMAIN = keccak256("zk-voting/election-key/v1");
    bytes32 public constant BATCH_DOMAIN = keccak256("zk-voting/vote-batch/v1");

    struct L2 {
        address submitter;     // pays L1 gas; the only writer for this l2Id
        uint64 nextBatchIndex;
        bytes32 latestRoot;
        bytes16 l2Uuid;
        uint256 bond;          // optional anti-spam deposit (0 by default)
    }

    IBatchVerifier public immutable batchVerifier;
    bool public immutable mockMode;          // dev/test only, same rule as RollupSettlement (H-06)
    uint256 public immutable registrationBond; // 0 = free; refund rules left to governance

    mapping(bytes32 => L2) public l2s;                                  // l2Id => L2
    mapping(bytes32 => bytes32) public electionOwner;                   // electionKey => l2Id
    mapping(bytes32 => mapping(bytes32 => bool)) public isSettledRootFor; // l2Id => root => settled

    constructor(address batchVerifier_, bool mockMode_, uint256 registrationBond_) {
        if (!mockMode_ && batchVerifier_ == address(0)) revert VerifierRequired();
        batchVerifier = IBatchVerifier(batchVerifier_);
        mockMode = mockMode_;
        registrationBond = registrationBond_;
    }

    // ---- ids -------------------------------------------------------------

    function computeL2Id(address operator, bytes16 l2Uuid, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(L2_ID_DOMAIN, operator, l2Uuid, salt));
    }

    function computeElectionKey(bytes32 l2Id, bytes16 electionUuid) public view returns (bytes32) {
        return keccak256(abi.encode(ELECTION_KEY_DOMAIN, block.chainid, l2Id, electionUuid));
    }

    function computeDataHash(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(batchIndex, prevStateRoot, newStateRoot));
    }

    function computeBatchDigest(
        bytes32 l2Id,
        uint64 batchIndex,
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 dataHash
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(BATCH_DOMAIN, block.chainid, address(this), l2Id, batchIndex, prevStateRoot, newStateRoot, dataHash)
        );
    }

    // ---- L2 lifecycle ----------------------------------------------------

    /// @notice Register an L2. The id is derived from msg.sender, so it cannot be squatted.
    function registerL2(bytes16 l2Uuid, bytes32 salt, bytes32 genesisRoot) external payable returns (bytes32 l2Id) {
        if (msg.value < registrationBond) revert BondTooLow();
        l2Id = computeL2Id(msg.sender, l2Uuid, salt);
        if (l2s[l2Id].submitter != address(0)) revert AlreadyRegistered();
        l2s[l2Id] = L2({submitter: msg.sender, nextBatchIndex: 0, latestRoot: genesisRoot, l2Uuid: l2Uuid, bond: msg.value});
        isSettledRootFor[l2Id][genesisRoot] = true;
        emit L2Registered(l2Id, msg.sender, l2Uuid, genesisRoot);
    }

    /// @notice Move the paying key. The l2Id does not change.
    function rotateSubmitter(bytes32 l2Id, address newSubmitter) external {
        if (newSubmitter == address(0)) revert ZeroAddress();
        L2 storage l2 = _onlySubmitter(l2Id);
        emit SubmitterRotated(l2Id, l2.submitter, newSubmitter);
        l2.submitter = newSubmitter;
    }

    /// @notice Claim an election key for this L2. Unique per L2 UUID; global by construction.
    function openElection(bytes32 l2Id, bytes16 electionUuid) external returns (bytes32 electionKey) {
        _onlySubmitter(l2Id);
        electionKey = computeElectionKey(l2Id, electionUuid);
        if (electionOwner[electionKey] != bytes32(0)) revert ElectionExists();
        electionOwner[electionKey] = l2Id;
        emit ElectionOpened(electionKey, l2Id, electionUuid);
    }

    /// @notice Deposit one vote batch for one L2. Strictly sequential per l2Id.
    function submitVoteBatch(
        bytes32 l2Id,
        uint64 batchIndex,
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 dataHash,
        bytes32[] calldata electionKeys,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        L2 storage l2 = _onlySubmitter(l2Id);
        if (batchIndex != l2.nextBatchIndex) revert BadBatchIndex();
        if (prevStateRoot != l2.latestRoot) revert PrevRootMismatch();
        if (dataHash != computeDataHash(batchIndex, prevStateRoot, newStateRoot)) revert DataHashMismatch();
        for (uint256 i = 0; i < electionKeys.length; i++) {
            if (electionOwner[electionKeys[i]] != l2Id) revert ElectionNotOwned(electionKeys[i]);
        }
        bytes32 digest = computeBatchDigest(l2Id, batchIndex, prevStateRoot, newStateRoot, dataHash);
        if (!mockMode) {
            uint256[] memory inputs = new uint256[](2);
            // Field-safe split of the digest; the batch circuit must expose the same two inputs.
            inputs[0] = uint256(digest) >> 128;
            inputs[1] = uint256(digest) & type(uint128).max;
            if (!batchVerifier.verifyProof(a, b, c, inputs)) revert InvalidProof();
        }
        l2.nextBatchIndex = batchIndex + 1;
        l2.latestRoot = newStateRoot;
        isSettledRootFor[l2Id][newStateRoot] = true;
        emit VoteBatchDeposited(l2Id, batchIndex, prevStateRoot, newStateRoot, dataHash, digest, electionKeys);
    }

    function _onlySubmitter(bytes32 l2Id) internal view returns (L2 storage l2) {
        l2 = l2s[l2Id];
        if (l2.submitter == address(0)) revert UnknownL2();
        if (msg.sender != l2.submitter) revert NotSubmitter();
    }
}
```

Notes:
- The verifier interface above uses `uint256[]` public inputs; adapt to the
  real batch verifier's fixed-size signature when the circuit exists. Outside
  `mockMode` the circuit must prove the same keccak root as the prover's
  `batch.settlement` (`demo/l2/identity.mjs` `computeSettlementStateRoot`).
- Bond: `registrationBond` defaults to 0. Non-zero deters L1 spam but excludes
  small operators. Refund/slash rules are out of scope; leave it 0 for mainnet
  v1 unless spam is observed.

## 2. `smart-contracts/src/l2/L1TallyMirror.sol` diff (additive)

Keep the existing `uint256 electionId` path. Add a keyed path bound to the
registry:

```diff
+interface IZkVotingL2Registry {
+    function electionOwner(bytes32 electionKey) external view returns (bytes32);
+    function isSettledRootFor(bytes32 l2Id, bytes32 root) external view returns (bool);
+    function l2s(bytes32 l2Id) external view returns (address submitter, uint64 nextBatchIndex, bytes32 latestRoot, bytes16 l2Uuid, uint256 bond);
+}
+
 contract L1TallyMirror {
+    error RegistryAlreadySet();
+    error RegistryNotSet();
+    error UnknownElectionKey();
+    error NotL2Submitter();
+
+    event ResultPostedByKey(
+        bytes32 indexed electionKey,
+        bytes32 indexed l2Id,
+        bytes32 resultHash,
+        bytes32 countsHash,
+        bytes32 l2StateRoot,
+        uint64 batchIndex
+    );
+
+    struct KeyedResult {
+        bytes32 resultHash;
+        bytes32 countsHash;
+        uint64 postedAt;
+        uint64 batchIndex;
+    }
+
+    IZkVotingL2Registry public registry;
+    mapping(bytes32 => KeyedResult) private _resultByKey;
+
+    /// @notice One-time wiring, admin only (same guard as setSettlement, L1TallyMirror.sol:139-145).
+    function setRegistry(address registry_) external {
+        if (msg.sender != admin) revert NotAuthorized();
+        if (registry_ == address(0)) revert ZeroAddress();
+        if (address(registry) != address(0)) revert RegistryAlreadySet();
+        registry = IZkVotingL2Registry(registry_);
+    }
+
+    /// @notice The owning L2's submitter posts the final result, proven by a root
+    ///         already settled for that same L2.
+    function postResultByKey(
+        bytes32 electionKey,
+        bytes32 resultHash,
+        bytes32 countsHash,
+        bytes32 l2StateRoot,
+        uint64 batchIndex
+    ) external {
+        if (address(registry) == address(0)) revert RegistryNotSet();
+        if (resultHash == bytes32(0)) revert ZeroResultHash();
+        bytes32 l2Id = registry.electionOwner(electionKey);
+        if (l2Id == bytes32(0)) revert UnknownElectionKey();
+        (address submitter,,,,) = registry.l2s(l2Id);
+        if (msg.sender != submitter) revert NotL2Submitter();
+        if (!registry.isSettledRootFor(l2Id, l2StateRoot)) revert UnsettledStateRoot();
+        if (_resultByKey[electionKey].postedAt != 0) revert AlreadyPosted();
+        _resultByKey[electionKey] = KeyedResult(resultHash, countsHash, uint64(block.timestamp), batchIndex);
+        emit ResultPostedByKey(electionKey, l2Id, resultHash, countsHash, l2StateRoot, batchIndex);
+    }
+
+    /// @notice Read path used by the dashboard (demo/apps/node/src/l2Identity.mjs readOutcomeFromL1).
+    function resultOf(bytes32 electionKey)
+        external
+        view
+        returns (bytes32 resultHash, bytes32 countsHash, uint64 postedAt, uint64 batchIndex)
+    {
+        KeyedResult memory r = _resultByKey[electionKey];
+        return (r.resultHash, r.countsHash, r.postedAt, r.batchIndex);
+    }
```

`admin`, `NotAuthorized`, `ZeroAddress`, `ZeroResultHash`, `UnsettledStateRoot`
and `AlreadyPosted` already exist in the contract (errors at `L1TallyMirror.sol:22-37`). The dispute/supersede flow for
the keyed path can mirror the existing certification flow later.

## 3. `smart-contracts/src/l2/RollupSettlement.sol`

Two options:

- **A (recommended):** leave it unchanged as the single-L2 dev/legacy contract.
  New deployments use `ZkVotingL2Registry`, which carries the per-`l2Id` state.
  The demo prover keeps calling `RollupSettlement.submitBatch` until Matthew
  adds a `submitVoteBatch` path (the off-chain batch already has `l2Id`,
  `electionKeys` and `dataHash`).
- **B:** make it per-L2 in place: `mapping(bytes32 => bytes32) latestRootOf`,
  `mapping(bytes32 => uint64) nextBatchIndexOf`, add `bytes32 l2Id` as the
  first argument of `submitBatch`, check `prevStateRoot == latestRootOf[l2Id]`,
  and replace `isSettledRoot(root)` with `isSettledRootFor(l2Id, root)`. This
  breaks the current L1TallyMirror `ISettlement` interface (`L1TallyMirror.sol:12`).

## 4. `ZkVotingMailbox`

No change required. `sendToL2/sendToL1/enqueue/forceInclude` are advisory and
admin-only. If force-inclusion is ever made public, key its queue by `l2Id`
and charge a fee, or it becomes a spam vector against every L2.

## 5. Deploy order (Matthew)

1. Deploy `ZkVotingL2Registry(batchVerifier, mockMode=false, bond=0)` on mainnet.
2. Apply the L1TallyMirror diff, deploy, call `setRegistry(registry)`.
3. Publish both addresses in the root `README.md` "Canonical contract addresses" table.
4. Operators: `npm run l2:identity -- init`, fund `L1_SUBMITTER_PRIVATE_KEY`,
   call `registerL2(bytes16(L2_UUID), L2_SALT, genesisRoot)`, set
   `L2_REGISTRY_ADDRESS` and `L1_TALLY_MIRROR_ADDRESS`.
