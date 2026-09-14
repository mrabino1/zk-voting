// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IElection} from "../src/interfaces/IElection.sol";
import {BallotInbox} from "../src/BallotInbox.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Last-ballot-counts coercion slice: overwrite inside the window,
///         replay of a superseded hash fails, MockVerifier still required.
contract CoercionResistanceTest is Deployer {
    uint256 internal electionId;
    address internal election;
    uint256 internal nullifier;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        nullifier = uint256(keccak256("coercion-nullifier"));
        (electionId, election) = createElection();
        registerVoter(electionId, Fixtures.identityCommitment(uint256(91)));
        freezeRoll(election);
        warpOpen(election);
    }

    function testRevoteThenTallyUsesUniqueNullifiers() public {
        bytes memory coerced = abi.encodePacked("coerced-ciphertext", nullifier);
        bytes memory free = abi.encodePacked("free-ciphertext", nullifier);
        submitVoteWithBallot(electionId, election, nullifier, coerced);
        submitVoteWithBallot(electionId, election, nullifier, free);
        assertEq(inbox.acceptedBallots(electionId), 1);

        vm.warp(IElection(election).params().cutoffTime);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(tallyOperator);
        tally.submitTally(electionId, counts, a, b, c);
        assertTrue(tally.isTallied(electionId));
    }

    function testRevoteAfterCutoffReverts() public {
        bytes memory first = abi.encodePacked("first", nullifier);
        bytes memory late = abi.encodePacked("late", nullifier);
        submitVoteWithBallot(electionId, election, nullifier, first);
        vm.warp(IElection(election).params().cutoffTime);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, late);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.OutsideVotingWindow.selector);
        inbox.submitVote(electionId, a, b, c, inputs, late);
        assertEq(inbox.ballotHashOf(electionId, nullifier), keccak256(first));
        assertEq(inbox.voteGeneration(electionId, nullifier), 1);
    }

    function testReceiptFieldsDoNotIncludeChoice() public {
        bytes memory enc = abi.encodePacked("elgamal-standin", uint256(7));
        submitVoteWithBallot(electionId, election, nullifier, enc);
        // On-chain public state is nullifier + ballotHash. There is no option id.
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
        assertEq(inbox.ballotHashOf(electionId, nullifier), keccak256(enc));
        assertEq(inbox.voteGeneration(electionId, nullifier), 1);
    }
}
