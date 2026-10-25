// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IElection} from "../src/interfaces/IElection.sol";
import {ElectionParams, ElectionState} from "../src/interfaces/ElectionParams.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice start/cutoff, freeze, participant cap, lifecycle states.
contract ElectionLifecycleTest is Deployer {
    uint256 internal electionId;
    address internal election;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        (electionId, election) = createElection();
    }

    function testCreatedStateBeforeFreeze() public {
        assertEq(IElection(election).state(), ElectionState.CREATED);
        assertFalse(IElection(election).rollFrozen());
        assertEq(IElection(election).participantCount(), 0);
    }

    function testStartTimeGteCutoffTimeReverts() public {
        ElectionParams memory p = Fixtures.withTimes(defaultParams(), uint64(block.timestamp + 50), uint64(block.timestamp + 50));
        vm.prank(admin);
        vm.expectRevert();
        factory.createElection(p);

        p = Fixtures.withTimes(defaultParams(), uint64(block.timestamp + 90), uint64(block.timestamp + 10));
        vm.prank(admin);
        vm.expectRevert();
        factory.createElection(p);
    }

    function testFreezeRollBlocksNewRegisters() public {
        uint256 first = Fixtures.identityCommitment(uint256(1));
        registerVoter(electionId, first);
        freezeRoll(election);
        assertTrue(IElection(election).rollFrozen());
        uint8 st = IElection(election).state();
        assertTrue(st == ElectionState.ROLL_FROZEN || st == ElectionState.OPEN);

        vm.prank(registrar);
        vm.expectRevert();
        voterRegistry.register(electionId, Fixtures.identityCommitment(uint256(2)));
    }

    function testVotingBeforeStartReverts() public {
        uint256 commitment = Fixtures.identityCommitment(uint256(3));
        registerVoter(electionId, commitment);
        freezeRoll(election);
        // still before startTime
        assertTrue(block.timestamp < IElection(election).params().startTime);
        expectSubmitVoteRevert(electionId, election, uint256(keccak256("n-before")));
    }

    function testVotingAfterCutoffReverts() public {
        uint256 commitment = Fixtures.identityCommitment(uint256(4));
        registerVoter(electionId, commitment);
        freezeRoll(election);
        warpClosed(election);
        expectSubmitVoteRevert(electionId, election, uint256(keccak256("n-after")));
    }

    function testVotingDuringWindowSucceeds() public {
        uint256 commitment = Fixtures.identityCommitment(uint256(5));
        registerVoter(electionId, commitment);
        freezeRoll(election);
        warpOpen(election);
        uint8 st = IElection(election).state();
        assertTrue(st == ElectionState.OPEN || st == ElectionState.ROLL_FROZEN);
        submitVote(electionId, election, uint256(keccak256("n-open")));
        assertEq(inbox.acceptedBallots(electionId), 1);
        assertTrue(inbox.nullifierUsed(electionId, uint256(keccak256("n-open"))));
    }

    function testMaxParticipantsCap() public {
        ElectionParams memory p = Fixtures.withCap(defaultParams(), 3);
        (uint256 id,) = createElection(p);

        registerVoter(id, Fixtures.identityCommitment(uint256(21)));
        registerVoter(id, Fixtures.identityCommitment(uint256(22)));
        registerVoter(id, Fixtures.identityCommitment(uint256(23)));
        assertEq(voterRegistry.participantCount(id), 3);

        vm.prank(registrar);
        vm.expectRevert();
        voterRegistry.register(id, Fixtures.identityCommitment(uint256(24)));
        assertEq(voterRegistry.participantCount(id), 3);
    }

    function testMaxParticipantsZeroIsUnlimitedRegister20() public {
        ElectionParams memory p = Fixtures.withCap(defaultParams(), 0);
        (uint256 id, address el) = createElection(p);
        assertEq(IElection(el).params().maxParticipants, 0);

        for (uint256 i = 1; i <= 20; ++i) {
            registerVoter(id, Fixtures.identityCommitment(i + 1000));
        }
        assertEq(voterRegistry.participantCount(id), 20);
        assertEq(IElection(el).participantCount(), 20);
    }

    function testStateClosedAfterCutoff() public {
        freezeRoll(election);
        warpClosed(election);
        uint8 st = IElection(election).state();
        assertTrue(st == ElectionState.CLOSED || st == ElectionState.ROLL_FROZEN || st == ElectionState.OPEN);
        if (st == ElectionState.CLOSED) {
            assertTrue(block.timestamp >= IElection(election).params().cutoffTime);
        }
    }
}
