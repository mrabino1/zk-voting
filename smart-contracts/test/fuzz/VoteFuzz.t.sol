// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "../../src/interfaces/ElectionParams.sol";
import {BallotInbox} from "../../src/BallotInbox.sol";
import {Deployer} from "../helpers/Deployer.sol";
import {Fixtures} from "../helpers/Fixtures.sol";

/// @title VoteFuzz
/// @notice Fuzz timestamps, nullifiers, and encrypted ballots.
///         Per individual election: a nullifier cannot be double-spent in that
///         election (not last-vote-counts, not a lifetime ban across elections).
///         Votes outside [start, cutoff) revert.
contract VoteFuzz is Deployer {
    uint256 internal electionId;
    address internal election;
    uint64 internal startTime;
    uint64 internal cutoffTime;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        startTime = uint64(block.timestamp + 1 days);
        cutoffTime = uint64(block.timestamp + 2 days);
        ElectionParams memory p = Fixtures.withTimes(defaultParams(), startTime, cutoffTime);
        p.maxParticipants = 32;
        p.treeDepth = 16;
        p.questionCount = 1;
        (electionId, election) = createElection(p);
        registerVoter(electionId, Fixtures.identityCommitment(uint256(55)));
        freezeRoll(election);
    }

    /// @notice Same election: second submit with the same nullifier reverts.
    function testFuzz_perElection_sameElectionSecondSubmitReverts(uint256 nullifier, bytes calldata encryptedBallot)
        public
    {
        vm.assume(encryptedBallot.length > 0 && encryptedBallot.length <= 512);
        vm.assume(nullifier != 0);
        vm.warp(bound(block.timestamp, startTime, uint256(cutoffTime) - 1));

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, encryptedBallot);

        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, inputs, encryptedBallot);
        assertTrue(inbox.nullifierUsed(electionId, nullifier), "nullifier not marked used");
        assertEq(inbox.acceptedBallots(electionId), 1);

        vm.prank(relayer);
        vm.expectRevert(BallotInbox.NullifierUsed.selector);
        inbox.submitVote(electionId, a, b, c, inputs, encryptedBallot);
        assertEq(inbox.acceptedBallots(electionId), 1, "double-vote accepted in same election");
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
    }

    function testFuzz_onceOnly_doubleVoteSameNullifierReverts(uint256 nullifier, bytes calldata encryptedBallot)
        public
    {
        testFuzz_perElection_sameElectionSecondSubmitReverts(nullifier, encryptedBallot);
    }

    /// @dev Historical name: same-election double-spend rejection.
    function testFuzz_nullifierNoDoubleSpend(uint256 nullifier, bytes calldata encryptedBallot) public {
        testFuzz_perElection_sameElectionSecondSubmitReverts(nullifier, encryptedBallot);
    }

    /// @notice Mind-change in the **same** election still reverts (not last-vote-counts).
    function testFuzz_perElection_mindChangeSameElectionStillRejected(
        uint256 nullifier,
        bytes calldata firstBallot,
        bytes calldata secondBallot
    ) public {
        vm.assume(firstBallot.length > 0 && firstBallot.length <= 512);
        vm.assume(secondBallot.length > 0 && secondBallot.length <= 512);
        vm.assume(keccak256(firstBallot) != keccak256(secondBallot));
        vm.assume(nullifier != 0);
        vm.warp(bound(block.timestamp, startTime, uint256(cutoffTime) - 1));

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory firstInputs = voteInputs(electionId, election, nullifier, firstBallot);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, firstInputs, firstBallot);
        bytes32 stored = inbox.ballotHashOf(electionId, nullifier);
        assertEq(stored, bytes32(Fixtures.ballotHash(firstBallot)));

        uint256[] memory secondInputs = voteInputs(electionId, election, nullifier, secondBallot);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.NullifierUsed.selector);
        inbox.submitVote(electionId, a, b, c, secondInputs, secondBallot);
        assertEq(inbox.acceptedBallots(electionId), 1, "mind-change must not accept a second ballot in this election");
        assertEq(inbox.ballotHashOf(electionId, nullifier), stored, "first ballot must not be superseded");
    }

    function testFuzz_onceOnly_sameNullifierDifferentCiphertextReverts(
        uint256 nullifier,
        bytes calldata firstBallot,
        bytes calldata secondBallot
    ) public {
        testFuzz_perElection_mindChangeSameElectionStillRejected(nullifier, firstBallot, secondBallot);
    }

    /// @notice Same nullifier field in a **different** election: first vote there succeeds.
    ///         Spentness is per election, not a lifetime ban.
    function testFuzz_perElection_sameFieldSucceedsInDifferentElection(
        uint256 nullifier,
        bytes calldata ballotA,
        bytes calldata ballotB
    ) public {
        vm.assume(ballotA.length > 0 && ballotA.length <= 512);
        vm.assume(ballotB.length > 0 && ballotB.length <= 512);
        vm.assume(nullifier != 0);

        ElectionParams memory p = Fixtures.withTimes(defaultParams(), startTime, cutoffTime);
        p.maxParticipants = 32;
        (uint256 idB, address elB) = createElection(p);
        registerVoter(idB, uint256(keccak256(abi.encode(nullifier, "leaf-b"))));
        freezeRoll(elB);

        vm.warp(bound(block.timestamp, startTime, uint256(cutoffTime) - 1));

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputsA = voteInputs(electionId, election, nullifier, ballotA);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, inputsA, ballotA);
        assertEq(inbox.acceptedBallots(electionId), 1);

        uint256[] memory inputsB = voteInputs(idB, elB, nullifier, ballotB);
        vm.prank(relayer);
        inbox.submitVote(idB, a, b, c, inputsB, ballotB);
        assertTrue(inbox.nullifierUsed(idB, nullifier), "first vote in election B must succeed");
        assertEq(inbox.acceptedBallots(idB), 1);
        assertEq(inbox.acceptedBallots(electionId), 1, "election A count unchanged");
    }

    function testFuzz_voteOutsideWindowReverts(uint256 ts, uint256 nullifier, bytes calldata encryptedBallot) public {
        vm.assume(encryptedBallot.length > 0 && encryptedBallot.length <= 512);
        vm.assume(nullifier != 0);

        uint256 tooEarly = bound(ts, 0, uint256(startTime) > 0 ? uint256(startTime) - 1 : 0);
        uint256 tooLate = bound(ts, cutoffTime, uint256(cutoffTime) + 365 days);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, encryptedBallot);

        vm.warp(tooEarly);
        vm.assume(block.timestamp < startTime);
        vm.prank(relayer);
        vm.expectRevert();
        inbox.submitVote(electionId, a, b, c, inputs, encryptedBallot);
        assertFalse(inbox.nullifierUsed(electionId, nullifier));

        vm.warp(tooLate);
        vm.assume(block.timestamp >= cutoffTime);
        vm.prank(relayer);
        vm.expectRevert();
        inbox.submitVote(electionId, a, b, c, inputs, encryptedBallot);
        assertEq(inbox.acceptedBallots(electionId), 0);
    }

    function testFuzz_voteInWindowAccepted(uint256 ts, uint256 nullifier, bytes calldata encryptedBallot) public {
        vm.assume(encryptedBallot.length > 0 && encryptedBallot.length <= 512);
        vm.assume(nullifier != 0);
        uint256 t = bound(ts, startTime, uint256(cutoffTime) - 1);
        vm.warp(t);
        assertTrue(block.timestamp >= startTime && block.timestamp < cutoffTime);

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, encryptedBallot);
        uint256 before = inbox.acceptedBallots(electionId);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, inputs, encryptedBallot);
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
        assertEq(inbox.acceptedBallots(electionId), before + 1);
    }

    function testFuzz_encryptedBallots(bytes calldata encryptedBallot, uint256 nullifier) public {
        vm.assume(encryptedBallot.length > 0 && encryptedBallot.length <= 1024);
        vm.assume(nullifier != 0);
        vm.warp(startTime);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, encryptedBallot);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, inputs, encryptedBallot);
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
        assertEq(inbox.ballotHashOf(electionId, nullifier), bytes32(Fixtures.ballotHash(encryptedBallot)));
    }

    function testFuzz_emptyBallotReverts(uint256 nullifier) public {
        vm.assume(nullifier != 0);
        vm.warp(startTime);
        bytes memory empty;
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, hex"01");
        vm.prank(relayer);
        vm.expectRevert();
        inbox.submitVote(electionId, a, b, c, inputs, empty);
        assertFalse(inbox.nullifierUsed(electionId, nullifier));
    }

    function testFuzz_timestampsBound(uint64 start, uint64 cutoff, uint256 voteAt, uint256 nullifier) public {
        vm.assume(nullifier != 0);
        uint64 origin = uint64(block.timestamp + 1);
        start = uint64(bound(start, origin, origin + 30 days));
        cutoff = uint64(bound(cutoff, uint256(start) + 1 hours, uint256(start) + 30 days));
        vm.assume(start < cutoff);

        ElectionParams memory p = Fixtures.withTimes(defaultParams(), start, cutoff);
        p.maxParticipants = 0;
        (uint256 id, address el) = createElection(p);
        registerVoter(id, uint256(keccak256(abi.encode(nullifier, "reg"))));
        freezeRoll(el);

        uint256 t = bound(voteAt, 0, uint256(cutoff) + 7 days);
        vm.warp(t);
        bytes memory ballot = hex"01";
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(id, el, nullifier, ballot);

        if (t < start || t >= cutoff) {
            vm.prank(relayer);
            vm.expectRevert();
            inbox.submitVote(id, a, b, c, inputs, ballot);
            assertFalse(inbox.nullifierUsed(id, nullifier));
        } else {
            vm.prank(relayer);
            inbox.submitVote(id, a, b, c, inputs, ballot);
            assertTrue(inbox.nullifierUsed(id, nullifier));
            assertEq(inbox.acceptedBallots(id), 1);
        }
    }

    function testFuzz_secondBallotDifferentHashReverts(
        uint256 nullifier,
        bytes calldata firstBallot,
        bytes calldata secondBallot
    ) public {
        vm.assume(firstBallot.length > 0 && firstBallot.length <= 256);
        vm.assume(secondBallot.length > 0 && secondBallot.length <= 256);
        vm.assume(keccak256(firstBallot) != keccak256(secondBallot));
        vm.assume(nullifier != 0);
        vm.warp(startTime);

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory firstInputs = voteInputs(electionId, election, nullifier, firstBallot);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, firstInputs, firstBallot);

        uint256[] memory secondInputs = voteInputs(electionId, election, nullifier, secondBallot);
        vm.prank(relayer);
        vm.expectRevert();
        inbox.submitVote(electionId, a, b, c, secondInputs, secondBallot);

        assertEq(inbox.acceptedBallots(electionId), 1);
        assertEq(inbox.ballotHashOf(electionId, nullifier), bytes32(Fixtures.ballotHash(firstBallot)));
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
    }
}
