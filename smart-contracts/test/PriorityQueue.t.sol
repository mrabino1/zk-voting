// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IZkVotingRollup} from "../src/interfaces/IZkVotingRollup.sol";
import {Ops} from "../src/libraries/Ops.sol";
import {StateTree} from "../src/libraries/StateTree.sol";
import {RollupTest} from "./helpers/RollupTest.sol";

/// @notice Roll changes, forced ballots and CLOSE reach the L2 only through the L1 queue.
contract PriorityQueueTest is RollupTest {
    uint32 internal id;

    function setUp() public override {
        super.setUp();
        vm.recordLogs();
        id = scheduledElection();
        recordRequests();
    }

    function _roll(uint256 n) internal pure returns (uint256[] memory r) {
        r = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            r[i] = 1000 + i;
        }
    }

    function test_RegisterQueuesChunksOf32() public {
        vm.recordLogs();
        vm.prank(registrar);
        rollup.registerVoters(id, _roll(70));
        recordRequests();
        // request 0 is CREATE_ELECTION from finalizeKey
        assertEq(rollup.totalPriorityRequests(), 4);
        assertEq(requestType[1], Ops.REGISTER);
        assertEq(requestBytes[1].length, 6 + 32 * 32);
        assertEq(requestBytes[3].length, 6 + 32 * 6);
        (bytes32 hashed, uint64 expiration, uint8 opType) = rollup.priorityRequests(3);
        assertEq(hashed, keccak256(requestBytes[3]));
        assertEq(expiration, block.timestamp + rollup.PRIORITY_EXPIRATION());
        assertEq(opType, Ops.REGISTER);
    }

    function test_RegisterRules() public {
        vm.expectRevert(IZkVotingRollup.NotRegistrar.selector);
        rollup.registerVoters(id, _roll(1));

        vm.startPrank(registrar);
        vm.expectRevert(IZkVotingRollup.BadInput.selector);
        rollup.registerVoters(id, new uint256[](0));
        uint256[] memory bad = _roll(2);
        bad[1] = 0;
        vm.expectRevert(IZkVotingRollup.BadInput.selector);
        rollup.registerVoters(id, bad);
        bad[1] = StateTree.FIELD;
        vm.expectRevert(IZkVotingRollup.BadInput.selector);
        rollup.registerVoters(id, bad);

        vm.warp(info(id).startTime);
        vm.expectRevert(IZkVotingRollup.TooLate.selector);
        rollup.registerVoters(id, _roll(1));
        vm.stopPrank();
    }

    function test_RegisterNeedsAFinalKey() public {
        uint32 pending = createElection();
        vm.expectRevert(abi.encodeWithSelector(IZkVotingRollup.WrongStatus.selector, IZkVotingRollup.Status.KeyGen));
        vm.prank(registrar);
        rollup.registerVoters(pending, _roll(1));
    }

    function test_DisqualifyRules() public {
        vm.expectRevert(IZkVotingRollup.NotOfficer.selector);
        rollup.disqualify(id, 1000, 1);

        vm.startPrank(officer);
        vm.expectRevert(IZkVotingRollup.BadInput.selector);
        rollup.disqualify(id, 1000, 0);
        vm.expectRevert(IZkVotingRollup.BadInput.selector);
        rollup.disqualify(id, 1000, 15);

        vm.recordLogs();
        rollup.disqualify(id, 1000, 5);
        recordRequests();
        assertEq(requestBytes[1], abi.encodePacked(Ops.DISQUALIFY, id, uint256(1000), uint16(5)));

        vm.warp(info(id).startTime);
        vm.expectRevert(IZkVotingRollup.TooLate.selector);
        rollup.disqualify(id, 1001, 5);
        vm.stopPrank();
    }

    function test_ForcedBallotOnlyWhileVotingIsOpen() public {
        bytes memory payload = hex"c0ffee";
        vm.expectRevert(IZkVotingRollup.TooEarly.selector);
        rollup.forceBallot(id, 1, 2, payload);

        vm.warp(info(id).startTime);
        vm.expectRevert(IZkVotingRollup.BadInput.selector);
        rollup.forceBallot(id, 0, 2, payload);
        vm.expectRevert(IZkVotingRollup.BadInput.selector);
        rollup.forceBallot(id, 1, 2, "");

        vm.recordLogs();
        uint64 requestId = rollup.forceBallot(id, 1, 2, payload);
        recordRequests();
        assertEq(requestId, 1);
        assertEq(requestBytes[1], abi.encodePacked(Ops.FORCED_BALLOT, id, uint256(1), uint256(2), keccak256(payload)));

        vm.warp(info(id).cutoffTime);
        vm.expectRevert(IZkVotingRollup.TooLate.selector);
        rollup.forceBallot(id, 3, 4, payload);
    }

    function test_CloseIsPermissionlessAfterCutoff() public {
        vm.expectRevert(IZkVotingRollup.TooEarly.selector);
        rollup.closeElection(id);
        vm.warp(info(id).cutoffTime);
        vm.prank(makeAddr("anyone"));
        rollup.closeElection(id);
        assertEq(uint8(info(id).status), uint8(IZkVotingRollup.Status.Closing));
        vm.expectRevert(abi.encodeWithSelector(IZkVotingRollup.WrongStatus.selector, IZkVotingRollup.Status.Closing));
        rollup.closeElection(id);
    }

    function test_DesertModeNeedsAnExpiredRequest() public {
        vm.expectRevert(IZkVotingRollup.NoExpiredRequest.selector);
        rollup.activateDesertMode();
        vm.warp(block.timestamp + rollup.PRIORITY_EXPIRATION());
        vm.expectRevert(IZkVotingRollup.NoExpiredRequest.selector);
        rollup.activateDesertMode();
        vm.warp(block.timestamp + 1);
        rollup.activateDesertMode();
        assertTrue(rollup.desertMode());
    }

    function test_ServedQueueNeverExpires() public {
        vm.recordLogs();
        vm.prank(registrar);
        rollup.registerVoters(id, _roll(3));
        recordRequests();
        processQueue("");
        assertEq(rollup.openPriorityRequests(), 0);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(IZkVotingRollup.NoExpiredRequest.selector);
        rollup.activateDesertMode();
    }

    function test_DesertModeFreezesEverything() public {
        vm.warp(block.timestamp + rollup.PRIORITY_EXPIRATION() + 1);
        rollup.activateDesertMode();

        vm.expectRevert(IZkVotingRollup.DesertMode.selector);
        vm.prank(registrar);
        rollup.registerVoters(id, _roll(1));
        vm.expectRevert(IZkVotingRollup.DesertMode.selector);
        vm.prank(clerk);
        rollup.createElection(defaultConfig());
        vm.expectRevert(IZkVotingRollup.DesertMode.selector);
        vm.prank(operator);
        rollup.commitBatch(lastBatch, IZkVotingRollup.CommitBatchInfo(bytes32(0), uint64(block.timestamp), ""));
        vm.expectRevert(IZkVotingRollup.DesertMode.selector);
        rollup.activateDesertMode();

        assertEq(uint8(info(id).status), uint8(IZkVotingRollup.Status.Halted), "an unclosed election reads as halted");
    }
}
