// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IDisqualificationRegistry} from "./interfaces/IDisqualificationRegistry.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {IHasher} from "./interfaces/IHasher.sol";
import {ReasonCodes} from "./ReasonCodes.sol";

/// @title DisqualificationRegistry
/// @notice Per-election disqualification set plus an IncrementalMerkleTree log.
///
/// @dev Tombstones
///      Incremental Merkle trees cannot delete a leaf. A revoke therefore:
///        1. Sets `isDisqualified[election][commitment] = false` (officer source of truth).
///        2. Inserts a **revocation leaf** Poseidon/keccak(commitment, reason, revokedFlag=1).
///      Officers read the mapping. The tree root is an append-only commitment
///      to (commitment, reason, revokedFlag) so the vote circuit can bind `disqRoot`.
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

        _appendLeaf(electionId, election, _eventLeaf(identityCommitment, reasonCode, false));

        emit Disqualified(electionId, identityCommitment, reasonCode, evidenceHash);
    }

    /// @inheritdoc IDisqualificationRegistry
    /// @dev Tombstone: mapping cleared, a revocation leaf is appended. The original
    ///      disqualification leaf remains in the tree (append-only).
    function revoke(uint256 electionId, uint256 identityCommitment, bytes32 evidenceHash) external {
        if (identityCommitment == 0) revert ZeroCommitment();

        IElection election = _election(electionId);
        _requireOfficer(election);
        _requireMutableRoll(electionId, election);

        if (!_isDisqualified[electionId][identityCommitment]) revert NotDisqualified();

        uint16 reason = _reasonCodeOf[electionId][identityCommitment];
        _isDisqualified[electionId][identityCommitment] = false;
        _reasonCodeOf[electionId][identityCommitment] = ReasonCodes.NONE;

        _appendLeaf(electionId, election, _eventLeaf(identityCommitment, reason, true));

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

    /// @dev Poseidon/keccak(commitment, reason, revokedFlag) folded through IHasher.
    function _eventLeaf(uint256 identityCommitment, uint16 reasonCode, bool revoked) internal view returns (uint256) {
        uint256 flag = revoked ? 1 : 0;
        uint256 inner = hasher.hashLeftRight(uint256(reasonCode), flag);
        return hasher.hashLeftRight(identityCommitment, inner);
    }

    function _appendLeaf(uint256 electionId, IElection election, uint256 leaf) internal {
        Tree storage tree = _trees[electionId];
        if (tree.depth == 0) {
            uint8 depth = election.params().treeDepth;
            if (depth < MIN_DEPTH || depth > MAX_DEPTH) revert InvalidTreeDepth();
            _initTree(tree, depth);
        }
        _insert(tree, leaf);
        election.setRoots(election.eligibleRoot(), bytes32(tree.currentRoot));
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
