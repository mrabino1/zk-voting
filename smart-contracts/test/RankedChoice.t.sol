// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams, TallyScheme} from "../src/interfaces/ElectionParams.sol";
import {IBallotInbox} from "../src/interfaces/IBallotInbox.sol";
import {ITallyVerifier} from "../src/interfaces/ITallyVerifier.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Sealed ranked choice: ranking envelope commitments and the IRV result commitment.
contract RankedChoiceTest is Deployer {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256[2] internal a;
    uint256[2][2] internal b;
    uint256[2] internal c;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        (a, b, c) = Fixtures.dummyProof();
    }

    function _open(uint256 n) internal returns (uint256 id, address el, uint256[] memory ids) {
        ElectionParams memory p = Fixtures.withTallyScheme(defaultParams(), TallyScheme.SUM_ONLY);
        (id, el) = createElection(p);
        for (uint256 i; i < n; ++i) {
            registerVoter(id, Fixtures.identityCommitment(uint256(2000 + i)));
        }
        freezeRoll(el);
        warpOpen(el);
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = uint256(keccak256(abi.encodePacked("rk", i))) % R;
            submitVote(id, el, ids[i]);
        }
    }

    function testCommitRankingChainsRoot() public {
        (uint256 id,, uint256[] memory ids) = _open(2);
        bytes32 h0 = keccak256("ranking-0");
        bytes32 h1 = keccak256("ranking-1");
        vm.prank(relayer);
        inbox.commitRanking(id, ids[0], h0);
        bytes32 r0 = keccak256(abi.encodePacked(bytes32(0), ids[0], h0));
        assertEq(inbox.rankingRoot(id), r0);
        vm.prank(relayer);
        inbox.commitRanking(id, ids[1], h1);
        assertEq(inbox.rankingRoot(id), keccak256(abi.encodePacked(r0, ids[1], h1)));
        assertEq(inbox.rankingHashOf(id, ids[0]), h0);
        assertEq(inbox.rankingCount(id), 2);
    }

    function testCommitRankingIsRelayerOnly() public {
        (uint256 id,, uint256[] memory ids) = _open(1);
        vm.prank(clerk);
        vm.expectRevert(IBallotInbox.NotRelayer.selector);
        inbox.commitRanking(id, ids[0], keccak256("x"));
    }

    function testCommitRankingNeedsAcceptedSubmission() public {
        (uint256 id,,) = _open(1);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.UnknownSubmission.selector);
        inbox.commitRanking(id, 12345, keccak256("x"));
    }

    function testRankingCannotBeSwappedAfterCommit() public {
        (uint256 id,, uint256[] memory ids) = _open(1);
        vm.prank(relayer);
        inbox.commitRanking(id, ids[0], keccak256("a"));
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.RankingAlreadyCommitted.selector);
        inbox.commitRanking(id, ids[0], keccak256("b"));
    }

    function testEmptyRankingRejected() public {
        (uint256 id,, uint256[] memory ids) = _open(1);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.EmptyRankingCommitment.selector);
        inbox.commitRanking(id, ids[0], bytes32(0));
    }

    function testPublishRankedResultAfterTally() public {
        (uint256 id, address el, uint256[] memory ids) = _open(3);
        for (uint256 i; i < 3; ++i) {
            vm.prank(relayer);
            inbox.commitRanking(id, ids[i], keccak256(abi.encodePacked("r", i)));
        }
        bytes32 root = inbox.rankingRoot(id);
        warpClosed(el);

        vm.prank(tallyOperator);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.RankedBeforeTally.selector, id));
        tally.publishRankedResult(id, keccak256("set"), keccak256("rounds"), 3);

        uint256[] memory counts = new uint256[](2);
        counts[0] = 2;
        counts[1] = 1;
        vm.prank(tallyOperator);
        tally.submitTally(id, counts, a, b, c);

        vm.prank(clerk);
        vm.expectRevert(ITallyVerifier.NotTallyOperator.selector);
        tally.publishRankedResult(id, keccak256("set"), keccak256("rounds"), 3);

        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.RankedCountTooHigh.selector);
        tally.publishRankedResult(id, keccak256("set"), keccak256("rounds"), 4);

        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.EmptyCommitment.selector);
        tally.publishRankedResult(id, bytes32(0), keccak256("rounds"), 3);

        vm.prank(tallyOperator);
        tally.publishRankedResult(id, keccak256("set"), keccak256("rounds"), 3);
        (bytes32 setHash, bytes32 roundsHash, bytes32 gotRoot, uint256 n, uint64 at) = tally.rankedResult(id);
        assertEq(setHash, keccak256("set"));
        assertEq(roundsHash, keccak256("rounds"));
        assertEq(gotRoot, root);
        assertEq(n, 3);
        assertGt(at, 0);

        vm.prank(tallyOperator);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.ResultAlreadyFinal.selector, id));
        tally.publishRankedResult(id, keccak256("set2"), keccak256("rounds"), 3);

        vm.prank(relayer);
        vm.expectRevert();
        inbox.commitRanking(id, ids[0], keccak256("late"));
    }

    function testCommitRankingGas() public {
        (uint256 id,, uint256[] memory ids) = _open(1);
        vm.prank(relayer);
        uint256 g = gasleft();
        inbox.commitRanking(id, ids[0], keccak256("g"));
        uint256 used = g - gasleft();
        // Three cold SSTOREs plus an event; well inside any batch budget.
        // Cold writes: hash slot, root, count, event (~137k measured). One tx per ranking.
        assertLt(used, 160_000);
    }
}
