// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkVotingDeployer} from "../../src/deploy/ZkVotingDeployer.sol";
import {KeccakHasher} from "../../src/hasher/KeccakHasher.sol";
import {MockVerifier} from "../../src/zk/MockVerifier.sol";
import {VoteVerifier} from "../../src/zk/VoteVerifier.sol";
import {ElectionFactory} from "../../src/ElectionFactory.sol";
import {VoterRegistry} from "../../src/VoterRegistry.sol";
import {DisqualificationRegistry} from "../../src/DisqualificationRegistry.sol";
import {BallotInbox} from "../../src/BallotInbox.sol";
import {Tally} from "../../src/Tally.sol";
import {JurisdictionRegistry} from "../../src/JurisdictionRegistry.sol";
import {ZkVotingEntryPoint} from "../../src/account/ZkVotingEntryPoint.sol";
import {ZkVotingPaymaster} from "../../src/account/ZkVotingPaymaster.sol";
import {RollupSettlement} from "../../src/l2/RollupSettlement.sol";
import {L1TallyMirror} from "../../src/l2/L1TallyMirror.sol";
import {ZkVotingMailbox} from "../../src/l2/ZkVotingMailbox.sol";
import {Roles} from "../../src/Roles.sol";

contract ZkVotingDeployerTest is Test {
    address launcher = address(0xA11CE);
    address admin = address(0xAD);
    bytes32 ns = keccak256("test.ns");
    ZkVotingDeployer d;

    function setUp() public {
        d = new ZkVotingDeployer(launcher, admin, ns);
    }

    function _one(bytes32 label, bytes memory code) internal returns (address) {
        bytes32[] memory l = new bytes32[](1);
        bytes[] memory k = new bytes[](1);
        (l[0], k[0]) = (label, code);
        vm.prank(launcher);
        uint256 g = gasleft();
        address a = d.deploy(l, k)[0];
        emit log_named_uint(string(abi.encodePacked("gas stage ", label)), g - gasleft());
        return a;
    }

    function test_DeployerFitsEip170AndIsSmall() public view {
        assertLt(address(d).code.length, 24_576);
        assertLt(type(ZkVotingDeployer).creationCode.length, 49_152);
    }

    function test_PredictMatchesAndIsDeterministic() public {
        bytes memory code = type(KeccakHasher).creationCode;
        address p = d.predict("Hasher", keccak256(code));
        assertEq(_one("Hasher", code), p);
        assertEq(d.deployed("Hasher"), p);
        // same namespace + launcher + admin on a fresh deployer at the same address => same result
        assertEq(
            p,
            vm.computeCreate2Address(keccak256(abi.encode(ns, bytes32("Hasher"))), keccak256(code), address(d))
        );
    }

    function test_LabelCannotBeReused() public {
        _one("Hasher", type(KeccakHasher).creationCode);
        bytes32[] memory l = new bytes32[](1);
        bytes[] memory k = new bytes[](1);
        (l[0], k[0]) = (bytes32("Hasher"), type(KeccakHasher).creationCode);
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(ZkVotingDeployer.AlreadyDeployed.selector, bytes32("Hasher")));
        d.deploy(l, k);
    }

    function test_OnlyLauncher() public {
        bytes32[] memory l = new bytes32[](0);
        bytes[] memory k = new bytes[](0);
        vm.expectRevert(ZkVotingDeployer.NotLauncher.selector);
        d.deploy(l, k);
        vm.expectRevert(ZkVotingDeployer.NotLauncher.selector);
        d.seal();
    }

    struct S {
        address hasher;
        address verifier;
        ElectionFactory f;
        JurisdictionRegistry j;
        address vr;
        address dr;
        address inbox;
        Tally tally;
        ZkVotingPaymaster pm;
    }

    function _stack(bool mock) internal returns (S memory s) {
        s.hasher = _one("Hasher", type(KeccakHasher).creationCode);
        if (mock) {
            MockVerifier m = new MockVerifier();
            s.verifier = address(m);
        } else {
            s.verifier = _one("VoteVerifier", abi.encodePacked(type(VoteVerifier).creationCode, abi.encode(address(0))));
        }
        s.f = ElectionFactory(
            _one("ElectionFactory", abi.encodePacked(type(ElectionFactory).creationCode, abi.encode(address(d), address(0))))
        );
        s.j = JurisdictionRegistry(
            _one("JurisdictionRegistry", abi.encodePacked(type(JurisdictionRegistry).creationCode, abi.encode(admin)))
        );
        s.vr = _one("VoterRegistry", abi.encodePacked(type(VoterRegistry).creationCode, abi.encode(s.hasher, address(s.f))));
        s.dr = _one(
            "DisqualificationRegistry",
            abi.encodePacked(type(DisqualificationRegistry).creationCode, abi.encode(s.hasher, address(s.f)))
        );
        s.inbox = _one("BallotInbox", abi.encodePacked(type(BallotInbox).creationCode, abi.encode(address(s.f))));
        s.tally = Tally(_one("Tally", abi.encodePacked(type(Tally).creationCode, abi.encode(address(s.f)))));
        address ep = _one("ZkVotingEntryPoint", type(ZkVotingEntryPoint).creationCode);
        s.pm = ZkVotingPaymaster(
            payable(_one("ZkVotingPaymaster", abi.encodePacked(type(ZkVotingPaymaster).creationCode, abi.encode(ep, admin))))
        );
    }

    function _w(S memory s, bool mock) internal pure returns (ZkVotingDeployer.ElectionWiring memory w) {
        w.factory = address(s.f);
        w.jurisdictions = address(s.j);
        w.verifier = s.verifier;
        w.voterRegistry = s.vr;
        w.disqualificationRegistry = s.dr;
        w.inbox = s.inbox;
        w.tally = address(s.tally);
        w.tallyVerifier = mock ? s.verifier : address(0);
        w.paymaster = address(s.pm);
        w.allowMockVerifiers = mock;
    }

    function test_WireHandsOffAndLeavesNoPrivilege() public {
        S memory s = _stack(true);
        vm.prank(launcher);
        uint256 g = gasleft();
        d.wireElectionStack(_w(s, true), true);
        emit log_named_uint("gas wireElectionStack", g - gasleft());
        assertTrue(d.sealed_());
        assertEq(s.f.pendingAdmin(), admin);
        assertEq(s.f.tallyVerifier(), address(s.tally));
        assertEq(s.tally.tallyProofVerifier(), s.verifier);

        vm.prank(admin);
        s.f.acceptAdmin();
        assertEq(s.f.admin(), admin);
        bytes32[3] memory rs = [Roles.PLATFORM_SUPER_ADMIN_ROLE, Roles.PLATFORM_ADMIN_ROLE, Roles.ADMIN_ROLE];
        for (uint256 i = 0; i < 3; i++) {
            assertFalse(s.f.roles(rs[i], address(d)), "deployer kept a role");
            assertFalse(s.f.roles(rs[i], launcher), "launcher has a role");
            assertTrue(s.f.roles(rs[i], admin));
        }
        // Nothing callable on the deployer any more, by anyone.
        vm.prank(launcher);
        vm.expectRevert(ZkVotingDeployer.AlreadySealed.selector);
        d.seal();
        // Launcher holds nothing on the factory.
        vm.prank(launcher);
        vm.expectRevert();
        s.f.setRelayer(launcher, true);
    }

    function test_WireRejectsWrongAdminOnImmutableModule() public {
        S memory s = _stack(true);
        s.j = new JurisdictionRegistry(launcher);
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(ZkVotingDeployer.WrongAdmin.selector, address(s.j), launcher));
        d.wireElectionStack(_w(s, true), true);
    }

    function test_MainnetRejectsMockVerifier() public {
        S memory s = _stack(true);
        vm.chainId(1);
        vm.prank(launcher);
        vm.expectRevert(ZkVotingDeployer.MockNotAllowedOnMainnet.selector);
        d.wireElectionStack(_w(s, true), true);
    }

    function test_MainnetRejectsAllowMockFlag() public {
        S memory s = _stack(false);
        ZkVotingDeployer.ElectionWiring memory w = _w(s, false);
        w.allowMockVerifiers = true;
        vm.chainId(1);
        vm.prank(launcher);
        vm.expectRevert(ZkVotingDeployer.MockNotAllowedOnMainnet.selector);
        d.wireElectionStack(w, true);
    }

    function _l1(bool mockMode, address bv)
        internal
        view
        returns (bytes memory sCode, bytes memory mCode, bytes memory tCode)
    {
        sCode = abi.encodePacked(type(RollupSettlement).creationCode, abi.encode(admin, admin, admin, bv, mockMode));
        mCode = abi.encodePacked(type(ZkVotingMailbox).creationCode, abi.encode(admin));
        address mailbox = d.predict(d.MAILBOX(), keccak256(mCode));
        tCode = abi.encodePacked(type(L1TallyMirror).creationCode, abi.encode(admin, mailbox));
    }

    function test_L1SettlementAtomicAndChecked() public {
        (bytes memory a, bytes memory b, bytes memory c) = _l1(true, address(0));
        vm.prank(launcher);
        uint256 g = gasleft();
        (address s, address m, address t) = d.deploySettlement(a, b, c);
        emit log_named_uint("gas deploySettlement", g - gasleft());
        assertEq(RollupSettlement(s).admin(), admin);
        assertEq(L1TallyMirror(t).related(), m);
        assertEq(s, d.predict(d.SETTLEMENT(), keccak256(a)));
    }

    function test_MainnetRejectsMockModeSettlement() public {
        (bytes memory a, bytes memory b, bytes memory c) = _l1(true, address(0));
        vm.chainId(1);
        vm.prank(launcher);
        vm.expectRevert(ZkVotingDeployer.MockNotAllowedOnMainnet.selector);
        d.deploySettlement(a, b, c);
    }

    function test_MainnetRejectsMockBatchVerifier() public {
        MockVerifier mv = new MockVerifier();
        (bytes memory a, bytes memory b, bytes memory c) = _l1(false, address(mv));
        vm.chainId(1);
        vm.prank(launcher);
        vm.expectRevert(ZkVotingDeployer.MockNotAllowedOnMainnet.selector);
        d.deploySettlement(a, b, c);
    }

    function test_MainnetRejectsVerifierWithoutCode() public {
        (bytes memory a, bytes memory b, bytes memory c) = _l1(false, address(0xBEEF));
        vm.chainId(1);
        vm.prank(launcher);
        vm.expectRevert(ZkVotingDeployer.MissingBatchVerifier.selector);
        d.deploySettlement(a, b, c);
    }

    function test_SettlementRejectsForeignAdmin() public {
        bytes memory a =
            abi.encodePacked(type(RollupSettlement).creationCode, abi.encode(launcher, admin, admin, address(0), true));
        (, bytes memory b, bytes memory c) = _l1(true, address(0));
        vm.prank(launcher);
        vm.expectRevert();
        d.deploySettlement(a, b, c);
        assertEq(d.deployed(d.SETTLEMENT()), address(0), "atomic: nothing kept");
    }

    function test_ConstructorRejectsZero() public {
        vm.expectRevert(ZkVotingDeployer.ZeroAddress.selector);
        new ZkVotingDeployer(address(0), admin, ns);
    }
}
