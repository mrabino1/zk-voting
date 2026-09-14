// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IGroth16Verifier} from "../../src/interfaces/IGroth16Verifier.sol";
import {IHasher} from "../../src/interfaces/IHasher.sol";

/// @title Ghost
/// @notice Ghost variables for Republic invariant tests. Tracks successful
///         handler actions so invariants can compare chain state to history.
contract Ghost {
    /// @dev electionId => nullifier => spent.
    mapping(uint256 => mapping(uint256 => bool)) public nullifierUsed;

    /// @dev Total ballots the handler observed as accepted.
    uint256 public votesAccepted;

    /// @dev Total identity commitments the handler observed as registered.
    uint256 public registered;

    uint256 public ghostElectionCount;
    uint256[] public trackedElectionIds;

    mapping(uint256 => bool) public seenElectionId;
    mapping(uint256 => address) public electionAddr;
    mapping(uint256 => uint256) public registeredByElection;
    mapping(uint256 => uint256) public acceptedByElection;
    mapping(uint256 => uint32) public capOf;
    mapping(uint256 => uint64) public startOf;
    mapping(uint256 => uint64) public cutoffOf;
    mapping(uint256 => address) public clerkOf;
    mapping(uint256 => address) public registrarOf;
    mapping(uint256 => address) public officerOf;
    mapping(uint256 => address) public tallyOpOf;
    mapping(uint256 => uint256[]) internal _nullifiersOf;
    mapping(uint256 => mapping(uint256 => bool)) public registeredCommitment;

    uint256 public duplicateNullifiers;
    uint256 public supersessions;
    uint256 public votesOutsideWindow;
    uint256 public votesWhileUnfrozen;

    function trackedElectionCount() public view returns (uint256) {
        return trackedElectionIds.length;
    }

    function nullifierCount(uint256 electionId) external view returns (uint256) {
        return _nullifiersOf[electionId].length;
    }

    function nullifierAt(uint256 electionId, uint256 index) external view returns (uint256) {
        return _nullifiersOf[electionId][index];
    }

    function _recordElection(
        uint256 electionId,
        address election,
        uint64 startTime,
        uint64 cutoffTime,
        uint32 maxParticipants,
        address clerk,
        address registrar,
        address officer,
        address tallyOperator
    ) internal {
        if (seenElectionId[electionId]) return;
        seenElectionId[electionId] = true;
        trackedElectionIds.push(electionId);
        ghostElectionCount += 1;
        electionAddr[electionId] = election;
        startOf[electionId] = startTime;
        cutoffOf[electionId] = cutoffTime;
        capOf[electionId] = maxParticipants;
        clerkOf[electionId] = clerk;
        registrarOf[electionId] = registrar;
        officerOf[electionId] = officer;
        tallyOpOf[electionId] = tallyOperator;
    }

    function _recordRegister(uint256 electionId, uint256 commitment) internal {
        if (registeredCommitment[electionId][commitment]) return;
        registeredCommitment[electionId][commitment] = true;
        registered += 1;
        registeredByElection[electionId] += 1;
    }

    function _recordVote(uint256 electionId, uint256 nullifier, bool frozen) internal {
        if (nullifierUsed[electionId][nullifier]) {
            // Last-ballot-counts: a later valid ballot for the same nullifier
            // replaces the previous one. Unique-voter count does not grow.
            supersessions += 1;
        } else {
            nullifierUsed[electionId][nullifier] = true;
            _nullifiersOf[electionId].push(nullifier);
            votesAccepted += 1;
            acceptedByElection[electionId] += 1;
        }
        uint64 start = startOf[electionId];
        uint64 cutoff = cutoffOf[electionId];
        if (block.timestamp < start || block.timestamp >= cutoff) {
            votesOutsideWindow += 1;
        }
        if (!frozen) {
            votesWhileUnfrozen += 1;
        }
    }
}

/// @notice Local groth16 stub. Owner (deployer) may flip `accept`.
contract FuzzMockVerifier is IGroth16Verifier {
    bool public accept = true;
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    function setAccept(bool v) external {
        require(msg.sender == owner, "FuzzMockVerifier: not owner");
        accept = v;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[] calldata)
        external
        view
        returns (bool)
    {
        return accept;
    }
}

/// @notice keccak256 hasher so Foundry tests do not need a trusted setup.
contract FuzzKeccakHasher is IHasher {
    function hashLeftRight(uint256 left, uint256 right) external pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(left, right)));
    }
}
