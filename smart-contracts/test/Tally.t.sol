// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IElection} from "../src/interfaces/IElection.sol";
import {ElectionParams, ElectionState, TallyScheme} from "../src/interfaces/ElectionParams.sol";
import {Tally} from "../src/Tally.sol";
import {TallyPublicInputs} from "../src/zk/TallyPublicInputs.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";
import {ITallyVerifier} from "../src/interfaces/ITallyVerifier.sol";

/// @notice Tally posting: legacy SUM_ONLY vs aggregate hash (no per-ballot openings).
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
        vm.expectRevert(ITallyVerifier.CountMismatch.selector);
        tally.submitTally(id, counts, a, b, c);
    }

    function testSubmitTallyBeforeCutoffReverts() public {
        (uint256 id,) = _openWithVotes(1);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(tallyOperator);
        vm.expectPartialRevert(ITallyVerifier.ChallengeWindowOpen.selector);
        tally.submitTally(id, counts, a, b, c);
    }

    function testNonOperatorCannotTally() public {
        (uint256 id, address el) = _openWithVotes(1);
        warpClosed(el);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(clerk);
        vm.expectRevert(ITallyVerifier.NotTallyOperator.selector);
        tally.submitTally(id, counts, a, b, c);
    }

    function testAggregateSchemeRejectsSumOnlyEntry() public {
        (uint256 id, address el) = _openWithVotesScheme(3, TallyScheme.AGGREGATE);
        warpClosed(el);
        uint256[] memory counts = new uint256[](2);
        counts[0] = 3;
        counts[1] = 0;
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.AggregateRequired.selector);
        tally.submitTally(id, counts, a, b, c);
    }

    function testAggregateTallyHasNoPerBallotOpenings() public {
        (uint256 id, address el) = _openWithVotesScheme(5, TallyScheme.AGGREGATE);
        warpClosed(el);

        uint256[] memory counts = new uint256[](3);
        counts[0] = 3;
        counts[1] = 1;
        counts[2] = 1;
        bytes32 aggregate = keccak256("homomorphic-product");
        assertTrue(counts.length != inbox.acceptedBallots(id));

        vm.prank(tallyOperator);
        tally.submitAggregateTally(id, counts, aggregate, a, b, c);

        assertTrue(tally.isTallied(id));
        assertEq(tally.postedScheme(id), TallyScheme.AGGREGATE);
        uint256[] memory got = tally.tally(id);
        assertEq(got.length, 3);
        assertEq(got[0], 3);
        assertEq(got[1], 1);
        assertEq(got[2], 1);
        assertEq(tally.aggregateHash(id), aggregate);
        assertEq(uint256(IElection(el).state()), uint256(ElectionState.TALLIED));

        (bool ok,) = address(tally)
            .call(
                abi.encodeWithSignature(
                    "submitOpenedTally(uint256,uint256[],uint256[],uint256[2],uint256[2][2],uint256[2])",
                    id,
                    counts,
                    counts,
                    a,
                    b,
                    c
                )
            );
        assertFalse(ok, "per-ballot openings entry point must be gone");
    }

    function testAggregateHashRequired() public {
        (uint256 id, address el) = _openWithVotesScheme(2, TallyScheme.AGGREGATE);
        warpClosed(el);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 2;
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.AggregateHashRequired.selector);
        tally.submitAggregateTally(id, counts, bytes32(0), a, b, c);
    }

    function testAggregateOnSumOnlySchemeReverts() public {
        (uint256 id, address el) = _openWithVotes(1);
        warpClosed(el);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.NotAggregateScheme.selector);
        tally.submitAggregateTally(id, counts, bytes32(uint256(1)), a, b, c);
    }

    function testAlreadyTalliedReverts() public {
        (uint256 id, address el) = _openWithVotes(1);
        warpClosed(el);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(tallyOperator);
        tally.submitTally(id, counts, a, b, c);
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.AlreadyTallied.selector);
        tally.submitTally(id, counts, a, b, c);
    }

    function testInstanceHasSevenWordsVersionTwo() public pure {
        uint256[] memory input = TallyPublicInputs.instance(
            7, 3, bytes32(uint256(11)), bytes32(uint256(22)), bytes32(uint256(33)), bytes32(uint256(44))
        );
        assertEq(input.length, 7);
        assertEq(input[0], TallyPublicInputs.VERSION);
        assertEq(input[0], 2);
        assertEq(input[1], 7);
        assertEq(input[2], 3);
        assertEq(input[3], 11);
        assertEq(input[4], 22);
        assertEq(input[5], 33);
        assertEq(input[6], 44);
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
