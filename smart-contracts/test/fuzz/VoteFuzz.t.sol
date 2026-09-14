// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "../../src/interfaces/ElectionParams.sol";
import {Deployer} from "../helpers/Deployer.sol";
import {Fixtures} from "../helpers/Fixtures.sol";

/// @title VoteFuzz
/// @notice Fuzz timestamps, nullifiers, and encrypted ballots. Nullifiers
///         cannot be double-spent. Votes outside [start, cutoff) revert.
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

    function testFuzz_nullifierNoDoubleSpend(uint256 nullifier, bytes calldata encryptedBallot) public {
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
        vm.expectRevert();
        inbox.submitVote(electionId, a, b, c, inputs, encryptedBallot);
        assertEq(inbox.acceptedBallots(electionId), 1, "double spend accepted");
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
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
        assertEq(inbox.ballotHashOf(electionId, nullifier), keccak256(encryptedBallot));
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
}
