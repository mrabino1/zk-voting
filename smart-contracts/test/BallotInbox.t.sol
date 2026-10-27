// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "../src/interfaces/ElectionParams.sol";
import {IElection} from "../src/interfaces/IElection.sol";
import {BallotInbox} from "../src/BallotInbox.sol";
import {IdentityCommitment} from "../src/IdentityCommitment.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";
import {IBallotInbox} from "../src/interfaces/IBallotInbox.sol";

/// @notice Ballot inbox: MockVerifier happy path, per-election once-only ballot, voting window.
///
/// Product rule: **one accepted ballot per voting identity per individual election**.
/// This is not a lifetime / once-ever ban: the same person may cast a first vote
/// in every election they are eligible for. Uniqueness is the spent nullifier
/// keyed by `(electionId, nullifier)`, not the submitter wallet. The Merkle leaf
/// is an identity commitment; `msg.sender` is typically the relayer.
///
/// Same election: a second `submitVote` (including a mind-change / different
/// ciphertext) reverts `NullifierUsed` — not last-vote-counts.
/// Different elections: first vote in each can succeed (nullifiers are
/// election-scoped: `Hash(nullifierSecret, electionId)`).
///
/// Circuits do not bind a question index. `questionCount > 1` still spends one
/// election-scoped nullifier. Distinct per-question nullifier fields would both
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

        uint256 canonical = nullifier % inbox.SNARK_SCALAR_FIELD();
        vm.expectEmit(true, true, false, false, address(inbox));
        emit VoteAccepted(electionId, canonical, bytes32(0), relayer);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, inputs, enc);

        assertTrue(inbox.nullifierUsed(electionId, nullifier));
        assertEq(inbox.acceptedBallots(electionId), 1);
        assertEq(inbox.ballotHashOf(electionId, nullifier), bytes32(Fixtures.ballotHash(enc)));
    }

    /// @notice Same identity + same election + second submit → `NullifierUsed`.
    ///         One vote per individual election, not a lifetime ban.
    function testPerElection_sameIdentitySecondSubmitReverts() public {
        warpOpen(election);
        submitVote(electionId, election, nullifier);
        assertEq(inbox.acceptedBallots(electionId), 1);
        assertTrue(inbox.nullifierUsed(electionId, nullifier));

        _expectNullifierUsed(electionId, election, nullifier, Fixtures.encryptedBallot(nullifier));
        assertEq(inbox.acceptedBallots(electionId), 1, "double-vote must not increment acceptedBallots");
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
    }

    /// @dev Historical name: same-election double-vote rejection.
    function testDoubleVoteSameNullifierReverts() public {
        testPerElection_sameIdentitySecondSubmitReverts();
    }

    function testOnceOnly_doubleVoteSameNullifierReverts() public {
        testPerElection_sameIdentitySecondSubmitReverts();
    }

    /// @notice Mind-change does not allow a second accept **within the same election**.
    ///         Different ciphertext, same nullifier: still `NullifierUsed`; first
    ///         ballot hash is not superseded (not last-vote-counts).
    function testPerElection_mindChangeSameElectionStillRejected() public {
        warpOpen(election);
        bytes memory firstChoice = abi.encodePacked("elgamal-choice-A", nullifier);
        bytes memory mindChange = abi.encodePacked("elgamal-choice-B-mind-change", nullifier);
        assertTrue(keccak256(firstChoice) != keccak256(mindChange));

        _submitVote(electionId, election, nullifier, firstChoice);
        bytes32 stored = inbox.ballotHashOf(electionId, nullifier);
        assertEq(stored, bytes32(Fixtures.ballotHash(firstChoice)));
        assertEq(inbox.acceptedBallots(electionId), 1);

        _expectNullifierUsed(electionId, election, nullifier, mindChange);
        assertEq(inbox.acceptedBallots(electionId), 1, "mind-change must not accept a second ballot in this election");
        assertEq(inbox.ballotHashOf(electionId, nullifier), stored, "first ballot must not be superseded");
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
    }

    function testOnceOnly_sameIdentityDifferentCiphertextStillRejected() public {
        testPerElection_mindChangeSameElectionStillRejected();
    }

    /// @notice Different nullifiers (different voting identities) in the **same**
    ///         election can both succeed.
    function testPerElection_differentVotersDistinctNullifiersBothSucceed() public {
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
        testPerElection_differentVotersDistinctNullifiersBothSucceed();
    }

    /// @notice Same identity + **different** elections: first vote in each succeeds.
    ///         Nullifiers are election-scoped (`Hash(nullifierSecret, electionId)`),
    ///         not a global once-ever ban.
    function testPerElection_sameIdentityFirstVoteInEachElectionSucceeds() public {
        uint256 trapdoor = uint256(keccak256("trapdoor-person"));
        uint256 secret = uint256(keccak256("nullifierSecret-person"));
        uint256 leaf = IdentityCommitment.toLeaf(trapdoor, secret);

        (uint256 idA, address elA) = createElection();
        (uint256 idB, address elB) = createElection();
        assertTrue(idA != idB);

        registerVoter(idA, leaf);
        registerVoter(idB, leaf);
        freezeRoll(elA);
        freezeRoll(elB);
        warpOpen(elA);
        warpOpen(elB);

        uint256 nA = IdentityCommitment.nullifier(secret, idA);
        uint256 nB = IdentityCommitment.nullifier(secret, idB);
        assertTrue(nA != nB, "nullifier binds electionId; not a lifetime spent key");

        submitVote(idA, elA, nA);
        submitVote(idB, elB, nB);
        assertEq(inbox.acceptedBallots(idA), 1, "first vote in election A");
        assertEq(inbox.acceptedBallots(idB), 1, "first vote in election B is not banned by A");
        assertTrue(inbox.nullifierUsed(idA, nA));
        assertTrue(inbox.nullifierUsed(idB, nB));
        assertFalse(inbox.nullifierUsed(idA, nB), "B's nullifier is not spent in A");
        assertFalse(inbox.nullifierUsed(idB, nA), "A's nullifier is not spent in B");

        _expectNullifierUsed(idA, elA, nA, Fixtures.encryptedBallot(nA));
        _expectNullifierUsed(idB, elB, nB, Fixtures.encryptedBallot(nB));
        assertEq(inbox.acceptedBallots(idA), 1);
        assertEq(inbox.acceptedBallots(idB), 1);
    }

    /// @notice Inbox mapping isolation: the same field value may be spent once in
    ///         election A and once in election B. Spentness is not global.
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

    function testOnceOnly_identityCommitmentNullifierIsElectionScoped() public {
        testPerElection_sameIdentityFirstVoteInEachElectionSucceeds();
    }

    /// @notice `questionCount > 1` still one accept per identity **in that election**.
    function testPerElection_multiQuestionStillOneBallotPerNullifier() public {
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

    function testOnceOnly_multiQuestionElectionStillOneBallotPerNullifier() public {
        testPerElection_multiQuestionStillOneBallotPerNullifier();
    }

    /// @notice Distinct nullifier fields both succeed in one multi-question election.
    ///         There is no per-question spent map — and no lifetime ban.
    function testPerElection_distinctNullifiersSucceedWhenQuestionCountIsTwo() public {
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
        vm.expectRevert(IBallotInbox.NullifierUsed.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
    }

    function testSecondBallotDifferentCiphertextReverts() public {
        warpOpen(election);
        bytes memory first = Fixtures.encryptedBallot(nullifier);
        bytes memory second = abi.encodePacked(first, "changed-mind");
        submitVoteWithBallot(electionId, election, nullifier, first);
        assertEq(inbox.acceptedBallots(electionId), 1);
        assertEq(inbox.ballotHashOf(electionId, nullifier), bytes32(Fixtures.ballotHash(first)));

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, second);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.NullifierUsed.selector);
        inbox.submitVote(electionId, a, b, c, inputs, second);

        assertTrue(inbox.nullifierUsed(electionId, nullifier));
        assertEq(inbox.acceptedBallots(electionId), 1, "second ballot must not mint a second voter");
        assertEq(
            inbox.ballotHashOf(electionId, nullifier),
            bytes32(Fixtures.ballotHash(first)),
            "first accepted hash is final"
        );
    }
}
