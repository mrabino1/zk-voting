// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IDisqualificationRegistry} from "./interfaces/IDisqualificationRegistry.sol";
import {IHasher} from "./interfaces/IHasher.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {IVoterRegistry} from "./interfaces/IVoterRegistry.sol";
import {DisqualificationSet} from "./tree/DisqualificationSet.sol";
import {FrontierTree} from "./tree/FrontierTree.sol";
import {IncrementalMerkleTree} from "./tree/IncrementalMerkleTree.sol";
import {Roles} from "./Roles.sol";

/// @title VoterRegistry
/// @notice Per-election Merkle tree of identity commitments. Leaves are
///         NEVER wallet addresses. maxParticipants == 0 means unlimited.
/// @dev `merkleRoot` is the append-only registration roll (disqualified
///      commitments stay in it). `Election.eligibleRoot` is
///      registered ∩ ¬currently-disqualified, in registration order.
///
///      Audit H-03: the eligible set is an append-only `FrontierTree`, so a
///      registration costs O(depth) hashes regardless of roll size. A
///      disqualify / revoke changes membership in the middle of the roll, so
///      the eligible tree is rebuilt in bounded pages of `REBUILD_BATCH`
///      leaves. The first page runs inside the disqualification transaction;
///      larger rolls are finished by anyone via `continueEligibleRebuild`.
///      While a rebuild is pending `eligibleRootPending` is true and
///      `BallotInbox` refuses ballots (`EligibleRootPending`). The published
///      root, once the rebuild completes, is identical to the old full rebuild.
contract VoterRegistry is IVoterRegistry {
    using IncrementalMerkleTree for IncrementalMerkleTree.Data;

    error ZeroAddress();
    error UnknownElection();
    error NotRegistrar();
    error ZeroCommitment();
    error AlreadyRegistered();
    error RollFrozen();
    error CapReached();
    error RegistrationClosed();
    error NotDisqualificationRegistry();
    error NoRebuildPending();

    event EligibleRebuildStarted(uint256 indexed electionId, uint256 rollSize);
    event EligibleRebuildProgress(uint256 indexed electionId, uint256 cursor, uint256 rollSize);
    event EligibleRootPublished(uint256 indexed electionId, bytes32 eligibleRoot, uint256 eligibleCount);
    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);

    /// @notice Roll entries processed per rebuild page.
    uint256 public constant REBUILD_BATCH = 64;

    struct Rebuild {
        bool pending;
        uint256 cursor;
    }

    IHasher public immutable hasher;
    IElectionFactory public immutable factory;

    mapping(uint256 => IncrementalMerkleTree.Data) private _trees;
    mapping(uint256 => mapping(uint256 => bool)) private _registered;
    mapping(uint256 => mapping(uint256 => uint256)) private _leafIndex;
    mapping(uint256 => uint256) private _counts;
    /// @dev Registration order. Disqualified commitments remain here.
    mapping(uint256 => uint256[]) private _roll;
    mapping(uint256 => uint256) private _eligibleCounts;
    mapping(uint256 => FrontierTree.Data) private _eligibleTrees;
    mapping(uint256 => Rebuild) private _rebuilds;
    mapping(bytes32 => mapping(address => bool)) public roles;

    /// @dev Audit L-08: fixed argument order (hasher, factory), same as
    ///      DisqualificationRegistry. No runtime guessing.
    constructor(address hasher_, address factory_) {
        if (hasher_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        hasher = IHasher(hasher_);
        factory = IElectionFactory(factory_);
    }

    function grantRole(bytes32 role, address account) external {
        if (msg.sender != _admin()) revert NotRegistrar();
        if (account == address(0)) revert ZeroAddress();
        roles[role][account] = true;
        emit RoleGranted(role, account);
    }

    /// @notice Audit L-05: roles are revocable.
    function revokeRole(bytes32 role, address account) external {
        if (msg.sender != _admin()) revert NotRegistrar();
        roles[role][account] = false;
        emit RoleRevoked(role, account);
    }

    /// @inheritdoc IVoterRegistry
    function register(uint256 electionId, uint256 identityCommitment) external {
        if (identityCommitment == 0) revert ZeroCommitment();
        IElection election = _election(electionId);
        _requireRegistrar(election);
        if (election.rollFrozen()) revert RollFrozen();
        if (block.timestamp >= election.params().cutoffTime) revert RegistrationClosed();
        if (_registered[electionId][identityCommitment]) revert AlreadyRegistered();

        uint32 cap = election.params().maxParticipants;
        if (cap != 0 && _counts[electionId] >= cap) revert CapReached();

        IncrementalMerkleTree.Data storage tree = _trees[electionId];
        if (!tree.initialized) {
            IncrementalMerkleTree.init(tree, election.params().treeDepth, hasher);
        }

        (uint256 index,) = IncrementalMerkleTree.insert(tree, identityCommitment, hasher);
        _registered[electionId][identityCommitment] = true;
        _leafIndex[electionId][identityCommitment] = index;
        _roll[electionId].push(identityCommitment);
        unchecked {
            _counts[electionId] += 1;
        }

        if (_rebuilds[electionId].pending) {
            // The new roll entry is picked up by the pending rebuild.
            _advanceRebuild(electionId, election, REBUILD_BATCH);
        } else {
            FrontierTree.Data storage eligibleTree = _eligibleTrees[electionId];
            if (eligibleTree.depth == 0) FrontierTree.reset(eligibleTree, election.params().treeDepth, hasher);
            if (!_currentlyDisqualified(electionId, identityCommitment)) {
                FrontierTree.append(eligibleTree, identityCommitment, hasher);
            }
            _publishEligibleRoot(electionId, election);
        }
        election.bumpParticipantCount();

        emit VoterRegistered(electionId, identityCommitment, index);
    }

    /// @inheritdoc IVoterRegistry
    function isRegistered(uint256 electionId, uint256 identityCommitment) external view returns (bool) {
        return _registered[electionId][identityCommitment];
    }

    /// @inheritdoc IVoterRegistry
    function isEligible(uint256 electionId, uint256 identityCommitment) external view returns (bool) {
        if (!_registered[electionId][identityCommitment]) return false;
        return !_currentlyDisqualified(electionId, identityCommitment);
    }

    /// @inheritdoc IVoterRegistry
    function merkleRoot(uint256 electionId) external view returns (bytes32) {
        return IncrementalMerkleTree.root(_trees[electionId]);
    }

    /// @inheritdoc IVoterRegistry
    function eligibleCount(uint256 electionId) external view returns (uint256) {
        return _eligibleCounts[electionId];
    }

    /// @inheritdoc IVoterRegistry
    /// @dev Starts (or restarts) a paged rebuild and processes the first page.
    ///      Returns the published eligible root (the new one when the rebuild
    ///      finished in this call, otherwise the previous one).
    function rebuildEligibleRoot(uint256 electionId) external returns (bytes32) {
        if (msg.sender != address(_disqualificationRegistry())) revert NotDisqualificationRegistry();
        IElection election = _election(electionId);
        FrontierTree.reset(_eligibleTrees[electionId], election.params().treeDepth, hasher);
        _rebuilds[electionId] = Rebuild({pending: true, cursor: 0});
        emit EligibleRebuildStarted(electionId, _roll[electionId].length);
        _advanceRebuild(electionId, election, REBUILD_BATCH);
        return election.eligibleRoot();
    }

    /// @inheritdoc IVoterRegistry
    function continueEligibleRebuild(uint256 electionId, uint256 maxLeaves) external returns (bool done) {
        if (!_rebuilds[electionId].pending) revert NoRebuildPending();
        if (maxLeaves == 0) maxLeaves = REBUILD_BATCH;
        return _advanceRebuild(electionId, _election(electionId), maxLeaves);
    }

    /// @inheritdoc IVoterRegistry
    function eligibleRootPending(uint256 electionId) external view returns (bool) {
        return _rebuilds[electionId].pending;
    }

    /// @inheritdoc IVoterRegistry
    function leafIndexOf(uint256 electionId, uint256 identityCommitment) external view returns (uint256) {
        return _leafIndex[electionId][identityCommitment];
    }

    /// @inheritdoc IVoterRegistry
    function participantCount(uint256 electionId) external view returns (uint256) {
        return _counts[electionId];
    }

    function _advanceRebuild(uint256 electionId, IElection election, uint256 maxLeaves) internal returns (bool done) {
        Rebuild storage rb = _rebuilds[electionId];
        uint256[] storage roll = _roll[electionId];
        uint256 n = roll.length;
        uint256 i = rb.cursor;
        uint256 end = n - i > maxLeaves ? i + maxLeaves : n;
        FrontierTree.Data storage tree = _eligibleTrees[electionId];
        IDisqualificationRegistry dq = _disqualificationRegistry();
        for (; i < end; ++i) {
            uint256 leaf = roll[i];
            if (address(dq) == address(0) || !dq.isDisqualified(electionId, leaf)) {
                FrontierTree.append(tree, leaf, hasher);
            }
        }
        rb.cursor = end;
        if (end == n) {
            rb.pending = false;
            _publishEligibleRoot(electionId, election);
            return true;
        }
        emit EligibleRebuildProgress(electionId, end, n);
        return false;
    }

    function _publishEligibleRoot(uint256 electionId, IElection election) internal returns (bytes32 eligible) {
        FrontierTree.Data storage tree = _eligibleTrees[electionId];
        eligible = bytes32(FrontierTree.root(tree, hasher));
        _eligibleCounts[electionId] = tree.count;
        bytes32 disq = election.disqualificationRoot();
        // Unset root is not the empty indexed chain. Publish Hash(0, 0) so a
        // vote can prove non-membership before anyone is disqualified.
        if (disq == bytes32(0)) {
            disq = bytes32(DisqualificationSet.rootOf(new uint256[](0), tree.depth, hasher));
        }
        election.setRoots(eligible, disq);
        emit EligibleRootPublished(electionId, eligible, tree.count);
    }

    function _currentlyDisqualified(uint256 electionId, uint256 identityCommitment) internal view returns (bool) {
        IDisqualificationRegistry dq = _disqualificationRegistry();
        if (address(dq) == address(0)) return false;
        return dq.isDisqualified(electionId, identityCommitment);
    }

    function _disqualificationRegistry() internal view returns (IDisqualificationRegistry) {
        (bool ok, bytes memory ret) = address(factory).staticcall(abi.encodeWithSignature("disqualificationRegistry()"));
        if (ok && ret.length >= 32) {
            return IDisqualificationRegistry(abi.decode(ret, (address)));
        }
        return IDisqualificationRegistry(address(0));
    }

    function _election(uint256 electionId) internal view returns (IElection election) {
        address addr = factory.getElection(electionId);
        if (addr == address(0)) revert UnknownElection();
        election = IElection(addr);
    }

    function _requireRegistrar(IElection election) internal view {
        if (msg.sender == election.params().registrar) return;
        if (msg.sender == _admin()) return;
        if (roles[Roles.REGISTRAR_ROLE][msg.sender]) return;
        revert NotRegistrar();
    }

    function _admin() internal view returns (address) {
        (bool ok, bytes memory ret) = address(factory).staticcall(abi.encodeWithSignature("admin()"));
        if (ok && ret.length >= 32) return abi.decode(ret, (address));
        return address(0);
    }
}
