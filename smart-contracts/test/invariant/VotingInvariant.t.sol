// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IElection} from "../../src/interfaces/IElection.sol";
import {ITallyVerifier} from "../../src/interfaces/ITallyVerifier.sol";
import {Handler} from "./Handler.sol";

/// @title VotingInvariant
/// @notice Foundry invariant suite for zk-voting.
///         fail_on_revert is true. The handler try/catches expected reverts
///         so a revert that escapes an action fails the campaign.
///         Per individual election (not a lifetime ban): a nullifier is accepted
///         at most once in that election. Same identity may vote in other elections.
///         `invariant_nullifierOnceOnlyPerElection_doubleVoteRejected` (and
///         `invariant_nullifierUnique`). Handler.doubleVote retries spent
///         nullifiers in the same election.
contract VotingInvariant is StdInvariant, Test {
    Handler public handler;

    function setUp() public {
        handler = new Handler();
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = Handler.createElection.selector;
        selectors[1] = Handler.register.selector;
        selectors[2] = Handler.freeze.selector;
        selectors[3] = Handler.warpIntoWindow.selector;
        selectors[4] = Handler.vote.selector;
        selectors[5] = Handler.doubleVote.selector;
        selectors[6] = Handler.disqualify.selector;
        selectors[7] = Handler.postTally.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        excludeSender(address(0));
    }

    /// @notice Per individual election: a nullifier is accepted at most once in
    ///         that election. Not a lifetime ban across elections. Mind-change
    ///         does not authorize a second accept in the same election.
    function invariant_nullifierOnceOnlyPerElection_doubleVoteRejected() public view {
        _assertNullifierOncePerElection();
    }

    /// @dev Same per-election uniqueness under the historical invariant name.
    function invariant_nullifierUnique() public view {
        _assertNullifierOncePerElection();
    }

    function _assertNullifierOncePerElection() internal view {
        assertEq(handler.duplicateNullifiers(), 0, "per-election: nullifier spent twice in the same election");
        assertEq(handler.doubleVotesAccepted(), 0, "per-election: double-vote accepted in the same election");
        uint256 n = handler.trackedElectionCount();
        uint256 ghostAccepted;
        for (uint256 i; i < n; ++i) {
            uint256 electionId = handler.trackedElectionIds(i);
            uint256 used = handler.nullifierCount(electionId);
            ghostAccepted += handler.acceptedByElection(electionId);
            for (uint256 j; j < used; ++j) {
                uint256 nullifier = handler.nullifierAt(electionId, j);
                assertTrue(handler.nullifierUsed(electionId, nullifier), "ghost nullifier missing");
                assertTrue(handler.getInbox().nullifierUsed(electionId, nullifier), "chain missing spent nullifier");
                handler.getInbox().ballotHashOf(electionId, nullifier);
            }
            uint256 onChainAccepted = handler.getInbox().acceptedBallots(electionId);
            assertEq(onChainAccepted, handler.acceptedByElection(electionId));
            assertEq(onChainAccepted, used, "per-election: acceptedBallots == unique spent nullifiers");
            assertFalse(handler.getInbox().nullifierUsed(electionId, 0), "zero nullifier must stay unspent");
        }
        assertEq(handler.votesAccepted(), ghostAccepted);
    }

    /// @notice No vote is accepted outside [startTime, cutoffTime).
    function invariant_noVoteOutsideWindow() public view {
        assertEq(handler.votesOutsideWindow(), 0, "vote accepted outside window");
        uint256 n = handler.trackedElectionCount();
        for (uint256 i; i < n; ++i) {
            uint256 electionId = handler.trackedElectionIds(i);
            uint256 accepted = handler.getInbox().acceptedBallots(electionId);
            if (accepted == 0) continue;
            uint64 start = handler.startOf(electionId);
            uint64 cutoff = handler.cutoffOf(electionId);
            assertTrue(cutoff > start, "malformed window");
        }
    }

    /// @notice If maxParticipants > 0, participantCount never exceeds the cap.
    function invariant_capHonored() public view {
        uint256 n = handler.trackedElectionCount();
        for (uint256 i; i < n; ++i) {
            uint256 electionId = handler.trackedElectionIds(i);
            uint32 cap = handler.capOf(electionId);
            uint256 participants = handler.getRegistry().participantCount(electionId);
            if (cap != 0) {
                assertLe(participants, cap, "registry cap breached");
                address el = handler.getFactory().getElection(electionId);
                if (el != address(0)) {
                    assertLe(IElection(el).participantCount(), cap, "election cap breached");
                }
            }
            if (cap != 0) {
                assertLe(handler.registeredByElection(electionId), cap);
            }
        }
    }

    /// @notice After a tally is posted, sum(counts) == acceptedBallots.
    function invariant_tallySumsIfPosted() public view {
        ITallyVerifier tallyer = ITallyVerifier(address(handler.getTally()));
        uint256 n = handler.trackedElectionCount();
        for (uint256 i; i < n; ++i) {
            uint256 electionId = handler.trackedElectionIds(i);
            if (!tallyer.isTallied(electionId)) continue;
            uint256[] memory counts = tallyer.tally(electionId);
            uint256 sum;
            for (uint256 j; j < counts.length; ++j) {
                sum += counts[j];
            }
            assertEq(sum, handler.getInbox().acceptedBallots(electionId), "tally != acceptedBallots");
        }
    }

    /// @notice electionCount equals the number of successful createElection calls.
    function invariant_electionCountMatches() public view {
        assertEq(handler.getFactory().electionCount(), handler.ghostElectionCount());
        assertEq(handler.getFactory().electionCount(), handler.trackedElectionCount());
        uint256 n = handler.trackedElectionCount();
        for (uint256 i; i < n; ++i) {
            uint256 electionId = handler.trackedElectionIds(i);
            address el = handler.getFactory().getElection(electionId);
            assertTrue(el != address(0), "missing election");
            assertEq(el, handler.electionAddr(electionId));
        }
    }

    /// @notice acceptedBallots <= registered for each election the handler tracks.
    function invariant_acceptedLeqRegistered() public view {
        uint256 n = handler.trackedElectionCount();
        for (uint256 i; i < n; ++i) {
            uint256 electionId = handler.trackedElectionIds(i);
            uint256 accepted = handler.getInbox().acceptedBallots(electionId);
            uint256 enrolled = handler.getRegistry().participantCount(electionId);
            assertLe(accepted, enrolled, "acceptedBallots > registered");
            assertLe(accepted, handler.registeredByElection(electionId));
            assertLe(handler.acceptedByElection(electionId), handler.registeredByElection(electionId));
        }
        assertLe(handler.votesAccepted(), handler.registered());
    }
}
