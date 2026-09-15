// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Script, console2} from "forge-std/Script.sol";
import {ElectionParams} from "../src/interfaces/ElectionParams.sol";
import {IHasher} from "../src/interfaces/IHasher.sol";
import {IGroth16Verifier} from "../src/interfaces/IGroth16Verifier.sol";
import {KeccakHasher} from "../src/hasher/KeccakHasher.sol";
import {StandInHasher} from "../src/hasher/StandInHasher.sol";
import {MockVerifier} from "../src/zk/MockVerifier.sol";
import {VoteVerifier} from "../src/zk/VoteVerifier.sol";
import {ElectionFactory} from "../src/ElectionFactory.sol";
import {VoterRegistry} from "../src/VoterRegistry.sol";
import {DisqualificationRegistry} from "../src/DisqualificationRegistry.sol";
import {BallotInbox} from "../src/BallotInbox.sol";
import {Tally} from "../src/Tally.sol";
import {RepublicEntryPoint} from "../src/account/RepublicEntryPoint.sol";
import {PasskeyAccountFactory} from "../src/account/PasskeyAccountFactory.sol";
import {RepublicPaymaster} from "../src/account/RepublicPaymaster.sol";
import {RollupSettlement} from "../src/l2/RollupSettlement.sol";
import {L1TallyMirror} from "../src/l2/L1TallyMirror.sol";
import {RepublicMailbox} from "../src/l2/RepublicMailbox.sol";

/// @notice Shared deploy result for the Republic election + AA stack.
struct RepublicStack {
    IHasher hasher;
    IGroth16Verifier verifier;
    bool mockVerifier;
    string hashScheme;
    ElectionFactory factory;
    VoterRegistry voterRegistry;
    DisqualificationRegistry disqualificationRegistry;
    BallotInbox inbox;
    Tally tally;
    RepublicEntryPoint entryPoint;
    PasskeyAccountFactory accountFactory;
    RepublicPaymaster paymaster;
}

/// @notice Anvil / L2 helpers. `DeployLocal` and `DeployL2` inherit this.
/// @dev Unit tests never call this script. Default is MockVerifier + keccak-dev-v1.
///      Integration: `REPUBLIC_PROVING_PATH=1` (or `REPUBLIC_USE_MOCK_VERIFIER=0`)
///      deploys `VoteVerifier` with no mock fallback (fail closed until a real VK).
abstract contract RepublicStackScript is Script {
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

    /// @dev Default true. `REPUBLIC_PROVING_PATH=1` or `REPUBLIC_USE_MOCK_VERIFIER=0` → VoteVerifier.
    function _useMockVerifier() internal view returns (bool) {
        if (_envTruthy("REPUBLIC_PROVING_PATH")) return false;
        string memory mock = vm.envOr("REPUBLIC_USE_MOCK_VERIFIER", string("1"));
        if (_isFalsy(mock)) return false;
        return true;
    }

    function _schemeIsStandIn(string memory scheme) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(scheme));
        return h == keccak256("republic.hash.standin-v0") || h == keccak256("standin-v0") || h == keccak256("standin");
    }

    function _logStack(RepublicStack memory s) internal view {
        _log("HASHER", address(s.hasher));
        _log("VERIFIER", address(s.verifier));
        _logStr("HASH_SCHEME", s.hashScheme);
        _logStr("PROVING_PATH", s.mockVerifier ? "0" : "1");
        _logStr("VERIFIER_KIND", s.mockVerifier ? "MockVerifier" : "VoteVerifier");
        _log("FACTORY", address(s.factory));
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
    function _deployElectionStack(address admin) internal returns (RepublicStack memory s) {
        bool useMock = _useMockVerifier();
        s.mockVerifier = useMock;

        string memory schemeEnv = vm.envOr("REPUBLIC_HASH_SCHEME", string(""));
        if (bytes(schemeEnv).length == 0) {
            s.hashScheme = useMock ? "republic.hash.keccak-dev-v1" : "republic.hash.standin-v0";
        } else {
            s.hashScheme = schemeEnv;
        }

        if (_schemeIsStandIn(s.hashScheme)) {
            s.hasher = IHasher(address(new StandInHasher()));
        } else {
            s.hasher = IHasher(address(new KeccakHasher()));
        }

        if (useMock) {
            MockVerifier mock = new MockVerifier();
            mock.setAccept(true);
            s.verifier = IGroth16Verifier(address(mock));
        } else {
            // Fail closed: zero VK, no MockVerifier fallback. Dummy proofs cannot pass.
            s.verifier = IGroth16Verifier(address(new VoteVerifier(address(0))));
        }

        // address(0) implementation: factory deploys Election internally.
        s.factory = new ElectionFactory(admin, address(0));
        s.voterRegistry = new VoterRegistry(address(s.factory), address(s.hasher));
        s.disqualificationRegistry = new DisqualificationRegistry(address(s.hasher), address(s.factory));
        s.inbox = new BallotInbox(address(s.factory));
        s.tally = new Tally(address(s.factory));
        s.factory
            .setModules(
                address(s.voterRegistry), address(s.disqualificationRegistry), address(s.inbox), address(s.tally)
            );

        s.entryPoint = new RepublicEntryPoint();
        s.accountFactory = new PasskeyAccountFactory(address(s.entryPoint));
        s.paymaster = new RepublicPaymaster(address(s.entryPoint), admin);
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
    }
}

/// @notice Broadcast the full local stack to Anvil, then create one sample election.
contract DeployLocal is RepublicStackScript {
    function run() external {
        vm.startBroadcast();
        address admin = msg.sender;

        RepublicStack memory s = _deployElectionStack(admin);

        address sequencer = vm.envOr("SEQUENCER", admin);
        address prover = vm.envOr("PROVER", admin);
        address batchVerifier = vm.envOr("BATCH_VERIFIER", address(0));

        RollupSettlement settlement = new RollupSettlement(admin, sequencer, prover, batchVerifier, true);
        RepublicMailbox mailbox = new RepublicMailbox(admin);
        L1TallyMirror mirror = new L1TallyMirror(admin, address(mailbox));

        s.paymaster.deposit{value: 10 ether}();

        (uint256 electionId, address election) =
            s.factory.createElection(_civicSampleParams(admin, address(s.verifier)));

        vm.stopBroadcast();

        _logStack(s);
        _log("SETTLEMENT", address(settlement));
        _log("TALLY_MIRROR", address(mirror));
        _log("MAILBOX", address(mailbox));
        _log("ELECTION", election);
        console2.log(string.concat("ELECTION_ID=", vm.toString(electionId)));
    }
}
