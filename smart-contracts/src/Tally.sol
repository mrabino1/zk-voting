// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "./interfaces/ElectionParams.sol";
import {IBallotInbox} from "./interfaces/IBallotInbox.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {IGroth16Verifier} from "./interfaces/IGroth16Verifier.sol";
import {ITallyVerifier} from "./interfaces/ITallyVerifier.sol";

/// @title Tally
/// @notice Posts a proven (or mock-verified) option-count vector after cutoff.
/// @dev Election.sol is not edited from this slice. This contract stores
///      `isTallied[electionId]` so a later Election.state() can read
///      `ITallyVerifier.isTallied` once the factory wires `tallyVerifier`.
///      Civic public good — no fees, no token, no skimming of results.
contract Tally is ITallyVerifier {
    error ZeroAddress();
    error UnknownElection();
    error NotTallyOperator();
    error ElectionNotClosed();
    error AlreadyTallied();
    error EmptyCounts();
    error CountMismatch();
    error InvalidProof();
    error ZeroVerifier();

    /// @notice Factory that maps `electionId` → Election clone.
    IElectionFactory public immutable factory;

    mapping(uint256 => uint256[]) private _counts;
    mapping(uint256 => bool) private _tallied;

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = IElectionFactory(factory_);
    }

    /// @inheritdoc ITallyVerifier
    function submitTally(
        uint256 electionId,
        uint256[] calldata counts,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        if (counts.length == 0) revert EmptyCounts();
        if (_tallied[electionId]) revert AlreadyTallied();

        (address inbox, address verifier) = _authorize(electionId);

        uint256 accepted = IBallotInbox(inbox).acceptedBallots(electionId);
        uint256 total = _sum(counts);
        // Mock path and circuit path both require the published vector to
        // exhaust the inbox. Invariant: sum(counts) == acceptedBallots.
        if (total != accepted) revert CountMismatch();

        bytes32 countsHash = keccak256(abi.encodePacked(counts));
        _verify(verifier, electionId, accepted, countsHash, a, b, c);

        _tallied[electionId] = true;
        _counts[electionId] = counts;

        emit TallyPosted(electionId, countsHash, total);
    }

    /// @inheritdoc ITallyVerifier
    function tally(uint256 electionId) external view returns (uint256[] memory) {
        return _counts[electionId];
    }

    /// @inheritdoc ITallyVerifier
    /// @dev Election.state() should treat TALLIED when this returns true.
    function isTallied(uint256 electionId) external view returns (bool) {
        return _tallied[electionId];
    }

    /// @dev Operator-only, after cutoff. Returns the election inbox and groth16 verifier.
    function _authorize(uint256 electionId) internal view returns (address inbox, address verifier) {
        address electionAddr = factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();

        IElection election = IElection(electionAddr);
        ElectionParams memory p = election.params();
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
        // CLOSED: voting window is [startTime, cutoffTime). Cutoff is exclusive.
        if (block.timestamp < p.cutoffTime) revert ElectionNotClosed();
        if (p.verifier == address(0)) revert ZeroVerifier();
        return (election.inbox(), p.verifier);
    }

    function _sum(uint256[] calldata counts) internal pure returns (uint256 total) {
        uint256 n = counts.length;
        for (uint256 i = 0; i < n; ++i) {
            total += counts[i];
        }
    }

    function _verify(
        address verifier,
        uint256 electionId,
        uint256 accepted,
        bytes32 countsHash,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) internal view {
        uint256[] memory input = new uint256[](3);
        input[0] = electionId;
        input[1] = accepted;
        input[2] = uint256(countsHash);
        bool ok = IGroth16Verifier(verifier).verifyProof(a, b, c, input);
        if (!ok) revert InvalidProof();
    }
}
