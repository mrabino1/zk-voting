// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IElection} from "../src/interfaces/IElection.sol";
import {VoterRegistry} from "../src/VoterRegistry.sol";
import {Roles} from "../src/Roles.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";
import {IVoterRegistry} from "../src/interfaces/IVoterRegistry.sol";

/// @notice Registry zero-commitment, unauthorized, closed-window, and cap-at-one edges.
contract VoterRegistryEdgesTest is Deployer {
    uint256 internal electionId;
    address internal election;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        (electionId, election) = createElection();
    }

    function testCtorRejectsZeroAddresses() public {
        vm.expectRevert(IVoterRegistry.ZeroAddress.selector);
        new VoterRegistry(address(0), address(factory));
        vm.expectRevert(IVoterRegistry.ZeroAddress.selector);
        new VoterRegistry(address(hasher), address(0));
    }

    function testZeroCommitmentReverts() public {
        vm.prank(registrar);
        vm.expectRevert(IVoterRegistry.ZeroCommitment.selector);
        voterRegistry.register(electionId, 0);
    }

    function testStrangerCannotRegister() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IVoterRegistry.NotRegistrar.selector);
        voterRegistry.register(electionId, Fixtures.identityCommitment(uint256(1)));
    }

    function testUnknownElectionReverts() public {
        vm.prank(registrar);
        vm.expectRevert(IVoterRegistry.UnknownElection.selector);
        voterRegistry.register(99, Fixtures.identityCommitment(uint256(1)));
    }

    function testRegistrationClosedAfterCutoffWithoutFreeze() public {
        warpClosed(election);
        vm.prank(registrar);
        vm.expectRevert(IVoterRegistry.RegistrationClosed.selector);
        voterRegistry.register(electionId, Fixtures.identityCommitment(uint256(1)));
    }

    function testFactoryAdminCanRegister() public {
        vm.prank(admin);
        voterRegistry.register(electionId, Fixtures.identityCommitment(uint256(2)));
        assertTrue(voterRegistry.isRegistered(electionId, Fixtures.identityCommitment(uint256(2))));
    }

    function testGrantedRegistrarRoleCanRegister() public {
        address extra = makeAddr("extraRegistrar");
        vm.prank(admin);
        voterRegistry.grantRole(Roles.REGISTRAR_ROLE, extra);
        vm.prank(extra);
        voterRegistry.register(electionId, Fixtures.identityCommitment(uint256(3)));
        assertTrue(voterRegistry.isRegistered(electionId, Fixtures.identityCommitment(uint256(3))));
    }

    function testStrangerCannotGrantRegistrarRole() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IVoterRegistry.NotRegistrar.selector);
        voterRegistry.grantRole(Roles.REGISTRAR_ROLE, makeAddr("x"));
    }

    function testCapOneAllowsExactlyOneThenReverts() public {
        (uint256 id, address el) = createElection(Fixtures.withCap(defaultParams(), 1));
        registerVoter(id, Fixtures.identityCommitment(uint256(1)));
        assertEq(voterRegistry.participantCount(id), 1);
        assertEq(IElection(el).participantCount(), 1);
        vm.prank(registrar);
        vm.expectRevert(IVoterRegistry.CapReached.selector);
        voterRegistry.register(id, Fixtures.identityCommitment(uint256(2)));
    }

    function testLeafIndexAssignedInOrder() public {
        registerVoter(electionId, Fixtures.identityCommitment(uint256(1)));
        registerVoter(electionId, Fixtures.identityCommitment(uint256(2)));
        assertEq(voterRegistry.leafIndexOf(electionId, Fixtures.identityCommitment(uint256(1))), 0);
        assertEq(voterRegistry.leafIndexOf(electionId, Fixtures.identityCommitment(uint256(2))), 1);
    }

    function testWalletAddressIsNotAValidCommitmentUnlessExplicitlyHashed() public {
        uint256 asNumber = uint256(uint160(relayer));
        registerVoter(electionId, Fixtures.identityCommitment(uint256(1)));
        assertFalse(voterRegistry.isRegistered(electionId, asNumber));
    }
}
