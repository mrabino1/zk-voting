// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @notice Per-election factory of unbounded external eligibility parties.
///         Election staff add parties (death records, felony systems, age
///         verification, …). A party may veto a registered person at cast time.
interface IExternalPartyRegistry {
    event PartyAdded(
        uint256 indexed electionId, uint256 indexed partyIndex, address indexed operator, uint8 mode, string name
    );
    event PartyStatusSet(uint256 indexed electionId, uint256 indexed partyIndex, bool active);
    event PartyOperatorSet(uint256 indexed electionId, uint256 indexed partyIndex, address operator);
    event VoteRejectedByParty(
        uint256 indexed electionId,
        uint256 indexed partyIndex,
        uint256 indexed identityCommitment,
        uint16 reasonCode,
        bytes32 evidenceHash
    );
    event PartyRejectionCleared(
        uint256 indexed electionId, uint256 indexed partyIndex, uint256 indexed identityCommitment, bytes32 evidenceHash
    );
    event PartyAttested(
        uint256 indexed electionId,
        uint256 indexed partyIndex,
        uint256 indexed identityCommitment,
        uint64 expiresAt,
        bytes32 evidenceHash
    );

    /// @notice 0 = VETO (push a rejection). 1 = MUST_ATTEST (fresh clearance required to cast).
    function addParty(address operator, string calldata name, string calldata metadataURI, uint8 mode)
        external
        returns (uint256 partyIndex);

    function setPartyActive(uint256 partyIndex, bool active) external;

    function reject(uint256 partyIndex, uint256 identityCommitment, uint16 reasonCode, bytes32 evidenceHash) external;

    function clearRejection(uint256 partyIndex, uint256 identityCommitment, bytes32 evidenceHash) external;

    function attest(uint256 partyIndex, uint256 identityCommitment, uint64 expiresAt, bytes32 evidenceHash) external;

    function partyCount() external view returns (uint256);

    function hasActiveGates() external view returns (bool);

    /// @notice True when any active must-attest party has no current attestation.
    ///         Used while building `eligibleRoot`. Not a vote-time argument.
    function missingRequiredAttestation(uint256 identityCommitment) external view returns (bool);

    function isRejected(uint256 identityCommitment) external view returns (bool);

    function assertCastAllowed(uint256 identityCommitment) external view;

    function assertCastAllowed(uint256 identityCommitment, uint256[] calldata mustAttestIds) external view;
}
