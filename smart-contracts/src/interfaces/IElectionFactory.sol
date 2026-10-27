// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "./ElectionParams.sol";

interface IElectionFactory {
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
    error MockVerifierNotAllowed();
    error ModulesAlreadySet();
    error VerifierNotApproved();
    error CannotGrantSuperAdmin();
    error NotPendingAdmin();
    error AlreadyPaused();
    error NotPaused();

    event ElectionCreated(
        uint256 indexed electionId,
        address indexed election,
        bytes32 indexed jurisdictionId,
        uint64 startTime,
        uint64 cutoffTime
    );
    event PartyRegistryCreated(uint256 indexed electionId, address indexed registry);
    event AdminApproved(address indexed account);
    event AdminRevoked(address indexed account);
    event ElectionStaffApproved(uint256 indexed electionId, address indexed account);
    event ElectionStaffRevoked(uint256 indexed electionId, address indexed account);
    event AllowMockVerifiersSet(bool allowed);
    event RelayerSet(address indexed account, bool allowed);
    event DisclosureIntervalSet(uint64 interval);
    /// @notice Audit M-03 / L-02: module wiring and admin changes are logged.
    event ModulesSet(address voterRegistry, address disqualificationRegistry, address ballotInbox, address tally);
    event ImplementationSet(address implementation);
    event PartyRegistryImplementationSet(address implementation);
    event JurisdictionRegistrySet(address jurisdictionRegistry);
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event VerifierApprovalSet(address indexed verifier, bool approved);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event ContractPaused(address indexed guardian, uint64 pausedAt);
    event ContractUnpaused(address indexed guardian);

    function createElection(ElectionParams calldata params) external returns (uint256 electionId, address election);

    function getElection(uint256 electionId) external view returns (address);

    function getPartyRegistry(uint256 electionId) external view returns (address);

    function electionCount() external view returns (uint256);

    function implementation() external view returns (address);

    function isSuperAdmin(address account) external view returns (bool);

    function isPlatformAdmin(address account) external view returns (bool);

    function isElectionStaff(uint256 electionId, address account) external view returns (bool);

    function admin() external view returns (address);

    function partyRegistryImplementation() external view returns (address);

    function voterRegistry() external view returns (address);

    function disqualificationRegistry() external view returns (address);

    function ballotInbox() external view returns (address);

    function tallyVerifier() external view returns (address);

    function jurisdictionRegistry() external view returns (address);

    function pendingAdmin() external view returns (address);

    function approvedVerifier(address verifier) external view returns (bool);

    function allowMockVerifiers() external view returns (bool);

    function isRelayer(address account) external view returns (bool);

    function disclosureInterval() external view returns (uint64);

    /// @notice A single pause cannot last longer than this, even if the admin key is lost.
    function MAX_PAUSE_DURATION() external view returns (uint64);

    function pausedAt() external view returns (uint64);

    function isPaused() external view returns (bool);

    function roles(bytes32 role, address account) external view returns (bool);

    function setAllowMockVerifiers(bool allowed) external;

    function setRelayer(address account, bool allowed) external;

    function setDisclosureInterval(uint64 interval) external;

    function pause() external;

    function unpause() external;

    function setVerifierApproved(address verifier, bool approved) external;

    function setImplementation(address implementation_) external;

    function setPartyRegistryImplementation(address implementation_) external;

    function setModules(address voterRegistry_, address disqualificationRegistry_, address inbox_, address tally_)
        external;

    function wireModules(address voterRegistry_, address disqualificationRegistry_, address inbox_, address tally_)
        external;

    function setJurisdictionRegistry(address jurisdictionRegistry_) external;

    function grantRole(bytes32 role, address account) external;

    function revokeRole(bytes32 role, address account) external;

    function transferAdmin(address newAdmin) external;

    function acceptAdmin() external;

    function hasRole(bytes32 role, address account) external view returns (bool);

    function approveAdmin(address account) external;

    function revokeAdmin(address account) external;

    function approveElectionStaff(uint256 electionId, address account) external;

    function revokeElectionStaff(uint256 electionId, address account) external;
}
