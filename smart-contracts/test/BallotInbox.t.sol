// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IElection} from "../src/interfaces/IElection.sol";
import {BallotInbox} from "../src/BallotInbox.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Ballot inbox: MockVerifier happy path, double-vote, voting window.
contract BallotInboxTest is Deployer {
    uint256 internal electionId;
    address internal election;
    uint256 internal commitment;
    uint256 internal nullifier;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        commitment = Fixtures.identityCommitment(uint256(55));
        nullifier = uint256(keccak256("nullifier-55"));
        (electionId, election) = createElection();
        registerVoter(electionId, commitment);
        freezeRoll(election);
    }

    function testHappyPathSubmitVoteWithMockVerifier() public {
        warpOpen(election);
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, enc);

        vm.expectEmit(true, true, false, false, address(inbox));
        emit VoteAccepted(electionId, nullifier, bytes32(0), relayer);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, inputs, enc);

        assertTrue(inbox.nullifierUsed(electionId, nullifier));
        assertEq(inbox.acceptedBallots(electionId), 1);
        assertEq(inbox.ballotHashOf(electionId, nullifier), bytes32(Fixtures.ballotHash(enc)));
    }

    function testDoubleVoteSameNullifierReverts() public {
        warpOpen(election);
        submitVote(electionId, election, nullifier);
        assertEq(inbox.acceptedBallots(electionId), 1);

        expectSubmitVoteRevert(electionId, election, nullifier);
        assertEq(inbox.acceptedBallots(electionId), 1);
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
    }

    function testVotingBeforeStartReverts() public {
        assertTrue(block.timestamp < IElection(election).params().startTime);
        expectSubmitVoteRevert(electionId, election, nullifier);
        assertEq(inbox.acceptedBallots(electionId), 0);
        assertFalse(inbox.nullifierUsed(electionId, nullifier));
    }

    function testVotingAfterCutoffReverts() public {
        warpClosed(election);
        expectSubmitVoteRevert(electionId, election, uint256(keccak256("late-nullifier")));
        assertEq(inbox.acceptedBallots(electionId), 0);
    }

    function testVoteWithoutFreezeReverts() public {
        (uint256 id, address el) = createElection();
        registerVoter(id, Fixtures.identityCommitment(uint256(56)));
        warpOpen(el);
        assertFalse(IElection(el).rollFrozen());
        expectSubmitVoteRevert(id, el, uint256(keccak256("unfrozen")));
    }

    function testNullifiersIsolatedPerElection() public {
        (uint256 idB, address elB) = createElection();
        registerVoter(idB, Fixtures.identityCommitment(uint256(57)));
        freezeRoll(elB);

        warpOpen(election);
        warpOpen(elB);

        submitVote(electionId, election, nullifier);
        submitVote(idB, elB, nullifier);

        assertTrue(inbox.nullifierUsed(electionId, nullifier));
        assertTrue(inbox.nullifierUsed(idB, nullifier));
        assertEq(inbox.acceptedBallots(electionId), 1);
        assertEq(inbox.acceptedBallots(idB), 1);
    }

    function testDistinctNullifiersCountSeparately() public {
        warpOpen(election);
        submitVote(electionId, election, uint256(keccak256("n1")));
        submitVote(electionId, election, uint256(keccak256("n2")));
        assertEq(inbox.acceptedBallots(electionId), 2);
    }

    function testSecondBallotDifferentCiphertextReverts() public {
        warpOpen(election);
        bytes memory first = Fixtures.encryptedBallot(nullifier);
        bytes memory second = abi.encodePacked(first, "changed-mind");
        submitVoteWithBallot(electionId, election, nullifier, first);
        assertEq(inbox.acceptedBallots(electionId), 1);
        assertEq(inbox.ballotHashOf(electionId, nullifier), keccak256(first));

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, second);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.NullifierUsed.selector);
        inbox.submitVote(electionId, a, b, c, inputs, second);

        assertTrue(inbox.nullifierUsed(electionId, nullifier));
        assertEq(inbox.acceptedBallots(electionId), 1, "second ballot must not mint a second voter");
        assertEq(inbox.ballotHashOf(electionId, nullifier), keccak256(first), "first accepted hash is final");
    }
}
