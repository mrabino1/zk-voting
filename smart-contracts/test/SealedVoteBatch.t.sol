// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IBallotInbox} from "../src/interfaces/IBallotInbox.sol";
import {IElection} from "../src/interfaces/IElection.sol";
import {ElectionType} from "../src/interfaces/ElectionParams.sol";
import {IRollupSettlement} from "../src/interfaces/IRollupSettlement.sol";
import {ITallyVerifier} from "../src/interfaces/ITallyVerifier.sol";
import {GuardianCeremony} from "../src/GuardianCeremony.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

contract PartialMath {
    struct Proof {
        uint256 pkX;
        uint256 pkY;
        uint256 c1X;
        uint256 c1Y;
        uint256 dX;
        uint256 dY;
        uint256 aX;
        uint256 aY;
        uint256 bX;
        uint256 bY;
        uint256 z;
    }

    function honest(uint256 share, uint256 nonce) public view returns (Proof memory p) {
        uint256 field = _field();
        p.c1X = 1;
        p.c1Y = 2;
        (p.pkX, p.pkY) = this.mulG(share);
        p.dX = p.pkX;
        p.dY = p.pkY;
        (p.aX, p.aY) = this.mulG(nonce);
        p.bX = p.aX;
        p.bY = p.aY;
        p.z = _response(p, share, nonce, field);
    }

    /// @dev External so the precompile call is not inlined into `honest`.
    function mulG(uint256 s) external view returns (uint256 xOut, uint256 yOut) {
        uint256[3] memory input;
        input[0] = 1;
        input[1] = 2;
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

    function _response(Proof memory p, uint256 share, uint256 nonce, uint256 field) private pure returns (uint256) {
        uint256 e =
            uint256(keccak256(abi.encode(p.pkX, p.pkY, p.c1X, p.c1Y, p.dX, p.dY, p.aX, p.aY, p.bX, p.bY))) % field;
        return addmod(nonce, mulmod(e, share, field), field);
    }

    function _field() private pure returns (uint256) {
        return 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    }
}

/// @notice Sealed hourly, final, and supplementary batches.
contract SealedVoteBatchTest is Deployer {
    uint256 internal constant RELAYER_KEY = 0xA11CE;
    PartialMath internal math;
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
        this.hold(id, el, 99, finalRoot, uint64(IElection(el).params().cutoffTime) - 1);
        vm.warp(tally.tallyAllowedAt(id));
        this.suppOne(id, finalRoot, hourly, keccak256("final-with-revote"), 99);
        (,, bool pending, bool included) = inbox.heldRevote(id, 99);
        assertFalse(pending);
        assertTrue(included, "final-hour re-vote counted in the supplementary batch");
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
        warpClosed(el);
        uint64 cutoff = IElection(el).params().cutoffTime;
        vm.warp(cutoff + 1 hours);
        this.forceAt(id, el, 42, hourRoot, cutoff - 1);
        (bytes32 root, bool pending) = inbox.forcedInRoot(id, 42);
        assertEq(root, hourRoot);
        assertTrue(pending);
        assertEq(inbox.acceptedBallots(id), 0, "force-in does not publish turnout");
        vm.expectRevert(IBallotInbox.UnknownBoundRoot.selector);
        this.forceAt(id, el, 43, keccak256("not-a-posted-root"), cutoff - 1);
        vm.warp(tally.tallyAllowedAt(id));
        vm.expectRevert(IBallotInbox.ForceInClosed.selector);
        this.forceAt(id, el, 44, hourRoot, cutoff - 1);
    }

    function testSupplementaryRechecksReceiptRootInTheChain() public {
        (uint256 id, address el) = this.openLinked(2 hours);
        bytes32 hourRoot = keccak256("chain-root");
        bytes32 hourly = keccak256("h4");
        this.hour(id, hourRoot, hourly, keccak256("f4"), 0, 0);
        warpClosed(el);
        vm.warp(IElection(el).params().cutoffTime + 30 minutes);
        this.forceAt(id, el, 42, hourRoot, uint64(IElection(el).params().cutoffTime) - 1);
        bytes32 finalRoot = keccak256("chain-final");
        this.sealFinal(id, finalRoot, hourly, keccak256("f4"), 0);
        vm.warp(tally.tallyAllowedAt(id));
        this.expectBadChain(id, finalRoot, hourly);
        this.suppOne(id, finalRoot, hourly, keccak256("f4b"), 42);
        assertEq(inbox.acceptedBallots(id), 1, "forced-in first ballot counts in the supplementary step");
        (, bool stillPending) = inbox.forcedInRoot(id, 42);
        assertFalse(stillPending);
    }

    function testAnyoneMayPostSupplementaryAfterGrace() public {
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
        this.suppEmpty(id, finalRoot, hourly, keccak256("f5"), stranger);
        assertTrue(settlement.supplementaryPosted(id));
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
        this.postTallyAndDecrypt(id);
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
        vm.expectRevert(IRollupSettlement.BoundRootMismatch.selector);
        this.hourBound(id, keccak256("r8b"), bytes32(0), keccak256("tag-a"));
        vm.expectRevert(IRollupSettlement.DuplicateFirstBallot.selector);
        this.hourDup(id, keccak256("r8c"), first);
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
        assertEq(inbox.pendingHeld(id).length, 0);
        assertEq(inbox.acceptedBallots(id), 1);
    }

    function testChallengeWindowRejectsZeroAndGatesTally() public {
        (uint256 id, address el) = createElection();
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
        warpClosed(el);
        this.expectWindowOpen(id);
        vm.warp(tally.tallyAllowedAt(id));
        this.postCount(id, 1);
        assertTrue(tally.isTallied(id));
    }

    function testBallotRefusedUntilKeyPosted() public {
        (uint256 id, address el) = createElection();
        (uint256 other, address otherEl) = createElection();
        GuardianCeremony ceremony = new GuardianCeremony(address(factory));
        vm.prank(admin);
        inbox.setCeremony(address(ceremony));
        this.postGuardian(ceremony, id, makeAddr("hourly-guardian"), 3, 9);
        registerVoter(other, Fixtures.identityCommitment(uint256(9)));
        freezeRoll(el);
        freezeRoll(otherEl);
        warpOpen(el);
        this.expectKeyMissing(other, otherEl, 5);
    }

    function expectKeyMissing(uint256 id, address el, uint256 nullifier) external {
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        uint256[] memory inputs = this.externalVoteInputs(id, el, nullifier, enc);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.KeyNotPosted.selector);
        inbox.submitVote(id, pa, pb, pc, inputs, enc);
    }

    function testHourlyPartialDoesNotTouchInterimAndRejectsABadProof() public {
        (uint256 id, address el) = createElection();
        GuardianCeremony ceremony = new GuardianCeremony(address(factory));
        vm.prank(admin);
        tally.setCeremony(address(ceremony));
        address guardian = makeAddr("hourly-guardian");
        this.postGuardian(ceremony, id, guardian, 3, 9);
        registerVoter(id, Fixtures.identityCommitment(uint256(8)));
        freezeRoll(el);
        warpOpen(el);
        bytes32 interim = keccak256("interim");
        vm.prank(tallyOperator);
        tally.postInterimResult(id, interim);
        vm.expectRevert(ITallyVerifier.InvalidPartial.selector);
        this.submitHour(id, guardian, 3, 9, true);
        assertEq(tally.interimResult(id), interim);
        assertFalse(tally.hourlyPartialPosted(id, 0, guardian));
        this.submitHour(id, guardian, 3, 9, false);
        assertEq(tally.interimResult(id), interim, "hourly partial is not the interim write");
        assertTrue(tally.hourlyPartialPosted(id, 0, guardian));
    }

    function testDecryptionWaitsForKPartials() public {
        (uint256 id, address el) = createElection();
        vm.prank(tallyOperator);
        tally.setChallengeWindow(id, 1 hours);
        GuardianCeremony ceremony = new GuardianCeremony(address(factory));
        vm.prank(admin);
        tally.setCeremony(address(ceremony));
        this.postPair(ceremony, id);
        freezeRoll(el);
        vm.warp(tally.tallyAllowedAt(id));
        this.postCount(id, 0);
        vm.prank(tallyOperator);
        vm.expectPartialRevert(ITallyVerifier.NotEnoughPartials.selector);
        tally.submitDecryption(id, keccak256("plain"));
        this.submitFinals(id);
        vm.prank(tallyOperator);
        tally.submitDecryption(id, keccak256("plain"));
        assertEq(tally.decryptionHash(id), keccak256("plain"));
    }

    function openLinked(uint64 window) external returns (uint256 id, address el) {
        (id, el) = createElection();
        vm.prank(tallyOperator);
        tally.setChallengeWindow(id, window);
        vm.startPrank(admin);
        inbox.setSettlement(address(settlement));
        tally.setRollupSettlement(address(settlement));
        vm.stopPrank();
        registerVoter(id, Fixtures.identityCommitment(uint256(1)));
        freezeRoll(el);
        warpOpen(el);
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
            Job(id, 1, root, keccak256("h8"), keccak256("f8"), 1, 1, bytes32(0), sequencer),
            bound,
            tags,
            new uint256[](0)
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
            Job(id, 1, root, keccak256("h8"), keccak256("f8"), 1, 2, bytes32(0), sequencer),
            bound,
            tags,
            new uint256[](0)
        );
    }

    function sealMismatch(uint256 id, bytes32 root, bytes32 hourly, bytes32 finalP) external {
        this.post(
            Job(id, 2, root, hourly, finalP, 1, 2, bytes32(0), sequencer),
            new bytes32[](0),
            new bytes32[](0),
            new uint256[](0)
        );
    }

    function sealFinal(uint256 id, bytes32 root, bytes32 hourly, bytes32 finalP, uint256 uniqueCount) external {
        this.post(
            Job(id, 2, root, hourly, finalP, uniqueCount, uniqueCount, bytes32(0), sequencer),
            new bytes32[](0),
            new bytes32[](0),
            new uint256[](0)
        );
    }

    function suppOne(uint256 id, bytes32 root, bytes32 hourly, bytes32 finalP, uint256 submissionId) external {
        uint256[] memory ids = new uint256[](1);
        ids[0] = submissionId;
        uint256 prevU = inbox.acceptedBallots(id);
        uint256 nextU = submissionId == 99 ? prevU : prevU + 1;
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

    function expectBadChain(uint256 id, bytes32 root, bytes32 hourly) external {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 42;
        IRollupSettlement.SealedParams memory p = this.blank(id, root, hourly, keccak256("f4b"), 0, 1);
        p.chainHash = keccak256("wrong-chain");
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
        tally.submitDecryption(id, keccak256("plain"));
        vm.prank(makeAddr("guardian"));
        vm.expectPartialRevert(ITallyVerifier.SupplementaryBatchRequired.selector);
        tally.submitFinalPartial(id, 1, 2, 1, 2, 1, 2, 1, 2, 3);
    }

    function postTallyAndDecrypt(uint256 id) external {
        uint256[] memory counts = new uint256[](1);
        vm.prank(tallyOperator);
        tally.submitTally(id, counts, pa, pb, pc);
        vm.prank(tallyOperator);
        tally.submitDecryption(id, keccak256("plain"));
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

    function postGuardian(GuardianCeremony ceremony, uint256 id, address guardian, uint256 share, uint256 nonce)
        external
    {
        PartialMath.Proof memory good = math.honest(share, nonce);
        PartialMath.Proof memory other = math.honest(5, nonce + 8);
        address[] memory guardians = new address[](2);
        guardians[0] = guardian;
        guardians[1] = makeAddr("other-guardian");
        uint256[2][] memory pks = new uint256[2][](2);
        pks[0] = [good.pkX, good.pkY];
        pks[1] = [other.pkX, other.pkY];
        vm.prank(tallyOperator);
        ceremony.postCeremony(id, ElectionType.POLL, guardians, pks, 2);
    }

    function submitHour(uint256 id, address guardian, uint256 share, uint256 nonce, bool bad) external {
        PartialMath.Proof memory good = math.honest(share, nonce);
        uint256 z = bad ? good.z + 1 : good.z;
        vm.prank(guardian);
        tally.submitHourlyPartial(id, 0, good.c1X, good.c1Y, good.dX, good.dY, good.aX, good.aY, good.bX, good.bY, z);
    }

    function postPair(GuardianCeremony ceremony, uint256 id) external {
        PartialMath.Proof memory aP = math.honest(3, 11);
        PartialMath.Proof memory bP = math.honest(5, 13);
        address[] memory guardians = new address[](2);
        guardians[0] = makeAddr("gA");
        guardians[1] = makeAddr("gB");
        uint256[2][] memory pks = new uint256[2][](2);
        pks[0] = [aP.pkX, aP.pkY];
        pks[1] = [bP.pkX, bP.pkY];
        vm.prank(tallyOperator);
        ceremony.postCeremony(id, ElectionType.POLL, guardians, pks, 2);
    }

    function submitFinals(uint256 id) external {
        PartialMath.Proof memory aP = math.honest(3, 11);
        PartialMath.Proof memory bP = math.honest(5, 13);
        vm.prank(makeAddr("gA"));
        tally.submitFinalPartial(id, aP.c1X, aP.c1Y, aP.dX, aP.dY, aP.aX, aP.aY, aP.bX, aP.bY, aP.z);
        vm.prank(makeAddr("gB"));
        tally.submitFinalPartial(id, bP.c1X, bP.c1Y, bP.dX, bP.dY, bP.aX, bP.aY, bP.bX, bP.bY, bP.z);
    }

    function hold(uint256 id, address el, uint256 submissionId, bytes32 reproof, uint64 at) external {
        vm.warp(uint256(IElection(el).params().cutoffTime) + 1 hours);
        this.deliver(id, el, submissionId, settlement.lastHourlyRoot(id), at, reproof, true);
    }

    function forceAt(uint256 id, address el, uint256 submissionId, bytes32 receiptRoot, uint64 at) external {
        this.deliver(id, el, submissionId, receiptRoot, at, bytes32(0), false);
    }

    function deliver(
        uint256 id,
        address el,
        uint256 submissionId,
        bytes32 receiptRoot,
        uint64 at,
        bytes32 reproof,
        bool held
    ) external {
        bytes memory enc = Fixtures.encryptedBallot(submissionId);
        uint256[] memory inputs = this.externalVoteInputs(id, el, submissionId, enc);
        this.deliverSigned(id, submissionId, receiptRoot, at, reproof, held, enc, inputs);
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
        uint256 submissionId,
        bytes32 receiptRoot,
        uint64 at,
        bytes32 reproof,
        bool held,
        bytes memory enc,
        uint256[] memory inputs
    ) external {
        IBallotInbox.RelayerReceipt memory receipt;
        receipt.submissionId = submissionId;
        receipt.ballotHash = bytes32(inputs[3]);
        receipt.ciphertextHash = keccak256(enc);
        receipt.boundRoot = receiptRoot;
        receipt.receivedAt = at;
        bytes memory sig = this.signReceipt(id, receipt);
        if (held) inbox.submitHeldRevote(id, receipt, sig, reproof, pa, pb, pc, inputs, enc);
        else inbox.forceIn(id, receipt, sig, pa, pb, pc, inputs, enc);
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
        p.boundRootHash = keccak256(abi.encodePacked(bound));
        p.tagHash = keccak256(abi.encodePacked(tags));
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
