// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams, TallyScheme} from "./interfaces/ElectionParams.sol";
import {IBallotInbox} from "./interfaces/IBallotInbox.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {IGroth16Verifier} from "./interfaces/IGroth16Verifier.sol";
import {ITallyVerifier} from "./interfaces/ITallyVerifier.sol";
import {TallyPublicInputs} from "./zk/TallyPublicInputs.sol";

/// @title Tally
/// @notice Posts a proven (or mock-verified) option-count vector after cutoff.
/// @dev Two additive schemes (ElectionParams.tallyScheme):
///      0 SUM_ONLY — any `counts` with sum == acceptedBallots (legacy demo).
///      1 OPENS_BALLOTS — operator must submit `openings` whose histogram is
///        `counts` and whose length is `acceptedBallots`. That rejects invented
///        partitions that only match the sum. Decryption of ECIES envelopes is
///        off-chain (Feldman t-of-n guardians, NON-PRODUCTION). On-chain
///        this slice binds openings ↔ counts ↔ inbox ballotRoot. MockVerifier
///        does not prove discrete-log decryption; do not treat it as a ceremony.
///
///      Public inputs: `TallyPublicInputs` (TALLY_SOL_MOCK_V1). Not the same
///      encoding as `circuits/tally.circom`. See that file's header.
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
    error OpeningsRequired();
    error OpeningLengthMismatch();
    error OpeningMismatch();
    error OptionOutOfRange();

    /// @notice Factory that maps `electionId` → Election clone.
    IElectionFactory public immutable factory;

    mapping(uint256 => uint256[]) private _counts;
    mapping(uint256 => bool) private _tallied;
    mapping(uint256 => bytes32) private _openingsHash;
    mapping(uint256 => uint8) private _postedScheme;

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

        (address inbox, address verifier, ElectionParams memory p) = _authorize(electionId);
        if (p.tallyScheme == TallyScheme.OPENS_BALLOTS) revert OpeningsRequired();

        uint256 accepted = IBallotInbox(inbox).acceptedBallots(electionId);
        uint256 total = _sum(counts);
        if (total != accepted) revert CountMismatch();

        bytes32 countsHash = keccak256(abi.encodePacked(counts));
        _verify(
            verifier,
            TallyPublicInputs.mockInstance(electionId, accepted, countsHash, bytes32(0), bytes32(0)),
            a,
            b,
            c
        );

        _tallied[electionId] = true;
        _counts[electionId] = counts;
        _postedScheme[electionId] = TallyScheme.SUM_ONLY;

        emit TallyPosted(electionId, countsHash, total);
    }

    /// @inheritdoc ITallyVerifier
    function submitOpenedTally(
        uint256 electionId,
        uint256[] calldata counts,
        uint256[] calldata openings,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        if (counts.length == 0) revert EmptyCounts();
        if (_tallied[electionId]) revert AlreadyTallied();

        (address inbox, address verifier,) = _authorize(electionId);

        uint256 accepted = IBallotInbox(inbox).acceptedBallots(electionId);
        if (openings.length != accepted) revert OpeningLengthMismatch();

        uint256 total = _sum(counts);
        if (total != accepted) revert CountMismatch();
        _requireHistogram(openings, counts);

        bytes32 countsHash = keccak256(abi.encodePacked(counts));
        bytes32 openedHash = TallyPublicInputs.openingsHashOf(openings);
        bytes32 root = IBallotInbox(inbox).ballotRoot(electionId);

        _verify(
            verifier,
            TallyPublicInputs.mockInstance(electionId, accepted, countsHash, root, openedHash),
            a,
            b,
            c
        );

        _tallied[electionId] = true;
        _counts[electionId] = counts;
        _openingsHash[electionId] = openedHash;
        _postedScheme[electionId] = TallyScheme.OPENS_BALLOTS;

        emit TallyPosted(electionId, countsHash, total);
        emit OpenedTallyPosted(electionId, countsHash, openedHash, root, total);
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

    function openingsHash(uint256 electionId) external view returns (bytes32) {
        return _openingsHash[electionId];
    }

    function postedScheme(uint256 electionId) external view returns (uint8) {
        return _postedScheme[electionId];
    }

    /// @dev Operator-only, after cutoff. Returns the election inbox, groth16 verifier, and params.
    function _authorize(uint256 electionId)
        internal
        view
        returns (address inbox, address verifier, ElectionParams memory p)
    {
        address electionAddr = factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();

        IElection election = IElection(electionAddr);
        p = election.params();
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
        // CLOSED: voting window is [startTime, cutoffTime). Cutoff is exclusive.
        if (block.timestamp < p.cutoffTime) revert ElectionNotClosed();
        if (p.verifier == address(0)) revert ZeroVerifier();
        return (election.inbox(), p.verifier, p);
    }

    function _sum(uint256[] calldata counts) internal pure returns (uint256 total) {
        uint256 n = counts.length;
        for (uint256 i = 0; i < n; ++i) {
            total += counts[i];
        }
    }

    function _requireHistogram(uint256[] calldata openings, uint256[] calldata counts) internal pure {
        uint256 nOptions = counts.length;
        uint256[] memory hist = new uint256[](nOptions);
        uint256 n = openings.length;
        for (uint256 i; i < n; ++i) {
            uint256 opt = openings[i];
            if (opt >= nOptions) revert OptionOutOfRange();
            unchecked {
                hist[opt] += 1;
            }
        }
        for (uint256 j; j < nOptions; ++j) {
            if (hist[j] != counts[j]) revert OpeningMismatch();
        }
    }

    function _verify(
        address verifier,
        uint256[] memory input,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) internal view {
        bool ok = IGroth16Verifier(verifier).verifyProof(a, b, c, input);
        if (!ok) revert InvalidProof();
    }
}
