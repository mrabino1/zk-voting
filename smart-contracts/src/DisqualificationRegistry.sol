// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IDisqualificationRegistry} from "./interfaces/IDisqualificationRegistry.sol";
import {IElection} from "./interfaces/IElection.sol";
import {ElectionParams} from "./interfaces/ElectionParams.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {IHasher} from "./interfaces/IHasher.sol";
import {IVoterRegistry} from "./interfaces/IVoterRegistry.sol";
import {ReasonCodes} from "./ReasonCodes.sol";
import {DisqualificationSet} from "./tree/DisqualificationSet.sol";
import {FrontierTree} from "./tree/FrontierTree.sol";

/// @title DisqualificationRegistry
/// @notice Per-election disqualification set. `merkleRoot` is the indexed chain
///         the vote circuit uses for non-membership (`DisqualificationSet`).
///
/// @dev The mapping `isDisqualified` is the officer source of truth. Reason
///      codes stay on the mapping and on `Disqualified` / `DisqualificationRevoked`
///      events. The tree is not an append-only event log: each disqualify or
///      revoke rebuilds the sorted chain of commitments that are currently
///      disqualified. A revoke drops the commitment from that chain, so the
///      root changes and a later vote can prove a gap again.
///
///      After each rebuild, the voter registry republishes `eligibleRoot` as
///      registered ∩ ¬currently-disqualified (paged for large rolls, audit
///      H-03). The vote circuit proves both membership in that root and
///      non-membership in this chain.
///
///      Tree construction matches `src/tree/IncrementalMerkleTree.sol`:
///      depth 16–32, zeros precomputed via `IHasher.hashLeftRight`. The chain
///      is built with an O(k log k) sort and a `FrontierTree` (amortized ~2
///      hashes per link) instead of an insertion sort and `depth` hashes per
///      link.
contract DisqualificationRegistry is IDisqualificationRegistry {
    uint8 internal constant MIN_DEPTH = 16;
    uint8 internal constant MAX_DEPTH = 32;

    error ZeroAddress();
    error UnknownElection();
    error NotDisqualificationOfficer();
    error NotClerk();
    error RollFrozen();
    error InvalidReasonCode();
    error ZeroCommitment();
    error AlreadyDisqualified();
    error NotDisqualified();
    error InvalidTreeDepth();
    error VotingStarted();

    /// @notice Audit M-01: the late-update switch is public and logged.
    event LateUpdateAllowedSet(uint256 indexed electionId, bool allowed);

    IHasher public immutable hasher;
    IElectionFactory public immutable factory;

    /// @notice After freeze, updates revert unless this flag is set (default false).
    mapping(uint256 => bool) public lateUpdateAllowed;

    mapping(uint256 => mapping(uint256 => bool)) private _isDisqualified;
    mapping(uint256 => mapping(uint256 => uint16)) private _reasonCodeOf;
    /// @dev Currently disqualified commitments. Order is not significant; the
    ///      published tree sorts them before hashing the indexed chain.
    mapping(uint256 => uint256[]) private _active;

    mapping(uint256 => FrontierTree.Data) private _trees;
    mapping(uint256 => bytes32) private _chainRoots;

    constructor(address hasher_, address factory_) {
        if (hasher_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        // Audit L-08: fixed argument order (hasher, factory). No guessing.
        hasher = IHasher(hasher_);
        factory = IElectionFactory(factory_);
    }

    /// @inheritdoc IDisqualificationRegistry
    function disqualify(uint256 electionId, uint256 identityCommitment, uint16 reasonCode, bytes32 evidenceHash)
        external
    {
        if (identityCommitment == 0) revert ZeroCommitment();
        if (!ReasonCodes.isValid(reasonCode)) revert InvalidReasonCode();

        IElection election = _election(electionId);
        _requireOfficer(election);
        _requireMutableRoll(electionId, election);

        if (_isDisqualified[electionId][identityCommitment]) revert AlreadyDisqualified();

        _isDisqualified[electionId][identityCommitment] = true;
        _reasonCodeOf[electionId][identityCommitment] = reasonCode;
        _active[electionId].push(identityCommitment);

        _publishChain(electionId, election);

        emit Disqualified(electionId, identityCommitment, reasonCode, evidenceHash);
    }

    /// @inheritdoc IDisqualificationRegistry
    /// @dev Clears the mapping and rebuilds the indexed chain without this commitment.
    function revoke(uint256 electionId, uint256 identityCommitment, bytes32 evidenceHash) external {
        if (identityCommitment == 0) revert ZeroCommitment();

        IElection election = _election(electionId);
        _requireOfficer(election);
        _requireMutableRoll(electionId, election);

        if (!_isDisqualified[electionId][identityCommitment]) revert NotDisqualified();

        _isDisqualified[electionId][identityCommitment] = false;
        _reasonCodeOf[electionId][identityCommitment] = ReasonCodes.NONE;
        _removeActive(electionId, identityCommitment);

        _publishChain(electionId, election);

        emit DisqualificationRevoked(electionId, identityCommitment, evidenceHash);
    }

    /// @notice Clerk may allow post-freeze updates. Default is false.
    /// @dev Audit M-01: the switch can only be turned ON before `startTime`,
    ///      so voters and observers know before voting opens whether roots
    ///      may move mid-vote. Turning it OFF is always allowed (it only
    ///      narrows the officer's power). Every change is logged, and each
    ///      root change emits `Election.RootsUpdated(.., afterStart)`.
    function setLateUpdateAllowed(uint256 electionId, bool allowed) external {
        IElection election = _election(electionId);
        ElectionParams memory p = election.params();
        if (msg.sender != p.clerk) revert NotClerk();
        if (allowed && block.timestamp >= p.startTime) revert VotingStarted();
        lateUpdateAllowed[electionId] = allowed;
        emit LateUpdateAllowedSet(electionId, allowed);
    }

    /// @inheritdoc IDisqualificationRegistry
    function isDisqualified(uint256 electionId, uint256 identityCommitment) external view returns (bool) {
        return _isDisqualified[electionId][identityCommitment];
    }

    /// @inheritdoc IDisqualificationRegistry
    function merkleRoot(uint256 electionId) external view returns (bytes32) {
        return _chainRoots[electionId];
    }

    /// @inheritdoc IDisqualificationRegistry
    function reasonCodeOf(uint256 electionId, uint256 identityCommitment) external view returns (uint16) {
        return _reasonCodeOf[electionId][identityCommitment];
    }

    function _election(uint256 electionId) internal view returns (IElection election) {
        address addr = factory.getElection(electionId);
        if (addr == address(0)) revert UnknownElection();
        election = IElection(addr);
    }

    function _requireOfficer(IElection election) internal view {
        if (msg.sender != election.params().disqualificationOfficer) {
            revert NotDisqualificationOfficer();
        }
    }

    function _requireMutableRoll(uint256 electionId, IElection election) internal view {
        if (election.rollFrozen() && !lateUpdateAllowed[electionId]) revert RollFrozen();
    }

    function _removeActive(uint256 electionId, uint256 commitment) internal {
        uint256[] storage arr = _active[electionId];
        uint256 n = arr.length;
        for (uint256 i; i < n; ++i) {
            if (arr[i] == commitment) {
                arr[i] = arr[n - 1];
                arr.pop();
                return;
            }
        }
    }

    /// @dev Rebuild the indexed chain and publish it as `disqualificationRoot`,
    ///      then ask the voter registry to rebuild `eligibleRoot` (paged).
    function _publishChain(uint256 electionId, IElection election) internal {
        uint8 depth = election.params().treeDepth;
        if (depth < MIN_DEPTH || depth > MAX_DEPTH) revert InvalidTreeDepth();
        uint256[] memory sorted = _sortedActive(electionId);
        uint256[] memory leaves = DisqualificationSet.chainLeaves(sorted, hasher);

        FrontierTree.Data storage tree = _trees[electionId];
        FrontierTree.reset(tree, depth, hasher);
        for (uint256 i; i < leaves.length; ++i) {
            FrontierTree.append(tree, leaves[i], hasher);
        }
        bytes32 chainRoot = bytes32(FrontierTree.root(tree, hasher));
        _chainRoots[electionId] = chainRoot;

        // Publish the new chain first so the voter registry reads it when its
        // (possibly paged) eligible rebuild completes.
        election.setRoots(election.eligibleRoot(), chainRoot);
        address registry = _voterRegistry();
        if (registry != address(0)) {
            IVoterRegistry(registry).rebuildEligibleRoot(electionId);
        }
    }

    function _sortedActive(uint256 electionId) internal view returns (uint256[] memory out) {
        uint256[] storage src = _active[electionId];
        uint256 n = src.length;
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = src[i];
        }
        _heapSort(out);
    }

    /// @dev In-place heap sort, O(k log k), no recursion.
    function _heapSort(uint256[] memory a) internal pure {
        uint256 n = a.length;
        if (n < 2) return;
        for (uint256 start = n / 2; start > 0;) {
            unchecked {
                --start;
            }
            _siftDown(a, start, n);
        }
        for (uint256 end = n - 1; end > 0;) {
            (a[0], a[end]) = (a[end], a[0]);
            _siftDown(a, 0, end);
            unchecked {
                --end;
            }
        }
    }

    function _siftDown(uint256[] memory a, uint256 root, uint256 n) internal pure {
        while (true) {
            uint256 child = 2 * root + 1;
            if (child >= n) return;
            if (child + 1 < n && a[child] < a[child + 1]) ++child;
            if (a[root] >= a[child]) return;
            (a[root], a[child]) = (a[child], a[root]);
            root = child;
        }
    }

    function _voterRegistry() internal view returns (address) {
        (bool ok, bytes memory ret) = address(factory).staticcall(abi.encodeWithSignature("voterRegistry()"));
        if (ok && ret.length >= 32) return abi.decode(ret, (address));
        return address(0);
    }
}
