// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "../src/interfaces/ElectionParams.sol";
import {IElection} from "../src/interfaces/IElection.sol";
import {BallotInbox} from "../src/BallotInbox.sol";
import {IdentityCommitment} from "../src/IdentityCommitment.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Ballot inbox: MockVerifier happy path, once-only ballot, voting window.
///
/// Product rule: one accepted ballot per voting identity per election.
/// The Merkle leaf is an identity commitment, not a wallet; `msg.sender` is
/// typically the relayer. Uniqueness is the spent nullifier, not the submitter.
/// A person may change their mind off-chain, but a second accepted on-chain
/// ballot is impossible — this is nullifier / double-vote rejection, not
/// last-vote-counts (the first ciphertext is not superseded).
///
/// Nullifier scope: BallotInbox keys spentness by `(electionId, nullifier)` only.
/// Circuits bind `nullifier = Hash(nullifierSecret, electionId)` with no question
/// index, so a multi-question election still spends one election-scoped nullifier.
/// Distinct per-question nullifiers would be different field values and would both
/// be accepted today; the inbox has no per-question spent map.
contract BallotInboxTest is Deployer {
    uint256 internal electionId;
    address internal election;
    uint256 internal commitment;
    uint256 internal nullifier;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        commitment = Fixtures.identityCommitment(uint256(55));
        nullifier = uint256(keccak256("nullifier-55"));
        (electionId, election) = createElection();
        registerVoter(electionId, commitment);
        freezeRoll(election);
    }

    function testHappyPathSubmitVoteWithMockVerifier() public {
        warpOpen(election);
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, enc);

        vm.expectEmit(true, true, false, false, address(inbox));
        emit VoteAccepted(electionId, nullifier, bytes32(0), relayer);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, inputs, enc);

        assertTrue(inbox.nullifierUsed(electionId, nullifier));
        assertEq(inbox.acceptedBallots(electionId), 1);
        assertEq(inbox.ballotHashOf(electionId, nullifier), bytes32(Fixtures.ballotHash(enc)));
    }

    /// @notice First `submitVote` with nullifier N is accepted; a second call with
    ///         the same nullifier reverts `NullifierUsed` (once-only / double-vote).
    function testOnceOnly_doubleVoteSameNullifierReverts() public {
        warpOpen(election);
        submitVote(electionId, election, nullifier);
        assertEq(inbox.acceptedBallots(electionId), 1);
        assertTrue(inbox.nullifierUsed(electionId, nullifier));

        _expectNullifierUsed(electionId, election, nullifier, Fixtures.encryptedBallot(nullifier));
        assertEq(inbox.acceptedBallots(electionId), 1, "double-vote must not increment acceptedBallots");
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
    }

    /// @dev Kept so existing CI / grep for "DoubleVote" still hits a test name.
    function testDoubleVoteSameNullifierReverts() public {
        testOnceOnly_doubleVoteSameNullifierReverts();
    }

    /// @notice Same identity, different choice/ciphertext, same nullifier: still
    ///         rejected. Off-chain mind-change does not authorize a second accept;
    ///         the first ballot hash is not superseded (not last-vote-counts).
    function testOnceOnly_sameIdentityDifferentCiphertextStillRejected() public {
        warpOpen(election);
        bytes memory firstChoice = abi.encodePacked("elgamal-choice-A", nullifier);
        bytes memory mindChange = abi.encodePacked("elgamal-choice-B-mind-change", nullifier);
        assertTrue(keccak256(firstChoice) != keccak256(mindChange));

        _submitVote(electionId, election, nullifier, firstChoice);
        bytes32 stored = inbox.ballotHashOf(electionId, nullifier);
        assertEq(stored, bytes32(Fixtures.ballotHash(firstChoice)));
        assertEq(inbox.acceptedBallots(electionId), 1);

        _expectNullifierUsed(electionId, election, nullifier, mindChange);
        assertEq(inbox.acceptedBallots(electionId), 1, "mind-change must not accept a second ballot");
        assertEq(inbox.ballotHashOf(electionId, nullifier), stored, "first ballot must not be superseded");
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
    }

    /// @notice Different nullifiers (different voting identities) can both succeed.
    function testOnceOnly_differentVotersDistinctNullifiersBothSucceed() public {
        warpOpen(election);
        uint256 n1 = uint256(keccak256("voter-identity-1"));
        uint256 n2 = uint256(keccak256("voter-identity-2"));
        submitVote(electionId, election, n1);
        submitVote(electionId, election, n2);
        assertTrue(inbox.nullifierUsed(electionId, n1));
        assertTrue(inbox.nullifierUsed(electionId, n2));
        assertEq(inbox.acceptedBallots(electionId), 2);
    }

    function testDistinctNullifiersCountSeparately() public {
        testOnceOnly_differentVotersDistinctNullifiersBothSucceed();
    }

    /// @notice Current circuit formula is election-scoped, not per-question.
    ///         `questionCount > 1` does not give the same identity a second accept.
    function testOnceOnly_multiQuestionElectionStillOneBallotPerNullifier() public {
        ElectionParams memory p = defaultParams();
        p.questionCount = 2;
        (uint256 id, address el) = createElection(p);
        registerVoter(id, Fixtures.identityCommitment(uint256(58)));
        freezeRoll(el);
        warpOpen(el);

        uint256 n = uint256(keccak256("multi-q-nullifier"));
        bytes memory q1 = abi.encodePacked("ciphertext-question-aspect-1", n);
        bytes memory q2 = abi.encodePacked("ciphertext-question-aspect-2", n);

        _submitVote(id, el, n, q1);
        assertEq(inbox.acceptedBallots(id), 1);

        _expectNullifierUsed(id, el, n, q2);
        assertEq(inbox.acceptedBallots(id), 1);
        assertEq(inbox.ballotHashOf(id, n), bytes32(Fixtures.ballotHash(q1)));
    }

    /// @notice If two identities produce distinct nullifier fields, both succeed
    ///         even when `questionCount == 2`. Per-question uniqueness is not a
    ///         separate inbox mapping — only the nullifier field is spent.
    function testOnceOnly_distinctNullifiersSucceedWhenQuestionCountIsTwo() public {
        ElectionParams memory p = defaultParams();
        p.questionCount = 2;
        (uint256 id, address el) = createElection(p);
        registerVoter(id, Fixtures.identityCommitment(uint256(59)));
        freezeRoll(el);
        warpOpen(el);

        submitVote(id, el, uint256(keccak256("q2-n1")));
        submitVote(id, el, uint256(keccak256("q2-n2")));
        assertEq(inbox.acceptedBallots(id), 2);
    }

    /// @notice Solidity stand-in matches the circuit: Hash(nullifierSecret, electionId).
    function testOnceOnly_identityCommitmentNullifierIsElectionScoped() public {
        warpOpen(election);
        uint256 secret = uint256(keccak256("nullifierSecret-55"));
        uint256 n = IdentityCommitment.nullifier(secret, electionId);
        assertTrue(n != IdentityCommitment.nullifier(secret, electionId + 1), "nullifier binds electionId");

        submitVote(electionId, election, n);
        _expectNullifierUsed(electionId, election, n, Fixtures.encryptedBallot(n));
        assertEq(inbox.acceptedBallots(electionId), 1);
    }

    function testVotingBeforeStartReverts() public {
        assertTrue(block.timestamp < IElection(election).params().startTime);
        expectSubmitVoteRevert(electionId, election, nullifier);
        assertEq(inbox.acceptedBallots(electionId), 0);
        assertFalse(inbox.nullifierUsed(electionId, nullifier));
    }

    function testVotingAfterCutoffReverts() public {
        warpClosed(election);
        expectSubmitVoteRevert(electionId, election, uint256(keccak256("late-nullifier")));
        assertEq(inbox.acceptedBallots(electionId), 0);
    }

    function testVoteWithoutFreezeReverts() public {
        (uint256 id, address el) = createElection();
        registerVoter(id, Fixtures.identityCommitment(uint256(56)));
        warpOpen(el);
        assertFalse(IElection(el).rollFrozen());
        expectSubmitVoteRevert(id, el, uint256(keccak256("unfrozen")));
    }

    function testNullifiersIsolatedPerElection() public {
        (uint256 idB, address elB) = createElection();
        registerVoter(idB, Fixtures.identityCommitment(uint256(57)));
        freezeRoll(elB);

        warpOpen(election);
        warpOpen(elB);

        submitVote(electionId, election, nullifier);
        submitVote(idB, elB, nullifier);

        assertTrue(inbox.nullifierUsed(electionId, nullifier));
        assertTrue(inbox.nullifierUsed(idB, nullifier));
        assertEq(inbox.acceptedBallots(electionId), 1);
        assertEq(inbox.acceptedBallots(idB), 1);
    }

    function _submitVote(uint256 id, address el, uint256 n, bytes memory enc) internal {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(id, el, n, enc);
        vm.prank(relayer);
        inbox.submitVote(id, a, b, c, inputs, enc);
    }

    function _expectNullifierUsed(uint256 id, address el, uint256 n, bytes memory enc) internal {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(id, el, n, enc);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.NullifierUsed.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
    }
}
