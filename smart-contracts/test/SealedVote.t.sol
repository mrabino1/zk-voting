// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Vm} from "forge-std/Vm.sol";
import {IBallotInbox} from "../src/interfaces/IBallotInbox.sol";
import {ITallyVerifier} from "../src/interfaces/ITallyVerifier.sol";
import {ElectionType} from "../src/interfaces/ElectionParams.sol";
import {SealedVoteInbox} from "../src/sealed/SealedVoteInbox.sol";
import {SealedVoteKey} from "../src/sealed/SealedVoteKey.sol";
import {SealedVoteTally} from "../src/sealed/SealedVoteTally.sol";
import {WesolowskiTimeLock} from "../src/sealed/WesolowskiTimeLock.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice VOTE ballots stay off chain until cutoff. POLL still uses the open inbox.
contract SealedVoteTest is Deployer {
    uint256 internal constant RELAYER_KEY = 0xA11CE;
    uint256 internal constant MODULUS = 10007 * 10009;
    uint256 internal constant LOCK_X = 5;
    uint256 internal constant LOCK_T = 8;

    SealedVoteInbox internal sealedInbox;
    WesolowskiTimeLock internal timeLock;
    SealedVoteKey internal key;
    SealedVoteTally internal sealedTally;
    uint256[2] internal a;
    uint256[2][2] internal b;
    uint256[2] internal c;
    address internal g1;
    address internal g2;
    address internal receiptRelayer;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        (a, b, c) = Fixtures.dummyProof();
        timeLock = new WesolowskiTimeLock(address(factory));
        sealedInbox = new SealedVoteInbox(address(factory));
        key = new SealedVoteKey(address(factory), address(timeLock));
        sealedTally = new SealedVoteTally(address(factory), address(sealedInbox), address(key));
        vm.prank(admin);
        sealedTally.setTallyProofVerifier(address(verifier));
        g1 = makeAddr("guardian-1");
        g2 = makeAddr("guardian-2");
        receiptRelayer = vm.addr(RELAYER_KEY);
        vm.prank(admin);
        factory.setRelayer(receiptRelayer, true);
    }

    function testNoPreCloseCountOrDecryptionSignal() public {
        (uint256 id, address el) = _ready();
        uint256 ballotsBefore = sealedInbox.acceptedBallots(id);
        bytes32 rootBefore = sealedInbox.ballotRoot(id);
        assertEq(ballotsBefore, 0);
        assertEq(rootBefore, bytes32(0));
        assertFalse(sealedInbox.nullifierUsed(id, 3));
        assertEq(key.releasedScalar(id), 0);
        assertFalse(key.isReleased(id));
        assertEq(sealedTally.decryptionHash(id), bytes32(0));
        assertEq(inbox.acceptedBallots(id), 0);

        vm.record();
        _revealEmpty(id);
        _assertNoWrites(address(sealedInbox));
        _assertNoLogs();

        vm.record();
        _rejectOpenInbox(id, el);
        _assertNoWrites(address(inbox));
        _assertNoLogs();

        vm.record();
        vm.prank(g1);
        vm.expectRevert(abi.encodeWithSelector(SealedVoteKey.TooEarly.selector, id));
        key.submitShare(id, 24);
        _assertNoWrites(address(key));

        vm.expectRevert(abi.encodeWithSelector(SealedVoteTally.TooEarly.selector, id));
        vm.prank(tallyOperator);
        sealedTally.submitDecryption(id, keccak256("early"));

        vm.expectRevert(abi.encodeWithSelector(SealedVoteTally.TooEarly.selector, id));
        vm.prank(tallyOperator);
        sealedTally.postInterimResult(id, keccak256("early"));

        vm.expectRevert(abi.encodeWithSelector(SealedVoteTally.TooEarly.selector, id));
        vm.prank(tallyOperator);
        sealedTally.disclose(id, keccak256("early"));

        vm.record();
        vm.expectRevert(abi.encodeWithSelector(WesolowskiTimeLock.TooEarly.selector, id));
        timeLock.submitOpening(id, 2, 1);
        _assertNoWrites(address(timeLock));
        _assertNoLogs();

        assertEq(sealedTally.decryptionHash(id), bytes32(0));
        assertEq(sealedTally.interimResult(id), bytes32(0));
        assertEq(sealedTally.disclosureHash(id), bytes32(0));
        assertFalse(timeLock.isOpen(id));
        assertEq(sealedInbox.acceptedBallots(id), 0);
        assertEq(inbox.acceptedBallots(id), 0);
    }

    function testRealBallotWritesNothingBeforeClose() public {
        (uint256 id, address el) = _ready();
        vm.record();
        _revealExpecting(id, el, 3, abi.encodeWithSelector(SealedVoteInbox.TooEarly.selector, id));
        _assertNoWrites(address(sealedInbox));
        _assertNoLogs();
        assertEq(sealedInbox.acceptedBallots(id), 0);
        assertFalse(sealedInbox.nullifierUsed(id, 3));
        assertEq(sealedInbox.ballotRoot(id), bytes32(0));

        vm.record();
        _forceExpecting(id, el, 4, abi.encodeWithSelector(SealedVoteInbox.TooEarly.selector, id));
        _assertNoWrites(address(sealedInbox));
        _assertNoLogs();
        assertEq(sealedInbox.acceptedBallots(id), 0);
    }

    function testRevealAndDecryptOnlyAfterClose() public {
        (uint256 id, address el) = _ready();
        warpClosed(el);
        vm.expectRevert(abi.encodeWithSelector(SealedVoteKey.TimeLockClosed.selector, id));
        vm.prank(g1);
        key.submitShare(id, 24);
        assertEq(key.shareCount(id), 0);
        assertEq(key.releasedScalar(id), 0);

        (uint256 y, uint256 pi) = _opening(id);
        vm.expectRevert(WesolowskiTimeLock.BadOpening.selector);
        timeLock.submitOpening(id, y, pi + 1);
        timeLock.submitOpening(id, y, pi);

        vm.prank(g1);
        vm.expectRevert(SealedVoteKey.BadShare.selector);
        key.submitShare(id, 99);
        vm.prank(g1);
        key.submitShare(id, 24);
        vm.expectRevert(abi.encodeWithSelector(SealedVoteKey.NeedMoreShares.selector, uint256(1), uint256(2)));
        key.release(id);
        assertEq(key.releasedScalar(id), 0);

        vm.prank(g2);
        key.submitShare(id, 38);
        key.release(id);
        assertEq(key.releasedScalar(id), 10);

        _revealOne(id, el, 3);
        assertEq(sealedInbox.acceptedBallots(id), 1);
        _forceOne(id, el, 4);
        assertEq(sealedInbox.acceptedBallots(id), 2);
        assertEq(inbox.acceptedBallots(id), 0);

        vm.prank(tallyOperator);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.DecryptionBeforeTally.selector, id));
        sealedTally.submitDecryption(id, keccak256("plain"));

        uint256[] memory counts = new uint256[](1);
        counts[0] = 2;
        vm.prank(tallyOperator);
        sealedTally.submitTally(id, counts, a, b, c);
        vm.prank(tallyOperator);
        sealedTally.submitDecryption(id, keccak256("plain"));
        vm.prank(tallyOperator);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.ResultAlreadyFinal.selector, id));
        sealedTally.submitDecryption(id, keccak256("other"));
        _revealExpecting(id, el, 5, abi.encodeWithSelector(SealedVoteInbox.AlreadyTallied.selector));
        assertEq(sealedTally.decryptionHash(id), keccak256("plain"));
        assertEq(sealedTally.tally(id)[0], 2);
    }

    function testInterimHashFreezesAfterClose() public {
        (uint256 id, address el) = _ready();
        warpClosed(el);
        vm.prank(tallyOperator);
        sealedTally.postInterimResult(id, keccak256("once"));
        vm.prank(tallyOperator);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.ResultAlreadyFinal.selector, id));
        sealedTally.postInterimResult(id, keccak256("twice"));
        assertEq(sealedTally.interimResult(id), keccak256("once"));
    }

    function testTallyWaitsOutTheChallengeWindow() public {
        (uint256 id, address el) = _ready();
        vm.prank(tallyOperator);
        sealedInbox.setChallengeWindow(id, 100);
        warpClosed(el);
        (uint256 y, uint256 pi) = _opening(id);
        timeLock.submitOpening(id, y, pi);
        vm.prank(g1);
        key.submitShare(id, 24);
        vm.prank(g2);
        key.submitShare(id, 38);
        key.release(id);
        _revealOne(id, el, 3);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.expectRevert(abi.encodeWithSelector(SealedVoteTally.TooEarly.selector, id));
        vm.prank(tallyOperator);
        sealedTally.submitTally(id, counts, a, b, c);
        assertFalse(sealedTally.isTallied(id));
        vm.warp(block.timestamp + 100);
        vm.prank(tallyOperator);
        sealedTally.submitTally(id, counts, a, b, c);
        assertEq(sealedTally.tally(id)[0], 1);
        _revealExpecting(id, el, 5, abi.encodeWithSelector(SealedVoteInbox.AlreadyTallied.selector));
    }

    function testPollStaysOnTheOpenInbox() public {
        (uint256 id, address el) = createElection();
        registerVoter(id, Fixtures.identityCommitment(9));
        freezeRoll(el);
        warpOpen(el);
        submitVote(id, el, 9);
        assertEq(inbox.acceptedBallots(id), 1);
        _revealEmpty(id);
    }

    function _ready() internal returns (uint256 id, address el) {
        (id, el) = createElection(Fixtures.withElectionType(defaultParams(), ElectionType.VOTE));
        address[] memory guardians = new address[](2);
        guardians[0] = g1;
        guardians[1] = g2;
        vm.startPrank(tallyOperator);
        sealedInbox.setSealedTally(id, address(sealedTally));
        key.configure(id, 2, guardians);
        vm.stopPrank();
        _deal(id, g1, 3, 5);
        _deal(id, g2, 7, 9);
        vm.prank(tallyOperator);
        key.finalize(id);
        vm.prank(tallyOperator);
        timeLock.configure(id, MODULUS, LOCK_X, LOCK_T);
        registerVoter(id, Fixtures.identityCommitment(1));
        freezeRoll(el);
        (uint256 kx, uint256 ky) = key.publicKey(id);
        assertTrue(kx != 0 && ky != 0);
    }

    function _deal(uint256 id, address guardian, uint256 a0, uint256 a1) internal {
        (uint256 x0, uint256 y0) = key.scalarMulG(a0);
        (uint256 x1, uint256 y1) = key.scalarMulG(a1);
        uint256[] memory xs = new uint256[](2);
        uint256[] memory ys = new uint256[](2);
        xs[0] = x0;
        xs[1] = x1;
        ys[0] = y0;
        ys[1] = y1;
        vm.prank(guardian);
        key.submitDeal(id, xs, ys);
    }

    function _opening(uint256 id) internal view returns (uint256 y, uint256 pi) {
        uint256 pow = uint256(1) << LOCK_T;
        y = timeLock.expMod(LOCK_X, pow, MODULUS);
        uint256 l = timeLock.challenge(LOCK_X, y, LOCK_T);
        uint256 q = pow / l;
        pi = timeLock.expMod(LOCK_X, q, MODULUS);
        id;
    }

    function _revealEmpty(uint256 id) internal {
        uint256[2][] memory pa = new uint256[2][](0);
        uint256[2][2][] memory pb = new uint256[2][2][](0);
        uint256[2][] memory pc = new uint256[2][](0);
        uint256[][] memory inputs = new uint256[][](0);
        bytes[] memory ballots = new bytes[](0);
        vm.prank(relayer);
        vm.expectRevert();
        sealedInbox.reveal(id, pa, pb, pc, inputs, ballots);
    }

    function _revealOne(uint256 id, address el, uint256 nullifier) internal {
        _revealAs(id, el, nullifier, "");
    }

    function _revealExpecting(uint256 id, address el, uint256 nullifier, bytes memory expected) internal {
        _revealAs(id, el, nullifier, expected);
    }

    function _revealCall(uint256 id, address el, uint256 nullifier) internal {
        _revealAs(id, el, nullifier, "");
    }

    function _revealAs(uint256 id, address el, uint256 nullifier, bytes memory expected) internal {
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        uint256[][] memory inputs = new uint256[][](1);
        inputs[0] = voteInputs(id, el, nullifier, enc);
        uint256[2][] memory pa = new uint256[2][](1);
        uint256[2][2][] memory pb = new uint256[2][2][](1);
        uint256[2][] memory pc = new uint256[2][](1);
        bytes[] memory ballots = new bytes[](1);
        pa[0] = a;
        pb[0] = b;
        pc[0] = c;
        ballots[0] = enc;
        if (expected.length != 0) vm.expectRevert(expected);
        vm.prank(relayer);
        sealedInbox.reveal(id, pa, pb, pc, inputs, ballots);
    }

    function _forceOne(uint256 id, address el, uint256 nullifier) internal {
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        uint256[] memory inputs = voteInputs(id, el, nullifier, enc);
        bytes32 ballotHash = bytes32(inputs[3]);
        bytes32 body = keccak256(
            abi.encode(
                "SEALED-VOTE-RECEIPT",
                block.chainid,
                address(sealedInbox),
                id,
                nullifier,
                ballotHash,
                keccak256(enc)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", body));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RELAYER_KEY, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.prank(makeAddr("anyone"));
        sealedInbox.forceInclude(id, a, b, c, inputs, enc, sig);
    }

    function _forceExpecting(uint256 id, address el, uint256 nullifier, bytes memory expected) internal {
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        uint256[] memory inputs = voteInputs(id, el, nullifier, enc);
        bytes32 ballotHash = bytes32(inputs[3]);
        bytes32 body = keccak256(
            abi.encode(
                "SEALED-VOTE-RECEIPT",
                block.chainid,
                address(sealedInbox),
                id,
                nullifier,
                ballotHash,
                keccak256(enc)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", body));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RELAYER_KEY, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.expectRevert(expected);
        vm.prank(makeAddr("anyone"));
        sealedInbox.forceInclude(id, a, b, c, inputs, enc, sig);
    }

    function _rejectOpenInbox(uint256 id, address el) internal {
        bytes memory enc = Fixtures.encryptedBallot(uint256(3));
        uint256[] memory inputs = voteInputs(id, el, uint256(3), enc);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IBallotInbox.SealedBallotNotAccepted.selector, id));
        inbox.submitVote(id, a, b, c, inputs, enc);
    }

    function _assertNoWrites(address target) internal view {
        (, bytes32[] memory writes) = vm.accesses(target);
        assertEq(writes.length, 0);
    }

    function _assertNoLogs() internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
    }
}
