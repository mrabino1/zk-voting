// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {console2} from "forge-std/console2.sol";
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

    function add(uint256 x1, uint256 y1, uint256 x2, uint256 y2) external view returns (uint256 xOut, uint256 yOut) {
        if (x1 == 0 && y1 == 0) return (x2, y2);
        if (x2 == 0 && y2 == 0) return (x1, y1);
        uint256[4] memory input;
        input[0] = x1;
        input[1] = y1;
        input[2] = x2;
        input[3] = y2;
        uint256[2] memory output;
        bool ok;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 6, input, 128, output, 64)
        }
        require(ok, "ecadd");
        xOut = output[0];
        yOut = output[1];
    }

    function sub(uint256 x1, uint256 y1, uint256 x2, uint256 y2) external view returns (uint256 xOut, uint256 yOut) {
        if (x2 == 0 && y2 == 0) return (x1, y1);
        uint256 p = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
        uint256 ny = y2 == 0 ? uint256(0) : p - y2;
        return this.add(x1, y1, x2, ny);
    }

    struct Hot {
        uint256 r;
        uint256 bit;
        uint256 pkX;
        uint256 pkY;
        uint256 a;
        uint256 eSim;
        uint256 zSim;
        uint256 c1x;
        uint256 c1y;
        uint256 c2x;
        uint256 c2y;
        uint256 electionId;
        uint256 submissionId;
        address settlement;
    }

    /// @dev CDS proof that `(r·G, bit·G + r·PK)` encrypts 0 or 1. Twelve words: A0, B0, e0, z0, A1, B1, e1, z1.
    function oneHot(
        uint256 r,
        uint256 bit,
        uint256 pkX,
        uint256 pkY,
        uint256 a,
        uint256 eSim,
        uint256 zSim,
        uint256 electionId,
        uint256 submissionId,
        address settlement
    ) external view returns (uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, uint256[12] memory proof) {
        require(bit < 2, "bit");
        Hot memory h = Hot(r, bit, pkX, pkY, a, eSim, zSim, 0, 0, 0, 0, electionId, submissionId, settlement);
        (h.c1x, h.c1y) = this.mulG(r);
        (h.c2x, h.c2y) = this.encMsg(h);
        proof = this.cdsProof(h);
        return (h.c1x, h.c1y, h.c2x, h.c2y, proof);
    }

    /// @dev `z` shows `log_G(S1) = log_PK(S2 - G)` for an Enc(1) sum under `pk`.
    function sumToOne(
        uint256 r,
        uint256 pkX,
        uint256 pkY,
        uint256 s1x,
        uint256 s1y,
        uint256 s2x,
        uint256 s2y,
        uint256 a,
        uint256 electionId,
        uint256 submissionId,
        address settlement
    ) external view returns (uint256[5] memory proof) {
        (proof[0], proof[1]) = this.mulG(a);
        (proof[2], proof[3]) = this.mul(pkX, pkY, a);
        uint256 e = uint256(
            keccak256(
                abi.encode(
                    keccak256("SUM_TO_ONE_V1"),
                    block.chainid,
                    settlement,
                    electionId,
                    submissionId,
                    pkX,
                    pkY,
                    s1x,
                    s1y,
                    s2x,
                    s2y,
                    proof[0],
                    proof[1],
                    proof[2],
                    proof[3]
                )
            )
        ) % _field();
        proof[4] = addmod(a, mulmod(e, r, _field()), _field());
    }

    function encMsg(Hot memory h) external view returns (uint256 x, uint256 y) {
        (uint256 rx, uint256 ry) = this.mul(h.pkX, h.pkY, h.r);
        if (h.bit == 0) return (rx, ry);
        return this.add(rx, ry, 1, 2);
    }

    function cdsProof(Hot memory h) external view returns (uint256[12] memory proof) {
        uint256[4] memory realP = this.realCommit(h.pkX, h.pkY, h.a);
        uint256[4] memory simP = this.simCommit(h);
        uint256[8] memory pts = this.pickBranches(h.bit, realP, simP);
        uint256 e = this.cdsChallenge(h, pts);
        uint256 eReal = addmod(e, _field() - (h.eSim % _field()), _field());
        uint256 zReal = addmod(h.a, mulmod(eReal, h.r, _field()), _field());
        proof = this.packCds(h.bit, pts, eReal, zReal, h.eSim % _field(), h.zSim % _field());
    }

    function realCommit(uint256 pkX, uint256 pkY, uint256 a) external view returns (uint256[4] memory p) {
        (p[0], p[1]) = this.mulG(a);
        (p[2], p[3]) = this.mul(pkX, pkY, a);
    }

    function simCommit(Hot memory h) external view returns (uint256[4] memory p) {
        uint256 mX = h.c2x;
        uint256 mY = h.c2y;
        if (h.bit == 0) (mX, mY) = this.sub(h.c2x, h.c2y, 1, 2);
        (uint256 zx, uint256 zy) = this.mulG(h.zSim);
        (uint256 ex, uint256 ey) = this.mul(h.c1x, h.c1y, h.eSim);
        (p[0], p[1]) = this.sub(zx, zy, ex, ey);
        (zx, zy) = this.mul(h.pkX, h.pkY, h.zSim);
        (ex, ey) = this.mul(mX, mY, h.eSim);
        (p[2], p[3]) = this.sub(zx, zy, ex, ey);
    }

    function cdsChallenge(Hot memory h, uint256[8] memory pts) external view returns (uint256) {
        return uint256(
            keccak256(
                abi.encode(
                    keccak256("ONE_HOT_CDS_V1"),
                    block.chainid,
                    h.settlement,
                    h.electionId,
                    h.submissionId,
                    h.pkX,
                    h.pkY,
                    h.c1x,
                    h.c1y,
                    h.c2x,
                    h.c2y,
                    pts[0],
                    pts[1],
                    pts[2],
                    pts[3],
                    pts[4],
                    pts[5],
                    pts[6],
                    pts[7]
                )
            )
        ) % _field();
    }

    function pickBranches(uint256 bit, uint256[4] memory realP, uint256[4] memory simP)
        external
        pure
        returns (uint256[8] memory pts)
    {
        uint256[4] memory left = bit == 0 ? realP : simP;
        uint256[4] memory right = bit == 1 ? realP : simP;
        pts[0] = left[0];
        pts[1] = left[1];
        pts[2] = left[2];
        pts[3] = left[3];
        pts[4] = right[0];
        pts[5] = right[1];
        pts[6] = right[2];
        pts[7] = right[3];
    }

    function packCds(uint256 bit, uint256[8] memory pts, uint256 eReal, uint256 zReal, uint256 eSim, uint256 zSim)
        external
        pure
        returns (uint256[12] memory proof)
    {
        proof[0] = pts[0];
        proof[1] = pts[1];
        proof[2] = pts[2];
        proof[3] = pts[3];
        proof[6] = pts[4];
        proof[7] = pts[5];
        proof[8] = pts[6];
        proof[9] = pts[7];
        if (bit == 0) {
            proof[4] = eReal;
            proof[5] = zReal;
            proof[10] = eSim;
            proof[11] = zSim;
        } else {
            proof[4] = eSim;
            proof[5] = zSim;
            proof[10] = eReal;
            proof[11] = zReal;
        }
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
        assertEq(settlement.postedUnique(id), 0, "unique count waits for a batch");
        bytes32 hourRoot = keccak256("hour-root");
        bytes32 hourly = keccak256("hourly");
        bytes32 finalP = keccak256("final");
        this.hour(id, hourRoot, hourly, finalP, 0, 0);
        assertEq(settlement.postedUnique(id), 0);
        warpClosed(el);
        bytes32 finalRoot = keccak256("final-root");
        this.sealFinal(id, finalRoot, hourly, finalP, 0);
        assertEq(settlement.postedUnique(id), 0, "final batch carries no turnout step");
        uint256 sid = this.hold(id, el, 99, finalRoot, uint64(IElection(el).params().cutoffTime) - 1);
        vm.warp(tally.tallyAllowedAt(id));
        this.suppOne(id, finalRoot, hourly, keccak256("final-with-revote"), sid, true);
        (, bool pending) = inbox.forcedInRoot(id, sid);
        assertFalse(pending);
        assertEq(inbox.pendingForcedIn(id).length, 0);
        assertEq(settlement.postedUnique(id), 0, "a replacement does not add a voter");
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
        assertEq(settlement.postedUnique(id), 0, "force-in does not publish turnout");
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
        assertEq(settlement.postedUnique(id), 0, "an unsettled force-in is not a first-ballot step");
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
        this.hour(id, hourRoot, hourly, keccak256("f7"), 0, 0);
        warpClosed(el);
        vm.expectRevert(IRollupSettlement.TurnoutOnFinalBatch.selector);
        this.sealMismatch(id, keccak256("rf7"), hourly, keccak256("f7"));
        assertEq(settlement.postedUnique(id), 0);
    }

    function testStaleBoundRootAndDuplicateFirstBallot() public {
        (uint256 id,) = this.openLinked(2 hours);
        bytes32 first = keccak256("r8");
        this.hour(id, first, keccak256("h8"), keccak256("f8"), 0, 0);
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
        this.hour(id, keccak256("r9"), hourly, keccak256("f9"), 0, 0);
        warpClosed(el);
        this.sealFinal(id, finalRoot, hourly, keccak256("f9"), 0);
        vm.warp(tally.tallyAllowedAt(id));
        this.suppEmpty(id, finalRoot, hourly, keccak256("f9"), sequencer);
        assertEq(inbox.pendingForcedIn(id).length, 0);
        assertEq(settlement.postedUnique(id), 0);
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
        ElectionParams memory params = defaultParams();
        params.electionType = ElectionType.VOTE;
        (uint256 id, address el) = createElection(params);
        stdstore.target(address(tally)).sig("challengeWindow(uint256)").with_key(id).checked_write(uint256(0));
        vm.expectRevert(ITallyVerifier.ZeroChallengeWindow.selector);
        tally.tallyAllowedAt(id);
        // A VOTE before cutoff is sealed. After cutoff the zero window is what blocks the tally.
        vm.warp(IElection(el).params().cutoffTime);
        vm.expectRevert(ITallyVerifier.ZeroChallengeWindow.selector);
        this.postCount(id, 0);
    }

    function testPollZeroStoredWindowUsesTheMinimum() public {
        (uint256 id, address el) = createElection();
        stdstore.target(address(tally)).sig("challengeWindow(uint256)").with_key(id).checked_write(uint256(0));
        uint64 cutoff = IElection(el).params().cutoffTime;
        assertEq(tally.tallyAllowedAt(id), uint256(cutoff) + 1 hours);
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
        ceremony.deriveShare(id, ElectionType.POLL, 1);
        ceremony.deriveShare(id, ElectionType.POLL, 2);
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
        this.hourOpening(id, keccak256("rh"), keccak256("hh"), keccak256("fh"), 0, 1);
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
        this.hour(id, keccak256("rd"), hourly, keccak256("fd"), 0, 0);
        (uint256 c1x, uint256 c1y) = math.mulG(3);
        (uint256 c2x, uint256 c2y) = math.mulG(16);
        this.acceptEg(id, 8800, c1x, c1y, c2x, c2y);
        warpClosed(el);
        this.sealFinal(id, keccak256("rfd"), hourly, keccak256("fd"), 0);
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
        uint256 secret = 42;
        uint256 key = PoseidonT3.hashLeftRight(secret, id);
        bytes memory eg1 = abi.encodePacked(bytes2("EG"), bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)), bytes32(uint256(4)));
        bytes memory eg2 = abi.encodePacked(bytes2("EG"), bytes32(uint256(5)), bytes32(uint256(6)), bytes32(uint256(7)), bytes32(uint256(8)));
        uint256 hash1 = inbox.ballotHashOfCiphertext(eg1);
        uint256 hash2 = inbox.ballotHashOfCiphertext(eg2);
        uint256 sid1 = PoseidonT3.hashLeftRight(key, hash1);
        uint256 sid2 = PoseidonT3.hashLeftRight(key, hash2);
        assertTrue(sid1 != sid2);
        assertTrue(sid1 != key && sid2 != key);
        assertTrue(sid1 != secret && sid2 != secret);
        submitVote(id, el, sid1);
        submitVote(id, el, sid2);
        assertTrue(inbox.nullifierUsed(id, sid1));
        assertTrue(inbox.nullifierUsed(id, sid2));
        assertFalse(inbox.nullifierUsed(id, key));
        assertFalse(inbox.nullifierUsed(id, secret));
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
        this.hourOpening(id, keccak256("rw"), keccak256("hw"), keccak256("fw"), 0, 1);
        uint256 hourIndex = block.timestamp / 1 hours;
        vm.warp(uint256(IElection(el).params().cutoffTime) + 30 minutes);
        vm.expectRevert(ITallyVerifier.InvalidPartial.selector);
        this.submitHour(id, makeAddr("g1"), 4, 21, hourIndex, false);
        this.submitHour(id, makeAddr("g1"), 6, 21, hourIndex, false);
        assertTrue(tally.hourlyPartialPosted(id, hourIndex, makeAddr("g1")));
    }

    function testDecryptionSubsetSkipsABadPartial() public {
        (uint256 id, address el) = this.openTrio(1 hours);
        bytes32 hourly = keccak256("hs");
        this.hour(id, keccak256("rs"), hourly, keccak256("fs"), 0, 0);
        (uint256 c1x, uint256 c1y) = math.mulG(3);
        (uint256 c2x, uint256 c2y) = math.mulG(16);
        this.acceptEg(id, 8800, c1x, c1y, c2x, c2y);
        warpClosed(el);
        this.sealFinal(id, keccak256("rfs"), hourly, keccak256("fs"), 0);
        this.suppCipherOption(id, keccak256("rfs"), hourly, keccak256("fs2"), c1x, c1y, c2x, c2y, true);
        this.postCount(id, 1);
        IRollupSettlement.Ciphertext memory opt0 = settlement.optionCiphertext(id, 0);
        IRollupSettlement.Ciphertext memory opt1 = settlement.optionCiphertext(id, 1);
        PartialMath.Proof memory bad =
            math.deal(4, 41, id, ElectionType.POLL, makeAddr("g2"), type(uint256).max, 5, opt0.c1X, opt0.c1Y);
        vm.prank(makeAddr("g2"));
        vm.expectRevert(ITallyVerifier.InvalidPartial.selector);
        tally.submitFinalPartial(id, 0, bad.dX, bad.dY, bad.aX, bad.aY, bad.bX, bad.bY, bad.z);
        assertFalse(tally.optionPartialPosted(id, 0, makeAddr("g2")));
        uint256 share3 = addmod(
            addmod(2, mulmod(3, 3, FIELD), FIELD), addmod(3, mulmod(FIELD - 2, 3, FIELD), FIELD), FIELD
        );
        this.oneOption(id, makeAddr("g3"), 1, share3, 51, opt1.c1X, opt1.c1Y);
        assertTrue(tally.optionPartialPosted(id, 1, makeAddr("g3")));
        this.oneFinal(id, makeAddr("g1"), 6, 31, opt0.c1X, opt0.c1Y);
        this.oneFinal(id, makeAddr("g2"), 7, 33, opt0.c1X, opt0.c1Y);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        bytes32 plain = keccak256(abi.encode(counts));
        uint8[] memory badSubset = new uint8[](2);
        badSubset[0] = 1;
        badSubset[1] = 3;
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
        this.hourOpening(id, keccak256("rgate"), keccak256("hgate"), keccak256("fgate"), 0, 1);
        uint256 hourIndex = block.timestamp / 1 hours;
        vm.warp(block.timestamp + 30 minutes);
        assertLt(block.timestamp, IElection(el).params().cutoffTime);
        assertEq(settlement.hourUnique(id, hourIndex), 1);
        vm.expectRevert(ITallyVerifier.HourGateClosed.selector);
        this.submitHour(id, makeAddr("g1"), 6, 21, hourIndex, false);
        (uint256 id2, address el2) = this.openLinked(4 hours);
        for (uint256 n; n < 10; ++n) {
            if (n != 0) vm.warp(block.timestamp + 1 hours);
            this.hourMany(
                id2,
                keccak256(abi.encodePacked("ropen", n)),
                keccak256(abi.encodePacked("hopen", n)),
                keccak256("fopen"),
                10
            );
        }
        uint256 openHour = block.timestamp / 1 hours;
        vm.warp(block.timestamp + 30 minutes);
        assertLt(block.timestamp, IElection(el2).params().cutoffTime);
        assertEq(settlement.hourUnique(id2, openHour), 100, "open hour unique");
        assertGe(block.timestamp, uint256(settlement.hourClosedAt(id2, openHour)) + 30 minutes, "delay");
        IRollupSettlement.Ciphertext memory opened = settlement.hourlyCiphertext(id2, openHour);
        this.submitHourAt(id2, makeAddr("g1"), 6, 21, openHour, opened.c1X, opened.c1Y, false);
        assertTrue(tally.hourlyPartialPosted(id2, openHour, makeAddr("g1")));
    }

    function testZeroWindowBlocksFinalizeAndTally() public {
        ElectionParams memory params = defaultParams();
        params.electionType = ElectionType.VOTE;
        (uint256 id, address el) = createElection(params);
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
        vm.prank(admin);
        naked.setAllowMockVerifiers(true);
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
        (uint256 id2, address el2) = this.openLinked(1 hours);
        bytes32 hourly2 = keccak256("ho2");
        this.hour(id2, keccak256("ro2"), hourly2, keccak256("fo2"), 0, 0);
        warpClosed(el2);
        this.sealFinal(id2, keccak256("rfo2"), hourly2, keccak256("fo2"), 0);
        this.suppCipherOption(id2, keccak256("rfo2"), hourly2, keccak256("fo3"), 0, 0, 0, 0, true);
        vm.prank(tallyOperator);
        tally.submitTally(id2, counts, pa, pb, pc);
        vm.prank(tallyOperator);
        tally.submitDecryption(id2, plain, new uint8[](0));
        assertEq(tally.decryptionHash(id2), plain);
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
        assertEq(this.liveAccepted(id), 1);
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
        bare.submitHourlyBatch(
            p,
            new bytes32[](0),
            new bytes32[](0),
            new IRollupSettlement.BallotRow[](0),
            new IRollupSettlement.OptionPoint[](0),
            pa,
            pb,
            pc
        );
    }

    function testZeroBallotRootIsRejected() public {
        (uint256 id,) = this.openLinked(2 hours);
        vm.expectRevert(IRollupSettlement.EmptyRoot.selector);
        this.hour(id, bytes32(0), keccak256("hz"), keccak256("fz"), 0, 0);
    }

    function testUniqueAndProductMustChain() public {
        (uint256 id,) = this.openLinked(2 hours);
        bytes32 first = keccak256("chain-1");
        this.hour(id, first, keccak256("hc1"), keccak256("fc1"), 0, 0);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(IRollupSettlement.UniqueCountMismatch.selector);
        this.hour(id, keccak256("chain-2"), keccak256("hc1"), keccak256("fc1"), 1, 1);
        vm.expectRevert(IRollupSettlement.ProductMismatch.selector);
        this.hourBadProduct(id, keccak256("chain-3"));
        this.hour(id, keccak256("chain-4"), keccak256("hc2"), keccak256("fc1"), 0, 0);
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

    function testPendingListRejectsBallot65() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        bytes32 hourRoot = keccak256("cap-root");
        this.hour(id, hourRoot, keccak256("hcap"), keccak256("fcap"), 0, 0);
        vm.warp(uint256(IElection(el).params().cutoffTime) + 30 minutes);
        this.forceMany(id, el, hourRoot, 64);
        assertEq(inbox.pendingForcedIn(id).length, 64);
        uint64 at = uint64(IElection(el).params().cutoffTime) - 1;
        vm.expectRevert(IBallotInbox.PendingListFull.selector);
        this.deliver(id, el, 65, hourRoot, at, bytes32(0), false);
    }

    function testPendingChunksSeal() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        bytes32 hourRoot = keccak256("chunk-root");
        bytes32 hourly = keccak256("hchunk");
        this.hour(id, hourRoot, hourly, keccak256("fchunk"), 0, 0);
        vm.warp(uint256(IElection(el).params().cutoffTime) + 30 minutes);
        this.forceMany(id, el, hourRoot, 9);
        uint256[] memory ids = inbox.pendingForcedIn(id);
        assertEq(ids.length, 9);
        vm.warp(tally.tallyAllowedAt(id) + settlement.SUPPLEMENTARY_GRACE());
        this.suppIds(id, hourRoot, hourly, keccak256("fchunk"), ids);
        assertEq(inbox.pendingForcedIn(id).length, 0);
        assertEq(settlement.postedUnique(id), 0);
    }

    function testEmptyIndexedRootOnlyAtDepth20() public {
        vm.expectRevert(IBallotInbox.BadTreeDepth.selector);
        inbox.emptyBallotRoot(16);
        assertTrue(inbox.emptyBallotRoot(20) != 0);
    }

    function testBoundListLongerThanFourReverts() public {
        (uint256 id,) = this.openLinked(2 hours);
        bytes32[] memory bound = new bytes32[](5);
        bytes32 empty = bytes32(inbox.emptyBallotRoot(20));
        for (uint256 i; i < 5; ++i) bound[i] = empty;
        bytes32[] memory tags = new bytes32[](1);
        tags[0] = keccak256("five");
        IRollupSettlement.SealedParams memory p = this.filled(
            Job(id, 1, keccak256("five-root"), keccak256("hfive"), keccak256("ffive"), 0, 0, bytes32(0), sequencer),
            bound,
            tags
        );
        vm.prank(sequencer);
        vm.expectRevert(IRollupSettlement.BoundRootMismatch.selector);
        settlement.submitHourlyBatch(
            p, bound, tags, new IRollupSettlement.BallotRow[](0), new IRollupSettlement.OptionPoint[](0), pa, pb, pc
        );
    }

    function testTwoPostedRootsFold() public {
        (uint256 id,) = this.openLinked(4 hours);
        bytes32 first = keccak256("root-a");
        this.hour(id, first, keccak256("ha"), keccak256("fa"), 0, 0);
        vm.warp(block.timestamp + 1 hours);
        bytes32 second = keccak256("root-b");
        this.hour(id, second, keccak256("hb"), keccak256("fa"), 0, 0);
        vm.warp(block.timestamp + 1 hours);
        bytes32[] memory bound = new bytes32[](2);
        bound[0] = second;
        bound[1] = first;
        bytes32[] memory tags = new bytes32[](1);
        tags[0] = keccak256("tag-third");
        this.post(
            Job(id, 1, keccak256("root-c"), keccak256("hc"), keccak256("fa"), 0, 0, bytes32(0), sequencer),
            bound,
            tags,
            new uint256[](0)
        );
        assertTrue(settlement.postedBallotRoot(id, keccak256("root-c")));
        assertTrue(settlement.postedBallotRoot(id, first));
        assertTrue(settlement.postedBallotRoot(id, second));
    }

    function testComplaintUnfoundedAndExclude() public {
        (uint256 id,) = createElection();
        ceremony = new GuardianCeremony(address(factory));
        address[] memory gs = new address[](2);
        gs[0] = makeAddr("g1");
        gs[1] = makeAddr("g2");
        vm.prank(tallyOperator);
        ceremony.openCeremony(id, ElectionType.POLL, 2, 2, gs);
        this.postDeal(id, gs[0], 2, 3, 11);
        vm.prank(gs[1]);
        vm.expectRevert(GuardianCeremony.ComplaintUnfounded.selector);
        ceremony.complain(id, ElectionType.POLL, 1, 8);
        vm.prank(gs[1]);
        ceremony.complain(id, ElectionType.POLL, 1, 9);
        assertFalse(ceremony.keyPosted(id, ElectionType.POLL));
    }

    function testDropAbsentFinalizesTwoOfThree() public {
        (uint256 id,) = createElection();
        ceremony = new GuardianCeremony(address(factory));
        address[] memory gs = new address[](3);
        gs[0] = makeAddr("g1");
        gs[1] = makeAddr("g2");
        gs[2] = makeAddr("g3");
        vm.prank(tallyOperator);
        ceremony.openCeremony(id, ElectionType.POLL, 2, 3, gs);
        this.postDeal(id, gs[0], 2, 3, 11);
        this.postDeal(id, gs[1], 3, FIELD - 2, 13);
        vm.expectRevert(GuardianCeremony.ComplaintWindowOpen.selector);
        ceremony.dropAbsent(id, ElectionType.POLL);
        vm.warp(block.timestamp + 1 hours);
        ceremony.dropAbsent(id, ElectionType.POLL);
        assertTrue(ceremony.keyPosted(id, ElectionType.POLL));
        (uint256 x, uint256 y) = ceremony.jointKey(id, ElectionType.POLL);
        (uint256 expectX, uint256 expectY) = math.mulG(5);
        assertEq(x, expectX);
        assertEq(y, expectY);
    }

    function testSixteenOfSixteenDeriveFits() public {
        (uint256 id,) = createElection();
        ceremony = new GuardianCeremony(address(factory));
        address[] memory gs = new address[](16);
        for (uint256 i; i < 16; ++i) {
            gs[i] = makeAddr(string.concat("wide-", vm.toString(i)));
        }
        vm.prank(tallyOperator);
        ceremony.openCeremony(id, ElectionType.POLL, 16, 16, gs);
        for (uint256 i; i < 15; ++i) {
            this.postWide(id, gs[i], i + 1, 100 + i);
        }
        uint256 postGas = this.postWideMeasured(id, gs[15], 16, 200);
        console2.log("guardian-16-post-gas", postGas);
        assertLt(postGas, 30_000_000);
        uint256 deriveGas = this.deriveMeasured(id, 1);
        console2.log("guardian-derive-gas", deriveGas);
        assertLt(deriveGas, 30_000_000);
        (uint256 x, uint256 y) = ceremony.jointKey(id, ElectionType.POLL);
        (uint256 expectX, uint256 expectY) = math.mulG(136);
        assertEq(x, expectX);
        assertEq(y, expectY);
    }

    function testBatchAndTallyRejectWhenPaused() public {
        (uint256 id,) = this.openLinked(2 hours);
        vm.prank(admin);
        factory.pause();
        vm.expectRevert(IRollupSettlement.ContractPaused.selector);
        this.hour(id, keccak256("paused"), keccak256("hp"), keccak256("fp"), 0, 0);
        uint256[] memory counts = new uint256[](1);
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.ContractPaused.selector);
        tally.submitTally(id, counts, pa, pb, pc);
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

    function testUniqueStepTooHighReverts() public {
        (uint256 id,) = this.openLinked(2 hours);
        vm.expectRevert(IRollupSettlement.UniqueStepMismatch.selector);
        this.hour(id, keccak256("step-high"), keccak256("hh"), keccak256("fh"), 0, 2);
    }

    function testUniqueStepTooLowReverts() public {
        (uint256 id,) = this.openLinked(2 hours);
        vm.expectRevert(IRollupSettlement.UniqueStepMismatch.selector);
        this.hourOpening(id, keccak256("step-low"), keccak256("hl"), keccak256("fl"), 0, 0);
    }

    function testUniqueStepMatchesFirstBallots() public {
        (uint256 id,) = this.openLinked(2 hours);
        this.hourOpening(id, keccak256("step-ok"), keccak256("ho"), keccak256("fo"), 0, 1);
        assertEq(settlement.postedUnique(id), 1);
        assertEq(settlement.hourUnique(id, block.timestamp / 1 hours), 1);
    }

    function testInflatedFirstBallotCountReverts() public {
        (uint256 id,) = this.openLinked(2 hours);
        vm.expectRevert(IRollupSettlement.UniqueStepMismatch.selector);
        this.hourOpening(id, keccak256("step-inflate"), keccak256("hi"), keccak256("fi"), 0, 2);
    }

    function testUnknownSubmissionReverts() public {
        (uint256 id,) = this.openLinked(2 hours);
        (uint256 pkX, uint256 pkY) = ceremony.jointKey(id, ElectionType.POLL);
        (uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, uint256[12] memory proof) =
            math.oneHot(1, 0, pkX, pkY, 11, 5, 13, id, 55, address(settlement));
        IRollupSettlement.BallotRow[] memory rows = new IRollupSettlement.BallotRow[](1);
        rows[0] = this.openingRow(c1x, c1y, c2x, c2y, proof);
        rows[0].submissionId = 55;
        vm.expectRevert(IBallotInbox.UnknownSubmission.selector);
        this.postRows(id, keccak256("unknown"), 0, 1, rows, new IRollupSettlement.OptionPoint[](0), c1x, c1y, c2x, c2y);
    }

    function testSettledHashMismatchReverts() public {
        (uint256 id,) = this.openLinked(2 hours);
        (uint256 pkX, uint256 pkY) = ceremony.jointKey(id, ElectionType.POLL);
        (uint256 ax, uint256 ay, uint256 au, uint256 av,) =
            math.oneHot(1, 0, pkX, pkY, 11, 5, 13, id, 56, address(settlement));
        this.acceptEg(id, 56, ax, ay, au, av);
        (uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, uint256[12] memory proof) =
            math.oneHot(3, 1, pkX, pkY, 11, 5, 13, id, 56, address(settlement));
        IRollupSettlement.BallotRow[] memory rows = new IRollupSettlement.BallotRow[](1);
        rows[0] = this.openingRow(c1x, c1y, c2x, c2y, proof);
        rows[0].submissionId = 56;
        vm.expectRevert(IBallotInbox.BallotHashMismatch.selector);
        this.postRows(id, keccak256("mismatch"), 0, 1, rows, new IRollupSettlement.OptionPoint[](0), c1x, c1y, c2x, c2y);
    }

    function testSubmissionConsumedTwiceReverts() public {
        (uint256 id,) = this.openLinked(4 hours);
        this.hourOpening(id, keccak256("once"), keccak256("h1"), keccak256("f1"), 0, 1);
        vm.warp(block.timestamp + 1 hours);
        (uint256 pkX, uint256 pkY) = ceremony.jointKey(id, ElectionType.POLL);
        (uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, uint256[12] memory proof) =
            math.oneHot(1, 0, pkX, pkY, 11, 5, 13, id, 9100, address(settlement));
        IRollupSettlement.BallotRow[] memory rows = new IRollupSettlement.BallotRow[](1);
        rows[0] = this.openingRow(c1x, c1y, c2x, c2y, proof);
        rows[0].submissionId = 9100;
        vm.expectRevert(IBallotInbox.SubmissionAlreadySettled.selector);
        this.postRows(id, keccak256("twice"), 1, 2, rows, new IRollupSettlement.OptionPoint[](0), c1x, c1y, c2x, c2y);
    }

    function testIdentityCiphertextRejected() public {
        (uint256 id,) = this.openLinked(2 hours);
        IRollupSettlement.BallotRow[] memory rows = new IRollupSettlement.BallotRow[](1);
        rows[0].isFirst = 1;
        rows[0].submissionId = 5;
        vm.expectRevert(IRollupSettlement.IdentityCiphertext.selector);
        this.postRows(id, keccak256("ident"), 0, 1, rows, new IRollupSettlement.OptionPoint[](0), 0, 0, 0, 0);
    }

    function testOneHotReplayAcrossElectionAndSubmission() public {
        (uint256 id,) = this.openLinked(2 hours);
        vm.expectRevert(IRollupSettlement.OneHotRejected.selector);
        this.replayRow(id, id + 1, 71);
        vm.expectRevert(IRollupSettlement.OneHotRejected.selector);
        this.replayRow(id, id, 72);
    }

    function testThreeOptionTotalRejectsTamper() public {
        (uint256 id,) = this.openLinked(2 hours);
        vm.expectRevert(IRollupSettlement.OptionTotalMismatch.selector);
        this.threeOption(id, keccak256("opt-bad"), true);
        this.threeOption(id, keccak256("opt-ok"), false);
    }

    function replayRow(uint256 id, uint256 proofElection, uint256 submissionId) external {
        IRollupSettlement.BallotRow[] memory rows = new IRollupSettlement.BallotRow[](1);
        rows[0] = this.proofRow(id, proofElection, submissionId);
        this.postRows(
            id,
            keccak256(abi.encodePacked("replay", submissionId)),
            0,
            1,
            rows,
            new IRollupSettlement.OptionPoint[](0),
            rows[0].c1X,
            rows[0].c1Y,
            rows[0].c2X,
            rows[0].c2Y
        );
    }

    function proofRow(uint256 id, uint256 proofElection, uint256 submissionId)
        external
        returns (IRollupSettlement.BallotRow memory row)
    {
        uint256 boundSubmission = submissionId == 72 ? 1 : submissionId;
        (uint256 pkX, uint256 pkY) = ceremony.jointKey(id, ElectionType.POLL);
        (uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, uint256[12] memory proof) =
            math.oneHot(1, 0, pkX, pkY, 11, 5, 13, proofElection, boundSubmission, address(settlement));
        this.acceptEg(id, submissionId, c1x, c1y, c2x, c2y);
        row = this.openingRow(c1x, c1y, c2x, c2y, proof);
        row.submissionId = submissionId;
    }

    function threeOption(uint256 id, bytes32 root, bool tamper) external {
        (IRollupSettlement.BallotRow[] memory rows, IRollupSettlement.OptionPoint[] memory claimed) = this.threeRows(id);
        if (tamper) claimed[1].c1X = 3;
        this.postRows(id, root, 0, 1, rows, claimed, rows[0].c1X, rows[0].c1Y, rows[0].c2X, rows[0].c2Y);
        if (tamper) return;
        this.assertThree(id, rows[0].options);
    }

    function threeRows(uint256 id)
        external
        returns (IRollupSettlement.BallotRow[] memory rows, IRollupSettlement.OptionPoint[] memory claimed)
    {
        uint256 submissionId = 42;
        rows = new IRollupSettlement.BallotRow[](1);
        rows[0] = this.makeAcceptedRow(id, submissionId, 7, 1);
        rows[0].options = this.threeCiphers(id, submissionId);
        rows[0].sumProof = this.sumAt(id, submissionId, 7, 19, rows[0].c1X, rows[0].c1Y, rows[0].c2X, rows[0].c2Y);
        claimed = new IRollupSettlement.OptionPoint[](3);
        claimed[0] = this.pointOf(rows[0].options[0]);
        claimed[1] = this.pointOf(rows[0].options[1]);
        claimed[2] = this.pointOf(rows[0].options[2]);
    }

    function threeCiphers(uint256 id, uint256 submissionId)
        external
        view
        returns (IRollupSettlement.OptionCipher[] memory vec)
    {
        vec = new IRollupSettlement.OptionCipher[](3);
        vec[0] = this.oneCipher(id, submissionId, 1, 1);
        vec[1] = this.oneCipher(id, submissionId, 2, 0);
        vec[2] = this.oneCipher(id, submissionId, 4, 0);
    }

    function oneCipher(uint256 id, uint256 submissionId, uint256 r, uint256 bit)
        external
        view
        returns (IRollupSettlement.OptionCipher memory o)
    {
        (uint256 pkX, uint256 pkY) = ceremony.jointKey(id, ElectionType.POLL);
        (o.c1X, o.c1Y, o.c2X, o.c2Y, o.oneHot) =
            math.oneHot(r, bit, pkX, pkY, 11, 5, 13, id, submissionId, address(settlement));
    }

    function sumAt(
        uint256 id,
        uint256 submissionId,
        uint256 r,
        uint256 a,
        uint256 c1x,
        uint256 c1y,
        uint256 c2x,
        uint256 c2y
    ) external view returns (uint256[5] memory) {
        (uint256 pkX, uint256 pkY) = ceremony.jointKey(id, ElectionType.POLL);
        return math.sumToOne(r, pkX, pkY, c1x, c1y, c2x, c2y, a, id, submissionId, address(settlement));
    }

    function pointOf(IRollupSettlement.OptionCipher memory o)
        external
        pure
        returns (IRollupSettlement.OptionPoint memory)
    {
        return IRollupSettlement.OptionPoint(o.c1X, o.c1Y, o.c2X, o.c2Y);
    }

    function assertThree(uint256 id, IRollupSettlement.OptionCipher[] memory vec) external view {
        IRollupSettlement.Ciphertext memory stored = settlement.optionCiphertext(id, 0);
        assertEq(stored.c1X, vec[0].c1X, "option 0 x");
        assertEq(stored.c1Y, vec[0].c1Y, "option 0 y");
        stored = settlement.optionCiphertext(id, 1);
        assertEq(stored.c1X, vec[1].c1X, "option 1 x");
        assertEq(stored.c2X, vec[1].c2X, "option 1 c2");
        stored = settlement.optionCiphertext(id, 2);
        assertEq(stored.c1X, vec[2].c1X, "option 2 x");
        assertEq(stored.c2Y, vec[2].c2Y, "option 2 c2y");
    }

    function postRows(
        uint256 id,
        bytes32 root,
        uint256 prevU,
        uint256 nextU,
        IRollupSettlement.BallotRow[] memory rows,
        IRollupSettlement.OptionPoint[] memory options,
        uint256 nx,
        uint256 ny,
        uint256 nu,
        uint256 nv
    ) external {
        bytes32[] memory bound = new bytes32[](1);
        bound[0] = this.boundWord(id);
        bytes32[] memory tags = new bytes32[](1);
        tags[0] = keccak256(abi.encodePacked("rows", id, root));
        IRollupSettlement.SealedParams memory p = this.filled(
            Job(id, 1, root, keccak256(abi.encodePacked("h", root)), keccak256("frow"), prevU, nextU, bytes32(0), sequencer),
            bound,
            tags
        );
        p.nextC1X = nx;
        p.nextC1Y = ny;
        p.nextC2X = nu;
        p.nextC2Y = nv;
        p.chainHash = settlement.chainHashOf(rows);
        p.dataHash = settlement.computeSealedDataHash(p, settlement.KIND_HOURLY(), options);
        vm.prank(sequencer);
        settlement.submitHourlyBatch(p, bound, tags, rows, options, pa, pb, pc);
    }

    function openLinked(uint64 window) external returns (uint256 id, address el) {
        // A previous case may have warped past start. The window can be set only before then.
        vm.warp(Fixtures.TIME_ORIGIN);
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

    function openTrio(uint64 window) external returns (uint256 id, address el) {
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
        address[] memory gs = new address[](3);
        gs[0] = makeAddr("g1");
        gs[1] = makeAddr("g2");
        gs[2] = makeAddr("g3");
        vm.prank(tallyOperator);
        ceremony.openCeremony(id, ElectionType.POLL, 2, 3, gs);
        this.postDeal(id, gs[0], 2, 3, 11);
        this.postDeal(id, gs[1], 3, FIELD - 2, 13);
        vm.warp(block.timestamp + 1 hours);
        ceremony.dropAbsent(id, ElectionType.POLL);
        ceremony.deriveShare(id, ElectionType.POLL, 1);
        ceremony.deriveShare(id, ElectionType.POLL, 2);
        ceremony.deriveShare(id, ElectionType.POLL, 3);
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
        ceremony.deriveShare(id, ElectionType.POLL, 1);
        ceremony.deriveShare(id, ElectionType.POLL, 2);
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

    function postWide(uint256 id, address guardian, uint256 a0, uint256 nonce) external {
        this.postWideInner(id, guardian, a0, nonce);
    }

    function postWideMeasured(uint256 id, address guardian, uint256 a0, uint256 nonce) external returns (uint256 used) {
        uint256 before = gasleft();
        this.postWideInner(id, guardian, a0, nonce);
        used = before - gasleft();
    }

    function deriveMeasured(uint256 id, uint8 index) external returns (uint256 used) {
        uint256 before = gasleft();
        ceremony.deriveShare(id, ElectionType.POLL, index);
        used = before - gasleft();
    }

    function postWideInner(uint256 id, address guardian, uint256 a0, uint256 nonce) external {
        uint256[] memory cx = new uint256[](16);
        uint256[] memory cy = new uint256[](16);
        (cx[0], cy[0]) = math.mulG(a0);
        for (uint256 t = 1; t < 16; ++t) {
            (cx[t], cy[t]) = math.mulG(1);
        }
        (uint256 rX, uint256 rY) = math.mulG(nonce);
        uint256 e = ceremony.schnorrChallenge(id, ElectionType.POLL, guardian, cx, cy, rX, rY);
        uint256 z = addmod(nonce, mulmod(e, a0, FIELD), FIELD);
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
        bound[0] = this.boundWord(id);
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
        bound[0] = this.boundWord(id);
        bytes32[] memory tags = new bytes32[](1);
        tags[0] = tag;
        uint256 n = settlement.postedUnique(id);
        this.post(
            Job(id, 1, root, settlement.hourlyProduct(id), settlement.finalProduct(id), n, n, bytes32(0), sequencer),
            bound,
            tags,
            new uint256[](0)
        );
    }

    function hourBadProduct(uint256 id, bytes32 root) external {
        bytes32[] memory bound = new bytes32[](1);
        bound[0] = this.boundWord(id);
        bytes32[] memory tags = new bytes32[](1);
        tags[0] = keccak256("fresh-tag");
        uint256 n = settlement.postedUnique(id);
        IRollupSettlement.SealedParams memory p =
            this.filled(Job(id, 1, root, settlement.hourlyProduct(id), settlement.finalProduct(id), n, n, bytes32(0), sequencer), bound, tags);
        p.previousHourly = bytes32(uint256(1));
        p.dataHash = settlement.computeSealedDataHash(p, settlement.KIND_HOURLY());
        vm.prank(sequencer);
        settlement.submitHourlyBatch(
            p, bound, tags, new IRollupSettlement.BallotRow[](0), new IRollupSettlement.OptionPoint[](0), pa, pb, pc
        );
    }

    function boundWord(uint256 id) external view returns (bytes32 word) {
        word = settlement.lastHourlyRoot(id);
        if (word == bytes32(0)) word = bytes32(inbox.emptyBallotRoot(20));
    }

    function openingRow(uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, uint256[12] memory proof)
        external
        pure
        returns (IRollupSettlement.BallotRow memory row)
    {
        row.isFirst = 1;
        row.c1X = c1x;
        row.c1Y = c1y;
        row.c2X = c2x;
        row.c2Y = c2y;
        row.oneHot = proof;
    }

    /// @dev One first ballot encrypting 0 under the joint key, with c1 = G.
    function hourOpening(uint256 id, bytes32 root, bytes32 hourly, bytes32 finalP, uint256 prevU, uint256 nextU)
        external
    {
        (uint256 pkX, uint256 pkY) = ceremony.jointKey(id, ElectionType.POLL);
        uint256 submissionId = 9100;
        (uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, uint256[12] memory proof) =
            math.oneHot(1, 0, pkX, pkY, 11, 5, 13, id, submissionId, address(settlement));
        this.acceptEg(id, submissionId, c1x, c1y, c2x, c2y);
        bytes32[] memory bound = new bytes32[](1);
        bound[0] = this.boundWord(id);
        bytes32[] memory tags = new bytes32[](1);
        tags[0] = keccak256(abi.encodePacked("first", id, root));
        IRollupSettlement.BallotRow[] memory rows = new IRollupSettlement.BallotRow[](1);
        rows[0] = this.openingRow(c1x, c1y, c2x, c2y, proof);
        rows[0].submissionId = submissionId;
        IRollupSettlement.SealedParams memory p =
            this.filled(Job(id, 1, root, hourly, finalP, prevU, nextU, bytes32(0), sequencer), bound, tags);
        p.nextC1X = c1x;
        p.nextC1Y = c1y;
        p.nextC2X = c2x;
        p.nextC2Y = c2y;
        p.chainHash = settlement.chainHashOf(rows);
        p.dataHash = settlement.computeSealedDataHash(p, settlement.KIND_HOURLY());
        vm.prank(sequencer);
        settlement.submitHourlyBatch(p, bound, tags, rows, new IRollupSettlement.OptionPoint[](0), pa, pb, pc);
    }

    /// @dev `count` accepted first ballots, each encrypting 0 with randomness 1.
    ///      The running total continues from the last hourly ciphertext. Ten rows
    ///      fit in one batch; a hundred-row batch runs out of gas in `chainHashOf`.
    function hourMany(uint256 id, bytes32 root, bytes32 hourly, bytes32 finalP, uint256 count) external {
        uint256 prevU = settlement.postedUnique(id);
        IRollupSettlement.Ciphertext memory prev = settlement.chainedHourly(id);
        IRollupSettlement.BallotRow[] memory rows = new IRollupSettlement.BallotRow[](count);
        uint256[4] memory sum;
        sum[0] = prev.c1X;
        sum[1] = prev.c1Y;
        sum[2] = prev.c2X;
        sum[3] = prev.c2Y;
        for (uint256 i; i < count; ++i) {
            (rows[i], sum) = this.hourAppend(id, prevU + i + 1, sum);
        }
        this.hourPost(id, root, hourly, finalP, prevU, prevU + count, rows, sum);
    }

    function hourAppend(uint256 id, uint256 submissionId, uint256[4] memory sum)
        external
        returns (IRollupSettlement.BallotRow memory row, uint256[4] memory next)
    {
        row = this.makeAcceptedRow(id, submissionId, 1, 0);
        (next[0], next[1]) = math.add(sum[0], sum[1], row.c1X, row.c1Y);
        (next[2], next[3]) = math.add(sum[2], sum[3], row.c2X, row.c2Y);
    }

    function makeAcceptedRow(uint256 id, uint256 submissionId, uint256 r, uint256 bit)
        external
        returns (IRollupSettlement.BallotRow memory row)
    {
        row = this.buildRow(id, submissionId, r, bit);
        this.acceptEg(id, submissionId, row.c1X, row.c1Y, row.c2X, row.c2Y);
    }

    function buildRow(uint256 id, uint256 submissionId, uint256 r, uint256 bit)
        external
        view
        returns (IRollupSettlement.BallotRow memory row)
    {
        (uint256 pkX, uint256 pkY) = ceremony.jointKey(id, ElectionType.POLL);
        (uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, uint256[12] memory proof) =
            math.oneHot(r, bit, pkX, pkY, 11, 5, 13, id, submissionId, address(settlement));
        row = this.openingRow(c1x, c1y, c2x, c2y, proof);
        row.submissionId = submissionId;
    }

    function hourPost(
        uint256 id,
        bytes32 root,
        bytes32 hourly,
        bytes32 finalP,
        uint256 prevU,
        uint256 nextU,
        IRollupSettlement.BallotRow[] memory rows,
        uint256[4] memory sum
    ) external {
        bytes32[] memory bound = new bytes32[](1);
        bound[0] = this.boundWord(id);
        bytes32[] memory tags = new bytes32[](1);
        tags[0] = keccak256(abi.encodePacked("many", id, root));
        IRollupSettlement.SealedParams memory p =
            this.filled(Job(id, 1, root, hourly, finalP, prevU, nextU, bytes32(0), sequencer), bound, tags);
        p.nextC1X = sum[0];
        p.nextC1Y = sum[1];
        p.nextC2X = sum[2];
        p.nextC2Y = sum[3];
        p.chainHash = settlement.chainHashOf(rows);
        p.dataHash = settlement.computeSealedDataHash(p, settlement.KIND_HOURLY());
        vm.prank(sequencer);
        settlement.submitHourlyBatch(p, bound, tags, rows, new IRollupSettlement.OptionPoint[](0), pa, pb, pc);
    }

    function acceptEg(uint256 id, uint256 submissionId, uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y) external {
        bytes memory enc = abi.encodePacked(bytes2("EG"), bytes32(c1x), bytes32(c1y), bytes32(c2x), bytes32(c2y));
        submitVoteWithBallot(id, factory.getElection(id), submissionId, enc);
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
        uint256 prevU = settlement.postedUnique(id);
        uint256 nextU = prevU + (replacement ? uint256(0) : uint256(0));
        this.post(
            Job(id, 3, root, hourly, finalP, prevU, nextU, bytes32(0), sequencer),
            new bytes32[](0),
            new bytes32[](0),
            ids
        );
    }

    function suppEmpty(uint256 id, bytes32 root, bytes32 hourly, bytes32 finalP, address who) external {
        uint256 n = settlement.postedUnique(id);
        this.post(
            Job(id, 3, root, hourly, finalP, n, n, bytes32(0), who),
            new bytes32[](0),
            new bytes32[](0),
            new uint256[](0)
        );
    }

    function suppIds(uint256 id, bytes32 root, bytes32 hourly, bytes32 finalP, uint256[] memory ids) external {
        uint256 n = settlement.postedUnique(id);
        this.post(
            Job(id, 3, root, hourly, finalP, n, n, bytes32(0), sequencer),
            new bytes32[](0),
            new bytes32[](0),
            ids
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
        this.suppCipherOption(id, root, hourly, finalP, c1x, c1y, c2x, c2y, false);
    }

    function suppCipherOption(
        uint256 id,
        bytes32 root,
        bytes32 hourly,
        bytes32 finalP,
        uint256 c1x,
        uint256 c1y,
        uint256 c2x,
        uint256 c2y,
        bool withOption
    ) external {
        uint256 n = settlement.postedUnique(id);
        bool opening = c1x != 0 || c1y != 0 || c2x != 0 || c2y != 0;
        IRollupSettlement.BallotRow[] memory rows;
        IRollupSettlement.OptionPoint[] memory options;
        uint256 nextU;
        if (opening) {
            (rows, options, nextU) = this.suppOpening(id, n, c1x, c1y, c2x, c2y, withOption);
        } else {
            rows = new IRollupSettlement.BallotRow[](0);
            options = new IRollupSettlement.OptionPoint[](withOption ? 1 : 0);
            nextU = n;
        }
        IRollupSettlement.SealedParams memory p = this.filled(
            Job(id, 3, root, hourly, finalP, n, nextU, bytes32(0), sequencer), new bytes32[](0), new bytes32[](0)
        );
        p.nextC1X = c1x;
        p.nextC1Y = c1y;
        p.nextC2X = c2x;
        p.nextC2Y = c2y;
        p.chainHash = settlement.chainHashOf(rows);
        p.dataHash = settlement.computeSealedDataHash(p, settlement.KIND_SUPPLEMENTARY(), options);
        vm.prank(sequencer);
        settlement.submitSupplementaryBatch(p, new uint256[](0), rows, options, pa, pb, pc);
    }

    function suppOpening(
        uint256 id,
        uint256 n,
        uint256 c1x,
        uint256 c1y,
        uint256 c2x,
        uint256 c2y,
        bool withOption
    )
        external
        returns (IRollupSettlement.BallotRow[] memory rows, IRollupSettlement.OptionPoint[] memory options, uint256 nextU)
    {
        uint256 submissionId = 8800;
        rows = new IRollupSettlement.BallotRow[](1);
        rows[0] = this.buildRow(id, submissionId, 3, 1);
        require(rows[0].c1X == c1x && rows[0].c1Y == c1y && rows[0].c2X == c2x && rows[0].c2Y == c2y, "opening");
        if (!inbox.nullifierUsed(id, submissionId)) {
            this.acceptEg(id, submissionId, rows[0].c1X, rows[0].c1Y, rows[0].c2X, rows[0].c2Y);
        }
        nextU = n + 1;
        if (!withOption) {
            options = new IRollupSettlement.OptionPoint[](0);
            return (rows, options, nextU);
        }
        rows[0].options = this.twoCiphers(id, submissionId);
        rows[0].sumProof = this.sumAt(id, submissionId, 3, 17, c1x, c1y, c2x, c2y);
        options = new IRollupSettlement.OptionPoint[](2);
        options[0] = this.pointOf(rows[0].options[0]);
        options[1] = this.pointOf(rows[0].options[1]);
    }

    function twoCiphers(uint256 id, uint256 submissionId)
        external
        view
        returns (IRollupSettlement.OptionCipher[] memory vec)
    {
        vec = new IRollupSettlement.OptionCipher[](2);
        vec[0] = this.oneCipher(id, submissionId, 1, 1);
        vec[1] = this.oneCipher(id, submissionId, 2, 0);
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
        settlement.submitSupplementaryBatch(
            p, ids, new IRollupSettlement.BallotRow[](0), new IRollupSettlement.OptionPoint[](0), pa, pb, pc
        );
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
        tally.submitFinalPartial(id, 0, 1, 2, 1, 2, 1, 2, 3);
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
        this.submitHourAt(id, guardian, share, nonce, hourIndex, 1, 2, bad);
    }

    function submitHourAt(
        uint256 id,
        address guardian,
        uint256 share,
        uint256 nonce,
        uint256 hourIndex,
        uint256 c1x,
        uint256 c1y,
        bool bad
    ) external {
        PartialMath.Proof memory good = math.deal(share, nonce, id, ElectionType.POLL, guardian, hourIndex, 5, c1x, c1y);
        uint256 z = bad ? good.z + 1 : good.z;
        vm.prank(guardian);
        tally.submitHourlyPartial(id, hourIndex, good.dX, good.dY, good.aX, good.aY, good.bX, good.bY, z);
    }

    function oneOption(
        uint256 id,
        address guardian,
        uint8 option,
        uint256 share,
        uint256 nonce,
        uint256 c1x,
        uint256 c1y
    ) external {
        PartialMath.Proof memory p =
            math.deal(share, nonce, id, ElectionType.POLL, guardian, type(uint256).max, 5, c1x, c1y);
        vm.prank(guardian);
        tally.submitFinalPartial(id, option, p.dX, p.dY, p.aX, p.aY, p.bX, p.bY, p.z);
    }

    function oneFinal(uint256 id, address guardian, uint256 share, uint256 nonce, uint256 c1x, uint256 c1y) external {
        PartialMath.Proof memory p =
            math.deal(share, nonce, id, ElectionType.POLL, guardian, type(uint256).max, 5, c1x, c1y);
        vm.prank(guardian);
        tally.submitFinalPartial(id, 0, p.dX, p.dY, p.aX, p.aY, p.bX, p.bY, p.z);
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
        bytes memory enc = inbox.settlementOf(id) == address(0)
            ? Fixtures.encryptedBallot(nullifier)
            : egBallot(nullifier);
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
        bytes memory enc = inbox.settlementOf(id) == address(0)
            ? Fixtures.encryptedBallot(submissionId)
            : egBallot(submissionId);
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
        settlement.submitHourlyBatch(
            p, bound, tags, new IRollupSettlement.BallotRow[](0), new IRollupSettlement.OptionPoint[](0), pa, pb, pc
        );
    }

    function postFinal(Job memory job) external {
        bytes32[] memory none = new bytes32[](0);
        IRollupSettlement.SealedParams memory p = this.filled(job, none, none);
        vm.prank(job.who);
        settlement.submitFinalBatch(
            p, none, none, new IRollupSettlement.BallotRow[](0), new IRollupSettlement.OptionPoint[](0), pa, pb, pc
        );
    }

    function postSupp(Job memory job, uint256[] memory included) external {
        bytes32[] memory none = new bytes32[](0);
        IRollupSettlement.SealedParams memory p = this.filled(job, none, none);
        p.tagHash = bytes32(settlement.foldScalars(included));
        p.dataHash = settlement.computeSealedDataHash(p, job.kind);
        vm.prank(job.who);
        settlement.submitSupplementaryBatch(
            p, included, new IRollupSettlement.BallotRow[](0), new IRollupSettlement.OptionPoint[](0), pa, pb, pc
        );
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
