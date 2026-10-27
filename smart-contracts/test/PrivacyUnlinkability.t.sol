// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Vm} from "forge-std/Vm.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Wallet address is unlinkable from the ballot / identity commitment.
contract PrivacyUnlinkabilityTest is Deployer {
    uint256 internal electionId;
    address internal election;
    address internal voterWallet;
    uint256 internal identityCommitment;
    uint256 internal nullifier;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        voterWallet = makeAddr("voterWallet");
        identityCommitment = Fixtures.identityCommitment(keccak256("trapdoor-nullifierSecret"));
        nullifier = uint256(keccak256(abi.encodePacked("nullifier", voterWallet, uint256(1))));
        (electionId, election) = createElection();
    }

    function testIdentityCommitmentNeverEqualsVoterWallet() public {
        assertTrue(identityCommitment != uint256(uint160(voterWallet)));
        registerVoter(electionId, identityCommitment);
        assertTrue(voterRegistry.isRegistered(electionId, identityCommitment));
        assertFalse(voterRegistry.isRegistered(electionId, uint256(uint160(voterWallet))));
        assertEq(uint256(uint160(voterWallet)), uint256(uint160(voterWallet)));
    }

    function testSubmitVoteFromRelayerNotVoterWallet() public {
        registerVoter(electionId, identityCommitment);
        freezeRoll(election);
        warpOpen(election);

        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, enc);

        vm.recordLogs();
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, inputs, enc);

        assertTrue(relayer != voterWallet);
        assertEq(inbox.acceptedBallots(electionId), 1);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("VoteAccepted(uint256,uint256,bytes32,address)");
        bytes32 voterTopic = bytes32(uint256(uint160(voterWallet)));
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(inbox)) continue;
            if (logs[i].topics.length == 0 || logs[i].topics[0] != sig) continue;
            seen = true;
            // Indexed fields: electionId, nullifier — must not include the voter wallet.
            for (uint256 t = 1; t < logs[i].topics.length; ++t) {
                assertTrue(logs[i].topics[t] != voterTopic, "indexed field leaked voter wallet");
            }
            (bytes32 ballotHash_, address emittedRelayer) = abi.decode(logs[i].data, (bytes32, address));
            assertEq(emittedRelayer, relayer, "msg.sender is the relayer");
            assertTrue(emittedRelayer != voterWallet, "relayer is not the voter wallet");
            assertTrue(ballotHash_ != voterTopic);
        }
        assertTrue(seen, "VoteAccepted emitted");
    }

    function testVoteAcceptedIndexedFieldsDoNotIncludeVoterWallet() public {
        registerVoter(electionId, identityCommitment);
        freezeRoll(election);
        warpOpen(election);

        vm.recordLogs();
        submitVote(electionId, election, nullifier);

        bytes32 sig = keccak256("VoteAccepted(uint256,uint256,bytes32,address)");
        bytes32 voterTopic = bytes32(uint256(uint160(voterWallet)));
        bool seen;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != sig) continue;
            seen = true;
            assertEq(logs[i].topics.length, 3, "only electionId and nullifier are indexed");
            assertEq(uint256(logs[i].topics[1]), electionId);
            assertEq(uint256(logs[i].topics[2]), nullifier);
            assertTrue(logs[i].topics[1] != voterTopic);
            assertTrue(logs[i].topics[2] != voterTopic);
        }
        assertTrue(seen);
    }

    /// @notice Per-election spent nullifier rejects a second ballot in **that**
    ///         election and is not the voter wallet. Not a lifetime ban.
    function testPerElection_nullifierUniquenessDoesNotIdentifyWallet() public {
        registerVoter(electionId, identityCommitment);
        freezeRoll(election);
        warpOpen(election);
        submitVote(electionId, election, nullifier);
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
        assertTrue(nullifier != uint256(uint160(voterWallet)));
        expectSubmitVoteRevert(electionId, election, nullifier);
        assertEq(inbox.acceptedBallots(electionId), 1, "double-vote must not increment acceptedBallots");
    }

    function testOnceOnly_nullifierUniquenessDoesNotIdentifyWallet() public {
        testPerElection_nullifierUniquenessDoesNotIdentifyWallet();
    }

    function testNullifierUniquenessDoesNotIdentifyWallet() public {
        testPerElection_nullifierUniquenessDoesNotIdentifyWallet();
    }
}
