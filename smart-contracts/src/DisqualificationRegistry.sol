// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IDisqualificationRegistry} from "./interfaces/IDisqualificationRegistry.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {IHasher} from "./interfaces/IHasher.sol";
import {IVoterRegistry} from "./interfaces/IVoterRegistry.sol";
import {ReasonCodes} from "./ReasonCodes.sol";
import {DisqualificationSet} from "./tree/DisqualificationSet.sol";

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
///      registered ∩ ¬currently-disqualified. The vote circuit proves both
///      membership in that root and non-membership in this chain.
///
///      Tree construction matches `src/tree/IncrementalMerkleTree.sol`:
///      depth 16–32, zeros precomputed via `IHasher.hashLeftRight`.
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
    error TreeFull();

    /// @dev IncrementalMerkleTree storage (depth 16–32, hasher-precomputed zeros).
    struct Tree {
        uint8 depth;
        uint256 nextIndex;
        uint256 currentRoot;
        mapping(uint256 => uint256) filledSubtrees;
        mapping(uint256 => uint256) zeros;
    }

    IHasher public immutable hasher;
    IElectionFactory public immutable factory;

    /// @notice After freeze, updates revert unless this flag is set (default false).
    mapping(uint256 => bool) public lateUpdateAllowed;

    mapping(uint256 => mapping(uint256 => bool)) private _isDisqualified;
    mapping(uint256 => mapping(uint256 => uint16)) private _reasonCodeOf;
    /// @dev Currently disqualified commitments. Order is not significant; the
    ///      published tree sorts them before hashing the indexed chain.
    mapping(uint256 => uint256[]) private _active;

    mapping(uint256 => Tree) private _trees;

    constructor(address hasher_, address factory_) {
        if (hasher_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        // Deployer helpers try (factory, hasher) first; the exclusive spec is
        // (hasher, factory). Detect IHasher so either order wires correctly.
        if (_looksLikeHasher(hasher_) && !_looksLikeHasher(factory_)) {
            hasher = IHasher(hasher_);
            factory = IElectionFactory(factory_);
        } else if (_looksLikeHasher(factory_) && !_looksLikeHasher(hasher_)) {
            hasher = IHasher(factory_);
            factory = IElectionFactory(hasher_);
        } else {
            hasher = IHasher(hasher_);
            factory = IElectionFactory(factory_);
        }
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
    function setLateUpdateAllowed(uint256 electionId, bool allowed) external {
        IElection election = _election(electionId);
        if (msg.sender != election.params().clerk) revert NotClerk();
        lateUpdateAllowed[electionId] = allowed;
    }

    /// @inheritdoc IDisqualificationRegistry
    function isDisqualified(uint256 electionId, uint256 identityCommitment) external view returns (bool) {
        return _isDisqualified[electionId][identityCommitment];
    }

    /// @inheritdoc IDisqualificationRegistry
    function merkleRoot(uint256 electionId) external view returns (bytes32) {
        return bytes32(_trees[electionId].currentRoot);
    }

    /// @inheritdoc IDisqualificationRegistry
    function reasonCodeOf(uint256 electionId, uint256 identityCommitment) external view returns (uint16) {
        return _reasonCodeOf[electionId][identityCommitment];
    }

    function _looksLikeHasher(address candidate) internal view returns (bool) {
        try IHasher(candidate).hashLeftRight(0, 0) returns (uint256) {
            return true;
        } catch {
            return false;
        }
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

    /// @dev Rebuild the indexed chain and publish it as `disqualificationRoot`.
    function _publishChain(uint256 electionId, IElection election) internal {
        uint8 depth = election.params().treeDepth;
        if (depth < MIN_DEPTH || depth > MAX_DEPTH) revert InvalidTreeDepth();
        uint256[] memory sorted = _sortedActive(electionId);
        uint256[] memory leaves = DisqualificationSet.chainLeaves(sorted, hasher);

        Tree storage tree = _trees[electionId];
        _resetTree(tree, depth);
        for (uint256 i; i < leaves.length; ++i) {
            _insert(tree, leaves[i]);
        }

        bytes32 eligible = election.eligibleRoot();
        address registry = _voterRegistry();
        if (registry != address(0)) {
            eligible = IVoterRegistry(registry).rebuildEligibleRoot(electionId);
        }
        election.setRoots(eligible, bytes32(tree.currentRoot));
    }

    function _sortedActive(uint256 electionId) internal view returns (uint256[] memory out) {
        uint256[] storage src = _active[electionId];
        uint256 n = src.length;
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = src[i];
        }
        for (uint256 i = 1; i < n; ++i) {
            uint256 key = out[i];
            uint256 j = i;
            while (j > 0 && out[j - 1] > key) {
                out[j] = out[j - 1];
                unchecked {
                    --j;
                }
            }
            out[j] = key;
        }
    }

    function _voterRegistry() internal view returns (address) {
        (bool ok, bytes memory ret) = address(factory).staticcall(abi.encodeWithSignature("voterRegistry()"));
        if (ok && ret.length >= 32) return abi.decode(ret, (address));
        return address(0);
    }

    function _resetTree(Tree storage tree, uint8 depth) internal {
        _initTree(tree, depth);
        tree.nextIndex = 0;
    }

    function _initTree(Tree storage tree, uint8 depth) internal {
        uint256 z = 0;
        tree.zeros[0] = 0;
        for (uint8 i = 0; i < depth;) {
            z = hasher.hashLeftRight(z, z);
            tree.zeros[i + 1] = z;
            tree.filledSubtrees[i] = tree.zeros[i];
            unchecked {
                ++i;
            }
        }
        tree.depth = depth;
        tree.currentRoot = z;
        tree.nextIndex = 0;
    }

    function _insert(Tree storage tree, uint256 leaf) internal {
        uint256 index = tree.nextIndex;
        if (index >= (uint256(1) << tree.depth)) revert TreeFull();

        uint256 currentIndex = index;
        uint256 currentHash = leaf;
        for (uint8 i = 0; i < tree.depth;) {
            if (currentIndex % 2 == 0) {
                tree.filledSubtrees[i] = currentHash;
                currentHash = hasher.hashLeftRight(currentHash, tree.zeros[i]);
            } else {
                currentHash = hasher.hashLeftRight(tree.filledSubtrees[i], currentHash);
            }
            currentIndex /= 2;
            unchecked {
                ++i;
            }
        }
        tree.nextIndex = index + 1;
        tree.currentRoot = currentHash;
    }
}
