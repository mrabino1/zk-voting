// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Clones} from "./Clones.sol";
import {Election} from "./Election.sol";
import {ExternalPartyRegistry} from "./ExternalPartyRegistry.sol";
import {ElectionParams} from "./interfaces/ElectionParams.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {IJurisdictionRegistry} from "./interfaces/IJurisdictionRegistry.sol";
import {Roles} from "./Roles.sol";

/// @title ElectionFactory
/// @notice Unbounded EIP-1167 factory for civic elections. Each election also
///         clones an ExternalPartyRegistry (unlimited external vote gates).
///         No token. No fee.
contract ElectionFactory is IElectionFactory {
    error ZeroAddress();
    error NotAdmin();
    error NotSuperAdmin();
    error CannotRevokeSuper();
    error InvalidWindow();
    error InvalidTreeDepth();
    error InvalidQuestionCount();
    error MissingRole();
    error ModulesNotSet();
    error InvalidTallyScheme();
    error InvalidJurisdiction();
    error NotJurisdictionClerk();
    error UnknownElection();

    uint8 internal constant MIN_DEPTH = 16;
    uint8 internal constant MAX_DEPTH = 32;

    address public admin;
    address public implementation;
    address public partyRegistryImplementation;
    address public voterRegistry;
    address public disqualificationRegistry;
    address public ballotInbox;
    address public tallyVerifier;
    address public jurisdictionRegistry;

    uint256 public electionCount;
    mapping(uint256 => address) private _elections;
    mapping(uint256 => address) private _partyRegistries;
    mapping(uint256 => mapping(address => bool)) private _electionStaff;
    mapping(bytes32 => mapping(address => bool)) public roles;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlySuperAdmin() {
        if (!_isSuperAdmin(msg.sender)) revert NotSuperAdmin();
        _;
    }

    constructor(address admin_, address implementation_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        if (implementation_ == address(0)) {
            implementation = address(new Election());
        } else {
            implementation = implementation_;
        }
        partyRegistryImplementation = address(new ExternalPartyRegistry());
        roles[Roles.PLATFORM_SUPER_ADMIN_ROLE][admin_] = true;
        roles[Roles.PLATFORM_ADMIN_ROLE][admin_] = true;
        roles[Roles.ADMIN_ROLE][admin_] = true;
    }

    function setImplementation(address implementation_) external onlyAdmin {
        if (implementation_ == address(0)) revert ZeroAddress();
        implementation = implementation_;
    }

    function setPartyRegistryImplementation(address implementation_) external onlySuperAdmin {
        if (implementation_ == address(0)) revert ZeroAddress();
        partyRegistryImplementation = implementation_;
    }

    function setModules(address voterRegistry_, address disqualificationRegistry_, address inbox_, address tally_)
        external
        onlyAdmin
    {
        voterRegistry = voterRegistry_;
        disqualificationRegistry = disqualificationRegistry_;
        ballotInbox = inbox_;
        tallyVerifier = tally_;
    }

    function wireModules(address voterRegistry_, address disqualificationRegistry_, address inbox_, address tally_)
        external
        onlyAdmin
    {
        voterRegistry = voterRegistry_;
        disqualificationRegistry = disqualificationRegistry_;
        ballotInbox = inbox_;
        tallyVerifier = tally_;
    }

    /// @notice Bind clerks to `JurisdictionRegistry` so one body cannot mint
    ///         an election that claims another body's `jurisdictionId`.
    function setJurisdictionRegistry(address jurisdictionRegistry_) external onlyAdmin {
        jurisdictionRegistry = jurisdictionRegistry_;
    }

    function grantRole(bytes32 role, address account) external onlyAdmin {
        roles[role][account] = true;
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return roles[role][account];
    }

    /// @notice Super admin approves a platform admin.
    function approveAdmin(address account) external onlySuperAdmin {
        if (account == address(0)) revert ZeroAddress();
        roles[Roles.ADMIN_ROLE][account] = true;
        roles[Roles.PLATFORM_ADMIN_ROLE][account] = true;
        emit AdminApproved(account);
    }

    /// @notice Super admin revokes a platform admin. Cannot revoke the bootstrap super.
    function revokeAdmin(address account) external onlySuperAdmin {
        if (account == address(0)) revert ZeroAddress();
        if (account == admin) revert CannotRevokeSuper();
        roles[Roles.ADMIN_ROLE][account] = false;
        roles[Roles.PLATFORM_ADMIN_ROLE][account] = false;
        emit AdminRevoked(account);
    }

    /// @notice Platform admin (or super) approves election staff for one election.
    function approveElectionStaff(uint256 electionId, address account) external {
        if (!_isAdmin(msg.sender)) revert NotAdmin();
        if (account == address(0)) revert ZeroAddress();
        if (_elections[electionId] == address(0)) revert UnknownElection();
        _electionStaff[electionId][account] = true;
        emit ElectionStaffApproved(electionId, account);
    }

    function revokeElectionStaff(uint256 electionId, address account) external {
        if (!_isAdmin(msg.sender)) revert NotAdmin();
        if (_elections[electionId] == address(0)) revert UnknownElection();
        _electionStaff[electionId][account] = false;
        emit ElectionStaffRevoked(electionId, account);
    }

    /// @inheritdoc IElectionFactory
    function isSuperAdmin(address account) external view returns (bool) {
        return _isSuperAdmin(account);
    }

    /// @inheritdoc IElectionFactory
    function isPlatformAdmin(address account) external view returns (bool) {
        return _isAdmin(account);
    }

    /// @inheritdoc IElectionFactory
    function isElectionStaff(uint256 electionId, address account) external view returns (bool) {
        return _isElectionStaff(electionId, account);
    }

    /// @inheritdoc IElectionFactory
    function createElection(ElectionParams calldata params) external returns (uint256 electionId, address election) {
        _validate(params);
        if (!_canCreate(params)) {
            if (jurisdictionRegistry != address(0)) revert NotJurisdictionClerk();
            revert MissingRole();
        }

        electionId = ++electionCount;
        election = Clones.clone(implementation);
        _elections[electionId] = election;

        IElection(election).initialize(
            electionId, params, address(this), voterRegistry, disqualificationRegistry, ballotInbox
        );

        address parties = Clones.clone(partyRegistryImplementation);
        ExternalPartyRegistry(parties).initialize(electionId, address(this));
        _partyRegistries[electionId] = parties;
        // The creating clerk is election staff for this clone (they set up parties).
        _electionStaff[electionId][params.clerk] = true;
        emit ElectionStaffApproved(electionId, params.clerk);
        emit PartyRegistryCreated(electionId, parties);
        emit ElectionCreated(electionId, election, params.jurisdictionId, params.startTime, params.cutoffTime);
    }

    /// @inheritdoc IElectionFactory
    function getElection(uint256 electionId) external view returns (address) {
        return _elections[electionId];
    }

    /// @inheritdoc IElectionFactory
    function getPartyRegistry(uint256 electionId) external view returns (address) {
        return _partyRegistries[electionId];
    }

    function _validate(ElectionParams calldata params) internal pure {
        if (params.startTime >= params.cutoffTime) revert InvalidWindow();
        if (params.treeDepth < MIN_DEPTH || params.treeDepth > MAX_DEPTH) revert InvalidTreeDepth();
        if (params.questionCount < 1) revert InvalidQuestionCount();
        if (params.tallyScheme > 1) revert InvalidTallyScheme();
        if (params.jurisdictionId == bytes32(0)) revert InvalidJurisdiction();
        if (
            params.clerk == address(0) || params.registrar == address(0)
                || params.disqualificationOfficer == address(0) || params.tallyOperator == address(0)
                || params.verifier == address(0)
        ) revert ZeroAddress();
    }

    /// @dev When `jurisdictionRegistry` is set, a clerk of A cannot create for B
    ///      by putting themselves in `params.clerk`. Platform admin may bootstrap.
    function _canCreate(ElectionParams calldata params) internal view returns (bool) {
        if (_isAdmin(msg.sender)) return true;
        if (jurisdictionRegistry != address(0)) {
            IJurisdictionRegistry registry = IJurisdictionRegistry(jurisdictionRegistry);
            if (!registry.isClerk(params.jurisdictionId, msg.sender)) return false;
            if (!registry.isClerk(params.jurisdictionId, params.clerk)) return false;
            return true;
        }
        if (msg.sender == params.clerk) return true;
        if (roles[Roles.CLERK_ROLE][msg.sender]) return true;
        return false;
    }

    function _isSuperAdmin(address account) internal view returns (bool) {
        return account == admin || roles[Roles.PLATFORM_SUPER_ADMIN_ROLE][account];
    }

    function _isAdmin(address account) internal view returns (bool) {
        if (_isSuperAdmin(account)) return true;
        if (roles[Roles.PLATFORM_ADMIN_ROLE][account]) return true;
        if (roles[Roles.ADMIN_ROLE][account]) return true;
        return false;
    }

    function _isElectionStaff(uint256 electionId, address account) internal view returns (bool) {
        if (account == address(0)) return false;
        if (_isAdmin(account)) return true;
        if (_electionStaff[electionId][account]) return true;
        if (roles[Roles.ELECTION_STAFF_ROLE][account]) return true;
        address el = _elections[electionId];
        if (el == address(0)) return false;
        if (IElection(el).params().clerk == account) return true;
        return false;
    }
}
