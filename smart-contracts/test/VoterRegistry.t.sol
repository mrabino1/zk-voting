// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IElection} from "../src/interfaces/IElection.sol";
import {ElectionParams} from "../src/interfaces/ElectionParams.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Registry insert, cap, duplicates, freeze, unlimited roll.
contract VoterRegistryTest is Deployer {
    uint256 internal electionId;
    address internal election;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        (electionId, election) = createElection();
    }

    function testRegisterInsertsIdentityCommitmentNotWallet() public {
        address voterWallet = makeAddr("voterWallet");
        uint256 commitment = Fixtures.identityCommitment(uint256(7));
        assertTrue(commitment != uint256(uint160(voterWallet)), "leaf is not the wallet");

        vm.expectEmit(true, true, false, false, address(voterRegistry));
        emit VoterRegistered(electionId, commitment, 0);
        registerVoter(electionId, commitment);

        assertTrue(voterRegistry.isRegistered(electionId, commitment));
        assertFalse(voterRegistry.isRegistered(electionId, uint256(uint160(voterWallet))));
        assertEq(voterRegistry.participantCount(electionId), 1);
        assertEq(IElection(election).participantCount(), 1);
        assertTrue(voterRegistry.merkleRoot(electionId) != bytes32(0) || IElection(election).eligibleRoot() != bytes32(0));
    }

    function testDuplicateCommitmentReverts() public {
        uint256 commitment = Fixtures.identityCommitment(uint256(8));
        registerVoter(electionId, commitment);
        vm.prank(registrar);
        vm.expectRevert();
        voterRegistry.register(electionId, commitment);
        assertEq(voterRegistry.participantCount(electionId), 1);
    }

    function testMaxParticipantsCap() public {
        ElectionParams memory p = Fixtures.withCap(defaultParams(), 2);
        (uint256 id,) = createElection(p);
        registerVoter(id, Fixtures.identityCommitment(uint256(31)));
        registerVoter(id, Fixtures.identityCommitment(uint256(32)));
        vm.prank(registrar);
        vm.expectRevert();
        voterRegistry.register(id, Fixtures.identityCommitment(uint256(33)));
        assertEq(voterRegistry.participantCount(id), 2);
    }

    function testMaxParticipantsZeroUnlimitedRegister20() public {
        ElectionParams memory p = Fixtures.withCap(defaultParams(), 0);
        (uint256 id,) = createElection(p);
        for (uint256 i; i < 20; ++i) {
            registerVoter(id, Fixtures.identityCommitment(i + 400));
            assertTrue(voterRegistry.isRegistered(id, Fixtures.identityCommitment(i + 400)));
        }
        assertEq(voterRegistry.participantCount(id), 20);
    }

    function testFreezeBlocksNewRegisters() public {
        registerVoter(electionId, Fixtures.identityCommitment(uint256(9)));
        freezeRoll(election);
        vm.prank(registrar);
        vm.expectRevert();
        voterRegistry.register(electionId, Fixtures.identityCommitment(uint256(10)));
        assertEq(voterRegistry.participantCount(electionId), 1);
    }

    function testRegistrationsIsolatedPerElection() public {
        (uint256 idB,) = createElection();
        uint256 c = Fixtures.identityCommitment(uint256(12));
        registerVoter(electionId, c);
        assertFalse(voterRegistry.isRegistered(idB, c));
        registerVoter(idB, c);
        assertTrue(voterRegistry.isRegistered(idB, c));
        assertEq(voterRegistry.leafIndexOf(electionId, c), voterRegistry.leafIndexOf(electionId, c));
    }
}
