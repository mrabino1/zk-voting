// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @dev Minimal views the deployer reads while wiring and checking. The real
///      contracts are unchanged; these match their public getters.
interface IDeployedFactory {
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function allowMockVerifiers() external view returns (bool);
    function setAllowMockVerifiers(bool allowed) external;
    function setJurisdictionRegistry(address registry) external;
    function setVerifierApproved(address verifier, bool approved) external;
    function setModules(address voterRegistry, address disqualificationRegistry, address inbox, address tally) external;
    function setRelayer(address account, bool allowed) external;
    function setDisclosureInterval(uint64 interval) external;
    function transferAdmin(address newAdmin) external;
}

interface IDeployedTally {
    function setTallyProofVerifier(address verifier) external;
}

interface IAdminView {
    function admin() external view returns (address);
}

interface IDeployedSettlement {
    function admin() external view returns (address);
    function mockMode() external view returns (bool);
    function batchVerifier() external view returns (address);
}

interface IDeployedMirror {
    function admin() external view returns (address);
    function related() external view returns (address);
}

interface IReportsMock {
    function isMock() external view returns (bool);
}

/// @title ZkVotingDeployer
/// @notice Deterministic, staged deployer for the zk-voting contracts.
/// @dev Design: creation code arrives as calldata and is deployed with CREATE2
///      under `keccak256(namespace, label)`. The deployer embeds no module
///      bytecode, so it stays far below EIP-170 however large the modules grow,
///      and every address is predictable before broadcast with `predict`.
///
///      Only `launcher` may call it, and only until it is sealed. Sealing is
///      one-way: after it, every state-changing function reverts, so neither
///      the launcher EOA nor this contract can act again.
///
///      Privilege model:
///      - Contracts whose admin cannot be transferred (RollupSettlement,
///        L1TallyMirror, ZkVotingMailbox, JurisdictionRegistry,
///        ZkVotingPaymaster) must be constructed with the final `admin`. The
///        checks below verify that, so this contract never holds them.
///      - ElectionFactory has a two-step admin handover. It is constructed with
///        this contract as admin, wired here in one transaction, then handed to
///        `admin` with `transferAdmin`. `admin` completes it with `acceptAdmin`,
///        which clears every bootstrap role this contract held.
///      - Chain id 1 never accepts mock mode: a mock vote or tally verifier,
///        `allowMockVerifiers`, a mock-mode settlement, or a settlement without
///        a batch verifier contract all revert.
contract ZkVotingDeployer {
    uint256 internal constant MAINNET = 1;

    bytes32 public constant SETTLEMENT = "RollupSettlement";
    bytes32 public constant MAILBOX = "ZkVotingMailbox";
    bytes32 public constant TALLY_MIRROR = "L1TallyMirror";

    address public immutable launcher;
    address public immutable admin;
    bytes32 public immutable namespace;
    bool public sealed_;

    /// @dev label => deployed address (zero until deployed).
    mapping(bytes32 => address) public deployed;

    struct ElectionWiring {
        address factory;
        address jurisdictions;
        address verifier;
        address voterRegistry;
        address disqualificationRegistry;
        address inbox;
        address tally;
        address tallyVerifier;
        address paymaster;
        address relayer;
        uint64 disclosureInterval;
        bool allowMockVerifiers;
    }

    event Deployed(bytes32 indexed label, address indexed addr, bytes32 initCodeHash);
    event ElectionStackWired(address indexed factory, address indexed admin);
    event SettlementChecked(address indexed settlement, address indexed mirror, address indexed mailbox);
    event Sealed(address indexed admin);

    error NotLauncher();
    error AlreadySealed();
    error ZeroAddress();
    error LengthMismatch();
    error AlreadyDeployed(bytes32 label);
    error CreateFailed(bytes32 label);
    error WrongAdmin(address target, address actual);
    error MockNotAllowedOnMainnet();
    error MissingBatchVerifier();
    error MirrorMailboxMismatch();
    error HandoffIncomplete();

    constructor(address launcher_, address admin_, bytes32 namespace_) {
        if (launcher_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        launcher = launcher_;
        admin = admin_;
        namespace = namespace_;
    }

    modifier onlyLauncher() {
        if (sealed_) revert AlreadySealed();
        if (msg.sender != launcher) revert NotLauncher();
        _;
    }

    // --- prediction ---------------------------------------------------------

    function saltFor(bytes32 label) public view returns (bytes32) {
        return keccak256(abi.encode(namespace, label));
    }

    function predict(bytes32 label, bytes32 initCodeHash) public view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), saltFor(label), initCodeHash))))
        );
    }

    function predictCode(bytes32 label, bytes calldata initCode) external view returns (address) {
        return predict(label, keccak256(initCode));
    }

    // --- stages -------------------------------------------------------------

    /// @notice Deploy one stage: each `initCodes[i]` (creation code plus ABI
    ///         constructor args) under `labels[i]`.
    function deploy(bytes32[] calldata labels, bytes[] calldata initCodes)
        external
        onlyLauncher
        returns (address[] memory addrs)
    {
        if (labels.length != initCodes.length) revert LengthMismatch();
        addrs = new address[](labels.length);
        for (uint256 i = 0; i < labels.length; i++) {
            addrs[i] = _create2(labels[i], initCodes[i]);
        }
    }

    /// @notice L1 settlement set in one transaction: deploy, then check admin,
    ///         wiring and the mainnet rules. Any failure reverts every deploy.
    function deploySettlement(bytes calldata settlementCode, bytes calldata mailboxCode, bytes calldata mirrorCode)
        external
        onlyLauncher
        returns (address settlement, address mailbox, address mirror)
    {
        settlement = _create2(SETTLEMENT, settlementCode);
        mailbox = _create2(MAILBOX, mailboxCode);
        mirror = _create2(TALLY_MIRROR, mirrorCode);
        _checkSettlement(settlement, mailbox, mirror);
    }

    /// @notice Wire the election stack atomically and start the factory
    ///         handover to `admin`. Seals the deployer when `sealAfter`.
    function wireElectionStack(ElectionWiring calldata w, bool sealAfter) external onlyLauncher {
        if (
            w.factory == address(0) || w.jurisdictions == address(0) || w.verifier == address(0)
                || w.voterRegistry == address(0) || w.disqualificationRegistry == address(0) || w.inbox == address(0)
                || w.tally == address(0)
        ) revert ZeroAddress();
        IDeployedFactory f = IDeployedFactory(w.factory);
        if (f.admin() != address(this)) revert WrongAdmin(w.factory, f.admin());
        _requireAdmin(w.jurisdictions);
        if (w.paymaster != address(0)) _requireAdmin(w.paymaster);
        if (block.chainid == MAINNET) {
            if (w.allowMockVerifiers || _reportsMock(w.verifier) || _reportsMock(w.tallyVerifier)) {
                revert MockNotAllowedOnMainnet();
            }
        }

        if (w.allowMockVerifiers) f.setAllowMockVerifiers(true);
        f.setJurisdictionRegistry(w.jurisdictions);
        // Audit M-02: non-admin clerks may only use admin-approved verifiers.
        f.setVerifierApproved(w.verifier, true);
        if (w.tallyVerifier != address(0)) IDeployedTally(w.tally).setTallyProofVerifier(w.tallyVerifier);
        f.setModules(w.voterRegistry, w.disqualificationRegistry, w.inbox, w.tally);
        if (w.relayer != address(0)) f.setRelayer(w.relayer, true);
        if (w.disclosureInterval != 0) f.setDisclosureInterval(w.disclosureInterval);
        f.transferAdmin(admin);
        if (f.pendingAdmin() != admin) revert HandoffIncomplete();
        emit ElectionStackWired(w.factory, admin);
        if (sealAfter) _seal();
    }

    /// @notice One-way: nothing on this contract can be called afterwards.
    function seal() external onlyLauncher {
        _seal();
    }

    // --- internals ----------------------------------------------------------

    function _create2(bytes32 label, bytes calldata initCode) internal returns (address addr) {
        if (deployed[label] != address(0)) revert AlreadyDeployed(label);
        bytes32 salt = saltFor(label);
        bytes memory code = initCode;
        assembly ("memory-safe") {
            addr := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (addr == address(0)) revert CreateFailed(label);
        deployed[label] = addr;
        emit Deployed(label, addr, keccak256(initCode));
    }

    function _checkSettlement(address settlement, address mailbox, address mirror) internal {
        IDeployedSettlement s = IDeployedSettlement(settlement);
        if (s.admin() != admin) revert WrongAdmin(settlement, s.admin());
        _requireAdmin(mailbox);
        _requireAdmin(mirror);
        if (IDeployedMirror(mirror).related() != mailbox) revert MirrorMailboxMismatch();
        if (block.chainid == MAINNET) {
            if (s.mockMode()) revert MockNotAllowedOnMainnet();
            address bv = s.batchVerifier();
            if (bv == address(0) || bv.code.length == 0) revert MissingBatchVerifier();
            if (_reportsMock(bv)) revert MockNotAllowedOnMainnet();
        }
        emit SettlementChecked(settlement, mirror, mailbox);
    }

    function _requireAdmin(address target) internal view {
        address a = IAdminView(target).admin();
        if (a != admin) revert WrongAdmin(target, a);
    }

    function _reportsMock(address v) internal view returns (bool) {
        if (v == address(0) || v.code.length == 0) return false;
        try IReportsMock(v).isMock() returns (bool m) {
            return m;
        } catch {
            return false;
        }
    }

    function _seal() internal {
        sealed_ = true;
        emit Sealed(admin);
    }
}
