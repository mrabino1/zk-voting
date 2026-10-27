// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice L1 rollup settlement: sequential batches and dataHash checks.
contract RollupSettlementTest is Deployer {
    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
    }

    function testSequentialBatchesAdvanceStateRoot() public {
        bytes32 root0 = settlement.stateRoot();
        uint64 count0 = settlement.batchCount();

        bytes32 root1 = keccak256("state-1");
        bytes32 dh1 = computeBatchDataHash(count0, root0, root1);
        submitBatch(count0, root0, root1, dh1);
        assertEq(settlement.batchCount(), count0 + 1);
        assertEq(settlement.stateRoot(), root1);

        bytes32 root2 = keccak256("state-2");
        bytes32 dh2 = computeBatchDataHash(count0 + 1, root1, root2);
        submitBatch(count0 + 1, root1, root2, dh2);
        assertEq(settlement.batchCount(), count0 + 2);
        assertEq(settlement.stateRoot(), root2);

        bytes32 root3 = keccak256("state-3");
        bytes32 dh3 = computeBatchDataHash(count0 + 2, root2, root3);
        submitBatch(count0 + 2, root2, root3, dh3);
        assertEq(settlement.batchCount(), count0 + 3);
        assertEq(settlement.stateRoot(), root3);
    }

    function testNonSequentialBatchIndexReverts() public {
        bytes32 root0 = settlement.stateRoot();
        uint64 count0 = settlement.batchCount();
        bytes32 next = keccak256("skip");
        bytes32 dh = computeBatchDataHash(count0 + 1, root0, next);

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(sequencer);
        vm.expectRevert();
        settlement.submitBatch(count0 + 1, root0, next, dh, a, b, c);
        assertEq(settlement.batchCount(), count0);
    }

    function testDataHashMismatchReverts() public {
        bytes32 root0 = settlement.stateRoot();
        uint64 count0 = settlement.batchCount();
        bytes32 next = keccak256("new-root");
        bytes32 wrong = keccak256("dataHash-mismatch");

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(sequencer);
        vm.expectRevert();
        settlement.submitBatch(count0, root0, next, wrong, a, b, c);

        vm.prank(prover);
        vm.expectRevert();
        settlement.submitBatch(count0, root0, next, wrong, a, b, c);

        assertEq(settlement.stateRoot(), root0);
        assertEq(settlement.batchCount(), count0);
    }

    function testWrongPrevStateRootReverts() public {
        bytes32 root0 = settlement.stateRoot();
        uint64 count0 = settlement.batchCount();
        bytes32 bogusPrev = keccak256("not-the-state-root");
        bytes32 next = keccak256("new-root");
        bytes32 dh = computeBatchDataHash(count0, bogusPrev, next);

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(sequencer);
        vm.expectRevert();
        settlement.submitBatch(count0, bogusPrev, next, dh, a, b, c);
        assertEq(settlement.stateRoot(), root0);
    }
}
