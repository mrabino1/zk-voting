// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";

import {PersonRegistry} from "../src/PersonRegistry.sol";
import {Roles} from "../src/Roles.sol";
import {IPersonRegistry} from "../src/interfaces/IPersonRegistry.sol";

/// @notice Many internally verified addresses; exactly one active per person.
contract PersonRegistryTest is Test {
    PersonRegistry internal registry;

    address internal registrar = makeAddr("registrar");
    address internal stranger = makeAddr("stranger");
    address internal addrA = makeAddr("addrA");
    address internal addrB = makeAddr("addrB");
    address internal addrC = makeAddr("addrC");

    bytes32 internal personA = keccak256("person-a");
    bytes32 internal personB = keccak256("person-b");

    function setUp() public {
        registry = new PersonRegistry(address(this));
        registry.grantRole(Roles.REGISTRAR_ROLE, registrar);
    }

    function testVerifyTwoAddressesOnlyOneActive() public {
        vm.startPrank(registrar);
        registry.verifyAddress(personA, addrA);
        registry.verifyAddress(personA, addrB);
        vm.stopPrank();

        assertTrue(registry.verified(personA, addrA));
        assertTrue(registry.verified(personA, addrB));
        assertEq(registry.personOf(addrA), personA);
        assertEq(registry.personOf(addrB), personA);
        assertEq(registry.activeAddress(personA), address(0));

        vm.prank(registrar);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IPersonRegistry.ActiveAddressSet(personA, addrA, address(0));
        registry.setActive(personA, addrA);
        assertEq(registry.activeAddress(personA), addrA);

        vm.prank(registrar);
        registry.setActive(personA, addrB);
        assertEq(registry.activeAddress(personA), addrB);
        assertTrue(registry.verified(personA, addrA), "previous active stays internally verified");
        assertTrue(registry.isVerified(personA, addrA));
    }

    /// @notice One ETH address is bound to at most one person. Orthogonal to
    ///         ballot uniqueness (votes are keyed by identity-commitment nullifiers
    ///         **per election**; `msg.sender` on `submitVote` is typically the relayer).
    function testOneAddressBoundToOnePerson_secondPersonCannotClaimIt() public {
        vm.prank(registrar);
        registry.verifyAddress(personA, addrA);

        vm.prank(registrar);
        vm.expectRevert(abi.encodeWithSelector(IPersonRegistry.AlreadyOwned.selector, personA));
        registry.verifyAddress(personB, addrA);

        assertEq(registry.personOf(addrA), personA);
        assertFalse(registry.verified(personB, addrA));
    }

    function testCannotStealVerifiedAddress() public {
        testOneAddressBoundToOnePerson_secondPersonCannotClaimIt();
    }

    function testSetActiveRequiresVerified() public {
        vm.prank(registrar);
        vm.expectRevert(IPersonRegistry.NotVerified.selector);
        registry.setActive(personA, addrC);
    }

    function testSetActiveSameAddressReverts() public {
        vm.startPrank(registrar);
        registry.verifyAddress(personA, addrA);
        registry.setActive(personA, addrA);
        vm.expectRevert(IPersonRegistry.SameActive.selector);
        registry.setActive(personA, addrA);
        vm.stopPrank();
    }

    function testVerifyIsIdempotentForSamePerson() public {
        vm.prank(registrar);
        registry.verifyAddress(personA, addrA);
        vm.prank(registrar);
        registry.verifyAddress(personA, addrA);
        assertTrue(registry.verified(personA, addrA));
    }

    function testNonRegistrarCannotVerifyOrSetActive() public {
        vm.prank(stranger);
        vm.expectRevert(IPersonRegistry.NotRegistrar.selector);
        registry.verifyAddress(personA, addrA);

        vm.prank(registrar);
        registry.verifyAddress(personA, addrA);

        vm.prank(stranger);
        vm.expectRevert(IPersonRegistry.NotRegistrar.selector);
        registry.setActive(personA, addrA);
    }

    function testZeroPersonAndZeroAddressRevert() public {
        vm.startPrank(registrar);
        vm.expectRevert(IPersonRegistry.ZeroPerson.selector);
        registry.verifyAddress(bytes32(0), addrA);
        vm.expectRevert(IPersonRegistry.ZeroAddress.selector);
        registry.verifyAddress(personA, address(0));
        registry.verifyAddress(personA, addrA);
        vm.expectRevert(IPersonRegistry.ZeroPerson.selector);
        registry.setActive(bytes32(0), addrA);
        vm.expectRevert(IPersonRegistry.ZeroAddress.selector);
        registry.setActive(personA, address(0));
        vm.stopPrank();
    }

    function testAdminCanActWithoutExtraGrant() public {
        registry.verifyAddress(personA, addrA);
        registry.setActive(personA, addrA);
        assertEq(registry.activeAddress(personA), addrA);
    }
}
