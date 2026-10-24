// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "./interfaces/ElectionParams.sol";
import {IBallotInbox} from "./interfaces/IBallotInbox.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {IExternalPartyRegistry} from "./interfaces/IExternalPartyRegistry.sol";
import {IGroth16Verifier} from "./interfaces/IGroth16Verifier.sol";
import {ITallyVerifier} from "./interfaces/ITallyVerifier.sol";
import {IVoterRegistry} from "./interfaces/IVoterRegistry.sol";

/// @title BallotInbox
/// @notice Accepts gasless vote proofs. `msg.sender` is the relayer/bundler.
/// @dev There is NO function that takes a voter address. The passkey smart
///      account is not an argument; unlinkability depends on that.
///
///      Coercion slice (not MACI, not last-ballot-counts): a nullifier is
///      accepted **once**. Any second `submitVote` for that nullifier reverts
///      `NullifierUsed`, including a new ciphertext. Voters may change their
///      mind privately on the ballot form before submit. Double voting remains
///      impossible. Receipts list hashes only and cannot prove choice.
///
///      Audit H-05: `ballotHash` (public input 3) is
///      `uint256(keccak256(encryptedBallot)) mod r` so it is always a BN254
///      field element. Audit H-04: a clearance commitment must be eligible on
///      this election's roll. Audit H-03: ballots are refused while a paged
///      eligible-root rebuild is pending.
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
    error AlreadyTallied();
    error ClearanceRequired();
    error ClearanceCommitmentNotEligible();
    error EligibleRootPending();
    error TallyStatusUnavailable();

    /// @notice BN254 scalar field modulus r.
    uint256 public constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IElectionFactory public immutable factory;

    mapping(uint256 => mapping(uint256 => bool)) private _nullifierUsed;
    mapping(uint256 => uint256) private _acceptedBallots;
    mapping(uint256 => mapping(uint256 => bytes32)) private _ballotHashOf;
    mapping(uint256 => bytes32[]) private _ballotHashList;
    mapping(uint256 => bytes32) private _ballotRoot;

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
        if (publicInputs.length != 5) revert InvalidPublicInputs();

        IElection election = _getElection(electionId);
        _requireNoActiveGates(electionId);
        address verifier = _requireOpen(election);
        _requireNotTallied(electionId);
        _requireBoundInstance(election, electionId, publicInputs, encryptedBallot);

        if (!IGroth16Verifier(verifier).verifyProof(a, b, c, publicInputs)) revert InvalidProof();

        uint256 nullifier = publicInputs[2];
        bytes32 ballotHash = bytes32(publicInputs[3]);
        // Audit L-06: key by the field element so n and n + r cannot both land.
        if (_nullifierUsed[electionId][nullifier % SNARK_SCALAR_FIELD]) revert NullifierUsed();
        _recordAcceptance(electionId, nullifier, ballotHash);
    }

    /// @inheritdoc IBallotInbox
    function submitVoteWithClearance(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot,
        uint256 identityCommitment,
        uint256[] calldata mustAttestIds
    ) external {
        if (encryptedBallot.length == 0) revert EmptyBallot();
        if (publicInputs.length != 5) revert InvalidPublicInputs();

        IElection election = _getElection(electionId);
        _requireExternalClearance(election, electionId, identityCommitment, mustAttestIds);
        address verifier = _requireOpen(election);
        _requireNotTallied(electionId);
        _requireBoundInstance(election, electionId, publicInputs, encryptedBallot);

        if (!IGroth16Verifier(verifier).verifyProof(a, b, c, publicInputs)) revert InvalidProof();

        uint256 nullifier = publicInputs[2];
        bytes32 ballotHash = bytes32(publicInputs[3]);
        // Audit L-06: key by the field element so n and n + r cannot both land.
        if (_nullifierUsed[electionId][nullifier % SNARK_SCALAR_FIELD]) revert NullifierUsed();
        _recordAcceptance(electionId, nullifier, ballotHash);
    }

    /// @inheritdoc IBallotInbox
    function nullifierUsed(uint256 electionId, uint256 nullifier) external view returns (bool) {
        return _nullifierUsed[electionId][nullifier % SNARK_SCALAR_FIELD];
    }

    /// @inheritdoc IBallotInbox
    function acceptedBallots(uint256 electionId) external view returns (uint256) {
        return _acceptedBallots[electionId];
    }

    /// @inheritdoc IBallotInbox
    function ballotHashOf(uint256 electionId, uint256 nullifier) external view returns (bytes32) {
        return _ballotHashOf[electionId][nullifier % SNARK_SCALAR_FIELD];
    }

    /// @inheritdoc IBallotInbox
    function ballotRoot(uint256 electionId) external view returns (bytes32) {
        return _ballotRoot[electionId];
    }

    /// @inheritdoc IBallotInbox
    function ballotHashAt(uint256 electionId, uint256 index) external view returns (bytes32) {
        return _ballotHashList[electionId][index];
    }

    function _requireNotTallied(uint256 electionId) internal view {
        // Audit M-04: fail closed. The tally module is set once in the factory
        // (M-03); a failing read or a reverting `isTallied` blocks the ballot
        // instead of silently skipping the check. Zero means no tally module
        // is wired, so nothing can have been tallied yet.
        (bool ok, bytes memory ret) = address(factory).staticcall(abi.encodeWithSignature("tallyVerifier()"));
        if (!ok || ret.length < 32) revert TallyStatusUnavailable();
        address tally = abi.decode(ret, (address));
        if (tally == address(0)) return;
        try ITallyVerifier(tally).isTallied(electionId) returns (bool done) {
            if (done) revert AlreadyTallied();
        } catch {
            revert TallyStatusUnavailable();
        }
    }

    function _getElection(uint256 electionId) internal view returns (IElection election) {
        address electionAddr = factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        election = IElection(electionAddr);
    }

    function _partyRegistry(uint256 electionId) internal view returns (address) {
        return factory.getPartyRegistry(electionId);
    }

    /// @dev Plain `submitVote` is allowed only while no external parties are active.
    function _requireNoActiveGates(uint256 electionId) internal view {
        address registry = _partyRegistry(electionId);
        if (registry == address(0)) return;
        if (IExternalPartyRegistry(registry).hasActiveGates()) revert ClearanceRequired();
    }

    /// @dev The commitment is still not a proof public input (that needs a
    ///      circuit change, see audit H-04), but it must at least be a
    ///      registered, not-disqualified roll entry of this election, so a
    ///      vetoed voter can no longer pass an arbitrary unregistered value.
    function _requireExternalClearance(
        IElection election,
        uint256 electionId,
        uint256 identityCommitment,
        uint256[] calldata mustAttestIds
    ) internal view {
        address registry = _partyRegistry(electionId);
        if (registry == address(0)) return;
        address voters = election.voterRegistry();
        if (voters == address(0) || !IVoterRegistry(voters).isEligible(electionId, identityCommitment)) {
            revert ClearanceCommitmentNotEligible();
        }
        IExternalPartyRegistry(registry).assertCastAllowed(identityCommitment, mustAttestIds);
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

        if (publicInputs[3] != ballotHashOfCiphertext(encryptedBallot)) revert BallotHashMismatch();

        address voters = election.voterRegistry();
        if (voters != address(0)) {
            (bool ok, bytes memory ret) =
                voters.staticcall(abi.encodeWithSelector(IVoterRegistry.eligibleRootPending.selector, electionId));
            if (ok && ret.length >= 32 && abi.decode(ret, (bool))) revert EligibleRootPending();
        }
    }

    /// @notice Field-safe ballot hash: `uint256(keccak256(ciphertext)) mod r`.
    function ballotHashOfCiphertext(bytes calldata encryptedBallot) public pure returns (uint256) {
        return uint256(keccak256(encryptedBallot)) % SNARK_SCALAR_FIELD;
    }

    function _recordAcceptance(uint256 electionId, uint256 nullifier, bytes32 ballotHash) internal {
        uint256 key = nullifier % SNARK_SCALAR_FIELD;
        _nullifierUsed[electionId][key] = true;
        _ballotHashOf[electionId][key] = ballotHash;
        _ballotHashList[electionId].push(ballotHash);
        _ballotRoot[electionId] = keccak256(abi.encodePacked(_ballotRoot[electionId], ballotHash));
        unchecked {
            _acceptedBallots[electionId] += 1;
        }
        emit VoteAccepted(electionId, nullifier, ballotHash, msg.sender);
    }
}
