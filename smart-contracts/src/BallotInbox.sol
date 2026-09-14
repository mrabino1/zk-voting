// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "./interfaces/ElectionParams.sol";
import {IBallotInbox} from "./interfaces/IBallotInbox.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {IGroth16Verifier} from "./interfaces/IGroth16Verifier.sol";

/// @title BallotInbox
/// @notice Accepts gasless vote proofs. `msg.sender` is the relayer/bundler.
/// @dev There is NO function that takes a voter address. The passkey smart
///      account is not an argument; unlinkability depends on that.
contract BallotInbox is IBallotInbox {
    error ZeroAddress();
    error UnknownElection();
    error EmptyBallot();
    error InvalidPublicInputs();
    error RollNotFrozen();
    error OutsideVotingWindow();
    error ZeroVerifier();
    error EligibleRootMismatch();
    error DisqualificationRootMismatch();
    error ElectionIdMismatch();
    error BallotHashMismatch();
    error NullifierUsed();
    error InvalidProof();

    IElectionFactory public immutable factory;

    mapping(uint256 => mapping(uint256 => bool)) private _nullifierUsed;
    mapping(uint256 => uint256) private _acceptedBallots;
    mapping(uint256 => mapping(uint256 => bytes32)) private _ballotHashOf;

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = IElectionFactory(factory_);
    }

    /// @inheritdoc IBallotInbox
    /// @dev Anyone (relayer / bundler / paymaster / voter) may submit. Gasless
    ///      by policy: the L2 paymaster sponsors this call. The voter address
    ///      is not recorded and is not an argument.
    function submitVote(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot
    ) external {
        if (encryptedBallot.length == 0) revert EmptyBallot();
        if (publicInputs.length < 5) revert InvalidPublicInputs();

        IElection election = _getElection(electionId);
        address verifier = _requireOpen(election);
        _requireBoundInstance(election, electionId, publicInputs, encryptedBallot);

        uint256 nullifier = publicInputs[2];
        if (_nullifierUsed[electionId][nullifier]) revert NullifierUsed();

        if (!IGroth16Verifier(verifier).verifyProof(a, b, c, publicInputs)) revert InvalidProof();

        _recordAcceptance(electionId, nullifier, bytes32(publicInputs[3]));
    }

    /// @inheritdoc IBallotInbox
    function nullifierUsed(uint256 electionId, uint256 nullifier) external view returns (bool) {
        return _nullifierUsed[electionId][nullifier];
    }

    /// @inheritdoc IBallotInbox
    function acceptedBallots(uint256 electionId) external view returns (uint256) {
        return _acceptedBallots[electionId];
    }

    /// @inheritdoc IBallotInbox
    function ballotHashOf(uint256 electionId, uint256 nullifier) external view returns (bytes32) {
        return _ballotHashOf[electionId][nullifier];
    }

    function _getElection(uint256 electionId) internal view returns (IElection election) {
        address electionAddr = factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        election = IElection(electionAddr);
    }

    /// @dev OPEN ≡ roll frozen AND now ∈ [startTime, cutoffTime).
    function _requireOpen(IElection election) internal view returns (address verifier) {
        if (!election.rollFrozen()) revert RollNotFrozen();
        ElectionParams memory p = election.params();
        if (block.timestamp < p.startTime || block.timestamp >= p.cutoffTime) {
            revert OutsideVotingWindow();
        }
        verifier = p.verifier;
        if (verifier == address(0)) revert ZeroVerifier();
    }

    function _requireBoundInstance(
        IElection election,
        uint256 electionId,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot
    ) internal view {
        if (publicInputs[0] != uint256(election.eligibleRoot())) {
            revert EligibleRootMismatch();
        }
        if (publicInputs[1] != uint256(election.disqualificationRoot())) {
            revert DisqualificationRootMismatch();
        }
        if (publicInputs[4] != electionId) revert ElectionIdMismatch();

        bytes32 expected = keccak256(encryptedBallot);
        if (bytes32(publicInputs[3]) != expected && publicInputs[3] != uint256(expected)) {
            revert BallotHashMismatch();
        }
    }

    function _recordAcceptance(uint256 electionId, uint256 nullifier, bytes32 ballotHash) internal {
        _nullifierUsed[electionId][nullifier] = true;
        _ballotHashOf[electionId][nullifier] = ballotHash;
        unchecked {
            _acceptedBallots[electionId] += 1;
        }
        emit VoteAccepted(electionId, nullifier, ballotHash, msg.sender);
    }
}
