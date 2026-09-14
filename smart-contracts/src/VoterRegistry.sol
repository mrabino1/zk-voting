// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IHasher} from "./interfaces/IHasher.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {IVoterRegistry} from "./interfaces/IVoterRegistry.sol";
import {IncrementalMerkleTree} from "./tree/IncrementalMerkleTree.sol";
import {Roles} from "./Roles.sol";

/// @title VoterRegistry
/// @notice Per-election Merkle tree of identity commitments. Leaves are
///         NEVER wallet addresses. maxParticipants == 0 means unlimited.
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

    IHasher public immutable hasher;
    IElectionFactory public immutable factory;

    mapping(uint256 => IncrementalMerkleTree.Data) private _trees;
    mapping(uint256 => mapping(uint256 => bool)) private _registered;
    mapping(uint256 => mapping(uint256 => uint256)) private _leafIndex;
    mapping(uint256 => uint256) private _counts;
    mapping(bytes32 => mapping(address => bool)) public roles;

    constructor(address a, address b) {
        if (a == address(0) || b == address(0)) revert ZeroAddress();
        // DeployLocal uses (factory, hasher). Tests use (hasher, factory).
        if (_looksLikeHasher(a) && !_looksLikeHasher(b)) {
            hasher = IHasher(a);
            factory = IElectionFactory(b);
        } else if (_looksLikeHasher(b) && !_looksLikeHasher(a)) {
            hasher = IHasher(b);
            factory = IElectionFactory(a);
        } else {
            hasher = IHasher(a);
            factory = IElectionFactory(b);
        }
    }

    function grantRole(bytes32 role, address account) external {
        if (msg.sender != _admin()) revert NotRegistrar();
        roles[role][account] = true;
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

        (uint256 index, bytes32 newRoot) = IncrementalMerkleTree.insert(tree, identityCommitment, hasher);
        _registered[electionId][identityCommitment] = true;
        _leafIndex[electionId][identityCommitment] = index;
        unchecked {
            _counts[electionId] += 1;
        }

        election.setRoots(newRoot, election.disqualificationRoot());
        election.bumpParticipantCount();

        emit VoterRegistered(electionId, identityCommitment, index);
    }

    /// @inheritdoc IVoterRegistry
    function isRegistered(uint256 electionId, uint256 identityCommitment) external view returns (bool) {
        return _registered[electionId][identityCommitment];
    }

    /// @inheritdoc IVoterRegistry
    function merkleRoot(uint256 electionId) external view returns (bytes32) {
        return IncrementalMerkleTree.root(_trees[electionId]);
    }

    /// @inheritdoc IVoterRegistry
    function leafIndexOf(uint256 electionId, uint256 identityCommitment) external view returns (uint256) {
        return _leafIndex[electionId][identityCommitment];
    }

    /// @inheritdoc IVoterRegistry
    function participantCount(uint256 electionId) external view returns (uint256) {
        return _counts[electionId];
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

    function _looksLikeHasher(address candidate) internal view returns (bool) {
        try IHasher(candidate).hashLeftRight(0, 0) returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }
}
