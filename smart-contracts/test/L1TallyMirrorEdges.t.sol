// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";

import {L1TallyMirror} from "../src/l2/L1TallyMirror.sol";

/// @notice L1 mirror ctor zeros, publisher revoke, and zero-hash slot behavior.
contract L1TallyMirrorEdgesTest is Test {
    L1TallyMirror internal mirror;
    address internal admin;
    address internal publisher;
    address internal stranger;

    function setUp() public {
        admin = makeAddr("admin");
        publisher = makeAddr("publisher");
        stranger = makeAddr("stranger");
        mirror = new L1TallyMirror(admin, address(0));
    }

    function testConstructorRejectsZeroAdmin() public {
        vm.expectRevert(L1TallyMirror.ZeroAddress.selector);
        new L1TallyMirror(address(0), address(1));
    }

    function testRelatedMayBeZero() public {
        assertEq(mirror.related(), address(0));
        L1TallyMirror withRelated = new L1TallyMirror(admin, address(0xBEEF));
        assertEq(withRelated.related(), address(0xBEEF));
    }

    function testRevokedPublisherCannotPost() public {
        vm.prank(admin);
        mirror.setPublisher(publisher, true);
        vm.prank(admin);
        mirror.setPublisher(publisher, false);

        vm.prank(publisher);
        vm.expectRevert(L1TallyMirror.NotAuthorized.selector);
        mirror.postResult(1, keccak256("result"), 3, bytes32(uint256(1)));
    }

    function testPostingZeroHashDoesNotLockSlot() public {
        // Zero resultHash is rejected; the slot stays empty so a real post can follow.
        vm.prank(admin);
        vm.expectRevert(L1TallyMirror.ZeroResultHash.selector);
        mirror.postResult(1, bytes32(0), 0, bytes32(0));
        assertEq(mirror.resultHashOf(1), bytes32(0));

        bytes32 real = keccak256("result");
        vm.prank(admin);
        mirror.postResult(1, real, 4, bytes32(uint256(9)));
        assertEq(mirror.resultHashOf(1), real);
        assertEq(mirror.totalBallotsOf(1), 4);
    }

    function testElectionsAreIsolated() public {
        vm.prank(admin);
        mirror.postResult(1, keccak256("a"), 1, bytes32(0));
        vm.prank(admin);
        mirror.postResult(2, keccak256("b"), 2, bytes32(0));
        assertTrue(mirror.resultHashOf(1) != mirror.resultHashOf(2));
    }

    function testStrangerCannotSetPublisher() public {
        vm.prank(stranger);
        vm.expectRevert(L1TallyMirror.NotAuthorized.selector);
        mirror.setPublisher(stranger, true);
    }
}
