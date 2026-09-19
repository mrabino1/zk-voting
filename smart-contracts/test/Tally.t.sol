// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IElection} from "../src/interfaces/IElection.sol";
import {ElectionParams, ElectionState, TallyScheme} from "../src/interfaces/ElectionParams.sol";
import {Tally} from "../src/Tally.sol";
import {TallyPublicInputs} from "../src/zk/TallyPublicInputs.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Tally posting: legacy SUM_ONLY vs OPENS_BALLOTS histogram bind.
contract TallyTest is Deployer {
    uint256[2] internal a;
    uint256[2][2] internal b;
    uint256[2] internal c;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        (a, b, c) = Fixtures.dummyProof();
    }

    function testSumOnlyAllowsAnyPartitionOfAccepted() public {
        (uint256 id, address el) = _openWithVotes(2);

        warpClosed(el);
        uint256[] memory counts = new uint256[](2);
        counts[0] = 2;
        counts[1] = 0;

        vm.prank(tallyOperator);
        tally.submitTally(id, counts, a, b, c);
        assertTrue(tally.isTallied(id));
        assertEq(uint256(IElection(el).state()), uint256(ElectionState.TALLIED));
        uint256[] memory got = tally.tally(id);
        assertEq(got[0], 2);
        assertEq(got[1], 0);
        assertEq(tally.postedScheme(id), TallyScheme.SUM_ONLY);
    }

    function testSumOnlyInventedPartitionStillSucceedsOnLegacyPath() public {
        // Documents the remaining SUM_ONLY hole: [0,2] and [2,0] both sum to 2.
        (uint256 id, address el) = _openWithVotes(2);
        warpClosed(el);

        uint256[] memory invented = new uint256[](2);
        invented[0] = 0;
        invented[1] = 2;

        vm.prank(tallyOperator);
        tally.submitTally(id, invented, a, b, c);
        assertEq(tally.tally(id)[1], 2);
    }

    function testSumOnlyWrongSumReverts() public {
        (uint256 id, address el) = _openWithVotes(2);
        warpClosed(el);

        uint256[] memory counts = new uint256[](2);
        counts[0] = 99;
        counts[1] = 0;

        vm.prank(tallyOperator);
        vm.expectRevert(Tally.CountMismatch.selector);
        tally.submitTally(id, counts, a, b, c);
    }

    function testSubmitTallyBeforeCutoffReverts() public {
        (uint256 id,) = _openWithVotes(1);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(tallyOperator);
        vm.expectRevert(Tally.ElectionNotClosed.selector);
        tally.submitTally(id, counts, a, b, c);
    }

    function testNonOperatorCannotTally() public {
        (uint256 id, address el) = _openWithVotes(1);
        warpClosed(el);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(clerk);
        vm.expectRevert(Tally.NotTallyOperator.selector);
        tally.submitTally(id, counts, a, b, c);
    }

    function testOpensBallotsSubmitTallyRevertsWithoutOpenings() public {
        (uint256 id, address el) = _openWithVotesScheme(3, TallyScheme.OPENS_BALLOTS);
        warpClosed(el);
        uint256[] memory counts = new uint256[](2);
        counts[0] = 3;
        counts[1] = 0;
        vm.prank(tallyOperator);
        vm.expectRevert(Tally.OpeningsRequired.selector);
        tally.submitTally(id, counts, a, b, c);
    }

    function testOpensBallotsRejectsInventedCountsThatOnlyMatchTheSum() public {
        (uint256 id, address el) = _openWithVotesScheme(3, TallyScheme.OPENS_BALLOTS);
        warpClosed(el);

        // Real openings: two option-0, one option-1. Histogram [2,1].
        uint256[] memory openings = new uint256[](3);
        openings[0] = 0;
        openings[1] = 0;
        openings[2] = 1;

        uint256[] memory invented = new uint256[](2);
        invented[0] = 3;
        invented[1] = 0; // sum == 3 == accepted, but not the histogram

        vm.prank(tallyOperator);
        vm.expectRevert(Tally.OpeningMismatch.selector);
        tally.submitOpenedTally(id, invented, openings, a, b, c);

        uint256[] memory alsoInvented = new uint256[](2);
        alsoInvented[0] = 0;
        alsoInvented[1] = 3;
        vm.prank(tallyOperator);
        vm.expectRevert(Tally.OpeningMismatch.selector);
        tally.submitOpenedTally(id, alsoInvented, openings, a, b, c);
    }

    function testOpensBallotsHappyPathPlurality() public {
        (uint256 id, address el) = _openWithVotesScheme(5, TallyScheme.OPENS_BALLOTS);
        warpClosed(el);

        // 0,0,1,0,2 → plurality option 0 with counts [3,1,1]
        uint256[] memory openings = new uint256[](5);
        openings[0] = 0;
        openings[1] = 0;
        openings[2] = 1;
        openings[3] = 0;
        openings[4] = 2;

        uint256[] memory counts = new uint256[](3);
        counts[0] = 3;
        counts[1] = 1;
        counts[2] = 1;

        vm.prank(tallyOperator);
        tally.submitOpenedTally(id, counts, openings, a, b, c);

        assertTrue(tally.isTallied(id));
        assertEq(tally.postedScheme(id), TallyScheme.OPENS_BALLOTS);
        uint256[] memory got = tally.tally(id);
        assertEq(got.length, 3);
        assertEq(got[0], 3);
        assertEq(got[1], 1);
        assertEq(got[2], 1);
        assertEq(tally.openingsHash(id), keccak256(abi.encodePacked(openings)));
        assertEq(uint256(IElection(el).state()), uint256(ElectionState.TALLIED));
    }

    function testOpensBallotsOpeningLengthMustEqualAccepted() public {
        (uint256 id, address el) = _openWithVotesScheme(2, TallyScheme.OPENS_BALLOTS);
        warpClosed(el);
        uint256[] memory openings = new uint256[](1);
        openings[0] = 0;
        uint256[] memory counts = new uint256[](2);
        counts[0] = 2;
        counts[1] = 0;
        vm.prank(tallyOperator);
        vm.expectRevert(Tally.OpeningLengthMismatch.selector);
        tally.submitOpenedTally(id, counts, openings, a, b, c);
    }

    function testOpensBallotsOptionOutOfRangeReverts() public {
        (uint256 id, address el) = _openWithVotesScheme(1, TallyScheme.OPENS_BALLOTS);
        warpClosed(el);
        uint256[] memory openings = new uint256[](1);
        openings[0] = 9;
        uint256[] memory counts = new uint256[](2);
        counts[0] = 1;
        counts[1] = 0;
        vm.prank(tallyOperator);
        vm.expectRevert(Tally.OptionOutOfRange.selector);
        tally.submitOpenedTally(id, counts, openings, a, b, c);
    }

    function testAlreadyTalliedReverts() public {
        (uint256 id, address el) = _openWithVotes(1);
        warpClosed(el);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(tallyOperator);
        tally.submitTally(id, counts, a, b, c);
        vm.prank(tallyOperator);
        vm.expectRevert(Tally.AlreadyTallied.selector);
        tally.submitTally(id, counts, a, b, c);
    }

    function testMockInstanceHasSixWordsVersionOne() public pure {
        uint256[] memory input = TallyPublicInputs.mockInstance(7, 3, bytes32(uint256(11)), bytes32(uint256(22)), bytes32(uint256(33)));
        assertEq(input.length, 6);
        assertEq(input[0], TallyPublicInputs.VERSION);
        assertEq(input[1], 7);
        assertEq(input[2], 3);
        assertEq(input[3], 11);
        assertEq(input[4], 22);
        assertEq(input[5], 33);
    }

    function testBallotRootChainsAcceptedHashes() public {
        (uint256 id, address el) = createElection();
        registerVoter(id, Fixtures.identityCommitment(uint256(1)));
        registerVoter(id, Fixtures.identityCommitment(uint256(2)));
        freezeRoll(el);
        warpOpen(el);

        assertEq(inbox.ballotRoot(id), bytes32(0));
        uint256 n0 = uint256(keccak256("n0"));
        uint256 n1 = uint256(keccak256("n1"));
        submitVote(id, el, n0);
        bytes32 h0 = inbox.ballotHashOf(id, n0);
        assertEq(inbox.ballotRoot(id), keccak256(abi.encodePacked(bytes32(0), h0)));
        assertEq(inbox.ballotHashAt(id, 0), h0);
        submitVote(id, el, n1);
        bytes32 h1 = inbox.ballotHashOf(id, n1);
        assertEq(inbox.ballotRoot(id), keccak256(abi.encodePacked(keccak256(abi.encodePacked(bytes32(0), h0)), h1)));
        assertEq(inbox.ballotHashAt(id, 1), h1);
    }

    function testCreateElectionStoresTallySchemeAndPubKey() public {
        ElectionParams memory p = defaultParams();
        p.tallyScheme = TallyScheme.OPENS_BALLOTS;
        p.tallyPubKeyX = bytes32(uint256(0xaaa));
        p.tallyPubKeyY = bytes32(uint256(0xbbb));
        (, address el) = createElection(p);
        ElectionParams memory got = IElection(el).params();
        assertEq(got.tallyScheme, TallyScheme.OPENS_BALLOTS);
        assertEq(got.tallyPubKeyX, p.tallyPubKeyX);
        assertEq(got.tallyPubKeyY, p.tallyPubKeyY);
    }

    function testInvalidTallySchemeReverts() public {
        ElectionParams memory p = defaultParams();
        p.tallyScheme = 2;
        vm.prank(admin);
        vm.expectRevert();
        factory.createElection(p);
    }

    function _openWithVotes(uint256 n) internal returns (uint256 id, address el) {
        return _openWithVotesScheme(n, TallyScheme.SUM_ONLY);
    }

    function _openWithVotesScheme(uint256 n, uint8 scheme) internal returns (uint256 id, address el) {
        ElectionParams memory p = Fixtures.withTallyScheme(defaultParams(), scheme);
        (id, el) = createElection(p);
        for (uint256 i; i < n; ++i) {
            registerVoter(id, Fixtures.identityCommitment(uint256(1000 + i)));
        }
        freezeRoll(el);
        warpOpen(el);
        for (uint256 i; i < n; ++i) {
            submitVote(id, el, uint256(keccak256(abi.encodePacked("n", i))));
        }
        assertEq(inbox.acceptedBallots(id), n);
    }
}
