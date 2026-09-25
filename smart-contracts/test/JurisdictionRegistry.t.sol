// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";

import {JurisdictionRegistry} from "../src/JurisdictionRegistry.sol";
import {Roles} from "../src/Roles.sol";

/// @notice Jurisdiction zero-id, zero-address, and clerk/officer role edges.
contract JurisdictionRegistryTest is Test {
    JurisdictionRegistry internal registry;
    address internal admin;
    address internal clerk;
    address internal stranger;
    bytes32 internal jid;

    event JurisdictionCreated(bytes32 indexed jurisdictionId, address clerk, string name);
    event ClerkSet(bytes32 indexed jurisdictionId, address clerk);

    function setUp() public {
        admin = makeAddr("admin");
        clerk = makeAddr("clerk");
        stranger = makeAddr("stranger");
        jid = keccak256("ward-1");
        registry = new JurisdictionRegistry(admin);
    }

    function testConstructorRejectsZeroAdmin() public {
        vm.expectRevert(JurisdictionRegistry.ZeroAddress.selector);
        new JurisdictionRegistry(address(0));
    }

    function testConstructorGrantsPlatformAdmin() public {
        assertEq(registry.admin(), admin);
        assertTrue(registry.roles(Roles.PLATFORM_ADMIN_ROLE, admin));
    }

    function testCreateJurisdictionZeroIdReverts() public {
        vm.prank(admin);
        vm.expectRevert(JurisdictionRegistry.ZeroId.selector);
        registry.createJurisdiction(bytes32(0), clerk, "Ward");
    }

    function testCreateJurisdictionZeroClerkReverts() public {
        vm.prank(admin);
        vm.expectRevert(JurisdictionRegistry.ZeroAddress.selector);
        registry.createJurisdiction(jid, address(0), "Ward");
    }

    function testStrangerCannotCreateJurisdiction() public {
        vm.prank(stranger);
        vm.expectRevert(JurisdictionRegistry.NotAdmin.selector);
        registry.createJurisdiction(jid, clerk, "Ward");
    }

    function testCreateJurisdictionEmitsAndSetsClerk() public {
        vm.expectEmit(true, false, false, true);
        emit JurisdictionCreated(jid, clerk, "Ward 1");
        vm.prank(admin);
        registry.createJurisdiction(jid, clerk, "Ward 1");
        assertEq(registry.clerkOf(jid), clerk);
        assertEq(registry.nameOf(jid), "Ward 1");
        assertTrue(registry.officers(jid, clerk));
        assertTrue(registry.isClerk(jid, clerk));
    }

    function testEmptyNameIsAllowed() public {
        vm.prank(admin);
        registry.createJurisdiction(jid, clerk, "");
        assertEq(registry.nameOf(jid), "");
    }

    function testSetClerkUnknownJurisdictionReverts() public {
        vm.prank(admin);
        vm.expectRevert(JurisdictionRegistry.UnknownJurisdiction.selector);
        registry.setClerk(jid, clerk);
    }

    function testSetClerkZeroReverts() public {
        vm.prank(admin);
        registry.createJurisdiction(jid, clerk, "Ward");
        vm.prank(admin);
        vm.expectRevert(JurisdictionRegistry.ZeroAddress.selector);
        registry.setClerk(jid, address(0));
    }

    function testSetClerkEmitsAndOldClerkRemainsOfficer() public {
        address newClerk = makeAddr("newClerk");
        vm.prank(admin);
        registry.createJurisdiction(jid, clerk, "Ward");
        vm.expectEmit(true, false, false, true);
        emit ClerkSet(jid, newClerk);
        vm.prank(admin);
        registry.setClerk(jid, newClerk);
        assertEq(registry.clerkOf(jid), newClerk);
        assertTrue(registry.isClerk(jid, newClerk));
        assertTrue(registry.isClerk(jid, clerk));
    }

    function testGrantOfficerByClerk() public {
        address officer = makeAddr("officer");
        vm.prank(admin);
        registry.createJurisdiction(jid, clerk, "Ward");
        vm.prank(clerk);
        registry.grantOfficer(jid, officer);
        assertTrue(registry.isClerk(jid, officer));
    }

    function testGrantOfficerZeroReverts() public {
        vm.prank(admin);
        registry.createJurisdiction(jid, clerk, "Ward");
        vm.prank(clerk);
        vm.expectRevert(JurisdictionRegistry.ZeroAddress.selector);
        registry.grantOfficer(jid, address(0));
    }

    function testStrangerCannotGrantOfficer() public {
        vm.prank(admin);
        registry.createJurisdiction(jid, clerk, "Ward");
        vm.prank(stranger);
        vm.expectRevert(JurisdictionRegistry.NotAdmin.selector);
        registry.grantOfficer(jid, stranger);
    }

    function testStrangerCannotSetClerk() public {
        vm.prank(admin);
        registry.createJurisdiction(jid, clerk, "Ward");
        vm.prank(stranger);
        vm.expectRevert(JurisdictionRegistry.NotAdmin.selector);
        registry.setClerk(jid, stranger);
    }

    function testGrantRoleOnlyAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(JurisdictionRegistry.NotAdmin.selector);
        registry.grantRole(Roles.PLATFORM_ADMIN_ROLE, stranger);

        vm.prank(admin);
        registry.grantRole(Roles.PLATFORM_ADMIN_ROLE, stranger);
        assertTrue(registry.roles(Roles.PLATFORM_ADMIN_ROLE, stranger));
    }

    function testJurisdictionsAreIsolated() public {
        bytes32 other = keccak256("ward-2");
        address clerkB = makeAddr("clerkB");
        vm.startPrank(admin);
        registry.createJurisdiction(jid, clerk, "A");
        registry.createJurisdiction(other, clerkB, "B");
        vm.stopPrank();
        assertFalse(registry.isClerk(other, clerk));
        assertFalse(registry.isClerk(jid, clerkB));
    }
}
