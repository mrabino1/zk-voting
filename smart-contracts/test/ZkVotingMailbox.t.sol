// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";

import {ZkVotingMailbox} from "../src/l2/ZkVotingMailbox.sol";

/// @notice Mailbox empty-input, time-boundary, and one-shot force-include edges.
/// @dev Edge cases: empty array, warp(t-1)/t/t+1, already-used keys.
contract ZkVotingMailboxTest is Test {
    ZkVotingMailbox internal mailbox;
    address internal admin;
    address internal sender;

    event MessageToL2(uint256 indexed nonce, address indexed sender, bytes message);
    event MessageToL1(uint256 indexed nonce, address indexed sender, bytes message);
    event Enqueued(uint256 indexed nonce, address indexed sender, uint256 readyAt, bytes message);
    event ForceIncluded(uint256 indexed nonce, address indexed includer);

    function setUp() public {
        admin = makeAddr("admin");
        sender = makeAddr("sender");
        mailbox = new ZkVotingMailbox(admin);
        vm.warp(1_700_000_000);
    }

    function testConstructorRejectsZeroAdmin() public {
        vm.expectRevert(ZkVotingMailbox.ZeroAddress.selector);
        new ZkVotingMailbox(address(0));
    }

    function testSendToL2EmptyReverts() public {
        vm.expectRevert(ZkVotingMailbox.EmptyMessage.selector);
        mailbox.sendToL2("");
    }

    function testSendToL1EmptyReverts() public {
        vm.expectRevert(ZkVotingMailbox.EmptyMessage.selector);
        mailbox.sendToL1("");
    }

    function testEnqueueEmptyReverts() public {
        vm.expectRevert(ZkVotingMailbox.EmptyMessage.selector);
        mailbox.enqueue("");
    }

    function testSendToL2EmitsAndIncrementsNonce() public {
        bytes memory msg_ = hex"01";
        vm.expectEmit(true, true, false, true);
        emit MessageToL2(1, sender, msg_);
        vm.prank(sender);
        mailbox.sendToL2(msg_);
        assertEq(mailbox.toL2Nonce(), 1);

        vm.prank(sender);
        mailbox.sendToL2(hex"02");
        assertEq(mailbox.toL2Nonce(), 2);
    }

    function testSendToL1EmitsAndIncrementsNonce() public {
        bytes memory msg_ = hex"aa";
        vm.expectEmit(true, true, false, true);
        emit MessageToL1(1, sender, msg_);
        vm.prank(sender);
        mailbox.sendToL1(msg_);
        assertEq(mailbox.toL1Nonce(), 1);
    }

    /// @dev Audit L-07: value can no longer be locked in the mailbox.
    function testSendToL2RejectsValue() public {
        vm.deal(sender, 1 ether);
        vm.prank(sender);
        (bool ok,) = address(mailbox).call{value: 1 ether}(abi.encodeCall(ZkVotingMailbox.sendToL2, (hex"01")));
        assertFalse(ok);
        assertEq(address(mailbox).balance, 0);
    }

    function testForceIncludeMissingNonceReverts() public {
        vm.expectRevert(ZkVotingMailbox.NotReady.selector);
        mailbox.forceInclude(1);
    }

    function testForceIncludeBeforeReadyReverts() public {
        vm.prank(sender);
        mailbox.enqueue(hex"ab");
        (address queuedSender, uint256 readyAt,, bool included) = mailbox.queue(1);
        assertEq(queuedSender, sender);
        assertEq(readyAt, block.timestamp + 1 days);
        assertFalse(included);

        vm.warp(readyAt - 1);
        vm.expectRevert(ZkVotingMailbox.NotReady.selector);
        mailbox.forceInclude(1);
    }

    function testForceIncludeExactlyAtReadySucceeds() public {
        vm.prank(sender);
        mailbox.enqueue(hex"cd");
        (, uint256 readyAt,,) = mailbox.queue(1);
        vm.warp(readyAt);

        address includer = makeAddr("includer");
        vm.expectEmit(true, true, false, true);
        emit ForceIncluded(1, includer);
        vm.prank(includer);
        mailbox.forceInclude(1);

        (,,, bool included) = mailbox.queue(1);
        assertTrue(included);
    }

    function testForceIncludeAfterReadySucceeds() public {
        vm.prank(sender);
        mailbox.enqueue(hex"ef");
        (, uint256 readyAt,,) = mailbox.queue(1);
        vm.warp(readyAt + 1);
        mailbox.forceInclude(1);
        (,,, bool included) = mailbox.queue(1);
        assertTrue(included);
    }

    function testForceIncludeTwiceReverts() public {
        vm.prank(sender);
        mailbox.enqueue(hex"11");
        (, uint256 readyAt,,) = mailbox.queue(1);
        vm.warp(readyAt);
        mailbox.forceInclude(1);
        vm.expectRevert(ZkVotingMailbox.NotReady.selector);
        mailbox.forceInclude(1);
    }

    function testEnqueueNoncesAreIsolatedFromSend() public {
        mailbox.sendToL2(hex"01");
        mailbox.enqueue(hex"02");
        assertEq(mailbox.toL2Nonce(), 1);
        assertEq(mailbox.queueNonce(), 1);
    }

    function testAnyoneCanEnqueue() public {
        vm.prank(makeAddr("alice"));
        mailbox.enqueue(hex"01");
        vm.prank(makeAddr("bob"));
        mailbox.enqueue(hex"02");
        assertEq(mailbox.queueNonce(), 2);
    }

    function testInclusionDelayIsOneDay() public {
        assertEq(mailbox.inclusionDelay(), 1 days);
    }
}
