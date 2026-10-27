// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {console2} from "forge-std/Script.sol";
import {DeployOnce} from "./DeployGuard.sol";
import {ElectionParams} from "../src/interfaces/ElectionParams.sol";
import {IHasher} from "../src/interfaces/IHasher.sol";
import {IGroth16Verifier} from "../src/interfaces/IGroth16Verifier.sol";
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

/// @notice Shared deploy result for the ZK-Voting election + AA stack.
struct ZkVotingStack {
    IHasher hasher;
    IGroth16Verifier verifier;
    bool mockVerifier;
    string hashScheme;
    ElectionFactory factory;
    JurisdictionRegistry jurisdictions;
    VoterRegistry voterRegistry;
    DisqualificationRegistry disqualificationRegistry;
    BallotInbox inbox;
    Tally tally;
    ZkVotingEntryPoint entryPoint;
    PasskeyAccountFactory accountFactory;
    ZkVotingPaymaster paymaster;
}

/// @notice Anvil / L2 helpers. `DeployLocal` and `DeployL2` inherit this.
/// @dev Unit tests never call this script. Default is MockVerifier + keccak-dev-v1.
///      Integration: `ZK_VOTING_PROVING_PATH=1` (or `ZK_VOTING_USE_MOCK_VERIFIER=0`)
///      deploys PoseidonHasher and a non-mock verifier. Without
///      `ZK_VOTING_VOTE_VERIFIER`, that is `VoteVerifier` with a zero VK (fail closed).
///      Set `ZK_VOTING_VOTE_VERIFIER` to a snarkjs-exported verifier to wrap it in
///      `Groth16VerifierAdapter`. That key is still untrusted until a ceremony.
abstract contract ZkVotingStackScript is DeployOnce {
    /// @dev Audit H-02: a mock (accept-all) verifier may only be deployed on
    ///      anvil (31337) or with the explicit dev flag ZK_VOTING_ALLOW_MOCK_VERIFIER=1.
    error MockVerifierNotAllowed(uint256 chainId);

    uint256 internal constant ANVIL_CHAIN_ID = 31337;

    function _mockVerifierAllowed() internal view returns (bool) {
        return block.chainid == ANVIL_CHAIN_ID || _envTruthy("ZK_VOTING_ALLOW_MOCK_VERIFIER");
    }

    function _log(string memory name, address addr) internal view {
        console2.log(string.concat(name, "=", vm.toString(addr)));
    }

    function _logStr(string memory name, string memory value) internal pure {
        console2.log(string.concat(name, "=", value));
    }

    function _isTruthy(string memory v) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(v));
        return h == keccak256("1") || h == keccak256("true") || h == keccak256("TRUE") || h == keccak256("yes")
            || h == keccak256("YES") || h == keccak256("on") || h == keccak256("ON");
    }

    function _isFalsy(string memory v) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(v));
        return h == keccak256("0") || h == keccak256("false") || h == keccak256("FALSE") || h == keccak256("no")
            || h == keccak256("NO") || h == keccak256("off") || h == keccak256("OFF");
    }

    function _envTruthy(string memory name) internal view returns (bool) {
        return _isTruthy(vm.envOr(name, string("")));
    }

    /// @dev Default true. `ZK_VOTING_PROVING_PATH=1` or `ZK_VOTING_USE_MOCK_VERIFIER=0` → VoteVerifier.
    function _useMockVerifier() internal view returns (bool) {
        if (_envTruthy("ZK_VOTING_PROVING_PATH")) return false;
        string memory mock = vm.envOr("ZK_VOTING_USE_MOCK_VERIFIER", string("1"));
        if (_isFalsy(mock)) return false;
        return true;
    }

    function _schemeIsStandIn(string memory scheme) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(scheme));
        return h == keccak256("zk-voting.hash.standin-v0") || h == keccak256("standin-v0") || h == keccak256("standin");
    }

    function _schemeIsPoseidon(string memory scheme) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(scheme));
        return h == keccak256("zk-voting.hash.poseidon-bn254-x5-t3-v1") || h == keccak256("poseidon")
            || h == keccak256("poseidon-bn254-x5-t3-v1");
    }

    function _logStack(ZkVotingStack memory s) internal view {
        _log("HASHER", address(s.hasher));
        _log("VERIFIER", address(s.verifier));
        _logStr("HASH_SCHEME", s.hashScheme);
        _logStr("PROVING_PATH", s.mockVerifier ? "0" : "1");
        _logStr("VERIFIER_KIND", s.mockVerifier ? "MockVerifier" : "VoteVerifier");
        _log("FACTORY", address(s.factory));
        _log("JURISDICTION_REGISTRY", address(s.jurisdictions));
        _log("IMPLEMENTATION", s.factory.implementation());
        _log("VOTER_REGISTRY", address(s.voterRegistry));
        _log("DISQUALIFICATION_REGISTRY", address(s.disqualificationRegistry));
        _log("INBOX", address(s.inbox));
        _log("TALLY", address(s.tally));
        _log("ENTRY_POINT", address(s.entryPoint));
        _log("ACCOUNT_FACTORY", address(s.accountFactory));
        _log("PAYMASTER", address(s.paymaster));
    }

    /// @dev Factory first, then modules that take `factory`, then `setModules`.
    function _deployElectionStack(address admin) internal returns (ZkVotingStack memory s) {
        bool useMock = _useMockVerifier();
        if (useMock && !_mockVerifierAllowed()) revert MockVerifierNotAllowed(block.chainid);
        s.mockVerifier = useMock;

        string memory schemeEnv = vm.envOr("ZK_VOTING_HASH_SCHEME", string(""));
        if (bytes(schemeEnv).length == 0) {
            s.hashScheme = useMock ? "zk-voting.hash.keccak-dev-v1" : "zk-voting.hash.poseidon-bn254-x5-t3-v1";
        } else {
            s.hashScheme = schemeEnv;
        }

        if (_schemeIsPoseidon(s.hashScheme)) {
            s.hasher = IHasher(address(new PoseidonHasher()));
        } else if (_schemeIsStandIn(s.hashScheme)) {
            s.hasher = IHasher(address(new StandInHasher()));
        } else {
            s.hasher = IHasher(address(new KeccakHasher()));
        }

        if (useMock) {
            // Test / demo only. acceptAll is not the proving path.
            MockVerifier mock = new MockVerifier();
            mock.setAccept(true);
            s.verifier = IGroth16Verifier(address(mock));
        } else {
            address exported = vm.envOr("ZK_VOTING_VOTE_VERIFIER", address(0));
            if (exported != address(0)) {
                // Caller deployed the snarkjs verifier. Still not a ceremony.
                s.verifier = IGroth16Verifier(address(new Groth16VerifierAdapter(exported, 5)));
            } else {
                // Fail closed: zero VK, no MockVerifier fallback. Dummy proofs cannot pass.
                s.verifier = IGroth16Verifier(address(new VoteVerifier(address(0))));
            }
        }

        // address(0) implementation: factory deploys Election internally.
        s.factory = new ElectionFactory(admin, address(0));
        // Explicit dev flag only (anvil allows mocks by default in the factory).
        if (useMock && block.chainid != ANVIL_CHAIN_ID) s.factory.setAllowMockVerifiers(true);
        s.jurisdictions = new JurisdictionRegistry(admin);
        s.factory.setJurisdictionRegistry(address(s.jurisdictions));
        // Audit M-02: non-admin clerks may only use admin-approved verifiers.
        s.factory.setVerifierApproved(address(s.verifier), true);
        s.voterRegistry = new VoterRegistry(address(s.hasher), address(s.factory));
        s.disqualificationRegistry = new DisqualificationRegistry(address(s.hasher), address(s.factory));
        s.inbox = new BallotInbox(address(s.factory));
        s.tally = new Tally(address(s.factory));
        // Audit H-01: the tally has its own verifier. Mock path: the same dev
        // mock. Otherwise ZK_VOTING_TALLY_VERIFIER, else unset (tally fails closed).
        address tallyVerifier = useMock ? address(s.verifier) : vm.envOr("ZK_VOTING_TALLY_VERIFIER", address(0));
        if (tallyVerifier != address(0)) s.tally.setTallyProofVerifier(tallyVerifier);
        s.factory
            .setModules(
                address(s.voterRegistry), address(s.disqualificationRegistry), address(s.inbox), address(s.tally)
            );
        address relayerAddr = vm.envOr("RELAYER", address(0));
        if (relayerAddr != address(0)) s.factory.setRelayer(relayerAddr, true);
        uint256 disclosure = vm.envOr("DISCLOSURE_INTERVAL", uint256(0));
        if (disclosure != 0) s.factory.setDisclosureInterval(uint64(disclosure));

        s.entryPoint = new ZkVotingEntryPoint();
        s.accountFactory = new PasskeyAccountFactory(address(s.entryPoint));
        s.paymaster = new ZkVotingPaymaster(address(s.entryPoint), admin);
        s.paymaster.setSponsoredTargets(address(s.inbox), address(s.voterRegistry), address(s.accountFactory));
    }

    function _civicSampleParams(address admin, address verifier) internal view returns (ElectionParams memory p) {
        p.title = "Civic Sample Election";
        p.metadataURI = "";
        p.startTime = uint64(block.timestamp + 60);
        p.cutoffTime = uint64(block.timestamp + 1 weeks);
        p.maxParticipants = 0;
        p.treeDepth = 20;
        p.ballotSpecHash = bytes32(0);
        p.clerk = admin;
        p.registrar = admin;
        p.disqualificationOfficer = admin;
        p.tallyOperator = admin;
        p.verifier = verifier;
        p.questionCount = 1;
        p.jurisdictionId = keccak256("CIVIC");
        // Default civic sample stays SUM_ONLY so existing operator scripts keep working.
        p.tallyScheme = 0;
    }
}

/// @notice Broadcast the full local stack to Anvil, then create one sample election.
contract DeployLocal is ZkVotingStackScript {
    error LocalDeployOnly(uint256 chainId);

    function run() external {
        // This script deploys a sample election and, on the mock path, an
        // accept-all verifier. It is for chain 31337. A public chain needs
        // ZK_VOTING_ALLOW_PUBLIC_DEPLOY=1 and still has to pass the mock gate.
        if (block.chainid != ANVIL_CHAIN_ID && !_envTruthy("ZK_VOTING_ALLOW_PUBLIC_DEPLOY")) {
            revert LocalDeployOnly(block.chainid);
        }
        _refuseIfAlreadyDeployed();
        vm.startBroadcast();
        address admin = msg.sender;

        ZkVotingStack memory s = _deployElectionStack(admin);

        address sequencer = vm.envOr("SEQUENCER", admin);
        address prover = vm.envOr("PROVER", admin);
        address batchVerifier = vm.envOr("BATCH_VERIFIER", address(0));

        RollupSettlement settlement = new RollupSettlement(admin, sequencer, prover, batchVerifier, true);
        ZkVotingMailbox mailbox = new ZkVotingMailbox(admin);
        L1TallyMirror mirror = new L1TallyMirror(admin, address(mailbox));
        mirror.setL2Factory(address(s.factory));

        s.jurisdictions.createJurisdiction(keccak256("CIVIC"), admin, "Civic");

        s.paymaster.deposit{value: 10 ether}();

        (uint256 electionId, address election) =
            s.factory.createElection(_civicSampleParams(admin, address(s.verifier)));

        vm.stopBroadcast();

        _logStack(s);
        _log("SETTLEMENT", address(settlement));
        _log("TALLY_MIRROR", address(mirror));
        _log("MAILBOX", address(mailbox));
        _log("JURISDICTION_REGISTRY", address(s.jurisdictions));
        _log("ELECTION", election);
        console2.log(string.concat("ELECTION_ID=", vm.toString(electionId)));
    }
}
