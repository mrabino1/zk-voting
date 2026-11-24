// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IZkVotingRollup} from "../src/interfaces/IZkVotingRollup.sol";
import {PoseidonT3} from "../src/libraries/PoseidonT3.sol";
import {StateTree} from "../src/libraries/StateTree.sol";
import {RollupTest} from "./helpers/RollupTest.sol";

/// @notice The escape hatch: when the operator stops serving the queue, an election is closed
///         from the last executed state root, then decrypted exactly as before.
contract DesertTest is RollupTest {
    uint32 internal id;
    StateTree.ElectionLeaf internal leaf;
    uint256[] internal siblings;

    function setUp() public override {
        super.setUp();
        vm.recordLogs();
        id = scheduledElection();
        uint256[] memory roll = new uint256[](4);
        for (uint256 i; i < 4; ++i) {
            roll[i] = i + 1;
        }
        vm.prank(registrar);
        rollup.registerVoters(id, roll);
        recordRequests();
        processQueue("");

        vm.warp(info(id).startTime);
        bytes memory ballots =
            bytes.concat(castOnL2(id, 1, 0), castOnL2(id, 1, 1), castOnL2(id, 0, 2), castOnL2(id, 2, 3));

        leaf = StateTree.ElectionLeaf({
            configHash: uint256(info(id).configHash) % StateTree.FIELD,
            eligibleRoot: 123,
            nullifierRoot: 456,
            accumulatorHash: StateTree.accumulatorHash(l2Acc[id]),
            ballotCount: l2Ballots[id],
            status: StateTree.STATUS_OPEN
        });
        uint256 zero;
        for (uint256 i; i < StateTree.ELECTION_TREE_DEPTH; ++i) {
            siblings.push(zero);
            zero = PoseidonT3.hashLeftRight(zero, zero);
        }
        bytes32 root = bytes32(StateTree.rootFrom(id, StateTree.leafHash(leaf), siblings));
        commitWithRoot(ballots, root);
        settle();

        // The operator now ignores a forced ballot until it expires.
        rollup.forceBallot(id, 99, 98, hex"01");
        vm.warp(block.timestamp + rollup.PRIORITY_EXPIRATION() + 1);
        rollup.activateDesertMode();
    }

    function test_DesertCloseThenDecrypt() public {
        rollup.desertClose(id, leaf, l2Acc[id], siblings);
        IZkVotingRollup.ElectionInfo memory e = info(id);
        assertEq(uint8(e.status), uint8(IZkVotingRollup.Status.Closed));
        assertTrue(e.viaDesert);
        assertEq(e.ballotCount, 4);

        postShares(id, 1);
        postShares(id, 2);
        uint256[] memory counts = new uint256[](3);
        (counts[0], counts[1], counts[2]) = (1, 2, 1);
        uint8[] memory subset = new uint8[](2);
        (subset[0], subset[1]) = (1, 2);
        rollup.finalizeResult(id, counts, subset);
        assertEq(uint8(info(id).status), uint8(IZkVotingRollup.Status.Finalized));
    }

    function test_DesertCloseNeedsAMatchingLeaf() public {
        StateTree.ElectionLeaf memory forged = leaf;
        forged.ballotCount = 5;
        vm.expectRevert(IZkVotingRollup.BadDesertProof.selector);
        rollup.desertClose(id, forged, l2Acc[id], siblings);

        uint256[4][] memory acc = l2Acc[id];
        acc[0][3] = acc[1][3];
        vm.expectRevert(IZkVotingRollup.BadDesertProof.selector);
        rollup.desertClose(id, leaf, acc, siblings);

        forged = leaf;
        forged.configHash = 1;
        vm.expectRevert(IZkVotingRollup.BadDesertProof.selector);
        rollup.desertClose(id, forged, l2Acc[id], siblings);
    }

    function test_DesertCloseOnlyOnce() public {
        rollup.desertClose(id, leaf, l2Acc[id], siblings);
        vm.expectRevert(abi.encodeWithSelector(IZkVotingRollup.WrongStatus.selector, IZkVotingRollup.Status.Closed));
        rollup.desertClose(id, leaf, l2Acc[id], siblings);
    }
}
