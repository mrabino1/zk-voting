// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {console2} from "forge-std/Script.sol";
import {ZkVotingStackScript} from "./DeployLocal.s.sol";
import {ZkVotingDeployer} from "../src/deploy/ZkVotingDeployer.sol";
import {KeccakHasher} from "../src/hasher/KeccakHasher.sol";
import {StandInHasher} from "../src/hasher/StandInHasher.sol";
import {PoseidonHasher} from "../src/hasher/PoseidonHasher.sol";
import {MockVerifier} from "../src/zk/MockVerifier.sol";
import {VoteVerifier} from "../src/zk/VoteVerifier.sol";
import {Groth16VerifierAdapter} from "../src/zk/Groth16VerifierAdapter.sol";
import {ElectionFactory} from "../src/ElectionFactory.sol";
import {VoterRegistry} from "../src/VoterRegistry.sol";
import {DisqualificationRegistry} from "../src/DisqualificationRegistry.sol";
import {BallotInbox} from "../src/BallotInbox.sol";
import {Tally} from "../src/Tally.sol";
import {ZkVotingEntryPoint} from "../src/account/ZkVotingEntryPoint.sol";
import {PasskeyAccountFactory} from "../src/account/PasskeyAccountFactory.sol";
import {ZkVotingPaymaster} from "../src/account/ZkVotingPaymaster.sol";
import {RollupSettlement} from "../src/l2/RollupSettlement.sol";
import {L1TallyMirror} from "../src/l2/L1TallyMirror.sol";
import {ZkVotingMailbox} from "../src/l2/ZkVotingMailbox.sol";
import {JurisdictionRegistry} from "../src/JurisdictionRegistry.sol";

/// @notice Deploy through `ZkVotingDeployer` (CREATE2, staged, role handoff).
///
///   ZK_VOTING_DEPLOY_TARGET   local | l2 | l1                (default local)
///   ADMIN                     final admin of every module     (default: the broadcaster)
///   DEPLOY_SALT_NAMESPACE     CREATE2 namespace string        (default zk-voting.deployer.v1)
///   SEQUENCER, PROVER         settlement operators            (default ADMIN)
///   BATCH_VERIFIER            settlement batch verifier       (required on l1; a contract on chain 1)
///   L2_FACTORY                pinned in the tally mirror      (optional on l1; else pin it later)
///   ZK_VOTING_CODE_SIZE_LIMIT runtime size cap of the chain   (default 24576, EIP-170)
///   ZK_VOTING_MAINNET_CONFIRMED=1  set by deploy.sh --yes; required to broadcast on chain 1
///   ZK_VOTING_DRY_RUN=1            set by deploy.sh --dry-run; preview only
///
/// Chain id 1 never accepts a mock verifier, ZK_VOTING_SETTLEMENT_MOCK_MODE, or
/// ZK_VOTING_ALLOW_MOCK_VERIFIER. Every predicted address is printed as
/// `preview NAME 0x...` before anything is broadcast.
contract DeployViaDeployer is ZkVotingStackScript {
    uint256 internal constant MAINNET = 1;
    uint256 internal constant EIP170 = 24_576;

    error UnknownTarget(string target);
    error MainnetNotConfirmed();
    error MockOnMainnet();
    error MissingBatchVerifier();
    error DeployerAlreadyLive(address deployer);
    error CodeTooLarge(string name, uint256 size, uint256 limit);
    error LocalOnly(uint256 chainId);

    struct Ctx {
        string target;
        address eoa;
        address admin;
        bytes32 ns;
        ZkVotingDeployer d;
        bool dryRun;
    }

    struct L2Out {
        address hasher;
        address verifier;
        bool mock;
        string scheme;
        address factory;
        address jurisdictions;
        address voterRegistry;
        address disqualificationRegistry;
        address inbox;
        address tally;
        address tallyVerifier;
        address entryPoint;
        address accountFactory;
        address paymaster;
    }

    struct L1Out {
        address settlement;
        address mailbox;
        address mirror;
        address batchVerifier;
        bool mockMode;
    }

    function run() external {
        Ctx memory c;
        c.target = vm.envOr("ZK_VOTING_DEPLOY_TARGET", string("local"));
        bytes32 t = keccak256(bytes(c.target));
        bool isLocal = t == keccak256("local");
        bool isL2 = t == keccak256("l2");
        bool isL1 = t == keccak256("l1");
        if (!isLocal && !isL2 && !isL1) revert UnknownTarget(c.target);
        if (isLocal && block.chainid != ANVIL_CHAIN_ID && !_envTruthy("ZK_VOTING_ALLOW_PUBLIC_DEPLOY")) {
            revert LocalOnly(block.chainid);
        }
        c.dryRun = _envTruthy("ZK_VOTING_DRY_RUN");
        _mainnetPreflight(isL1 || isLocal, isL2 || isLocal, c.dryRun);
        _refuseIfAlreadyDeployed();

        vm.startBroadcast();
        c.eoa = msg.sender;
        c.admin = vm.envOr("ADMIN", c.eoa);
        c.ns = keccak256(bytes(vm.envOr("DEPLOY_SALT_NAMESPACE", string("zk-voting.deployer.v1"))));
        c.d = _deployDeployer(c);

        L1Out memory l1;
        L2Out memory l2;
        if (isL2 || isLocal) l2 = _deployL2(c);
        if (isL1 || isLocal) l1 = _deployL1(c);
        if (isL2 || isLocal) {
            c.d.wireElectionStack(_wiring(l2), true);
        } else {
            c.d.seal();
        }
        _adminFollowUps(c, l1, l2, isLocal, isL1);
        vm.stopBroadcast();

        _log("ZK_VOTING_DEPLOYER", address(c.d));
        _log("ADMIN", c.admin);
        if (isL2 || isLocal) _logL2(l2);
        if (isL1 || isLocal) _logL1(l1, isL1 ? _l2Factory() : l2.factory);
        _logStr("DEPLOY_VIA", "ZkVotingDeployer");
        _logStr("DEPLOY_SALT_NAMESPACE", vm.envOr("DEPLOY_SALT_NAMESPACE", string("zk-voting.deployer.v1")));
    }

    // --- preflight ----------------------------------------------------------

    function _mainnetPreflight(bool l1Set, bool l2Set, bool dryRun) internal view {
        if (block.chainid != MAINNET) return;
        if (!dryRun && !_envTruthy("ZK_VOTING_MAINNET_CONFIRMED")) revert MainnetNotConfirmed();
        if (
            _envTruthy("ZK_VOTING_SETTLEMENT_MOCK_MODE") || _envTruthy("ZK_VOTING_ALLOW_MOCK_VERIFIER")
                || (l2Set && _useMockVerifier())
        ) revert MockOnMainnet();
        if (l1Set) {
            address bv = vm.envOr("BATCH_VERIFIER", address(0));
            if (bv == address(0) || bv.code.length == 0) revert MissingBatchVerifier();
        }
    }

    function _checkSize(string memory name, bytes memory creation) internal view {
        // Runtime size is bounded by the creation size; check the compiled runtime.
        uint256 limit = vm.envOr("ZK_VOTING_CODE_SIZE_LIMIT", EIP170);
        bytes memory runtime = vm.getDeployedCode(string.concat(name, ".sol:", name));
        creation;
        if (runtime.length > limit) revert CodeTooLarge(name, runtime.length, limit);
    }

    // --- deployer -----------------------------------------------------------

    function _deployDeployer(Ctx memory c) internal returns (ZkVotingDeployer d) {
        bytes32 salt = keccak256(abi.encode(c.ns, c.eoa, c.admin));
        bytes memory init =
            abi.encodePacked(type(ZkVotingDeployer).creationCode, abi.encode(c.eoa, c.admin, c.ns));
        address predicted = vm.computeCreate2Address(salt, keccak256(init));
        console2.log(string.concat("preview DEPLOYER ", vm.toString(predicted)));
        if (predicted.code.length != 0) revert DeployerAlreadyLive(predicted);
        d = new ZkVotingDeployer{salt: salt}(c.eoa, c.admin, c.ns);
        require(address(d) == predicted, "deployer address mismatch");
    }

    function _stage(Ctx memory c, string memory stage, bytes32[] memory labels, bytes[] memory codes)
        internal
        returns (address[] memory addrs)
    {
        for (uint256 i = 0; i < labels.length; i++) {
            console2.log(
                string.concat(
                    "preview ", stage, " ", _label(labels[i]), " ", vm.toString(c.d.predict(labels[i], keccak256(codes[i])))
                )
            );
        }
        addrs = c.d.deploy(labels, codes);
        for (uint256 i = 0; i < labels.length; i++) {
            require(addrs[i] == c.d.predict(labels[i], keccak256(codes[i])), "predict mismatch");
        }
    }

    // --- L2 election + AA stack ---------------------------------------------

    function _deployL2(Ctx memory c) internal returns (L2Out memory o) {
        o.mock = _useMockVerifier();
        if (o.mock && !_mockVerifierAllowed()) revert MockVerifierNotAllowed(block.chainid);
        string memory schemeEnv = vm.envOr("ZK_VOTING_HASH_SCHEME", string(""));
        o.scheme = bytes(schemeEnv).length != 0
            ? schemeEnv
            : (o.mock ? "zk-voting.hash.keccak-dev-v1" : "zk-voting.hash.poseidon-bn254-x5-t3-v1");

        // Stage 1: hasher and vote verifier.
        bytes memory hasherCode = _schemeIsPoseidon(o.scheme)
            ? type(PoseidonHasher).creationCode
            : (_schemeIsStandIn(o.scheme) ? type(StandInHasher).creationCode : type(KeccakHasher).creationCode);
        if (o.mock) {
            // Dev only and never through the deployer: MockVerifier keeps its
            // deployer as owner, so the launcher EOA deploys it directly.
            MockVerifier mock = new MockVerifier();
            mock.setAccept(true);
            o.verifier = address(mock);
            bytes32[] memory l = new bytes32[](1);
            bytes[] memory k = new bytes[](1);
            l[0] = "Hasher";
            k[0] = hasherCode;
            o.hasher = _stage(c, "stage1", l, k)[0];
        } else {
            address exported = vm.envOr("ZK_VOTING_VOTE_VERIFIER", address(0));
            bytes memory vCode = exported != address(0)
                ? abi.encodePacked(type(Groth16VerifierAdapter).creationCode, abi.encode(exported, uint256(5)))
                : abi.encodePacked(type(VoteVerifier).creationCode, abi.encode(address(0)));
            bytes32[] memory l = new bytes32[](2);
            bytes[] memory k = new bytes[](2);
            (l[0], k[0]) = (bytes32("Hasher"), hasherCode);
            (l[1], k[1]) = (bytes32("VoteVerifier"), vCode);
            address[] memory a = _stage(c, "stage1", l, k);
            (o.hasher, o.verifier) = (a[0], a[1]);
        }

        // Stage 2: factory (deployer is the temporary admin) and jurisdictions (final admin).
        {
            _checkSize("ElectionFactory", type(ElectionFactory).creationCode);
            bytes32[] memory l = new bytes32[](2);
            bytes[] memory k = new bytes[](2);
            l[0] = "ElectionFactory";
            k[0] = abi.encodePacked(type(ElectionFactory).creationCode, abi.encode(address(c.d), address(0)));
            l[1] = "JurisdictionRegistry";
            k[1] = abi.encodePacked(type(JurisdictionRegistry).creationCode, abi.encode(c.admin));
            address[] memory a = _stage(c, "stage2", l, k);
            (o.factory, o.jurisdictions) = (a[0], a[1]);
        }

        // Stage 3: modules that take the factory.
        {
            _checkSize("BallotInbox", type(BallotInbox).creationCode);
            _checkSize("Tally", type(Tally).creationCode);
            bytes32[] memory l = new bytes32[](4);
            bytes[] memory k = new bytes[](4);
            l[0] = "VoterRegistry";
            k[0] = abi.encodePacked(type(VoterRegistry).creationCode, abi.encode(o.hasher, o.factory));
            l[1] = "DisqualificationRegistry";
            k[1] = abi.encodePacked(type(DisqualificationRegistry).creationCode, abi.encode(o.hasher, o.factory));
            l[2] = "BallotInbox";
            k[2] = abi.encodePacked(type(BallotInbox).creationCode, abi.encode(o.factory));
            l[3] = "Tally";
            k[3] = abi.encodePacked(type(Tally).creationCode, abi.encode(o.factory));
            address[] memory a = _stage(c, "stage3", l, k);
            (o.voterRegistry, o.disqualificationRegistry, o.inbox, o.tally) = (a[0], a[1], a[2], a[3]);
        }

        // Stage 4: account abstraction.
        {
            bytes32[] memory l = new bytes32[](3);
            bytes[] memory k = new bytes[](3);
            l[0] = "ZkVotingEntryPoint";
            k[0] = type(ZkVotingEntryPoint).creationCode;
            address ep = c.d.predict(l[0], keccak256(k[0]));
            l[1] = "PasskeyAccountFactory";
            k[1] = abi.encodePacked(type(PasskeyAccountFactory).creationCode, abi.encode(ep));
            l[2] = "ZkVotingPaymaster";
            k[2] = abi.encodePacked(type(ZkVotingPaymaster).creationCode, abi.encode(ep, c.admin));
            address[] memory a = _stage(c, "stage4", l, k);
            (o.entryPoint, o.accountFactory, o.paymaster) = (a[0], a[1], a[2]);
        }

        o.tallyVerifier = o.mock ? o.verifier : vm.envOr("ZK_VOTING_TALLY_VERIFIER", address(0));
    }

    function _wiring(L2Out memory o) internal view returns (ZkVotingDeployer.ElectionWiring memory w) {
        w.factory = o.factory;
        w.jurisdictions = o.jurisdictions;
        w.verifier = o.verifier;
        w.voterRegistry = o.voterRegistry;
        w.disqualificationRegistry = o.disqualificationRegistry;
        w.inbox = o.inbox;
        w.tally = o.tally;
        w.tallyVerifier = o.tallyVerifier;
        w.paymaster = o.paymaster;
        w.relayer = vm.envOr("RELAYER", address(0));
        w.disclosureInterval = uint64(vm.envOr("DISCLOSURE_INTERVAL", uint256(0)));
        w.allowMockVerifiers = o.mock; // the factory refuses mocks unless opted in, anvil included
    }

    // --- L1 settlement set --------------------------------------------------

    function _deployL1(Ctx memory c) internal returns (L1Out memory o) {
        _checkSize("RollupSettlement", type(RollupSettlement).creationCode);
        address sequencer = vm.envOr("SEQUENCER", c.admin);
        address prover = vm.envOr("PROVER", c.admin);
        o.batchVerifier = vm.envOr("BATCH_VERIFIER", address(0));
        bool isLocal = keccak256(bytes(c.target)) == keccak256("local");
        if (isLocal) {
            o.mockMode = true; // same as DeployLocal
        } else {
            bool mockSettlement = _envTruthy("ZK_VOTING_SETTLEMENT_MOCK_MODE") && block.chainid != MAINNET;
            if (o.batchVerifier == address(0) && !mockSettlement) revert MissingBatchVerifier();
            o.mockMode = o.batchVerifier == address(0) && mockSettlement;
        }
        if (o.mockMode) console2.log("WARNING: RollupSettlement in mockMode; batches are NOT verified");

        bytes memory sCode = abi.encodePacked(
            type(RollupSettlement).creationCode, abi.encode(c.admin, sequencer, prover, o.batchVerifier, o.mockMode)
        );
        bytes memory mCode = abi.encodePacked(type(ZkVotingMailbox).creationCode, abi.encode(c.admin));
        address mailbox = c.d.predict(c.d.MAILBOX(), keccak256(mCode));
        bytes memory tCode = abi.encodePacked(type(L1TallyMirror).creationCode, abi.encode(c.admin, mailbox));
        console2.log(string.concat("preview l1 RollupSettlement ", vm.toString(c.d.predict(c.d.SETTLEMENT(), keccak256(sCode)))));
        console2.log(string.concat("preview l1 ZkVotingMailbox ", vm.toString(mailbox)));
        console2.log(string.concat("preview l1 L1TallyMirror ", vm.toString(c.d.predict(c.d.TALLY_MIRROR(), keccak256(tCode)))));
        (o.settlement, o.mailbox, o.mirror) = c.d.deploySettlement(sCode, mCode, tCode);
    }

    // --- admin follow-ups ---------------------------------------------------

    /// @dev Calls only the final admin may make (contracts without a transferable
    ///      admin, and the factory's acceptAdmin). Made here when the
    ///      broadcaster is the admin; otherwise printed for the admin to send.
    function _adminFollowUps(Ctx memory c, L1Out memory l1, L2Out memory l2, bool isLocal, bool isL1) internal {
        bool self = c.admin == c.eoa;
        if (l2.factory != address(0)) {
            _todo(self, l2.factory, abi.encodeWithSignature("acceptAdmin()"), "factory.acceptAdmin");
            _todo(
                self,
                l2.paymaster,
                abi.encodeCall(ZkVotingPaymaster.setSponsoredTargets, (l2.inbox, l2.voterRegistry, l2.accountFactory)),
                "paymaster.setSponsoredTargets"
            );
            if (vm.envOr("CREATE_CIVIC_JURISDICTION", true)) {
                _todo(
                    self,
                    l2.jurisdictions,
                    abi.encodeCall(JurisdictionRegistry.createJurisdiction, (keccak256("CIVIC"), c.admin, "Civic")),
                    "jurisdictions.createJurisdiction(CIVIC)"
                );
            }
            uint256 sponsor = vm.envOr("PAYMASTER_DEPOSIT_WEI", uint256(isLocal ? 10 ether : 0));
            if (sponsor > 0) ZkVotingPaymaster(payable(l2.paymaster)).deposit{value: sponsor}();
        }
        if (l1.mirror != address(0)) {
            address f = isL1 ? _l2Factory() : l2.factory;
            if (f != address(0)) {
                _todo(self, l1.mirror, abi.encodeCall(L1TallyMirror.setL2Factory, (f)), "mirror.setL2Factory");
            } else {
                // L1 first on a new chain pair: pin the L2 factory once the L2 deploy has run
                // (scripts/l2-vps-bootstrap.sh deploy-l2 prints the call).
                console2.log(string.concat("NOTE mirror.setL2Factory pending on ", vm.toString(l1.mirror)));
            }
            if (_envTruthy("TALLY_MIRROR_REQUIRE_SETTLED_ROOT")) {
                _todo(
                    self,
                    l1.mirror,
                    abi.encodeCall(
                        L1TallyMirror.setSettlement, (vm.envOr("TALLY_MIRROR_ELECTION_ID", uint256(0)), l1.settlement)
                    ),
                    "mirror.setSettlement"
                );
            }
        }
    }

    function _todo(bool self, address target, bytes memory data, string memory what) internal {
        if (self) {
            (bool ok, bytes memory ret) = target.call(data);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        } else {
            console2.log(string.concat("ADMIN_TODO ", what, " to=", vm.toString(target), " data=", vm.toString(data)));
        }
    }

    // --- logs ---------------------------------------------------------------

    function _l2Factory() internal view returns (address) {
        address a = vm.envOr("L2_FACTORY", address(0));
        return a != address(0) ? a : vm.envOr("ELECTION_FACTORY_ADDRESS", address(0));
    }

    function _logL2(L2Out memory o) internal view {
        _log("HASHER", o.hasher);
        _log("VERIFIER", o.verifier);
        _logStr("HASH_SCHEME", o.scheme);
        _logStr("PROVING_PATH", o.mock ? "0" : "1");
        _logStr("VERIFIER_KIND", o.mock ? "MockVerifier" : "VoteVerifier");
        _log("FACTORY", o.factory);
        _log("JURISDICTION_REGISTRY", o.jurisdictions);
        _log("IMPLEMENTATION", ElectionFactory(o.factory).implementation());
        _log("VOTER_REGISTRY", o.voterRegistry);
        _log("DISQUALIFICATION_REGISTRY", o.disqualificationRegistry);
        _log("INBOX", o.inbox);
        _log("TALLY", o.tally);
        _log("ENTRY_POINT", o.entryPoint);
        _log("ACCOUNT_FACTORY", o.accountFactory);
        _log("PAYMASTER", o.paymaster);
    }

    function _logL1(L1Out memory o, address l2Factory) internal view {
        _log("SETTLEMENT", o.settlement);
        _log("TALLY_MIRROR", o.mirror);
        _log("MAILBOX", o.mailbox);
        _log("L2_FACTORY", l2Factory);
        _log("BATCH_VERIFIER", o.batchVerifier);
    }

    function _label(bytes32 b) internal pure returns (string memory) {
        uint256 n = 0;
        while (n < 32 && b[n] != 0) n++;
        bytes memory s = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            s[i] = b[i];
        }
        return string(s);
    }
}
