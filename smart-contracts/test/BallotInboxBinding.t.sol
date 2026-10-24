// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {BallotInbox} from "../src/BallotInbox.sol";
import {IElection} from "../src/interfaces/IElection.sol";
import {ElectionState} from "../src/interfaces/ElectionParams.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Proof-binding, window boundaries, fail-closed proof, and vote-after-tally.
/// @dev Edge cases: wrong public inputs, empty/short payload,
///      failed proof must not consume the unique key, warp(t-1)/t/t+1.
contract BallotInboxBindingTest is Deployer {
    uint256 internal electionId;
    address internal election;
    uint256[2] internal a;
    uint256[2][2] internal b;
    uint256[2] internal c;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        (a, b, c) = Fixtures.dummyProof();
        uint256 commitment = Fixtures.identityCommitment(uint256(1));
        (electionId, election) = prepareOpenElection(commitment);
    }

    function testEmptyBallotReverts() public {
        uint256[] memory inputs = voteInputs(electionId, election, 7, Fixtures.encryptedBallot(7));
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.EmptyBallot.selector);
        inbox.submitVote(electionId, a, b, c, inputs, bytes(""));
    }

    function testPublicInputsLengthZeroReverts() public {
        _expectInvalidPublicInputs(new uint256[](0));
    }

    function testPublicInputsLengthFourReverts() public {
        uint256[] memory inputs = new uint256[](4);
        _expectInvalidPublicInputs(inputs);
    }

    function testUnknownElectionReverts() public {
        bytes memory enc = Fixtures.encryptedBallot(7);
        uint256[] memory inputs = voteInputs(electionId, election, 7, enc);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.UnknownElection.selector);
        inbox.submitVote(999, a, b, c, inputs, enc);
    }

    function testEligibleRootMismatchRevertsAndDoesNotConsume() public {
        _corruptAndAssertUnused(0, 1, BallotInbox.EligibleRootMismatch.selector);
    }

    function testDisqualificationRootMismatchRevertsAndDoesNotConsume() public {
        _corruptAndAssertUnused(1, 1, BallotInbox.DisqualificationRootMismatch.selector);
    }

    function testElectionIdMismatchRevertsAndDoesNotConsume() public {
        _corruptAndAssertUnused(4, electionId + 1, BallotInbox.ElectionIdMismatch.selector);
    }

    function testBallotHashMismatchRevertsAndDoesNotConsume() public {
        bytes memory enc = Fixtures.encryptedBallot(11);
        uint256[] memory inputs = voteInputs(electionId, election, 11, enc);
        inputs[3] = 0xdead;
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.BallotHashMismatch.selector);
        inbox.submitVote(electionId, a, b, c, inputs, enc);
        assertFalse(inbox.nullifierUsed(electionId, 11));
        assertEq(inbox.acceptedBallots(electionId), 0);
    }

    function testInvalidProofDoesNotConsumeNullifier() public {
        bytes memory enc = Fixtures.encryptedBallot(13);
        uint256[] memory inputs = voteInputs(electionId, election, 13, enc);

        verifier.setAccept(false);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.InvalidProof.selector);
        inbox.submitVote(electionId, a, b, c, inputs, enc);
        assertFalse(inbox.nullifierUsed(electionId, 13));
        assertEq(inbox.acceptedBallots(electionId), 0);

        verifier.setAccept(true);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, inputs, enc);
        assertTrue(inbox.nullifierUsed(electionId, 13));
        assertEq(inbox.acceptedBallots(electionId), 1);
    }

    function testDeniedNullifierIsInvalidProof() public {
        bytes memory enc = Fixtures.encryptedBallot(17);
        uint256[] memory inputs = voteInputs(electionId, election, 17, enc);
        verifier.setDeniedNullifier(bytes32(uint256(17)), true);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.InvalidProof.selector);
        inbox.submitVote(electionId, a, b, c, inputs, enc);
        assertFalse(inbox.nullifierUsed(electionId, 17));
    }

    function testZeroNullifierIsAcceptedOnce() public {
        submitVote(electionId, election, 0);
        assertTrue(inbox.nullifierUsed(electionId, 0));
        _expectNullifierUsed(0);
    }

    function testMaxUintNullifierIsAcceptedOnce() public {
        uint256 n = type(uint256).max;
        submitVote(electionId, election, n);
        assertTrue(inbox.nullifierUsed(electionId, n));
        _expectNullifierUsed(n);
    }

    function testSameBlockDoubleSubmitReverts() public {
        submitVote(electionId, election, 21);
        _expectNullifierUsed(21);
        assertEq(inbox.acceptedBallots(electionId), 1);
    }

    function testVoteAtExactStartTimeSucceeds() public {
        vm.warp(IElection(election).params().startTime);
        submitVote(electionId, election, 23);
        assertEq(inbox.acceptedBallots(electionId), 1);
    }

    function testVoteOneSecondBeforeStartReverts() public {
        vm.warp(IElection(election).params().startTime - 1);
        _expectOutsideWindow(29);
    }

    function testVoteAtExactCutoffReverts() public {
        vm.warp(IElection(election).params().cutoffTime);
        _expectOutsideWindow(31);
    }

    function testVoteOneSecondBeforeCutoffSucceeds() public {
        vm.warp(IElection(election).params().cutoffTime - 1);
        submitVote(electionId, election, 37);
        assertEq(inbox.acceptedBallots(electionId), 1);
    }

    function testVoteOneSecondAfterCutoffReverts() public {
        vm.warp(IElection(election).params().cutoffTime + 1);
        _expectOutsideWindow(41);
    }

    function testVoteAfterTallyRevertsAlreadyTallied() public {
        submitVote(electionId, election, 43);
        warpClosed(election);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(tallyOperator);
        tally.submitTally(electionId, counts, a, b, c);
        assertTrue(tally.isTallied(electionId));
        assertEq(uint256(IElection(election).state()), uint256(ElectionState.TALLIED));

        // Still inside a warped-closed window; AlreadyTallied is checked after window.
        // Warp back into the window so the tally gate is the one that fires.
        vm.warp(IElection(election).params().startTime);
        bytes memory enc = Fixtures.encryptedBallot(47);
        uint256[] memory inputs = voteInputs(electionId, election, 47, enc);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.AlreadyTallied.selector);
        inbox.submitVote(electionId, a, b, c, inputs, enc);
        assertFalse(inbox.nullifierUsed(electionId, 47));
    }

    function testAnyoneMayRelayNotJustDesignatedRelayer() public {
        address stranger = makeAddr("strangerRelayer");
        bytes memory enc = Fixtures.encryptedBallot(53);
        uint256[] memory inputs = voteInputs(electionId, election, 53, enc);
        vm.prank(stranger);
        inbox.submitVote(electionId, a, b, c, inputs, enc);
        assertTrue(inbox.nullifierUsed(electionId, 53));
    }

    function testAcceptedCountAndBallotRootChain() public {
        submitVote(electionId, election, 61);
        submitVote(electionId, election, 67);
        assertEq(inbox.acceptedBallots(electionId), 2);
        bytes32 h0 = inbox.ballotHashOf(electionId, 61);
        bytes32 h1 = inbox.ballotHashOf(electionId, 67);
        assertEq(inbox.ballotHashAt(electionId, 0), h0);
        assertEq(inbox.ballotHashAt(electionId, 1), h1);
        assertEq(inbox.ballotRoot(electionId), keccak256(abi.encodePacked(keccak256(abi.encodePacked(bytes32(0), h0)), h1)));
    }

    function _expectInvalidPublicInputs(uint256[] memory inputs) internal {
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.InvalidPublicInputs.selector);
        inbox.submitVote(electionId, a, b, c, inputs, Fixtures.encryptedBallot(1));
    }

    function _corruptAndAssertUnused(uint256 index, uint256 value, bytes4 selector) internal {
        bytes memory enc = Fixtures.encryptedBallot(11);
        uint256[] memory inputs = voteInputs(electionId, election, 11, enc);
        inputs[index] = value;
        vm.prank(relayer);
        vm.expectRevert(selector);
        inbox.submitVote(electionId, a, b, c, inputs, enc);
        assertFalse(inbox.nullifierUsed(electionId, 11));
        assertEq(inbox.acceptedBallots(electionId), 0);
    }

    function _expectNullifierUsed(uint256 nullifier) internal {
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, enc);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.NullifierUsed.selector);
        inbox.submitVote(electionId, a, b, c, inputs, enc);
    }

    function _expectOutsideWindow(uint256 nullifier) internal {
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, enc);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.OutsideVotingWindow.selector);
        inbox.submitVote(electionId, a, b, c, inputs, enc);
        assertEq(inbox.acceptedBallots(electionId), 0);
    }
}
