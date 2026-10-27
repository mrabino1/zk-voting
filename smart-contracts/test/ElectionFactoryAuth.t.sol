// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Election} from "../src/Election.sol";
import {ElectionFactory} from "../src/ElectionFactory.sol";
import {ElectionParams} from "../src/interfaces/ElectionParams.sol";
import {ExternalPartyRegistry} from "../src/ExternalPartyRegistry.sol";
import {Roles} from "../src/Roles.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";
import {IElection} from "../src/interfaces/IElection.sol";
import {IElectionFactory} from "../src/interfaces/IElectionFactory.sol";
import {IExternalPartyRegistry} from "../src/interfaces/IExternalPartyRegistry.sol";

/// @notice Factory validation, role transfer lockout, and clone initialize-once.
/// @dev Factory/ownable edge cases: zero address, old-owner dead,
///      already-initialized clone, inclusive bounds, unauthorized create.
contract ElectionFactoryAuthTest is Deployer {
    address internal stranger;
    address internal platformAdmin;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        stranger = makeAddr("stranger");
        platformAdmin = makeAddr("platformAdmin");
    }

    function testConstructorRejectsZeroAdmin() public {
        vm.expectRevert(IElectionFactory.ZeroAddress.selector);
        new ElectionFactory(address(0), address(0));
    }

    function testSetImplementationZeroReverts() public {
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.ZeroAddress.selector);
        factory.setImplementation(address(0));
    }

    function testStrangerCannotSetImplementation() public {
        vm.prank(stranger);
        vm.expectRevert(IElectionFactory.NotAdmin.selector);
        factory.setImplementation(address(electionImpl));
    }

    function testSetPartyRegistryImplementationZeroReverts() public {
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.ZeroAddress.selector);
        factory.setPartyRegistryImplementation(address(0));
    }

    function testStrangerCannotSetPartyRegistryImplementation() public {
        vm.prank(stranger);
        vm.expectRevert(IElectionFactory.NotSuperAdmin.selector);
        factory.setPartyRegistryImplementation(address(1));
    }

    function testTreeDepthFifteenReverts() public {
        ElectionParams memory p = defaultParams();
        p.treeDepth = 15;
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.InvalidTreeDepth.selector);
        factory.createElection(p);
    }

    function testTreeDepthThirtyThreeReverts() public {
        ElectionParams memory p = defaultParams();
        p.treeDepth = 33;
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.InvalidTreeDepth.selector);
        factory.createElection(p);
    }

    function testTreeDepthBoundsInclusive() public {
        ElectionParams memory lo = defaultParams();
        lo.treeDepth = 16;
        ElectionParams memory hi = defaultParams();
        hi.treeDepth = 32;
        vm.prank(admin);
        (, address a) = factory.createElection(lo);
        vm.prank(admin);
        (, address b) = factory.createElection(hi);
        assertTrue(a != address(0) && b != address(0) && a != b);
    }

    function testQuestionCountZeroReverts() public {
        ElectionParams memory p = defaultParams();
        p.questionCount = 0;
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.InvalidQuestionCount.selector);
        factory.createElection(p);
    }

    function testStrangerCreateElectionRevertsNotJurisdictionClerk() public {
        vm.prank(stranger);
        vm.expectRevert(IElectionFactory.NotJurisdictionClerk.selector);
        factory.createElection(defaultParams());
    }

    function testClerkCanCreateElection() public {
        vm.prank(clerk);
        (uint256 id, address el) = factory.createElection(defaultParams());
        assertEq(id, 1);
        assertTrue(el != address(0));
        assertTrue(factory.isElectionStaff(id, clerk));
        assertTrue(factory.getPartyRegistry(id) != address(0));
    }

    function testClerkRoleHolderWithoutJurisdictionCannotCreate() public {
        address extraClerk = makeAddr("extraClerk");
        vm.prank(admin);
        factory.grantRole(Roles.CLERK_ROLE, extraClerk);
        vm.prank(extraClerk);
        vm.expectRevert(IElectionFactory.NotJurisdictionClerk.selector);
        factory.createElection(defaultParams());
    }

    function testApproveAdminZeroReverts() public {
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.ZeroAddress.selector);
        factory.approveAdmin(address(0));
    }

    function testStrangerCannotApproveAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(IElectionFactory.NotSuperAdmin.selector);
        factory.approveAdmin(platformAdmin);
    }

    function testCannotRevokeBootstrapSuper() public {
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.CannotRevokeSuper.selector);
        factory.revokeAdmin(admin);
    }

    function testOldAdminCannotApproveStaffAfterRevoke() public {
        vm.prank(admin);
        factory.approveAdmin(platformAdmin);
        (uint256 id,) = createElection();

        vm.prank(platformAdmin);
        factory.approveElectionStaff(id, stranger);
        assertTrue(factory.isElectionStaff(id, stranger));

        vm.prank(admin);
        factory.revokeAdmin(platformAdmin);

        address other = makeAddr("otherStaff");
        vm.prank(platformAdmin);
        vm.expectRevert(IElectionFactory.NotAdmin.selector);
        factory.approveElectionStaff(id, other);
    }

    function testApproveStaffUnknownElectionReverts() public {
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.UnknownElection.selector);
        factory.approveElectionStaff(99, stranger);
    }

    function testApproveStaffZeroReverts() public {
        (uint256 id,) = createElection();
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.ZeroAddress.selector);
        factory.approveElectionStaff(id, address(0));
    }

    function testRevokeElectionStaffRemovesPartyAccess() public {
        (uint256 id,) = createElection();
        address staff = makeAddr("staff");
        vm.prank(admin);
        factory.approveElectionStaff(id, staff);
        ExternalPartyRegistry parties = ExternalPartyRegistry(factory.getPartyRegistry(id));

        vm.prank(staff);
        parties.addParty(makeAddr("op"), "AgeOracle", "", 1);

        vm.prank(admin);
        factory.revokeElectionStaff(id, staff);
        vm.prank(staff);
        vm.expectRevert(IExternalPartyRegistry.NotStaff.selector);
        parties.addParty(makeAddr("op2"), "Other", "", 0);
    }

    function testCloneInitializeTwiceReverts() public {
        (, address el) = createElection();
        ElectionParams memory p = defaultParams();
        vm.expectRevert(IElection.AlreadyInitialized.selector);
        Election(el).initialize(99, p, address(factory), address(voterRegistry), address(disqualification), address(inbox));
    }

    function testPartyCloneInitializeTwiceReverts() public {
        (uint256 id,) = createElection();
        ExternalPartyRegistry parties = ExternalPartyRegistry(factory.getPartyRegistry(id));
        vm.expectRevert(IExternalPartyRegistry.AlreadyInitialized.selector);
        parties.initialize(id, address(factory));
    }

    function testPartyInitializeZeroElectionIdReverts() public {
        ExternalPartyRegistry impl = new ExternalPartyRegistry();
        vm.expectRevert(IExternalPartyRegistry.NotFactory.selector);
        impl.initialize(0, address(factory));
    }

    function testUninitializedImplementationHasZeroElectionId() public {
        assertEq(Election(factory.implementation()).electionId(), 0);
        assertEq(ExternalPartyRegistry(factory.partyRegistryImplementation()).electionId(), 0);
    }

    function testStrangerCannotGrantRole() public {
        vm.prank(stranger);
        vm.expectRevert(IElectionFactory.NotAdmin.selector);
        factory.grantRole(Roles.CLERK_ROLE, stranger);
    }

    function testStrangerCannotWireModules() public {
        vm.prank(stranger);
        vm.expectRevert(IElectionFactory.NotAdmin.selector);
        factory.setModules(address(1), address(2), address(3), address(4));
    }
}
