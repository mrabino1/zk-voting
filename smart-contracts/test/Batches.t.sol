// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IZkVotingRollup} from "../src/interfaces/IZkVotingRollup.sol";
import {Ops} from "../src/libraries/Ops.sol";
import {StateTree} from "../src/libraries/StateTree.sol";
import {RollupTest} from "./helpers/RollupTest.sol";

/// @notice commit → verify → execute, in order, with the queue enforced inside pubdata.
contract BatchesTest is RollupTest {
    uint32 internal id;

    function setUp() public override {
        super.setUp();
        vm.recordLogs();
        id = scheduledElection();
        recordRequests();
    }

    function test_BatchCommitmentBindsEverything() public {
        bytes memory pubdata = pendingRequestOps();
        bytes32 prevRoot = lastBatch.stateRoot;
        IZkVotingRollup.StoredBatchInfo memory b = commitWithRoot(pubdata, bytes32(uint256(77)));
        bytes32 expected = bytes32(
            uint256(
                sha256(
                    abi.encodePacked(
                        prevRoot,
                        bytes32(uint256(77)),
                        uint64(1),
                        uint64(block.timestamp),
                        sha256(pubdata),
                        b.priorityOpsHash,
                        b.onchainOpsHash
                    )
                )
            ) & ((uint256(1) << 253) - 1)
        );
        assertEq(b.commitment, expected);
        assertEq(b.priorityOperations, 1);
        assertEq(rollup.storedBatchHashes(1), keccak256(abi.encode(b)));
        assertEq(rollup.totalCommittedPriorityRequests(), 1);
    }

    function test_OnlyOperatorsCommit() public {
        IZkVotingRollup.CommitBatchInfo memory next =
            IZkVotingRollup.CommitBatchInfo(bytes32(uint256(1)), uint64(block.timestamp), "");
        vm.expectRevert(IZkVotingRollup.NotOperator.selector);
        rollup.commitBatch(lastBatch, next);
    }

    function test_CommitMustExtendTheLatestBatch() public {
        IZkVotingRollup.StoredBatchInfo memory stale = lastBatch;
        commit(pendingRequestOps());
        IZkVotingRollup.CommitBatchInfo memory next =
            IZkVotingRollup.CommitBatchInfo(bytes32(uint256(1)), uint64(block.timestamp), "");
        vm.expectRevert(IZkVotingRollup.BadStoredBatch.selector);
        vm.prank(operator);
        rollup.commitBatch(stale, next);
    }

    function test_TimestampRules() public {
        vm.warp(block.timestamp + 1 hours);
        _expectBadTimestamp(uint64(block.timestamp + 1));
        _expectBadTimestamp(uint64(block.timestamp - 15 minutes - 1));
        _expectBadTimestamp(lastBatch.timestamp - 1);
    }

    function _expectBadTimestamp(uint64 ts) internal {
        IZkVotingRollup.CommitBatchInfo memory next = IZkVotingRollup.CommitBatchInfo(bytes32(uint256(1)), ts, "");
        vm.expectRevert(IZkVotingRollup.BadTimestamp.selector);
        vm.prank(operator);
        rollup.commitBatch(lastBatch, next);
    }

    function test_PriorityOpsMustMatchTheQueueInOrder() public {
        bytes memory forged = pendingRequestOps();
        forged[10] = bytes1(uint8(forged[10]) ^ 1);
        IZkVotingRollup.CommitBatchInfo memory next =
            IZkVotingRollup.CommitBatchInfo(bytes32(uint256(1)), uint64(block.timestamp), forged);
        vm.expectRevert(IZkVotingRollup.PriorityOpMismatch.selector);
        vm.prank(operator);
        rollup.commitBatch(lastBatch, next);
    }

    function test_OperatorCannotInventARegistration() public {
        bytes memory invented = abi.encodePacked(Ops.REGISTER, id, uint8(1), uint256(5));
        IZkVotingRollup.CommitBatchInfo memory next = IZkVotingRollup.CommitBatchInfo(
            bytes32(uint256(1)), uint64(block.timestamp), bytes.concat(pendingRequestOps(), invented)
        );
        vm.expectRevert(IZkVotingRollup.MissingPriorityOps.selector);
        vm.prank(operator);
        rollup.commitBatch(lastBatch, next);
    }

    function test_OperatorCannotSkipTheQueueHead() public {
        vm.recordLogs();
        vm.prank(registrar);
        uint256[] memory roll = new uint256[](1);
        roll[0] = 9;
        rollup.registerVoters(id, roll);
        recordRequests();
        IZkVotingRollup.CommitBatchInfo memory next =
            IZkVotingRollup.CommitBatchInfo(bytes32(uint256(1)), uint64(block.timestamp), requestBytes[1]);
        vm.expectRevert(IZkVotingRollup.PriorityOpMismatch.selector);
        vm.prank(operator);
        rollup.commitBatch(lastBatch, next);
    }

    function test_MalformedPubdataReverts() public {
        _expectMalformed(hex"07");
        _expectMalformed(abi.encodePacked(Ops.BALLOT, id, uint256(1)));
        _expectMalformed(abi.encodePacked(Ops.REGISTER, id, uint8(0)));
        _expectMalformed(abi.encodePacked(Ops.REGISTER, id, uint8(33)));
    }

    function _expectMalformed(bytes memory pubdata) internal {
        IZkVotingRollup.CommitBatchInfo memory next =
            IZkVotingRollup.CommitBatchInfo(bytes32(uint256(1)), uint64(block.timestamp), pubdata);
        vm.expectRevert(Ops.MalformedPubdata.selector);
        vm.prank(operator);
        rollup.commitBatch(lastBatch, next);
    }

    function test_L2BallotsNeedNoQueueEntry() public {
        vm.warp(info(id).startTime);
        commit(bytes.concat(pendingRequestOps(), castOnL2(id, 0, 1), castOnL2(id, 1, 2)));
        assertEq(rollup.totalCommittedPriorityRequests(), 1);
    }

    function test_VerifyInOrderWithAValidProof() public {
        IZkVotingRollup.StoredBatchInfo memory b1 = commit(pendingRequestOps());
        IZkVotingRollup.StoredBatchInfo memory b2 = commit("");

        vm.expectRevert(IZkVotingRollup.BatchNotCommitted.selector);
        rollup.verifyBatch(b2, proof());

        vm.expectRevert(IZkVotingRollup.InvalidProof.selector);
        rollup.verifyBatch(b1, [uint256(0), 0, 0, 0, 0, 0, 0, 0]);

        b1.stateRoot = bytes32(uint256(5));
        vm.expectRevert(IZkVotingRollup.BadStoredBatch.selector);
        rollup.verifyBatch(b1, proof());
    }

    function test_ExecuteNeedsAVerifiedBatch() public {
        IZkVotingRollup.StoredBatchInfo memory b1 = commit(pendingRequestOps());
        IZkVotingRollup.StoredBatchInfo[] memory list = new IZkVotingRollup.StoredBatchInfo[](1);
        list[0] = b1;
        bytes[] memory ops = new bytes[](1);
        vm.expectRevert(IZkVotingRollup.BatchNotVerified.selector);
        rollup.executeBatches(list, ops);

        verify(b1);
        rollup.executeBatches(list, ops);
        assertEq(rollup.executedStateRoot(), b1.stateRoot);
        assertEq(rollup.firstPriorityRequestId(), 1);
        (bytes32 hashed,,) = rollup.priorityRequests(0);
        assertEq(hashed, bytes32(0), "executed requests are deleted");
    }

    function test_ExecuteChecksTheOnchainOps() public {
        vm.warp(info(id).cutoffTime);
        vm.recordLogs();
        rollup.closeElection(id);
        recordRequests();
        IZkVotingRollup.StoredBatchInfo memory b = commit(pendingRequestOps());
        verify(b);
        IZkVotingRollup.StoredBatchInfo[] memory list = new IZkVotingRollup.StoredBatchInfo[](1);
        list[0] = b;
        bytes[] memory ops = new bytes[](1);
        vm.expectRevert(IZkVotingRollup.OnchainOpsMismatch.selector);
        rollup.executeBatches(list, ops);

        ops[0] = closeOp(id);
        rollup.executeBatches(list, ops);
        assertEq(uint8(info(id).status), uint8(IZkVotingRollup.Status.Withheld));
        uint256[4][] memory acc = rollup.accumulator(id);
        assertEq(acc.length, 3);
        assertEq(acc[0][1], 1, "an empty sum is the identity");
    }

    function test_CloseResponseMustMatchTheElection() public {
        vm.warp(info(id).cutoffTime);
        vm.recordLogs();
        rollup.closeElection(id);
        recordRequests();
        bytes memory bad = abi.encodePacked(Ops.CLOSE, id, uint32(0), uint8(2));
        bad = bytes.concat(bad, abi.encodePacked(uint256(0), uint256(1), uint256(0), uint256(1)));
        bad = bytes.concat(bad, abi.encodePacked(uint256(0), uint256(1), uint256(0), uint256(1)));
        bytes memory pubdata = bytes.concat(requestBytes[0], requestBytes[1], _slice(bad, 5, bad.length - 5));
        IZkVotingRollup.StoredBatchInfo memory b = commit(pubdata);
        verify(b);
        IZkVotingRollup.StoredBatchInfo[] memory list = new IZkVotingRollup.StoredBatchInfo[](1);
        list[0] = b;
        bytes[] memory ops = new bytes[](1);
        ops[0] = bad;
        vm.expectRevert(IZkVotingRollup.OnchainOpsMismatch.selector);
        rollup.executeBatches(list, ops);
    }

    function test_RevertDropsUnexecutedBatchesAndReopensTheirRequests() public {
        IZkVotingRollup.StoredBatchInfo memory genesis = lastBatch;
        IZkVotingRollup.StoredBatchInfo memory b1 = commit(pendingRequestOps());
        verify(b1);

        vm.expectRevert(IZkVotingRollup.NotOperator.selector);
        rollup.revertBatches(genesis);

        vm.prank(operator);
        rollup.revertBatches(genesis);
        assertEq(rollup.totalBatchesCommitted(), 0);
        assertEq(rollup.totalBatchesVerified(), 0);
        assertEq(rollup.totalCommittedPriorityRequests(), 0);
        assertEq(rollup.storedBatchHashes(1), bytes32(0));

        lastBatch = genesis;
        delete pendingBatches;
        delete pendingOnchainOps;
        processQueue("");
        assertEq(rollup.totalBatchesExecuted(), 1);

        vm.expectRevert(IZkVotingRollup.CannotRevertExecuted.selector);
        vm.prank(operator);
        rollup.revertBatches(genesis);
    }

    function test_ExecutedRequestsCannotTriggerDesertMode() public {
        processQueue("");
        vm.warp(block.timestamp + 10 days);
        vm.expectRevert(IZkVotingRollup.NoExpiredRequest.selector);
        rollup.activateDesertMode();
    }

    function test_CommittedButUnexecutedRequestsStillExpire() public {
        commit(pendingRequestOps());
        vm.warp(block.timestamp + rollup.PRIORITY_EXPIRATION() + 1);
        rollup.activateDesertMode();
        assertTrue(rollup.desertMode());
    }

    function test_DesertCloseOnlyInDesertMode() public {
        StateTree.ElectionLeaf memory leaf;
        vm.expectRevert(IZkVotingRollup.NotDesertMode.selector);
        rollup.desertClose(id, leaf, new uint256[4][](3), new uint256[](32));
    }
}
