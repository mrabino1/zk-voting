// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

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
    uint8 internal constant MIN_DEPTH = 16;
    uint8 internal constant MAX_DEPTH = 32;

    /// @notice One pause cannot outlive this. Voting resumes if the admin key is lost.
    uint64 public constant MAX_PAUSE_DURATION = 72 hours;

    address public admin;
    address public implementation;
    address public partyRegistryImplementation;
    address public voterRegistry;
    address public disqualificationRegistry;
    address public ballotInbox;
    address public tallyVerifier;
    address public jurisdictionRegistry;
    /// @notice Two-step admin handover (audit M-03).
    address public pendingAdmin;

    /// @notice Audit M-02: vote verifiers a non-admin creator may use.
    ///         Platform admins may still pick any verifier (they already
    ///         control module wiring); clerks are limited to this list.
    mapping(address => bool) public approvedVerifier;

    /// @notice Audit H-02: elections whose verifier reports `isMock() == true`
    ///         are refused unless this is set. Defaults to true only on anvil
    ///         (chain id 31337); elsewhere a super admin must opt in explicitly.
    bool public allowMockVerifiers;

    /// @notice Shared relayers allowed to submit ballots. A voter account is not a relayer.
    mapping(address => bool) public isRelayer;

    /// @notice Seconds between ballot batches. Zero keeps single `submitVote` (tests).
    ///         Non-zero forces `submitVoteBatch` so one transaction does not timestamp one voter.
    uint64 public disclosureInterval;

    uint256 public electionCount;
    mapping(uint256 => address) private _elections;
    mapping(uint256 => address) private _partyRegistries;
    mapping(uint256 => mapping(address => bool)) private _electionStaff;
    mapping(bytes32 => mapping(address => bool)) public roles;

    /// @notice Start of the current emergency pause. Zero means not paused.
    ///         Appended so earlier slots are unchanged. Expires after `MAX_PAUSE_DURATION`.
    uint64 public pausedAt;

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
        allowMockVerifiers = block.chainid == 31337;
    }

    /// @notice Dev / test only: allow mock verifiers on this chain.
    function setAllowMockVerifiers(bool allowed) external onlySuperAdmin {
        allowMockVerifiers = allowed;
        emit AllowMockVerifiersSet(allowed);
    }

    /// @notice Allow or remove a shared ballot relayer. Admin only.
    function setRelayer(address account, bool allowed) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        isRelayer[account] = allowed;
        emit RelayerSet(account, allowed);
    }

    /// @notice Minimum spacing for `submitVoteBatch`. Zero disables the batch-only rule.
    function setDisclosureInterval(uint64 interval) external onlyAdmin {
        disclosureInterval = interval;
        emit DisclosureIntervalSet(interval);
    }

    /// @notice Stop ballot and tally submission. Reads stay open. The pause
    ///         expires on its own so a lost admin key cannot freeze an election.
    function pause() external onlyAdmin {
        if (isPaused()) revert AlreadyPaused();
        pausedAt = uint64(block.timestamp);
        emit ContractPaused(msg.sender, pausedAt);
    }

    /// @notice End a pause before it expires.
    function unpause() external onlyAdmin {
        if (!isPaused()) revert NotPaused();
        pausedAt = 0;
        emit ContractUnpaused(msg.sender);
    }

    /// @notice True only inside the current pause window.
    function isPaused() public view returns (bool) {
        uint64 at = pausedAt;
        if (at == 0) return false;
        return block.timestamp < uint256(at) + MAX_PAUSE_DURATION;
    }

    /// @notice Audit H-02 / M-02: approve or withdraw a vote verifier for
    ///         elections created by non-admin clerks.
    function setVerifierApproved(address verifier, bool approved) external onlySuperAdmin {
        if (verifier == address(0)) revert ZeroAddress();
        approvedVerifier[verifier] = approved;
        emit VerifierApprovalSet(verifier, approved);
    }

    function setImplementation(address implementation_) external onlyAdmin {
        if (implementation_ == address(0)) revert ZeroAddress();
        implementation = implementation_;
        emit ImplementationSet(implementation_);
    }

    function setPartyRegistryImplementation(address implementation_) external onlySuperAdmin {
        if (implementation_ == address(0)) revert ZeroAddress();
        partyRegistryImplementation = implementation_;
        emit PartyRegistryImplementationSet(implementation_);
    }

    /// @notice Wire the shared modules. Audit M-03: set once, non-zero, logged.
    ///         Existing elections read these addresses dynamically, so a later
    ///         swap could replace the inbox or tally under a live election.
    function setModules(address voterRegistry_, address disqualificationRegistry_, address inbox_, address tally_)
        external
        onlyAdmin
    {
        _setModules(voterRegistry_, disqualificationRegistry_, inbox_, tally_);
    }

    /// @notice Alias of `setModules` kept for deploy scripts.
    function wireModules(address voterRegistry_, address disqualificationRegistry_, address inbox_, address tally_)
        external
        onlyAdmin
    {
        _setModules(voterRegistry_, disqualificationRegistry_, inbox_, tally_);
    }

    function _setModules(address voterRegistry_, address disqualificationRegistry_, address inbox_, address tally_)
        internal
    {
        if (
            voterRegistry != address(0) || disqualificationRegistry != address(0) || ballotInbox != address(0)
                || tallyVerifier != address(0)
        ) revert ModulesAlreadySet();
        if (
            voterRegistry_ == address(0) || disqualificationRegistry_ == address(0) || inbox_ == address(0)
                || tally_ == address(0)
        ) revert ZeroAddress();
        voterRegistry = voterRegistry_;
        disqualificationRegistry = disqualificationRegistry_;
        ballotInbox = inbox_;
        tallyVerifier = tally_;
        emit ModulesSet(voterRegistry_, disqualificationRegistry_, inbox_, tally_);
    }

    /// @notice Bind clerks to `JurisdictionRegistry` so one body cannot mint
    ///         an election that claims another body's `jurisdictionId`.
    function setJurisdictionRegistry(address jurisdictionRegistry_) external onlyAdmin {
        if (jurisdictionRegistry_ == address(0)) revert ZeroAddress();
        jurisdictionRegistry = jurisdictionRegistry_;
        emit JurisdictionRegistrySet(jurisdictionRegistry_);
    }

    /// @notice Audit M-03: super admin cannot be minted through `grantRole`
    ///         (use the two-step admin transfer); every grant is logged.
    function grantRole(bytes32 role, address account) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        if (role == Roles.PLATFORM_SUPER_ADMIN_ROLE) revert CannotGrantSuperAdmin();
        roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    /// @notice Audit M-03: roles granted via `grantRole` can be revoked.
    function revokeRole(bytes32 role, address account) external onlyAdmin {
        if (account == admin && role == Roles.PLATFORM_SUPER_ADMIN_ROLE) revert CannotRevokeSuper();
        roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    /// @notice Audit M-03: step 1 of a two-step admin handover.
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    /// @notice Audit M-03: step 2; the pending admin takes over the bootstrap
    ///         super-admin seat and the previous admin's bootstrap roles end.
    function acceptAdmin() external {
        address next = pendingAdmin;
        if (msg.sender != next) revert NotPendingAdmin();
        address prev = admin;
        admin = next;
        pendingAdmin = address(0);
        roles[Roles.PLATFORM_SUPER_ADMIN_ROLE][prev] = false;
        roles[Roles.PLATFORM_ADMIN_ROLE][prev] = false;
        roles[Roles.ADMIN_ROLE][prev] = false;
        roles[Roles.PLATFORM_SUPER_ADMIN_ROLE][next] = true;
        roles[Roles.PLATFORM_ADMIN_ROLE][next] = true;
        roles[Roles.ADMIN_ROLE][next] = true;
        emit AdminTransferred(prev, next);
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
        // Audit M-03: revoking an admin also ends any super-admin seat.
        roles[Roles.PLATFORM_SUPER_ADMIN_ROLE][account] = false;
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
        if (!allowMockVerifiers && _reportsMock(params.verifier)) revert MockVerifierNotAllowed();
        if (!_canCreate(params)) {
            if (jurisdictionRegistry != address(0)) revert NotJurisdictionClerk();
            revert MissingRole();
        }
        if (!_isAdmin(msg.sender) && !approvedVerifier[params.verifier]) revert VerifierNotApproved();

        electionId = ++electionCount;
        election = Clones.clone(implementation);
        _elections[electionId] = election;

        IElection(election)
            .initialize(electionId, params, address(this), voterRegistry, disqualificationRegistry, ballotInbox);

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
            params.clerk == address(0) || params.registrar == address(0) || params.disqualificationOfficer == address(0)
                || params.tallyOperator == address(0) || params.verifier == address(0)
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
        // Audit M-02: without a jurisdiction registry, creation is no longer
        // self-service (`msg.sender == params.clerk`); an admin-granted
        // CLERK_ROLE is required, and the caller must be the named clerk.
        if (roles[Roles.CLERK_ROLE][msg.sender] && msg.sender == params.clerk) return true;
        return false;
    }

    function _reportsMock(address verifier) internal view returns (bool) {
        (bool ok, bytes memory ret) = verifier.staticcall(abi.encodeWithSignature("isMock()"));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
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
