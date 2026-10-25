// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {IExternalPartyRegistry} from "./interfaces/IExternalPartyRegistry.sol";
import {ReasonCodes} from "./ReasonCodes.sol";

/// @title ExternalPartyRegistry
/// @notice Cloneable per-election factory of unlimited external eligibility parties.
/// @dev Veto is O(1) via a rejection counter. MUST_ATTEST parties are checked
///      against caller-supplied ids (the relayer pays for that set; the contract
///      never loops the full party list at vote time).
contract ExternalPartyRegistry is IExternalPartyRegistry {
    uint8 internal constant MODE_VETO = 0;
    uint8 internal constant MODE_MUST_ATTEST = 1;

    error AlreadyInitialized();
    error NotFactory();
    error NotStaff();
    error NotPartyOperator();
    error PartyNotActive();
    error ZeroAddress();
    error ZeroCommitment();
    error InvalidMode();
    error InvalidReasonCode();
    error UnknownParty();
    error AlreadyRejected();
    error NotRejected();
    error VoteRejectedByExternalParty();
    error MissingAttestation();
    error DuplicateAttestationId();
    error ExpiredAttestation();
    error UnexpectedAttestationIds();

    struct Party {
        address operator;
        string name;
        string metadataURI;
        uint8 mode;
        bool active;
    }

    IElectionFactory public factory;
    uint256 public electionId;
    bool private _initialized;

    uint256 public partyCount;
    uint256 public activePartyCount;
    uint256 public mustAttestActiveCount;

    mapping(uint256 => Party) private _parties;
    mapping(uint256 => uint256) private _rejectionCount;
    mapping(uint256 => mapping(uint256 => bool)) private _rejectedBy;
    mapping(uint256 => mapping(uint256 => uint16)) private _reasonBy;
    mapping(uint256 => mapping(uint256 => uint64)) private _attestationExpires;

    modifier onlyStaff() {
        if (!factory.isElectionStaff(electionId, msg.sender)) revert NotStaff();
        _;
    }

    /// @notice Called once by ElectionFactory after EIP-1167 clone.
    function initialize(uint256 electionId_, address factory_) external {
        if (_initialized) revert AlreadyInitialized();
        if (factory_ == address(0)) revert ZeroAddress();
        if (electionId_ == 0) revert NotFactory();
        _initialized = true;
        electionId = electionId_;
        factory = IElectionFactory(factory_);
    }

    /// @inheritdoc IExternalPartyRegistry
    function addParty(address operator, string calldata name, string calldata metadataURI, uint8 mode)
        external
        onlyStaff
        returns (uint256 partyIndex)
    {
        if (operator == address(0)) revert ZeroAddress();
        if (mode > MODE_MUST_ATTEST) revert InvalidMode();

        partyIndex = partyCount;
        unchecked {
            partyCount = partyIndex + 1;
            activePartyCount += 1;
            if (mode == MODE_MUST_ATTEST) mustAttestActiveCount += 1;
        }

        Party storage party = _parties[partyIndex];
        party.operator = operator;
        party.name = name;
        party.metadataURI = metadataURI;
        party.mode = mode;
        party.active = true;

        emit PartyAdded(electionId, partyIndex, operator, mode, name);
    }

    /// @inheritdoc IExternalPartyRegistry
    function setPartyActive(uint256 partyIndex, bool active) external onlyStaff {
        Party storage party = _party(partyIndex);
        if (party.active == active) return;
        party.active = active;
        if (active) {
            unchecked {
                activePartyCount += 1;
                if (party.mode == MODE_MUST_ATTEST) mustAttestActiveCount += 1;
            }
        } else {
            unchecked {
                activePartyCount -= 1;
                if (party.mode == MODE_MUST_ATTEST) mustAttestActiveCount -= 1;
            }
        }
        emit PartyStatusSet(electionId, partyIndex, active);
    }

    function setPartyOperator(uint256 partyIndex, address operator) external onlyStaff {
        if (operator == address(0)) revert ZeroAddress();
        Party storage party = _party(partyIndex);
        party.operator = operator;
        emit PartyOperatorSet(electionId, partyIndex, operator);
    }

    /// @inheritdoc IExternalPartyRegistry
    function reject(uint256 partyIndex, uint256 identityCommitment, uint16 reasonCode, bytes32 evidenceHash)
        external
    {
        if (identityCommitment == 0) revert ZeroCommitment();
        if (!ReasonCodes.isValid(reasonCode)) revert InvalidReasonCode();
        _requireActiveOperator(partyIndex);
        if (_rejectedBy[identityCommitment][partyIndex]) revert AlreadyRejected();

        _rejectedBy[identityCommitment][partyIndex] = true;
        _reasonBy[identityCommitment][partyIndex] = reasonCode;
        unchecked {
            _rejectionCount[identityCommitment] += 1;
        }
        emit VoteRejectedByParty(electionId, partyIndex, identityCommitment, reasonCode, evidenceHash);
    }

    /// @inheritdoc IExternalPartyRegistry
    function clearRejection(uint256 partyIndex, uint256 identityCommitment, bytes32 evidenceHash) external {
        if (identityCommitment == 0) revert ZeroCommitment();
        _requireOperator(partyIndex);
        if (!_rejectedBy[identityCommitment][partyIndex]) revert NotRejected();

        _rejectedBy[identityCommitment][partyIndex] = false;
        _reasonBy[identityCommitment][partyIndex] = ReasonCodes.NONE;
        unchecked {
            _rejectionCount[identityCommitment] -= 1;
        }
        emit PartyRejectionCleared(electionId, partyIndex, identityCommitment, evidenceHash);
    }

    /// @inheritdoc IExternalPartyRegistry
    function attest(uint256 partyIndex, uint256 identityCommitment, uint64 expiresAt, bytes32 evidenceHash)
        external
    {
        if (identityCommitment == 0) revert ZeroCommitment();
        Party storage party = _requireActiveOperator(partyIndex);
        if (party.mode != MODE_MUST_ATTEST) revert InvalidMode();
        uint64 exp = expiresAt == 0 ? type(uint64).max : expiresAt;
        _attestationExpires[identityCommitment][partyIndex] = exp;
        emit PartyAttested(electionId, partyIndex, identityCommitment, exp, evidenceHash);
    }

    function getParty(uint256 partyIndex)
        external
        view
        returns (address operator, string memory name, string memory metadataURI, uint8 mode, bool active)
    {
        Party storage party = _party(partyIndex);
        return (party.operator, party.name, party.metadataURI, party.mode, party.active);
    }

    /// @inheritdoc IExternalPartyRegistry
    function hasActiveGates() public view returns (bool) {
        return activePartyCount > 0;
    }

    /// @inheritdoc IExternalPartyRegistry
    function isRejected(uint256 identityCommitment) public view returns (bool) {
        return _rejectionCount[identityCommitment] > 0;
    }

    function rejectionReason(uint256 identityCommitment, uint256 partyIndex) external view returns (uint16) {
        return _reasonBy[identityCommitment][partyIndex];
    }

    /// @inheritdoc IExternalPartyRegistry
    /// @dev Veto-only. Reverts if any MUST_ATTEST party is active (pass their ids).
    function assertCastAllowed(uint256 identityCommitment) external view {
        if (identityCommitment == 0) revert ZeroCommitment();
        if (_rejectionCount[identityCommitment] > 0) revert VoteRejectedByExternalParty();
        if (mustAttestActiveCount != 0) revert MissingAttestation();
    }

    /// @inheritdoc IExternalPartyRegistry
    function assertCastAllowed(uint256 identityCommitment, uint256[] calldata mustAttestIds) external view {
        if (identityCommitment == 0) revert ZeroCommitment();
        if (_rejectionCount[identityCommitment] > 0) revert VoteRejectedByExternalParty();
        uint256 required = mustAttestActiveCount;
        if (required == 0) {
            if (mustAttestIds.length != 0) revert UnexpectedAttestationIds();
            return;
        }
        if (mustAttestIds.length != required) revert MissingAttestation();
        uint256 len = mustAttestIds.length;
        for (uint256 i; i < len;) {
            uint256 id = mustAttestIds[i];
            for (uint256 j; j < i;) {
                if (mustAttestIds[j] == id) revert DuplicateAttestationId();
                unchecked {
                    ++j;
                }
            }
            if (id >= partyCount) revert UnknownParty();
            Party storage party = _parties[id];
            if (!party.active || party.mode != MODE_MUST_ATTEST) revert UnknownParty();
            uint64 exp = _attestationExpires[identityCommitment][id];
            if (exp == 0) revert MissingAttestation();
            if (exp != type(uint64).max && exp < block.timestamp) revert ExpiredAttestation();
            unchecked {
                ++i;
            }
        }
    }

    function _party(uint256 partyIndex) internal view returns (Party storage party) {
        if (partyIndex >= partyCount) revert UnknownParty();
        party = _parties[partyIndex];
    }

    function _requireOperator(uint256 partyIndex) internal view returns (Party storage party) {
        party = _party(partyIndex);
        if (msg.sender != party.operator) revert NotPartyOperator();
    }

    function _requireActiveOperator(uint256 partyIndex) internal view returns (Party storage party) {
        party = _requireOperator(partyIndex);
        if (!party.active) revert PartyNotActive();
    }
}
