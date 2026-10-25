// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IElection} from "../src/interfaces/IElection.sol";
import {ElectionState} from "../src/interfaces/ElectionParams.sol";
import {Tally} from "../src/Tally.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Tally empty-input, fail-closed proof, unknown election, exact cutoff.
/// @dev Ported from nuursha empty-array / failed-proof state consistency / warp boundary.
contract TallyEdgesTest is Deployer {
    uint256[2] internal a;
    uint256[2][2] internal b;
    uint256[2] internal c;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        (a, b, c) = Fixtures.dummyProof();
    }

    function testCtorRejectsZeroFactory() public {
        vm.expectRevert(Tally.ZeroAddress.selector);
        new Tally(address(0));
    }

    function testEmptyCountsReverts() public {
        (uint256 id, address el) = _openWithVotes(1);
        warpClosed(el);
        uint256[] memory empty;
        vm.prank(tallyOperator);
        vm.expectRevert(Tally.EmptyCounts.selector);
        tally.submitTally(id, empty, a, b, c);
        assertFalse(tally.isTallied(id));
    }

    function testUnknownElectionReverts() public {
        uint256[] memory counts = new uint256[](1);
        counts[0] = 0;
        vm.prank(tallyOperator);
        vm.expectRevert(Tally.UnknownElection.selector);
        tally.submitTally(99, counts, a, b, c);
    }

    function testInvalidProofDoesNotMarkTallied() public {
        (uint256 id, address el) = _openWithVotes(1);
        warpClosed(el);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        verifier.setAccept(false);
        vm.prank(tallyOperator);
        vm.expectRevert(Tally.InvalidProof.selector);
        tally.submitTally(id, counts, a, b, c);
        assertFalse(tally.isTallied(id));
        assertEq(uint256(IElection(el).state()), uint256(ElectionState.CLOSED));

        verifier.setAccept(true);
        vm.prank(tallyOperator);
        tally.submitTally(id, counts, a, b, c);
        assertTrue(tally.isTallied(id));
    }

    function testTallyExactlyAtCutoffSucceeds() public {
        (uint256 id, address el) = _openWithVotes(1);
        vm.warp(IElection(el).params().cutoffTime);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(tallyOperator);
        tally.submitTally(id, counts, a, b, c);
        assertTrue(tally.isTallied(id));
    }

    function testTallyOneSecondBeforeCutoffReverts() public {
        (uint256 id, address el) = _openWithVotes(1);
        vm.warp(IElection(el).params().cutoffTime - 1);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(tallyOperator);
        vm.expectRevert(Tally.ElectionNotClosed.selector);
        tally.submitTally(id, counts, a, b, c);
    }

    function testZeroAcceptedEmptyElectionAllowsZeroVector() public {
        (uint256 id, address el) = createElection();
        freezeRoll(el);
        warpClosed(el);
        uint256[] memory counts = new uint256[](2);
        vm.prank(tallyOperator);
        tally.submitTally(id, counts, a, b, c);
        assertTrue(tally.isTallied(id));
        assertEq(tally.tally(id)[0], 0);
        assertEq(tally.tally(id)[1], 0);
    }

    function testOpenedTallyEmptyCountsReverts() public {
        (uint256 id, address el) = _openWithVotes(1);
        warpClosed(el);
        uint256[] memory empty;
        uint256[] memory openings = new uint256[](1);
        vm.prank(tallyOperator);
        vm.expectRevert(Tally.EmptyCounts.selector);
        tally.submitOpenedTally(id, empty, openings, a, b, c);
    }

    function testTallyIsolationAcrossElections() public {
        (uint256 idA, address elA) = _openWithVotes(1);
        (uint256 idB, address elB) = _openWithVotes(1);
        warpClosed(elA);
        warpClosed(elB);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(tallyOperator);
        tally.submitTally(idA, counts, a, b, c);
        assertTrue(tally.isTallied(idA));
        assertFalse(tally.isTallied(idB));
    }

    function _openWithVotes(uint256 n) internal returns (uint256 id, address el) {
        (id, el) = createElection();
        for (uint256 i; i < n; ++i) {
            registerVoter(id, Fixtures.identityCommitment(i + 1));
        }
        freezeRoll(el);
        warpOpen(el);
        for (uint256 i; i < n; ++i) {
            submitVote(id, el, 1000 + i);
        }
    }
}
