// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {BallotInbox} from "../../src/BallotInbox.sol";
import {DisqualificationRegistry} from "../../src/DisqualificationRegistry.sol";
import {Election} from "../../src/Election.sol";
import {ElectionFactory} from "../../src/ElectionFactory.sol";
import {ExternalPartyRegistry} from "../../src/ExternalPartyRegistry.sol";
import {ReasonCodes} from "../../src/ReasonCodes.sol";
import {Roles} from "../../src/Roles.sol";
import {ElectionParams} from "../../src/interfaces/ElectionParams.sol";
import {IElection} from "../../src/interfaces/IElection.sol";
import {ITallyVerifier} from "../../src/interfaces/ITallyVerifier.sol";
import {L1TallyMirror} from "../../src/l2/L1TallyMirror.sol";
import {RollupSettlement} from "../../src/l2/RollupSettlement.sol";
import {PasskeyAccount} from "../../src/account/PasskeyAccount.sol";
import {ZkVotingEntryPoint} from "../../src/account/ZkVotingEntryPoint.sol";
import {UserOp} from "../../src/interfaces/UserOp.sol";
import {ZkVotingPaymaster} from "../../src/account/ZkVotingPaymaster.sol";
import {MockVerifier} from "../../src/zk/MockVerifier.sol";
import {Vm} from "forge-std/Vm.sol";
import {Deployer} from "../helpers/Deployer.sol";
import {Fixtures} from "../helpers/Fixtures.sol";
import {IBallotInbox} from "../../src/interfaces/IBallotInbox.sol";
import {IDisqualificationRegistry} from "../../src/interfaces/IDisqualificationRegistry.sol";
import {IElectionFactory} from "../../src/interfaces/IElectionFactory.sol";
import {IExternalPartyRegistry} from "../../src/interfaces/IExternalPartyRegistry.sol";
import {IL1TallyMirror} from "../../src/interfaces/IL1TallyMirror.sol";
import {IZkVotingPaymaster} from "../../src/interfaces/IZkVotingPaymaster.sol";

contract MedSink {
    uint256 public value;

    function ping(uint256 v) external {
        value = v;
    }

    function boom() external pure {
        revert("boom");
    }

    /// @dev Return bomb: reverts with 100 KB of data.
    function bomb() external pure {
        assembly {
            revert(0, 100000)
        }
    }
}

contract MediumRegressionsTest is Deployer {
    uint8 internal constant MODE_VETO = 0;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
    }

    // ------------------------------------------------------------------ M-01

    function testM01_LateUpdateCannotBeEnabledAfterStart() public {
        (uint256 id, address el) = prepareOpenElection(Fixtures.identityCommitment(uint256(1)));
        vm.prank(clerk);
        vm.expectRevert(IDisqualificationRegistry.VotingStarted.selector);
        disqualification.setLateUpdateAllowed(id, true);
        // Narrowing is always allowed.
        vm.prank(clerk);
        disqualification.setLateUpdateAllowed(id, false);
        assertFalse(disqualification.lateUpdateAllowed(id));
        // Without the pre-start opt-in, the officer cannot move roots mid-vote.
        vm.prank(officer);
        vm.expectRevert(IDisqualificationRegistry.RollFrozen.selector);
        disqualification.disqualify(id, Fixtures.identityCommitment(uint256(1)), ReasonCodes.DECEASED, bytes32(0));
        el;
    }

    function testM01_LateRootChangeIsLogged() public {
        uint256 cm = Fixtures.identityCommitment(uint256(2));
        (uint256 id, address el) = createElection();
        registerVoter(id, cm);
        freezeRoll(el);
        vm.expectEmit(true, false, false, true, address(disqualification));
        emit IDisqualificationRegistry.LateUpdateAllowedSet(id, true);
        vm.prank(clerk);
        disqualification.setLateUpdateAllowed(id, true);
        warpOpen(el);

        vm.recordLogs();
        vm.prank(officer);
        disqualification.disqualify(id, cm, ReasonCodes.DECEASED, bytes32(0));
        bytes32 sig = keccak256("RootsUpdated(bytes32,bytes32,bool)");
        bool seen;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == el && logs[i].topics[0] == sig) {
                (,, bool afterStart) = abi.decode(logs[i].data, (bytes32, bytes32, bool));
                assertTrue(afterStart, "late update flagged");
                seen = true;
            }
        }
        assertTrue(seen, "RootsUpdated emitted");
    }

    // ------------------------------------------------------------------ M-02

    function testM02_ExploitClerkWithUnapprovedVerifierRefused() public {
        ElectionParams memory p = defaultParams();
        p.verifier = address(new MockVerifier()); // attacker-chosen accept-all
        vm.prank(clerk);
        vm.expectRevert(IElectionFactory.VerifierNotApproved.selector);
        factory.createElection(p);
        // Approved verifier still works for the clerk (flow preserved).
        vm.prank(clerk);
        (uint256 id,) = factory.createElection(defaultParams());
        assertGt(id, 0);
    }

    function testM02_ExploitPermissionlessCreationWithoutRegistryRefused() public {
        ElectionFactory naked = new ElectionFactory(admin, address(0));
        vm.prank(admin);
        naked.setAllowMockVerifiers(true);
        ElectionParams memory p = defaultParams();
        address attacker = makeAddr("attacker");
        p.clerk = attacker;
        vm.prank(attacker);
        vm.expectRevert(IElectionFactory.MissingRole.selector);
        naked.createElection(p);
    }

    function testM02_VerifierApprovalIsSuperAdminOnly() public {
        vm.prank(clerk);
        vm.expectRevert(IElectionFactory.NotSuperAdmin.selector);
        factory.setVerifierApproved(address(1), true);
        vm.prank(admin);
        factory.setVerifierApproved(address(1), true);
        assertTrue(factory.approvedVerifier(address(1)));
    }

    // ------------------------------------------------------------------ M-03

    function testM03_ExploitModuleRewireRefused() public {
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.ModulesAlreadySet.selector);
        factory.setModules(address(1), address(2), address(3), address(4));
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.ModulesAlreadySet.selector);
        factory.wireModules(address(1), address(2), address(3), address(4));
        assertEq(factory.ballotInbox(), address(inbox));
    }

    function testM03_ModulesRejectZero() public {
        ElectionFactory f = new ElectionFactory(admin, address(0));
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.ZeroAddress.selector);
        f.setModules(address(1), address(0), address(3), address(4));
    }

    function testM03_SuperAdminNotGrantableAndRolesRevocable() public {
        address x = makeAddr("x");
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.CannotGrantSuperAdmin.selector);
        factory.grantRole(Roles.PLATFORM_SUPER_ADMIN_ROLE, x);

        vm.prank(admin);
        factory.grantRole(Roles.CLERK_ROLE, x);
        assertTrue(factory.roles(Roles.CLERK_ROLE, x));
        vm.prank(admin);
        factory.revokeRole(Roles.CLERK_ROLE, x);
        assertFalse(factory.roles(Roles.CLERK_ROLE, x));
    }

    function testM03_TwoStepAdminTransfer() public {
        address next = makeAddr("nextAdmin");
        vm.prank(next);
        vm.expectRevert(IElectionFactory.NotAdmin.selector);
        factory.transferAdmin(next);

        vm.prank(admin);
        factory.transferAdmin(next);
        assertEq(factory.admin(), admin, "not until accepted");
        vm.prank(makeAddr("other"));
        vm.expectRevert(IElectionFactory.NotPendingAdmin.selector);
        factory.acceptAdmin();

        vm.prank(next);
        factory.acceptAdmin();
        assertEq(factory.admin(), next);
        assertTrue(factory.isSuperAdmin(next));
        assertFalse(factory.isSuperAdmin(admin));
    }

    // ------------------------------------------------------------------ M-04

    function testM04_ExploitTallyStatusFailureNoLongerFailsOpen() public {
        (uint256 id, address el) = prepareOpenElection(Fixtures.identityCommitment(uint256(3)));
        vm.mockCallRevert(address(tally), abi.encodeWithSelector(ITallyVerifier.isTallied.selector, id), "down");
        bytes memory enc = Fixtures.encryptedBallot(7);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(id, el, 7, enc);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.TallyStatusUnavailable.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);

        vm.clearMockedCalls();
        submitVote(id, el, 7);
        assertEq(this.liveAccepted(id), 1);
    }

    // ------------------------------------------------------------------ M-05

    function _cert(bytes32 resultHash, bytes32 root) internal returns (IL1TallyMirror.Certification memory c) {
        c.factory = makeAddr("l2Factory"); // no code on this chain
        c.electionId = 1;
        c.jurisdictionId = keccak256("CIVIC");
        c.resultHash = resultHash;
        c.totalBallots = 10;
        c.l2StateRoot = root;
    }

    function testM05_SupersedeWithinDisputeWindowOnly() public {
        L1TallyMirror mirror = new L1TallyMirror(admin, address(0));
        IL1TallyMirror.Certification memory c = _cert(keccak256("wrong"), bytes32(0));
        vm.prank(admin);
        mirror.postCertifiedResult(c);
        bytes32 id = mirror.certificationIdOf(c.factory, c.electionId, c.jurisdictionId);
        assertFalse(mirror.isFinal(id));

        vm.prank(makeAddr("publisher"));
        vm.expectRevert(IL1TallyMirror.NotAuthorized.selector);
        mirror.supersedeCertifiedResult(id, keccak256("right"), 10, bytes32(0), keccak256("order"));

        vm.prank(admin);
        mirror.supersedeCertifiedResult(id, keccak256("right"), 10, bytes32(0), keccak256("order"));
        assertEq(mirror.resultHashOfIdentity(id), keccak256("right"));

        vm.warp(block.timestamp + mirror.DISPUTE_WINDOW());
        assertTrue(mirror.isFinal(id));
        vm.prank(admin);
        vm.expectRevert(IL1TallyMirror.DisputeWindowClosed.selector);
        mirror.supersedeCertifiedResult(id, keccak256("late"), 10, bytes32(0), bytes32(0));
    }

    function testM05_PinnedSettlementRequiresSettledRoot() public {
        L1TallyMirror mirror = new L1TallyMirror(admin, address(0));
        vm.prank(admin);
        mirror.setSettlement(1, address(settlement));
        vm.prank(admin);
        vm.expectRevert(IL1TallyMirror.SettlementAlreadySet.selector);
        mirror.setSettlement(1, address(settlement));

        vm.prank(admin);
        vm.expectRevert(IL1TallyMirror.UnsettledStateRoot.selector);
        mirror.postCertifiedResult(_cert(keccak256("r"), keccak256("unsettled")));

        bytes32 g = keccak256("genesis");
        vm.prank(admin);
        settlement.setGenesis(g);
        assertTrue(settlement.isSettledRoot(g));
        vm.prank(admin);
        mirror.postCertifiedResult(_cert(keccak256("r"), g));
    }

    // ------------------------------------------------------------------ M-06 (acknowledged)
    // OPENS_BALLOTS tally gas bound: no contract change; see report.

    // ------------------------------------------------------------------ M-07

    function testM07_StaffClearsRejectionOfPausedParty() public {
        uint256 cm = Fixtures.identityCommitment(uint256(4));
        (uint256 id,) = createElection();
        ExternalPartyRegistry parties = ExternalPartyRegistry(factory.getPartyRegistry(id));
        address op = makeAddr("partyOp");
        vm.prank(clerk);
        uint256 idx = parties.addParty(op, "Records", "", MODE_VETO);
        vm.prank(op);
        parties.reject(idx, cm, ReasonCodes.COURT_ORDER, bytes32(0));
        vm.prank(clerk);
        parties.setPartyActive(idx, false);
        assertTrue(parties.isRejected(cm), "stale rejection");

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IExternalPartyRegistry.NotPartyOperator.selector);
        parties.clearRejection(idx, cm, bytes32(0));

        vm.prank(clerk);
        parties.clearRejection(idx, cm, keccak256("appeal"));
        assertFalse(parties.isRejected(cm));
    }

    // ------------------------------------------------------------------ M-08

    function _account() internal returns (address acct, uint256 pk) {
        pk = 0xB0B;
        acct = accountFactory.createAccountWithBackupSigner(keccak256("m08"), 1, 2, vm.addr(pk), bytes32(0));
    }

    function testM08_PaymasterDefaultsOff() public {
        ZkVotingPaymaster fresh = new ZkVotingPaymaster(address(entryPoint), admin);
        assertFalse(fresh.alwaysSponsor());
    }

    function testM08_ExploitInitCodeNoLongerSponsorsArbitraryCall() public {
        vm.prank(admin);
        paymaster.setAlwaysSponsor(false);
        UserOp memory op;
        op.sender = makeAddr("undeployed");
        op.initCode = abi.encodePacked(address(accountFactory), bytes("x"));
        op.callData = abi.encodeWithSelector(PasskeyAccount.execute.selector, makeAddr("drain"), uint256(0), "");
        op.paymaster = address(paymaster);
        vm.prank(address(entryPoint));
        vm.expectRevert(IZkVotingPaymaster.NotSponsored.selector);
        paymaster.validateAndPay(op);

        // Value transfers into a civic target are not sponsored either.
        op.initCode = "";
        op.callData = abi.encodeWithSelector(PasskeyAccount.execute.selector, address(inbox), uint256(1), "");
        vm.prank(address(entryPoint));
        vm.expectRevert(IZkVotingPaymaster.NotSponsored.selector);
        paymaster.validateAndPay(op);

        // Deploy-only and zero-value civic calls stay sponsored.
        op.initCode = abi.encodePacked(address(accountFactory), bytes("x"));
        op.callData = "";
        vm.prank(address(entryPoint));
        assertTrue(paymaster.validateAndPay(op));
    }

    function testM08_ExploitOneBadOpNoLongerCensorsBatch() public {
        (address acct, uint256 pk) = _account();
        MedSink sink = new MedSink();
        UserOp[] memory ops = new UserOp[](3);
        ops[0] = signedExecuteOp(acct, address(sink), abi.encodeCall(MedSink.boom, ()), pk, 0);
        ops[1] = signedExecuteOp(acct, address(sink), abi.encodeCall(MedSink.bomb, ()), pk, 1);
        ops[2] = signedExecuteOp(acct, address(sink), abi.encodeCall(MedSink.ping, (9)), pk, 2);

        vm.recordLogs();
        vm.prank(relayer);
        entryPoint.handleOps(ops);
        assertEq(sink.value(), 9, "later op still ran");
        assertEq(PasskeyAccount(payable(acct)).nonce(), 3);

        bytes32 sig = keccak256("UserOpReverted(address,uint256,bytes)");
        uint256 reverted;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(entryPoint) && logs[i].topics[0] == sig) {
                (, bytes memory reason) = abi.decode(logs[i].data, (uint256, bytes));
                assertLe(reason.length, entryPoint.MAX_RETURN_BYTES(), "returndata capped");
                ++reverted;
            }
        }
        assertEq(reverted, 2);
    }
}
