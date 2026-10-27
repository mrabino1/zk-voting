// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IElection} from "../src/interfaces/IElection.sol";
import {BallotInbox} from "../src/BallotInbox.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";
import {IBallotInbox} from "../src/interfaces/IBallotInbox.sol";

/// @notice Coercion slice: one accepted nullifier, choice-free on-chain state.
///         A second ballot (even a new ciphertext) reverts. Double voting is
///         impossible. MockVerifier is still required.
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

    function testSecondCiphertextDoesNotSupersede() public {
        bytes memory first = abi.encodePacked("first-ciphertext", nullifier);
        bytes memory later = abi.encodePacked("later-ciphertext", nullifier);
        submitVoteWithBallot(electionId, election, nullifier, first);

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, later);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.NullifierUsed.selector);
        inbox.submitVote(electionId, a, b, c, inputs, later);

        assertEq(inbox.acceptedBallots(electionId), 1);
        assertEq(inbox.ballotHashOf(electionId, nullifier), bytes32(Fixtures.ballotHash(first)));

        vm.warp(IElection(election).params().cutoffTime);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(tallyOperator);
        tally.submitTally(electionId, counts, a, b, c);
        assertTrue(tally.isTallied(electionId));
    }

    function testSecondBallotAfterCutoffReverts() public {
        bytes memory first = abi.encodePacked("first", nullifier);
        bytes memory late = abi.encodePacked("late", nullifier);
        submitVoteWithBallot(electionId, election, nullifier, first);
        vm.warp(IElection(election).params().cutoffTime);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, late);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.OutsideVotingWindow.selector);
        inbox.submitVote(electionId, a, b, c, inputs, late);
        assertEq(inbox.ballotHashOf(electionId, nullifier), bytes32(Fixtures.ballotHash(first)));
        assertEq(inbox.acceptedBallots(electionId), 1);
    }

    function testReceiptFieldsDoNotIncludeChoice() public {
        bytes memory enc = abi.encodePacked("elgamal-standin", uint256(7));
        submitVoteWithBallot(electionId, election, nullifier, enc);
        // On-chain public state is nullifier + ballotHash. There is no option id.
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
        assertEq(inbox.ballotHashOf(electionId, nullifier), bytes32(Fixtures.ballotHash(enc)));
        assertEq(inbox.acceptedBallots(electionId), 1);
    }
}
