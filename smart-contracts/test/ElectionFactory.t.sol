// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IElection} from "../src/interfaces/IElection.sol";
import {ElectionParams} from "../src/interfaces/ElectionParams.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Unbounded factory creates, clone isolation, distinct ids.
contract ElectionFactoryTest is Deployer {
    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
    }

    function testCreatesManyElectionsWithDistinctAddressesAndIsolatedIds() public {
        uint256 n = 12;
        uint256[] memory ids = new uint256[](n);
        address[] memory addrs = new address[](n);

        for (uint256 i; i < n; ++i) {
            ElectionParams memory p = Fixtures.withTitle(
                defaultParams(), string.concat("Election ", vm.toString(i + 1))
            );
            p.jurisdictionId = keccak256(abi.encodePacked("jurisdiction", i));
            (ids[i], addrs[i]) = createElection(p);

            assertTrue(addrs[i] != address(0), "clone address");
            assertEq(factory.getElection(ids[i]), addrs[i], "getElection");
            assertEq(IElection(addrs[i]).electionId(), ids[i], "electionId on clone");
            assertEq(IElection(addrs[i]).factory(), address(factory), "factory pointer");
        }

        assertEq(factory.electionCount(), n, "electionCount matches successful creates");
        assertTrue(factory.implementation() != address(0), "implementation deployed");

        for (uint256 i; i < n; ++i) {
            for (uint256 j = i + 1; j < n; ++j) {
                assertTrue(ids[i] != ids[j], "ids isolated");
                assertTrue(addrs[i] != addrs[j], "clone addresses distinct");
            }
        }
    }

    function testCloneStorageIsIsolatedAcrossElections() public {
        (uint256 idA, address elA) = createElection();
        (uint256 idB,) = createElection();

        uint256 leaf = Fixtures.identityCommitment(uint256(11));
        registerVoter(idA, leaf);

        assertTrue(voterRegistry.isRegistered(idA, leaf), "registered on A");
        assertFalse(voterRegistry.isRegistered(idB, leaf), "not registered on B");
        assertEq(voterRegistry.participantCount(idA), 1);
        assertEq(voterRegistry.participantCount(idB), 0);
        assertEq(IElection(elA).participantCount(), 1);
    }

    function testStartTimeGteCutoffTimeReverts() public {
        ElectionParams memory eq = Fixtures.withTimes(defaultParams(), Fixtures.TIME_ORIGIN + 100, Fixtures.TIME_ORIGIN + 100);
        vm.prank(admin);
        vm.expectRevert();
        factory.createElection(eq);

        ElectionParams memory gt = Fixtures.withTimes(defaultParams(), Fixtures.TIME_ORIGIN + 200, Fixtures.TIME_ORIGIN + 100);
        vm.prank(admin);
        vm.expectRevert();
        factory.createElection(gt);
    }

    function testGetElectionUnknownIdIsZero() public {
        uint256 before = factory.electionCount();
        assertEq(factory.getElection(before + 99), address(0));
    }

    function testCreateStoresParamsOnClone() public {
        ElectionParams memory p = defaultParams();
        (uint256 id, address el) = createElection(p);
        assertEq(factory.getElection(id), el);
        ElectionParams memory got = IElection(el).params();
        assertEq(got.startTime, p.startTime);
        assertEq(got.cutoffTime, p.cutoffTime);
        assertEq(got.jurisdictionId, p.jurisdictionId);
        assertEq(got.maxParticipants, p.maxParticipants);
        assertEq(got.clerk, clerk);
        assertEq(got.registrar, registrar);
    }
}
