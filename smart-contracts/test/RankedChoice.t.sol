// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams, TallyScheme} from "../src/interfaces/ElectionParams.sol";
import {IBallotInbox} from "../src/interfaces/IBallotInbox.sol";
import {ITallyVerifier} from "../src/interfaces/ITallyVerifier.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Sealed ranked choice: ranking hashes ride in the hourly vote batch; IRV result commitment.
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

    function _setup(uint256 n) internal returns (uint256 id, address el, uint256[] memory ids) {
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
        }
    }

    function _args(uint256 id, address el, uint256[] memory ids)
        internal
        view
        returns (
            uint256[2][] memory pa,
            uint256[2][2][] memory pb,
            uint256[2][] memory pc,
            uint256[][] memory inputs,
            bytes[] memory ballots
        )
    {
        uint256 n = ids.length;
        pa = new uint256[2][](n);
        pb = new uint256[2][2][](n);
        pc = new uint256[2][](n);
        inputs = new uint256[][](n);
        ballots = new bytes[](n);
        for (uint256 i; i < n; ++i) {
            pa[i] = a;
            pb[i] = b;
            pc[i] = c;
            ballots[i] = Fixtures.encryptedBallot(ids[i]);
            inputs[i] = voteInputs(id, el, ids[i], ballots[i]);
        }
    }

    function _sorted(uint256 n, string memory salt) internal pure returns (bytes32[] memory hs) {
        hs = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            hs[i] = keccak256(abi.encodePacked(salt, i));
        }
        for (uint256 i = 1; i < n; ++i) {
            bytes32 v = hs[i];
            uint256 j = i;
            while (j > 0 && uint256(hs[j - 1]) > uint256(v)) {
                hs[j] = hs[j - 1];
                --j;
            }
            hs[j] = v;
        }
    }

    function _ranked(uint256 id, address el, uint256[] memory ids, bytes32[] memory hs) internal {
        (uint256[2][] memory pa, uint256[2][2][] memory pb, uint256[2][] memory pc, uint256[][] memory inputs, bytes[] memory ballots) =
            _args(id, el, ids);
        vm.prank(relayer);
        inbox.submitVoteBatchRanked(id, pa, pb, pc, inputs, ballots, hs);
    }

    function testBatchCarriesRankingRoot() public {
        (uint256 id, address el, uint256[] memory ids) = _setup(3);
        bytes32[] memory hs = _sorted(3, "r");
        _ranked(id, el, ids, hs);
        bytes32 digest = keccak256(abi.encodePacked(hs));
        assertEq(inbox.rankingRoot(id), keccak256(abi.encodePacked(bytes32(0), digest, uint256(3))));
        assertEq(inbox.rankingCount(id), 3);
        assertEq(inbox.acceptedCount(id), 3);
    }

    function testUnsortedRankingsRevertWithTheBallots() public {
        (uint256 id, address el, uint256[] memory ids) = _setup(2);
        bytes32[] memory hs = _sorted(2, "r");
        (hs[0], hs[1]) = (hs[1], hs[0]);
        (uint256[2][] memory pa, uint256[2][2][] memory pb, uint256[2][] memory pc, uint256[][] memory inputs, bytes[] memory ballots) =
            _args(id, el, ids);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.RankingsNotSorted.selector);
        inbox.submitVoteBatchRanked(id, pa, pb, pc, inputs, ballots, hs);
        // The whole batch reverted, so no ballot landed without its ranking.
        assertEq(inbox.acceptedCount(id), 0);
    }

    function testRankingCountBoundedByBallots() public {
        (uint256 id, address el, uint256[] memory ids) = _setup(1);
        (uint256[2][] memory pa, uint256[2][2][] memory pb, uint256[2][] memory pc, uint256[][] memory inputs, bytes[] memory ballots) =
            _args(id, el, ids);
        bytes32[] memory two = _sorted(2, "r");
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.RankingCountMismatch.selector);
        inbox.submitVoteBatchRanked(id, pa, pb, pc, inputs, ballots, two);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.RankingCountMismatch.selector);
        inbox.submitVoteBatchRanked(id, pa, pb, pc, inputs, ballots, new bytes32[](0));
        bytes32[] memory zero = new bytes32[](1);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.EmptyRankingCommitment.selector);
        inbox.submitVoteBatchRanked(id, pa, pb, pc, inputs, ballots, zero);
    }

    function testRankedBatchIsRelayerOnly() public {
        (uint256 id, address el, uint256[] memory ids) = _setup(1);
        (uint256[2][] memory pa, uint256[2][2][] memory pb, uint256[2][] memory pc, uint256[][] memory inputs, bytes[] memory ballots) =
            _args(id, el, ids);
        vm.prank(clerk);
        vm.expectRevert(IBallotInbox.NotRelayer.selector);
        inbox.submitVoteBatchRanked(id, pa, pb, pc, inputs, ballots, _sorted(1, "r"));
    }

    function testPublishRankedResultAfterTally() public {
        (uint256 id, address el, uint256[] memory ids) = _setup(3);
        _ranked(id, el, ids, _sorted(3, "r"));
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
    }

    /// @dev Marginal cost of carrying rankings: a full 64-ballot batch with and without
    ///      its 64 ranking hashes. Must stay far inside the 24M default batch budget.
    function testRankingBatchGas() public {
        (uint256 id, address el, uint256[] memory ids) = _setup(64);
        bytes32[] memory hs = _sorted(64, "g");
        (uint256[2][] memory pa, uint256[2][2][] memory pb, uint256[2][] memory pc, uint256[][] memory inputs, bytes[] memory ballots) =
            _args(id, el, ids);
        vm.prank(relayer);
        uint256 g = gasleft();
        inbox.submitVoteBatchRanked(id, pa, pb, pc, inputs, ballots, hs);
        uint256 used = g - gasleft();
        emit log_named_uint("submitVoteBatchRanked(64) gas", used);
        assertLt(used, 24_000_000);
    }
}
