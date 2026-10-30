// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {IBallotInbox} from "../src/interfaces/IBallotInbox.sol";
import {IElection} from "../src/interfaces/IElection.sol";
import {ElectionParams, ElectionType} from "../src/interfaces/ElectionParams.sol";
import {IRollupSettlement} from "../src/interfaces/IRollupSettlement.sol";
import {ITallyVerifier} from "../src/interfaces/ITallyVerifier.sol";
import {ElectionFactory} from "../src/ElectionFactory.sol";
import {GuardianCeremony} from "../src/GuardianCeremony.sol";
import {IElectionFactory} from "../src/interfaces/IElectionFactory.sol";
import {L1TallyMirror} from "../src/l2/L1TallyMirror.sol";
import {IL1TallyMirror} from "../src/interfaces/IL1TallyMirror.sol";
import {PoseidonT3} from "../src/hasher/PoseidonT3.sol";
import {RollupSettlement} from "../src/l2/RollupSettlement.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

contract PartialMath {
    struct Proof {
        uint256 pkX;
        uint256 pkY;
        uint256 c0X;
        uint256 c0Y;
        uint256 c1X;
        uint256 c1Y;
        uint256 dX;
        uint256 dY;
        uint256 aX;
        uint256 aY;
        uint256 bX;
        uint256 bY;
        uint256 z;
        uint256 rX;
        uint256 rY;
        uint256 sz;
    }

    function deal(
        uint256 share,
        uint256 nonce,
        uint256 electionId,
        uint8 electionType,
        address guardian,
        uint256 hourIndex,
        uint256 c0Scalar,
        uint256 c1X,
        uint256 c1Y
    ) public view returns (Proof memory p) {
        uint256 field = _field();
        (p.pkX, p.pkY) = this.mulG(share);
        (p.c0X, p.c0Y) = this.mulG(c0Scalar);
        p.c1X = c1X;
        p.c1Y = c1Y;
        (p.dX, p.dY) = this.mul(c1X, c1Y, share);
        (p.aX, p.aY) = this.mulG(nonce);
        (p.bX, p.bY) = this.mul(c1X, c1Y, nonce);
        uint256 e = uint256(
            keccak256(
                abi.encode(
                    keccak256("CHAUM_PEDERSEN_V1"),
                    electionId,
                    hourIndex,
                    guardian,
                    p.pkX,
                    p.pkY,
                    p.c1X,
                    p.c1Y,
                    p.dX,
                    p.dY,
                    p.aX,
                    p.aY,
                    p.bX,
                    p.bY
                )
            )
        ) % field;
        p.z = addmod(nonce, mulmod(e, share, field), field);
        uint256 schnorrNonce = nonce + 17;
        (p.rX, p.rY) = this.mulG(schnorrNonce);
        uint256 es = uint256(
            keccak256(
                abi.encode(
                    keccak256("GUARDIAN_SCHNORR_V1"),
                    electionId,
                    electionType,
                    guardian,
                    p.pkX,
                    p.pkY,
                    p.rX,
                    p.rY
                )
            )
        ) % field;
        p.sz = addmod(schnorrNonce, mulmod(es, share, field), field);
    }

    function mulG(uint256 s) external view returns (uint256 xOut, uint256 yOut) {
        return this.mul(1, 2, s);
    }

    function mul(uint256 x, uint256 y, uint256 s) external view returns (uint256 xOut, uint256 yOut) {
        uint256[3] memory input;
        input[0] = x;
        input[1] = y;
        input[2] = s % _field();
        uint256[2] memory output;
        bool ok;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 7, input, 96, output, 64)
        }
        require(ok, "ecmul");
        xOut = output[0];
        yOut = output[1];
    }

    function _field() private pure returns (uint256) {
        return 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    }
}

/// @notice Sealed hourly, final, and supplementary batches.
contract SealedVoteBatchTest is Deployer {
    using stdStorage for StdStorage;

    uint256 internal constant RELAYER_KEY = 0xA11CE;
    uint256 internal constant FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    PartialMath internal math;
    GuardianCeremony internal ceremony;
    uint256[2] internal pa;
    uint256[2][2] internal pb;
    uint256[2] internal pc;

    function setUp() public {
        deployStack();
        this.arm();
    }

    function arm() external {
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        (pa, pb, pc) = Fixtures.dummyProof();
        vm.prank(admin);
        factory.setRelayer(vm.addr(RELAYER_KEY), true);
        math = new PartialMath();
    }

    function testFinalHourRevoteIsCarriedBySupplementary() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        submitVote(id, el, 7);
        assertEq(inbox.acceptedBallots(id), 0, "unique count waits for a batch");
        bytes32 hourRoot = keccak256("hour-root");
        bytes32 hourly = keccak256("hourly");
        bytes32 finalP = keccak256("final");
        this.hour(id, hourRoot, hourly, finalP, 0, 1);
        assertEq(inbox.acceptedBallots(id), 1);
        warpClosed(el);
        bytes32 finalRoot = keccak256("final-root");
        this.sealFinal(id, finalRoot, hourly, finalP, 1);
        assertEq(inbox.acceptedBallots(id), 1, "final batch carries no turnout step");
        uint256 sid = this.hold(id, el, 99, finalRoot, uint64(IElection(el).params().cutoffTime) - 1);
        vm.warp(tally.tallyAllowedAt(id));
        this.suppOne(id, finalRoot, hourly, keccak256("final-with-revote"), sid, true);
        (, bool pending) = inbox.forcedInRoot(id, sid);
        assertFalse(pending);
        assertEq(inbox.pendingForcedIn(id).length, 0);
        assertEq(inbox.acceptedBallots(id), 1, "a replacement does not add a voter");
        assertTrue(settlement.supplementaryPosted(id));
    }

    function testReceiptAfterCutoffIsRejected() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        bytes32 hourly = keccak256("h");
        this.hour(id, keccak256("hour-root-2"), hourly, keccak256("f"), 0, 0);
        warpClosed(el);
        this.sealFinal(id, keccak256("final-root-2"), hourly, keccak256("f"), 0);
        uint64 cutoff = IElection(el).params().cutoffTime;
        vm.expectRevert(IBallotInbox.ReceiptAfterCutoff.selector);
        this.hold(id, el, 99, keccak256("final-root-2"), cutoff);
    }

    function testForcedInUsesReceiptRootAndClosesAtTally() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        bytes32 hourRoot = keccak256("receipt-root");
        this.hour(id, hourRoot, keccak256("h3"), keccak256("f3"), 0, 0);
        uint64 cutoff = IElection(el).params().cutoffTime;
        vm.warp(cutoff + 1 hours);
        uint256 sid = this.forceAt(id, el, 42, hourRoot, cutoff - 1);
        (bytes32 root, bool pending) = inbox.forcedInRoot(id, sid);
        assertEq(root, hourRoot);
        assertTrue(pending);
        assertEq(inbox.acceptedBallots(id), 0, "force-in does not publish turnout");
        vm.expectRevert(IBallotInbox.UnknownBoundRoot.selector);
        this.forceAt(id, el, 43, keccak256("not-a-posted-root"), cutoff - 1);
        vm.expectRevert(IBallotInbox.UnknownBoundRoot.selector);
        this.forceAt(id, el, 45, bytes32(0), cutoff - 1);
        vm.warp(tally.tallyAllowedAt(id));
        vm.expectRevert(IBallotInbox.ForceInClosed.selector);
        this.forceAt(id, el, 44, hourRoot, cutoff - 1);
    }

    function testSupplementaryRechecksReceiptRootInTheChain() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        bytes32 hourRoot = keccak256("chain-root");
        bytes32 hourly = keccak256("h4");
        this.hour(id, hourRoot, hourly, keccak256("f4"), 0, 0);
        uint64 cutoff = IElection(el).params().cutoffTime;
        vm.warp(cutoff + 30 minutes);
        uint256 sid = this.forceAt(id, el, 42, hourRoot, cutoff - 1);
        bytes32 finalRoot = keccak256("chain-final");
        this.sealFinal(id, finalRoot, hourly, keccak256("f4"), 0);
        vm.warp(tally.tallyAllowedAt(id));
        this.expectBadChain(id, finalRoot, hourly, sid);
        this.suppOne(id, finalRoot, hourly, keccak256("f4b"), sid, false);
        assertEq(inbox.acceptedBallots(id), 1, "forced-in first ballot counts in the supplementary step");
        (, bool stillPending) = inbox.forcedInRoot(id, sid);
        assertFalse(stillPending);
    }

    function testMockModeStaysOperatorOnlyAfterGrace() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        bytes32 hourly = keccak256("h5");
        bytes32 finalRoot = keccak256("rf5");
        this.hour(id, keccak256("r5"), hourly, keccak256("f5"), 0, 0);
        warpClosed(el);
        this.sealFinal(id, finalRoot, hourly, keccak256("f5"), 0);
        address stranger = makeAddr("stranger");
        vm.warp(tally.tallyAllowedAt(id));
        vm.expectRevert(IRollupSettlement.NotAuthorized.selector);
        this.suppEmpty(id, finalRoot, hourly, keccak256("f5"), stranger);
        vm.warp(tally.tallyAllowedAt(id) + settlement.SUPPLEMENTARY_GRACE());
        vm.expectRevert(IRollupSettlement.NotAuthorized.selector);
        this.suppEmpty(id, finalRoot, hourly, keccak256("f5"), stranger);
        this.suppEmpty(id, finalRoot, hourly, keccak256("f5"), sequencer);
        assertTrue(settlement.supplementaryPosted(id));
    }

    function testStrangerMayPostAfterGraceOutsideMockMode() public {
        RollupSettlement live = new RollupSettlement(admin, sequencer, prover, address(verifier), false);
        vm.startPrank(admin);
        live.setElectionFactory(address(factory));
        live.setInbox(address(inbox));
        vm.stopPrank();
        settlement = live;
        (uint256 id, address el) = this.openLinked(1 hours);
        bytes32 hourly = keccak256("hlive");
        bytes32 finalRoot = keccak256("rflive");
        this.hour(id, keccak256("rlive"), hourly, keccak256("flive"), 0, 0);
        warpClosed(el);
        this.sealFinal(id, finalRoot, hourly, keccak256("flive"), 0);
        address stranger = makeAddr("live-stranger");
        vm.warp(tally.tallyAllowedAt(id));
        vm.expectRevert(IRollupSettlement.NotAuthorized.selector);
        this.suppEmpty(id, finalRoot, hourly, keccak256("flive"), stranger);
        vm.warp(tally.tallyAllowedAt(id) + live.SUPPLEMENTARY_GRACE());
        this.suppEmpty(id, finalRoot, hourly, keccak256("flive"), stranger);
        assertTrue(live.supplementaryPosted(id));
    }

    function testSupplementaryFlagGatesTallyDecryptAndFinalPartials() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        bytes32 hourly = keccak256("h6");
        bytes32 finalRoot = keccak256("rf6");
        this.hour(id, keccak256("r6"), hourly, keccak256("f6"), 0, 0);
        warpClosed(el);
        this.sealFinal(id, finalRoot, hourly, keccak256("f6"), 0);
        vm.warp(tally.tallyAllowedAt(id));
        this.expectTallyBlocked(id);
        this.suppEmpty(id, finalRoot, hourly, keccak256("f6"), sequencer);
        this.postCount(id, 0);
        assertTrue(tally.isTallied(id));
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.PlaintextMismatch.selector);
        tally.submitDecryption(id, keccak256("plain"), new uint8[](0));
    }

    function testFinalBatchRejectsATurnoutStep() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        bytes32 hourly = keccak256("h7");
        bytes32 hourRoot = keccak256("r7");
        this.hour(id, hourRoot, hourly, keccak256("f7"), 0, 1);
        warpClosed(el);
        vm.expectRevert(IRollupSettlement.TurnoutOnFinalBatch.selector);
        this.sealMismatch(id, keccak256("rf7"), hourly, keccak256("f7"));
        assertEq(inbox.acceptedBallots(id), 1);
    }

    function testStaleBoundRootAndDuplicateFirstBallot() public {
        (uint256 id,) = this.openLinked(2 hours);
        bytes32 first = keccak256("r8");
        this.hour(id, first, keccak256("h8"), keccak256("f8"), 0, 1);
        vm.expectRevert(IRollupSettlement.HourAlreadyPosted.selector);
        this.hour(id, keccak256("r8-again"), keccak256("h8b"), keccak256("f8b"), 1, 1);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(IRollupSettlement.BoundRootMismatch.selector);
        this.hourBound(id, keccak256("r8b"), bytes32(0), keccak256("tag-a"));
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(IRollupSettlement.DuplicateFirstBallot.selector);
        this.hourDup(id, keccak256("r8c"), first);
        vm.expectRevert(IRollupSettlement.DuplicateFirstBallot.selector);
        this.hourSameTag(id, keccak256("r8d"), keccak256(abi.encodePacked("first", id, first)));
    }

    function testOfflineDeviceLeavesTheEarlierBallot() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        submitVote(id, el, 7);
        bytes32 hourly = keccak256("h9");
        bytes32 finalRoot = keccak256("rf9");
        this.hour(id, keccak256("r9"), hourly, keccak256("f9"), 0, 1);
        warpClosed(el);
        this.sealFinal(id, finalRoot, hourly, keccak256("f9"), 1);
        vm.warp(tally.tallyAllowedAt(id));
        this.suppEmpty(id, finalRoot, hourly, keccak256("f9"), sequencer);
        assertEq(inbox.pendingForcedIn(id).length, 0);
        assertEq(inbox.acceptedBallots(id), 1);
    }

    function testChallengeWindowRejectsZeroAndGatesTally() public {
        (uint256 id, address el) = createElection();
        assertEq(tally.challengeWindow(id), tally.MIN_CHALLENGE_WINDOW());
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.ZeroChallengeWindow.selector);
        tally.setChallengeWindow(id, 0);
        vm.prank(tallyOperator);
        tally.setChallengeWindow(id, 2 hours);
        vm.prank(tallyOperator);
        vm.expectPartialRevert(ITallyVerifier.ChallengeWindowAlreadySet.selector);
        tally.setChallengeWindow(id, 3 hours);
        warpOpen(el);
        vm.prank(tallyOperator);
        vm.expectPartialRevert(ITallyVerifier.ChallengeWindowLocked.selector);
        tally.setChallengeWindow(id, 4 hours);
        registerVoter(id, Fixtures.identityCommitment(uint256(3)));
        freezeRoll(el);
        submitVote(id, el, 8);
        vm.warp(IElection(el).params().cutoffTime);
        this.expectWindowOpen(id);
        vm.warp(tally.tallyAllowedAt(id));
        this.postCount(id, 1);
        assertTrue(tally.isTallied(id));
    }

    function testZeroStoredWindowReverts() public {
        (uint256 id,) = createElection();
        stdstore.target(address(tally)).sig("challengeWindow(uint256)").with_key(id).checked_write(uint256(0));
        vm.expectRevert(ITallyVerifier.ZeroChallengeWindow.selector);
        tally.tallyAllowedAt(id);
        vm.expectRevert(ITallyVerifier.ZeroChallengeWindow.selector);
        this.postCount(id, 0);
    }

    function testBallotRefusedUntilKeyPosted() public {
        (uint256 id, address el) = createElection();
        GuardianCeremony local = new GuardianCeremony(address(factory));
        vm.startPrank(admin);
        inbox.setSettlement(id, address(settlement));
        inbox.setCeremony(id, address(local));
        vm.stopPrank();
        registerVoter(id, Fixtures.identityCommitment(uint256(9)));
        freezeRoll(el);
        warpOpen(el);
        this.expectKeyMissing(id, el, 5);
    }

    function testCeremonyIsFeldmanAndChecksType() public {
        (uint256 id,) = createElection();
        ceremony = new GuardianCeremony(address(factory));
        address[] memory gs = new address[](2);
        gs[0] = makeAddr("g1");
        gs[1] = makeAddr("g2");
        vm.prank(tallyOperator);
        vm.expectRevert(GuardianCeremony.WrongElectionType.selector);
        ceremony.openCeremony(id, ElectionType.VOTE, 2, 2, gs);
        vm.prank(tallyOperator);
        ceremony.openCeremony(id, ElectionType.POLL, 2, 2, gs);
        vm.expectRevert(GuardianCeremony.NotGuardian.selector);
        this.postDeal(id, makeAddr("stranger"), 2, 3, 19);
        vm.expectRevert(GuardianCeremony.BadSchnorr.selector);
        this.postBadDeal(id, gs[1], 3, FIELD - 2, 13);
        this.postDeal(id, gs[1], 3, FIELD - 2, 13);
        assertEq(ceremony.guardianIndex(id, ElectionType.POLL, gs[1]), 2);
        this.postDeal(id, gs[0], 2, 3, 11);
        assertTrue(ceremony.keyPosted(id, ElectionType.POLL));
        (uint256 x, uint256 y) = ceremony.jointKey(id, ElectionType.POLL);
        (uint256 expectX, uint256 expectY) = math.mulG(5);
        assertEq(x, expectX);
        assertEq(y, expectY);
        (uint256 pkX, uint256 pkY, bool ok) = ceremony.guardianPk(id, ElectionType.POLL, gs[0]);
        (uint256 shareX, uint256 shareY) = math.mulG(6);
        assertTrue(ok);
        assertEq(pkX, shareX);
        assertEq(pkY, shareY);
        (pkX, pkY, ok) = ceremony.guardianPk(id, ElectionType.POLL, gs[1]);
        (shareX, shareY) = math.mulG(7);
        assertTrue(ok);
        assertEq(pkX, shareX);
        assertEq(pkY, shareY);
    }

    function testHourlyPartialIsPollAndGated() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        bytes32 interim = keccak256("interim");
        vm.prank(tallyOperator);
        tally.postInterimResult(id, interim);
        uint256 hourIndex = block.timestamp / 1 hours;
        vm.expectRevert(ITallyVerifier.HourNotPosted.selector);
        this.submitHour(id, makeAddr("g1"), 6, 21, hourIndex, false);
        this.hourPoints(id, keccak256("rh"), keccak256("hh"), keccak256("fh"), 0, 0, 1, 2, 1, 2);
        vm.expectRevert(ITallyVerifier.HourGateClosed.selector);
        this.submitHour(id, makeAddr("g1"), 6, 21, hourIndex, false);
        vm.warp(uint256(IElection(el).params().cutoffTime) + 30 minutes);
        vm.expectRevert(ITallyVerifier.InvalidPartial.selector);
        this.submitHour(id, makeAddr("g2"), 7, 23, hourIndex, true);
        this.submitHour(id, makeAddr("g1"), 6, 21, hourIndex, false);
        assertEq(tally.interimResult(id), interim, "hourly partial is not the interim write");
        assertTrue(tally.hourlyPartialPosted(id, hourIndex, makeAddr("g1")));
        vm.expectRevert(ITallyVerifier.PartialAlreadyPosted.selector);
        this.submitHour(id, makeAddr("g1"), 6, 21, hourIndex, false);
    }

    function testVoteElectionRejectsHourlyPartial() public {
        ElectionParams memory params = defaultParams();
        params.electionType = ElectionType.VOTE;
        (uint256 id,) = createElection(params);
        GuardianCeremony voteCeremony = new GuardianCeremony(address(factory));
        vm.prank(admin);
        tally.setCeremony(id, address(voteCeremony));
        vm.expectRevert(ITallyVerifier.NotPoll.selector);
        this.submitHour(id, makeAddr("g1"), 6, 21, 1, false);
    }

    function testDecryptionCombinesKPartials() public {
        (uint256 id, address el) = this.openLinked(1 hours);
        bytes32 hourly = keccak256("hd");
        this.hour(id, keccak256("rd"), hourly, keccak256("fd"), 0, 1);
        warpClosed(el);
        this.sealFinal(id, keccak256("rfd"), hourly, keccak256("fd"), 1);
        (uint256 c1x, uint256 c1y) = math.mulG(3);
        (uint256 c2x, uint256 c2y) = math.mulG(16);
        uint8[] memory subset = new uint8[](2);
        subset[0] = 1;
        subset[1] = 2;
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        bytes32 plain = keccak256(abi.encode(counts));
        vm.prank(tallyOperator);
        vm.expectPartialRevert(ITallyVerifier.SupplementaryBatchRequired.selector);
        tally.submitDecryption(id, plain, subset);
        this.suppCipher(id, keccak256("rfd"), hourly, keccak256("fd2"), c1x, c1y, c2x, c2y);
        this.postCount(id, 1);
        this.oneFinal(id, makeAddr("g1"), 6, 31, c1x, c1y);
        uint8[] memory short = new uint8[](1);
        short[0] = 1;
        vm.prank(tallyOperator);
        vm.expectPartialRevert(ITallyVerifier.NotEnoughPartials.selector);
        tally.submitDecryption(id, plain, short);
        this.oneFinal(id, makeAddr("g2"), 7, 33, c1x, c1y);
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.PlaintextMismatch.selector);
        tally.submitDecryption(id, keccak256("not-the-point"), subset);
        vm.prank(tallyOperator);
        tally.submitDecryption(id, plain, subset);
        assertEq(tally.decryptionHash(id), plain);
    }

    function testTwoSealedBallotsShareNoVoterId() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        uint256 voter = 42;
        bytes memory enc1 = Fixtures.encryptedBallot(1);
        bytes memory enc2 = Fixtures.encryptedBallot(2);
        uint256 sid1 = PoseidonT3.hashLeftRight(voter, uint256(keccak256(enc1)) % FIELD);
        uint256 sid2 = PoseidonT3.hashLeftRight(voter, uint256(keccak256(enc2)) % FIELD);
        assertTrue(sid1 != sid2);
        assertTrue(sid1 != voter && sid2 != voter);
        submitVote(id, el, sid1);
        submitVote(id, el, sid2);
        assertTrue(inbox.nullifierUsed(id, sid1));
        assertTrue(inbox.nullifierUsed(id, sid2));
        assertFalse(inbox.nullifierUsed(id, voter));
    }

    function testStrangerCannotPostGuardian() public {
        (uint256 id,) = createElection();
        ceremony = new GuardianCeremony(address(factory));
        address[] memory gs = new address[](2);
        gs[0] = makeAddr("g1");
        gs[1] = makeAddr("g2");
        vm.prank(tallyOperator);
        ceremony.openCeremony(id, ElectionType.POLL, 2, 2, gs);
        vm.expectRevert(GuardianCeremony.NotGuardian.selector);
        this.postDeal(id, makeAddr("stranger"), 2, 3, 19);
    }

    function testWrongGuardianShareRejected() public {
        (uint256 id, address el) = this.openLinked(4 hours);
        this.hourPoints(id, keccak256("rw"), keccak256("hw"), keccak256("fw"), 0, 0, 1, 2, 1, 2);
        uint256 hourIndex = block.timestamp / 1 hours;
        vm.warp(uint256(IElection(el).params().cutoffTime) + 30 minutes);
        vm.expectRevert(ITallyVerifier.InvalidPartial.selector);
        this.submitHour(id, makeAddr("g1"), 4, 21, hourIndex, false);
        this.submitHour(id, makeAddr("g1"), 6, 21, hourIndex, false);
        assertTrue(tally.hourlyPartialPosted(id, hourIndex, makeAddr("g1")));
    }

    function testDecryptionSubsetSkipsABadPartial() public {
        (uint256 id, address el) = this.openLinked(1 hours);
        bytes32 hourly = keccak256("hs");
        this.hour(id, keccak256("rs"), hourly, keccak256("fs"), 0, 1);
        warpClosed(el);
        this.sealFinal(id, keccak256("rfs"), hourly, keccak256("fs"), 1);
        (uint256 c1x, uint256 c1y) = math.mulG(3);
        (uint256 c2x, uint256 c2y) = math.mulG(16);
        this.suppCipher(id, keccak256("rfs"), hourly, keccak256("fs2"), c1x, c1y, c2x, c2y);
        this.postCount(id, 1);
        PartialMath.Proof memory bad =
            math.deal(4, 41, id, ElectionType.POLL, makeAddr("g2"), type(uint256).max, 5, c1x, c1y);
        vm.prank(makeAddr("g2"));
        vm.expectRevert(ITallyVerifier.InvalidPartial.selector);
        tally.submitFinalPartial(id, bad.dX, bad.dY, bad.aX, bad.aY, bad.bX, bad.bY, bad.z);
        this.oneFinal(id, makeAddr("g1"), 6, 31, c1x, c1y);
        this.oneFinal(id, makeAddr("g2"), 7, 33, c1x, c1y);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        bytes32 plain = keccak256(abi.encode(counts));
        uint8[] memory badSubset = new uint8[](2);
        badSubset[0] = 1;
        badSubset[1] = 9;
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.InvalidPartial.selector);
        tally.submitDecryption(id, plain, badSubset);
        uint8[] memory subset = new uint8[](2);
        subset[0] = 1;
        subset[1] = 2;
        vm.prank(tallyOperator);
        tally.submitDecryption(id, plain, subset);
        assertEq(tally.decryptionHash(id), plain);
    }

    function testLinkAfterStartReverts() public {
        (uint256 id, address el) = createElection();
        warpOpen(el);
        vm.prank(admin);
        vm.expectRevert(IBallotInbox.LinksLocked.selector);
        inbox.setSettlement(id, address(settlement));
        vm.prank(admin);
        vm.expectRevert(IBallotInbox.LinksLocked.selector);
        inbox.setCeremony(id, address(settlement));
        vm.prank(admin);
        vm.expectRevert(ITallyVerifier.LinksLocked.selector);
        tally.setRollupSettlement(id, address(settlement));
        vm.prank(admin);
        vm.expectRevert(ITallyVerifier.LinksLocked.selector);
        tally.setCeremony(id, address(settlement));
    }

    function testRevotesDoNotOpenTheHourlyGate() public {
        (uint256 id, address el) = this.openLinked(4 hours);
        this.hourPoints(id, keccak256("rgate"), keccak256("hgate"), keccak256("fgate"), 0, 0, 1, 2, 1, 2);
        uint256 hourIndex = block.timestamp / 1 hours;
        vm.warp(block.timestamp + 30 minutes);
        assertLt(block.timestamp, IElection(el).params().cutoffTime);
        stdstore.target(address(inbox)).sig("acceptedBallots(uint256)").with_key(id).checked_write(uint256(1000));
        vm.expectRevert(ITallyVerifier.HourGateClosed.selector);
        this.submitHour(id, makeAddr("g1"), 6, 21, hourIndex, false);
        stdstore.target(address(inbox)).sig("firstBallots(uint256)").with_key(id).checked_write(uint256(100));
        this.submitHour(id, makeAddr("g1"), 6, 21, hourIndex, false);
        assertTrue(tally.hourlyPartialPosted(id, hourIndex, makeAddr("g1")));
    }

    function testZeroWindowBlocksFinalizeAndTally() public {
        (uint256 id, address el) = createElection();
        stdstore.target(address(tally)).sig("challengeWindow(uint256)").with_key(id).checked_write(uint256(0));
        vm.warp(IElection(el).params().cutoffTime);
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.ZeroChallengeWindow.selector);
        tally.postInterimResult(id, keccak256("late"));
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.ZeroChallengeWindow.selector);
        tally.disclose(id, keccak256("late-disc"));
        vm.expectRevert(ITallyVerifier.ZeroChallengeWindow.selector);
        tally.tallyAllowedAt(id);
        vm.expectRevert(ITallyVerifier.ZeroChallengeWindow.selector);
        this.postCount(id, 0);
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.ZeroChallengeWindow.selector);
        tally.submitDecryption(id, keccak256("plain"), new uint8[](0));
    }

    function testChallengeWindowBelowMinimumReverts() public {
        (uint256 id,) = createElection();
        vm.startPrank(tallyOperator);
        vm.expectRevert(ITallyVerifier.ZeroChallengeWindow.selector);
        tally.setChallengeWindow(id, 0);
        vm.expectRevert(ITallyVerifier.ChallengeWindowTooShort.selector);
        tally.setChallengeWindow(id, 30 minutes);
        tally.setChallengeWindow(id, 2 hours);
        vm.stopPrank();
        assertEq(tally.challengeWindow(id), 2 hours);
    }

    function testVoteRequiresATally() public {
        ElectionFactory naked = new ElectionFactory(admin, address(0));
        ElectionParams memory params = defaultParams();
        params.electionType = ElectionType.VOTE;
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.TallyVerifierNotSet.selector);
        naked.createElection(params);
        params.electionType = ElectionType.POLL;
        vm.prank(admin);
        (uint256 id,) = naked.createElection(params);
        assertGt(id, 0);
    }

    function testEmptyCiphertextIsZeroCount() public {
        (uint256 id, address el) = this.openLinked(1 hours);
        bytes32 hourly = keccak256("he");
        this.hour(id, keccak256("re"), hourly, keccak256("fe"), 0, 0);
        warpClosed(el);
        this.sealFinal(id, keccak256("rfe"), hourly, keccak256("fe"), 0);
        this.suppCipher(id, keccak256("rfe"), hourly, keccak256("fe2"), 0, 0, 0, 0);
        this.postCount(id, 0);
        uint256[] memory counts = new uint256[](1);
        bytes32 plain = keccak256(abi.encode(counts));
        vm.prank(tallyOperator);
        tally.submitDecryption(id, plain, new uint8[](0));
        assertEq(tally.decryptionHash(id), plain);
    }

    function testOptionCiphertextRequired() public {
        (uint256 id, address el) = this.openLinked(1 hours);
        bytes32 hourly = keccak256("ho");
        this.hour(id, keccak256("ro"), hourly, keccak256("fo"), 0, 0);
        warpClosed(el);
        this.sealFinal(id, keccak256("rfo"), hourly, keccak256("fo"), 0);
        this.suppCipher(id, keccak256("rfo"), hourly, keccak256("fo2"), 0, 0, 0, 0);
        uint256[] memory counts = new uint256[](2);
        vm.prank(tallyOperator);
        tally.submitTally(id, counts, pa, pb, pc);
        bytes32 plain = keccak256(abi.encode(counts));
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.CiphertextMissing.selector);
        tally.submitDecryption(id, plain, new uint8[](0));
        vm.prank(tallyOperator);
        tally.postOptionCiphertext(id, 1, 0, 0, 0, 0);
        vm.prank(tallyOperator);
        tally.submitDecryption(id, plain, new uint8[](0));
        assertEq(tally.decryptionHash(id), plain);
    }

    function testMirrorSettlementIsPerElection() public {
        L1TallyMirror mirror = new L1TallyMirror(admin, address(0));
        vm.prank(admin);
        mirror.setSettlement(1, address(settlement));
        vm.prank(admin);
        mirror.setSettlement(2, address(settlement));
        assertEq(mirror.settlementOf(1), address(settlement));
        assertEq(mirror.settlementOf(2), address(settlement));
        assertEq(mirror.settlementOf(3), address(0));
        vm.prank(admin);
        mirror.postResult(3, keccak256("free"), 1, keccak256("any-root"));
        vm.prank(admin);
        vm.expectRevert(IL1TallyMirror.UnsettledStateRoot.selector);
        mirror.postResult(1, keccak256("pinned"), 1, keccak256("missing-root"));
    }

    function testLegacySecondBallotDoesNotDoubleCount() public {
        (uint256 id, address el) = createElection();
        registerVoter(id, Fixtures.identityCommitment(uint256(4)));
        freezeRoll(el);
        warpOpen(el);
        submitVote(id, el, 7);
        this.expectSameNullifier(id, el, 7);
        assertEq(inbox.acceptedBallots(id), 1);
    }

    function testCommitUniqueRevertsWhenUnlinked() public {
        (uint256 id, address el) = createElection();
        registerVoter(id, Fixtures.identityCommitment(uint256(5)));
        freezeRoll(el);
        warpOpen(el);
        vm.expectRevert(IRollupSettlement.NotAuthorized.selector);
        this.hour(id, keccak256("unlinked"), keccak256("hu"), keccak256("fu"), 0, 0);
    }

    function testFactoryUnsetReverts() public {
        RollupSettlement bare = new RollupSettlement(admin, sequencer, prover, address(verifier), true);
        IRollupSettlement.SealedParams memory p;
        p.electionId = 1;
        p.ballotSetRoot = keccak256("root");
        vm.expectRevert(IRollupSettlement.FactoryUnset.selector);
        bare.submitHourlyBatch(p, new bytes32[](0), new bytes32[](0), pa, pb, pc);
    }

    function testZeroBallotRootIsRejected() public {
        (uint256 id,) = this.openLinked(2 hours);
        vm.expectRevert(IRollupSettlement.EmptyRoot.selector);
        this.hour(id, bytes32(0), keccak256("hz"), keccak256("fz"), 0, 0);
    }

    function testUniqueAndProductMustChain() public {
        (uint256 id,) = this.openLinked(2 hours);
        bytes32 first = keccak256("chain-1");
        this.hour(id, first, keccak256("hc1"), keccak256("fc1"), 0, 1);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(IRollupSettlement.UniqueCountMismatch.selector);
        this.hour(id, keccak256("chain-2"), keccak256("hc1"), keccak256("fc1"), 0, 1);
        vm.expectRevert(IRollupSettlement.ProductMismatch.selector);
        this.hourBadProduct(id, keccak256("chain-3"));
        this.hour(id, keccak256("chain-4"), keccak256("hc2"), keccak256("fc1"), 1, 1);
    }

    function testSupplementaryWithoutFinalAfterGrace() public {
        (uint256 id,) = this.openLinked(1 hours);
        bytes32 hourly = keccak256("h-live");
        bytes32 root = keccak256("r-live");
        this.hour(id, root, hourly, keccak256("f-live"), 0, 0);
        vm.warp(tally.tallyAllowedAt(id));
        vm.expectRevert(IRollupSettlement.FinalBatchRequired.selector);
        this.suppEmpty(id, root, hourly, keccak256("f-live"), sequencer);
        vm.warp(tally.tallyAllowedAt(id) + settlement.SUPPLEMENTARY_GRACE());
        this.suppEmpty(id, root, hourly, keccak256("f-live"), sequencer);
        assertTrue(settlement.supplementaryPosted(id));
        assertTrue(settlement.finalBatchPosted(id));
        assertEq(settlement.finalBatchRoot(id), root);
    }

    function testPendingListHoldsBallot65() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        bytes32 hourRoot = keccak256("cap-root");
        this.hour(id, hourRoot, keccak256("hcap"), keccak256("fcap"), 0, 0);
        vm.warp(uint256(IElection(el).params().cutoffTime) + 30 minutes);
        this.forceMany(id, el, hourRoot, 65);
        assertEq(inbox.pendingForcedIn(id).length, 65);
    }

    function testReceiptDigestBindsChainAndReproof() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        bytes32 hourly = keccak256("h-dig");
        bytes32 finalRoot = keccak256("rf-dig");
        this.hour(id, keccak256("r-dig"), hourly, keccak256("f-dig"), 0, 0);
        warpClosed(el);
        this.sealFinal(id, finalRoot, hourly, keccak256("f-dig"), 0);
        IBallotInbox.RelayerReceipt memory receipt;
        receipt.boundRoot = finalRoot;
        bytes32 first = inbox.receiptDigest(id, receipt);
        vm.chainId(block.chainid + 1);
        assertTrue(inbox.receiptDigest(id, receipt) != first);
        vm.chainId(block.chainid - 1);
        uint64 receivedAt = uint64(IElection(el).params().cutoffTime) - 1;
        vm.expectRevert(IBallotInbox.UnknownBoundRoot.selector);
        this.hold(id, el, 4, keccak256("not-the-final-root"), receivedAt);
        verifier.setAccept(false);
        vm.expectRevert(IBallotInbox.InvalidProof.selector);
        this.hold(id, el, 4, finalRoot, receivedAt);
        verifier.setAccept(true);
    }

    function openLinked(uint64 window) external returns (uint256 id, address el) {
        (id, el) = createElection();
        vm.prank(tallyOperator);
        tally.setChallengeWindow(id, window);
        ceremony = new GuardianCeremony(address(factory));
        vm.startPrank(admin);
        inbox.setSettlement(id, address(settlement));
        inbox.setCeremony(id, address(ceremony));
        tally.setRollupSettlement(id, address(settlement));
        tally.setCeremony(id, address(ceremony));
        vm.stopPrank();
        this.sealKey(id);
        registerVoter(id, Fixtures.identityCommitment(uint256(1)));
        freezeRoll(el);
        warpOpen(el);
    }

    function sealKey(uint256 id) external {
        address[] memory gs = new address[](2);
        gs[0] = makeAddr("g1");
        gs[1] = makeAddr("g2");
        vm.prank(tallyOperator);
        ceremony.openCeremony(id, ElectionType.POLL, 2, 2, gs);
        this.postDeal(id, gs[0], 2, 3, 11);
        this.postDeal(id, gs[1], 3, FIELD - 2, 13);
    }

    function postDeal(uint256 id, address guardian, uint256 a0, uint256 a1, uint256 nonce) external {
        this.postDealZ(id, guardian, a0, a1, nonce, false);
    }

    function postBadDeal(uint256 id, address guardian, uint256 a0, uint256 a1, uint256 nonce) external {
        this.postDealZ(id, guardian, a0, a1, nonce, true);
    }

    function postDealZ(uint256 id, address guardian, uint256 a0, uint256 a1, uint256 nonce, bool bad) external {
        uint256[] memory cx = new uint256[](2);
        uint256[] memory cy = new uint256[](2);
        (cx[0], cy[0]) = math.mulG(a0);
        (cx[1], cy[1]) = math.mulG(a1);
        (uint256 rX, uint256 rY) = math.mulG(nonce);
        uint256 e = ceremony.schnorrChallenge(id, ElectionType.POLL, guardian, cx, cy, rX, rY);
        uint256 z = addmod(nonce, mulmod(e, a0, FIELD), FIELD);
        if (bad) z += 1;
        vm.prank(guardian);
        ceremony.postGuardian(id, ElectionType.POLL, cx, cy, rX, rY, z);
    }

    struct Job {
        uint256 id;
        uint8 kind;
        bytes32 root;
        bytes32 hourly;
        bytes32 finalP;
        uint256 prevU;
        uint256 nextU;
        bytes32 chain;
        address who;
    }

    function hour(uint256 id, bytes32 root, bytes32 hourly, bytes32 finalP, uint256 prevU, uint256 nextU) external {
        bytes32[] memory bound = new bytes32[](1);
        bound[0] = settlement.lastHourlyRoot(id);
        bytes32[] memory tags = new bytes32[](1);
        tags[0] = keccak256(abi.encodePacked("first", id, root));
        this.post(Job(id, 1, root, hourly, finalP, prevU, nextU, bytes32(0), sequencer), bound, tags, new uint256[](0));
    }

    function hourBound(uint256 id, bytes32 root, bytes32 boundRoot, bytes32 tag) external {
        bytes32[] memory bound = new bytes32[](1);
        bound[0] = boundRoot;
        bytes32[] memory tags = new bytes32[](1);
        tags[0] = tag;
        this.post(
            Job(id, 1, root, keccak256("h8"), keccak256("f8"), 1, 1, bytes32(0), sequencer), bound, tags, new uint256[](0)
        );
    }

    function hourDup(uint256 id, bytes32 root, bytes32 boundRoot) external {
        bytes32[] memory bound = new bytes32[](2);
        bound[0] = boundRoot;
        bound[1] = boundRoot;
        bytes32[] memory tags = new bytes32[](2);
        tags[0] = keccak256("same");
        tags[1] = tags[0];
        this.post(
            Job(id, 1, root, keccak256("h8"), keccak256("f8"), 1, 2, bytes32(0), sequencer), bound, tags, new uint256[](0)
        );
    }

    function hourSameTag(uint256 id, bytes32 root, bytes32 tag) external {
        bytes32[] memory bound = new bytes32[](1);
        bound[0] = settlement.lastHourlyRoot(id);
        bytes32[] memory tags = new bytes32[](1);
        tags[0] = tag;
        uint256 n = inbox.acceptedBallots(id);
        this.post(
            Job(id, 1, root, settlement.hourlyProduct(id), settlement.finalProduct(id), n, n, bytes32(0), sequencer),
            bound,
            tags,
            new uint256[](0)
        );
    }

    function hourBadProduct(uint256 id, bytes32 root) external {
        bytes32[] memory bound = new bytes32[](1);
        bound[0] = settlement.lastHourlyRoot(id);
        bytes32[] memory tags = new bytes32[](1);
        tags[0] = keccak256("fresh-tag");
        uint256 n = inbox.acceptedBallots(id);
        IRollupSettlement.SealedParams memory p =
            this.filled(Job(id, 1, root, settlement.hourlyProduct(id), settlement.finalProduct(id), n, n, bytes32(0), sequencer), bound, tags);
        p.previousHourly = bytes32(uint256(1));
        p.dataHash = settlement.computeSealedDataHash(p, settlement.KIND_HOURLY());
        vm.prank(sequencer);
        settlement.submitHourlyBatch(p, bound, tags, pa, pb, pc);
    }

    function hourPoints(
        uint256 id,
        bytes32 root,
        bytes32 hourly,
        bytes32 finalP,
        uint256 prevU,
        uint256 nextU,
        uint256 c1x,
        uint256 c1y,
        uint256 c2x,
        uint256 c2y
    ) external {
        bytes32[] memory bound = new bytes32[](1);
        bound[0] = settlement.lastHourlyRoot(id);
        bytes32[] memory tags = new bytes32[](1);
        tags[0] = keccak256(abi.encodePacked("first", id, root));
        IRollupSettlement.SealedParams memory p =
            this.filled(Job(id, 1, root, hourly, finalP, prevU, nextU, bytes32(0), sequencer), bound, tags);
        p.nextC1X = c1x;
        p.nextC1Y = c1y;
        p.nextC2X = c2x;
        p.nextC2Y = c2y;
        p.dataHash = settlement.computeSealedDataHash(p, settlement.KIND_HOURLY());
        vm.prank(sequencer);
        settlement.submitHourlyBatch(p, bound, tags, pa, pb, pc);
    }

    function sealMismatch(uint256 id, bytes32 root, bytes32 hourly, bytes32 finalP) external {
        this.post(Job(id, 2, root, hourly, finalP, 1, 2, bytes32(0), sequencer), new bytes32[](0), new bytes32[](0), new uint256[](0));
    }

    function sealFinal(uint256 id, bytes32 root, bytes32 hourly, bytes32 finalP, uint256 uniqueCount) external {
        this.post(
            Job(id, 2, root, hourly, finalP, uniqueCount, uniqueCount, bytes32(0), sequencer),
            new bytes32[](0),
            new bytes32[](0),
            new uint256[](0)
        );
    }

    function suppOne(uint256 id, bytes32 root, bytes32 hourly, bytes32 finalP, uint256 submissionId, bool replacement)
        external
    {
        uint256[] memory ids = new uint256[](1);
        ids[0] = submissionId;
        uint256 prevU = inbox.acceptedBallots(id);
        uint256 nextU = replacement ? prevU : prevU + 1;
        this.post(
            Job(id, 3, root, hourly, finalP, prevU, nextU, settlement.supplementaryChainHash(id), sequencer),
            new bytes32[](0),
            new bytes32[](0),
            ids
        );
    }

    function suppEmpty(uint256 id, bytes32 root, bytes32 hourly, bytes32 finalP, address who) external {
        uint256 n = inbox.acceptedBallots(id);
        this.post(
            Job(id, 3, root, hourly, finalP, n, n, settlement.supplementaryChainHash(id), who),
            new bytes32[](0),
            new bytes32[](0),
            new uint256[](0)
        );
    }

    function suppCipher(
        uint256 id,
        bytes32 root,
        bytes32 hourly,
        bytes32 finalP,
        uint256 c1x,
        uint256 c1y,
        uint256 c2x,
        uint256 c2y
    ) external {
        uint256 n = inbox.acceptedBallots(id);
        IRollupSettlement.SealedParams memory p = this.filled(
            Job(id, 3, root, hourly, finalP, n, n, settlement.supplementaryChainHash(id), sequencer),
            new bytes32[](0),
            new bytes32[](0)
        );
        p.nextC1X = c1x;
        p.nextC1Y = c1y;
        p.nextC2X = c2x;
        p.nextC2Y = c2y;
        p.dataHash = settlement.computeSealedDataHash(p, settlement.KIND_SUPPLEMENTARY());
        vm.prank(sequencer);
        settlement.submitSupplementaryBatch(p, new uint256[](0), pa, pb, pc);
    }

    function expectBadChain(uint256 id, bytes32 root, bytes32 hourly, uint256 submissionId) external {
        uint256[] memory ids = new uint256[](1);
        ids[0] = submissionId;
        IRollupSettlement.SealedParams memory p = this.blank(id, root, hourly, keccak256("f4b"), 0, 1);
        p.chainHash = keccak256("wrong-chain");
        p.previousHourly = settlement.hourlyProduct(id);
        p.previousFinal = settlement.finalProduct(id);
        p.dataHash = settlement.computeSealedDataHash(p, settlement.KIND_SUPPLEMENTARY());
        vm.prank(sequencer);
        vm.expectRevert(IRollupSettlement.DataHashMismatch.selector);
        settlement.submitSupplementaryBatch(p, ids, pa, pb, pc);
    }

    function expectTallyBlocked(uint256 id) external {
        uint256[] memory counts = new uint256[](1);
        vm.prank(tallyOperator);
        vm.expectPartialRevert(ITallyVerifier.SupplementaryBatchRequired.selector);
        tally.submitTally(id, counts, pa, pb, pc);
        vm.prank(tallyOperator);
        vm.expectPartialRevert(ITallyVerifier.SupplementaryBatchRequired.selector);
        tally.submitDecryption(id, keccak256("plain"), new uint8[](0));
        vm.prank(makeAddr("g1"));
        vm.expectPartialRevert(ITallyVerifier.SupplementaryBatchRequired.selector);
        tally.submitFinalPartial(id, 1, 2, 1, 2, 1, 2, 3);
    }

    function expectWindowOpen(uint256 id) external {
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(tallyOperator);
        vm.expectPartialRevert(ITallyVerifier.ChallengeWindowOpen.selector);
        tally.submitTally(id, counts, pa, pb, pc);
    }

    function postCount(uint256 id, uint256 n) external {
        uint256[] memory counts = new uint256[](1);
        counts[0] = n;
        vm.prank(tallyOperator);
        tally.submitTally(id, counts, pa, pb, pc);
    }

    function submitHour(uint256 id, address guardian, uint256 share, uint256 nonce, uint256 hourIndex, bool bad)
        external
    {
        PartialMath.Proof memory good = math.deal(share, nonce, id, ElectionType.POLL, guardian, hourIndex, 5, 1, 2);
        uint256 z = bad ? good.z + 1 : good.z;
        vm.prank(guardian);
        tally.submitHourlyPartial(id, hourIndex, good.dX, good.dY, good.aX, good.aY, good.bX, good.bY, z);
    }

    function oneFinal(uint256 id, address guardian, uint256 share, uint256 nonce, uint256 c1x, uint256 c1y) external {
        PartialMath.Proof memory p =
            math.deal(share, nonce, id, ElectionType.POLL, guardian, type(uint256).max, 5, c1x, c1y);
        vm.prank(guardian);
        tally.submitFinalPartial(id, p.dX, p.dY, p.aX, p.aY, p.bX, p.bY, p.z);
    }

    function expectSameNullifier(uint256 id, address el, uint256 nullifier) external {
        bytes memory enc = Fixtures.encryptedBallot(nullifier + 1);
        uint256[] memory inputs = this.externalVoteInputs(id, el, nullifier, enc);
        inputs[3] = uint256(keccak256(enc)) % FIELD;
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.NullifierUsed.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
    }

    function expectKeyMissing(uint256 id, address el, uint256 nullifier) external {
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        uint256[] memory inputs = this.externalVoteInputs(id, el, nullifier, enc);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.KeyNotPosted.selector);
        inbox.submitVote(id, pa, pb, pc, inputs, enc);
    }

    function hold(uint256 id, address el, uint256 submissionId, bytes32 reproof, uint64 at) external returns (uint256) {
        vm.warp(uint256(IElection(el).params().cutoffTime) + 1 hours);
        return this.deliver(id, el, submissionId, reproof, at, bytes32(0), false);
    }

    function forceAt(uint256 id, address el, uint256 submissionId, bytes32 receiptRoot, uint64 at)
        external
        returns (uint256)
    {
        return this.deliver(id, el, submissionId, receiptRoot, at, bytes32(0), false);
    }

    function forceMany(uint256 id, address el, bytes32 hourRoot, uint256 n) external {
        uint64 at = uint64(IElection(el).params().cutoffTime) - 1;
        for (uint256 i = 1; i <= n; ++i) {
            this.deliver(id, el, i, hourRoot, at, bytes32(0), false);
        }
    }

    function deliver(
        uint256 id,
        address el,
        uint256 submissionId,
        bytes32 receiptRoot,
        uint64 at,
        bytes32 reproof,
        bool held
    ) external returns (uint256) {
        bytes memory enc = Fixtures.encryptedBallot(submissionId);
        uint256[] memory inputs = this.externalVoteInputs(id, el, submissionId, enc);
        return this.deliverSigned(id, receiptRoot, at, reproof, held, enc, inputs);
    }

    function externalVoteInputs(uint256 id, address el, uint256 submissionId, bytes memory enc)
        external
        view
        returns (uint256[] memory)
    {
        return voteInputs(id, el, submissionId, enc);
    }

    function deliverSigned(
        uint256 id,
        bytes32 receiptRoot,
        uint64 at,
        bytes32 reproof,
        bool held,
        bytes memory enc,
        uint256[] memory inputs
    ) external returns (uint256 spent) {
        spent = inputs[2] % FIELD;
        IBallotInbox.RelayerReceipt memory receipt;
        receipt.submissionId = spent;
        receipt.ballotHash = bytes32(inputs[3]);
        receipt.ciphertextHash = keccak256(enc);
        receipt.boundRoot = receiptRoot;
        receipt.receivedAt = at;
        bytes memory sig = this.signReceipt(id, receipt);
        if (held && reproof != reproof) revert();
        inbox.forceIn(id, receipt, sig, pa, pb, pc, inputs, enc);
    }

    function signReceipt(uint256 id, IBallotInbox.RelayerReceipt memory receipt) external view returns (bytes memory) {
        return _sign(id, receipt);
    }

    function post(Job memory job, bytes32[] memory bound, bytes32[] memory tags, uint256[] memory included) external {
        if (job.kind == 1) this.postHour(job, bound, tags);
        else if (job.kind == 2) this.postFinal(job);
        else this.postSupp(job, included);
    }

    function postHour(Job memory job, bytes32[] memory bound, bytes32[] memory tags) external {
        IRollupSettlement.SealedParams memory p = this.filled(job, bound, tags);
        vm.prank(job.who);
        settlement.submitHourlyBatch(p, bound, tags, pa, pb, pc);
    }

    function postFinal(Job memory job) external {
        bytes32[] memory none = new bytes32[](0);
        IRollupSettlement.SealedParams memory p = this.filled(job, none, none);
        vm.prank(job.who);
        settlement.submitFinalBatch(p, none, none, pa, pb, pc);
    }

    function postSupp(Job memory job, uint256[] memory included) external {
        bytes32[] memory none = new bytes32[](0);
        IRollupSettlement.SealedParams memory p = this.filled(job, none, none);
        vm.prank(job.who);
        settlement.submitSupplementaryBatch(p, included, pa, pb, pc);
    }

    function filled(Job memory job, bytes32[] memory bound, bytes32[] memory tags)
        external
        view
        returns (IRollupSettlement.SealedParams memory p)
    {
        p = this.blank(job.id, job.root, job.hourly, job.finalP, job.prevU, job.nextU);
        p.chainHash = job.chain;
        p.boundRootHash = settlement.expectedBoundHash(bound, settlement.lastHourlyRoot(job.id));
        p.tagHash = settlement.foldWords(tags);
        p.previousHourly = settlement.hourlyProduct(job.id);
        p.previousFinal = settlement.finalProduct(job.id);
        IRollupSettlement.Ciphertext memory prev = job.kind == settlement.KIND_HOURLY()
            ? settlement.chainedHourly(job.id)
            : settlement.chainedFinal(job.id);
        p.prevC1X = prev.c1X;
        p.prevC1Y = prev.c1Y;
        p.prevC2X = prev.c2X;
        p.prevC2Y = prev.c2Y;
        p.dataHash = settlement.computeSealedDataHash(p, job.kind);
    }

    function blank(uint256 id, bytes32 root, bytes32 hourly, bytes32 finalP, uint256 prevU, uint256 nextU)
        external
        view
        returns (IRollupSettlement.SealedParams memory p)
    {
        p.electionId = id;
        p.batchIndex = settlement.batchCount();
        p.prevStateRoot = settlement.stateRoot();
        p.newStateRoot = keccak256(abi.encodePacked("state", id, p.batchIndex, root));
        p.ballotSetRoot = root;
        p.hourlyProduct = hourly;
        p.finalProduct = finalP;
        p.previousUnique = prevU;
        p.nextUnique = nextU;
    }

    function _sign(uint256 id, IBallotInbox.RelayerReceipt memory receipt) internal view returns (bytes memory) {
        bytes32 digest = inbox.receiptDigest(id, receipt);
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RELAYER_KEY, ethHash);
        return abi.encodePacked(r, s, v);
    }
}
