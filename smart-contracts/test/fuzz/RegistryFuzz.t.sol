// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "../../src/interfaces/ElectionParams.sol";
import {IElection} from "../../src/interfaces/IElection.sol";
import {Deployer} from "../helpers/Deployer.sol";
import {Fixtures} from "../helpers/Fixtures.sol";

/// @title RegistryFuzz
/// @notice Fuzz identity commitments and maxParticipants. Cap and uniqueness hold.
contract RegistryFuzz is Deployer {
    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
    }

    function testFuzz_registerCommitment(uint256 commitment, uint32 maxParticipants) public {
        commitment = bound(commitment, 1, type(uint256).max);
        maxParticipants = uint32(bound(maxParticipants, 0, 16));
        uint256 electionId = _newElection(maxParticipants);

        registerVoter(electionId, commitment);
        assertTrue(voterRegistry.isRegistered(electionId, commitment));
        assertEq(voterRegistry.participantCount(electionId), 1);
        assertEq(IElection(factory.getElection(electionId)).participantCount(), 1);
    }

    function testFuzz_duplicateCommitmentReverts(uint256 commitment) public {
        commitment = bound(commitment, 1, type(uint256).max);
        uint256 electionId = _newElection(0);
        registerVoter(electionId, commitment);
        vm.prank(registrar);
        vm.expectRevert();
        voterRegistry.register(electionId, commitment);
        assertEq(voterRegistry.participantCount(electionId), 1);
    }

    function testFuzz_maxParticipantsCap(uint32 maxParticipants, uint256 seed) public {
        maxParticipants = uint32(bound(maxParticipants, 1, 12));
        uint256 electionId = _newElection(maxParticipants);
        for (uint256 i; i < maxParticipants; ++i) {
            uint256 c = uint256(keccak256(abi.encode(seed, i, "leaf")));
            vm.assume(c != 0);
            registerVoter(electionId, c);
        }
        assertEq(voterRegistry.participantCount(electionId), maxParticipants);
        uint256 extra = uint256(keccak256(abi.encode(seed, "overflow")));
        vm.assume(extra != 0);
        vm.prank(registrar);
        vm.expectRevert();
        voterRegistry.register(electionId, extra);
        assertEq(voterRegistry.participantCount(electionId), maxParticipants);
        assertLe(IElection(factory.getElection(electionId)).participantCount(), maxParticipants);
    }

    function testFuzz_unlimitedWhenCapZero(uint8 n, uint256 seed) public {
        n = uint8(bound(n, 1, 8));
        uint256 electionId = _newElection(0);
        for (uint256 i; i < n; ++i) {
            uint256 c = uint256(keccak256(abi.encode(seed, i)));
            vm.assume(c != 0);
            registerVoter(electionId, c);
            assertTrue(voterRegistry.isRegistered(electionId, c));
        }
        assertEq(voterRegistry.participantCount(electionId), n);
    }

    function testFuzz_zeroCommitment(uint32 maxParticipants) public {
        maxParticipants = uint32(bound(maxParticipants, 0, 4));
        uint256 electionId = _newElection(maxParticipants);
        uint256 before = voterRegistry.participantCount(electionId);
        vm.prank(registrar);
        try voterRegistry.register(electionId, 0) {
            assertTrue(voterRegistry.isRegistered(electionId, 0));
            assertEq(voterRegistry.participantCount(electionId), before + 1);
        } catch {
            assertEq(voterRegistry.participantCount(electionId), before, "zero commitment must not increment on revert");
        }
    }

    function testFuzz_manyCommitments(uint256 seed, uint8 n) public {
        n = uint8(bound(n, 1, 10));
        uint256 electionId = _newElection(0);
        uint256 unique;
        for (uint256 i; i < n; ++i) {
            uint256 c = uint256(keccak256(abi.encode(seed, i)));
            if (c == 0) continue;
            if (voterRegistry.isRegistered(electionId, c)) continue;
            registerVoter(electionId, c);
            unique += 1;
        }
        assertEq(voterRegistry.participantCount(electionId), unique);
        assertLe(voterRegistry.participantCount(electionId), n);
    }

    function _newElection(uint32 cap) internal returns (uint256 electionId) {
        uint64 start = uint64(block.timestamp + 1_000);
        uint64 cutoff = uint64(block.timestamp + 10_000);
        ElectionParams memory p = Fixtures.withCap(Fixtures.withTimes(defaultParams(), start, cutoff), cap);
        (electionId,) = createElection(p);
    }
}
