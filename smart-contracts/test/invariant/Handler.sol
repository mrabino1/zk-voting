// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "../../src/interfaces/ElectionParams.sol";
import {IElection} from "../../src/interfaces/IElection.sol";
import {ElectionFactory} from "../../src/ElectionFactory.sol";
import {VoterRegistry} from "../../src/VoterRegistry.sol";
import {DisqualificationRegistry} from "../../src/DisqualificationRegistry.sol";
import {BallotInbox} from "../../src/BallotInbox.sol";
import {Tally} from "../../src/Tally.sol";
import {MockVerifier} from "../../src/zk/MockVerifier.sol";
import {ReasonCodes} from "../../src/ReasonCodes.sol";
import {Deployer} from "../helpers/Deployer.sol";
import {Fixtures} from "../helpers/Fixtures.sol";
import {Ghost} from "./Ghost.sol";

/// @title Handler
/// @notice Invariant fuzzer entrypoints for ZK-Voting. Every action uses
///         try/catch so a revert does not abort the invariant run.
///         Actors are pranked; Foundry's random msg.sender is ignored.
contract Handler is Deployer, Ghost {
    bytes32 public constant JURISDICTION = keccak256("zk-voting-fuzz-jurisdiction");

    uint256[2] internal _a;
    uint256[2][2] internal _b;
    uint256[2] internal _c;

    constructor() {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        (_a, _b, _c) = Fixtures.dummyProof();
    }

    function getFactory() public view returns (ElectionFactory) {
        return factory;
    }

    function getInbox() public view returns (BallotInbox) {
        return inbox;
    }

    function getRegistry() public view returns (VoterRegistry) {
        return voterRegistry;
    }

    function getDq() public view returns (DisqualificationRegistry) {
        return disqualification;
    }

    function getTally() public view returns (Tally) {
        return tally;
    }

    function getVerifier() public view returns (MockVerifier) {
        return verifier;
    }

    function getAdmin() public view returns (address) {
        return admin;
    }

    function getClerk() public view returns (address) {
        return clerk;
    }

    function getRegistrar() public view returns (address) {
        return registrar;
    }

    function getOfficer() public view returns (address) {
        return officer;
    }

    function getTallyOp() public view returns (address) {
        return tallyOperator;
    }

    function getRelayer() public view returns (address) {
        return relayer;
    }

    // -------------------------------------------------------------------------
    // Fuzzer actions
    // -------------------------------------------------------------------------

    function createElection(
        uint64 startTime,
        uint64 cutoffTime,
        uint8 treeDepth,
        uint8 questionCount,
        uint32 maxParticipants
    ) public {
        _tryCreateElection(startTime, cutoffTime, treeDepth, questionCount, maxParticipants);
    }

    function register(uint256 electionSeed, uint256 commitment) public {
        _tryRegister(electionSeed, commitment);
    }

    function freeze(uint256 electionSeed) public {
        _tryFreeze(electionSeed);
    }

    function warpIntoWindow(uint256 electionSeed) public {
        _tryWarpIntoWindow(electionSeed);
    }

    function vote(uint256 electionSeed, uint256 nullifier, bytes calldata encryptedBallot) public {
        _tryVote(electionSeed, nullifier, encryptedBallot);
    }

    /// @notice Same-election double-vote: retry a spent nullifier with a (possibly
    ///         different) ciphertext. Must revert; does not ban other elections.
    function doubleVote(uint256 electionSeed, uint256 spentIndex, bytes calldata encryptedBallot) public {
        _tryDoubleVote(electionSeed, spentIndex, encryptedBallot);
    }

    function disqualify(uint256 electionSeed, uint256 commitment, uint16 reasonCode) public {
        _tryDisqualify(electionSeed, commitment, reasonCode);
    }

    function postTally(uint256 electionSeed) public {
        _tryTally(electionSeed);
    }

    function makeValidParams(uint64 start, uint64 cutoff, uint8 depth, uint8 questions, uint32 cap)
        public
        view
        returns (ElectionParams memory)
    {
        return _params(start, cutoff, depth, questions, cap);
    }

    // -------------------------------------------------------------------------
    // _try implementations — never bubble reverts to the invariant runner
    // -------------------------------------------------------------------------

    function _tryCreateElection(
        uint64 startTime,
        uint64 cutoffTime,
        uint8 treeDepth,
        uint8 questionCount,
        uint32 maxParticipants
    ) internal {
        uint64 start = uint64(_clamp(startTime, block.timestamp + 1, block.timestamp + 365 days));
        uint64 cutoff = uint64(_clamp(cutoffTime, uint256(start) + 1, uint256(start) + 30 days));
        uint8 depth = uint8(_clamp(treeDepth, 16, 20));
        uint8 questions = uint8(_clamp(questionCount, 1, 8));
        uint32 cap = uint32(_clamp(maxParticipants, 0, 8));

        ElectionParams memory p = _params(start, cutoff, depth, questions, cap);
        vm.prank(admin);
        try factory.createElection(p) returns (uint256 electionId, address election) {
            _recordElection(
                electionId,
                election,
                start,
                cutoff,
                cap,
                p.clerk,
                p.registrar,
                p.disqualificationOfficer,
                p.tallyOperator
            );
        } catch {
            vm.prank(clerk);
            try factory.createElection(p) returns (uint256 electionId, address election) {
                _recordElection(
                    electionId,
                    election,
                    start,
                    cutoff,
                    cap,
                    p.clerk,
                    p.registrar,
                    p.disqualificationOfficer,
                    p.tallyOperator
                );
            } catch {}
        }
    }

    function _tryRegister(uint256 electionSeed, uint256 commitment) internal {
        uint256 electionId = _pick(electionSeed);
        if (electionId == 0) return;
        if (commitment == 0) commitment = uint256(keccak256(abi.encode(electionSeed, registered)));
        address who = registrarOf[electionId];
        if (who == address(0)) who = registrar;
        vm.prank(who);
        try voterRegistry.register(electionId, commitment) {
            _recordRegister(electionId, commitment);
        } catch {
            vm.prank(admin);
            try voterRegistry.register(electionId, commitment) {
                _recordRegister(electionId, commitment);
            } catch {}
        }
    }

    function _tryFreeze(uint256 electionSeed) internal {
        uint256 electionId = _pick(electionSeed);
        if (electionId == 0) return;
        address el = factory.getElection(electionId);
        if (el == address(0)) return;
        address who = clerkOf[electionId];
        if (who == address(0)) who = clerk;
        vm.prank(who);
        try IElection(el).freezeRoll() {}
        catch {
            vm.prank(admin);
            try IElection(el).freezeRoll() {} catch {}
        }
    }

    function _tryWarpIntoWindow(uint256 electionSeed) internal {
        uint256 electionId = _pick(electionSeed);
        if (electionId == 0) return;
        uint64 start = startOf[electionId];
        uint64 cutoff = cutoffOf[electionId];
        if (cutoff <= start) return;
        // Never warp backwards past a posted tally / closed poll. If we are
        // already at or after cutoff, leave time alone.
        if (block.timestamp >= cutoff) return;
        if (block.timestamp < start) {
            vm.warp(start);
        }
    }

    function _tryVote(uint256 electionSeed, uint256 nullifier, bytes calldata encryptedBallot) internal {
        uint256 electionId = _pick(electionSeed);
        if (electionId == 0) return;
        bytes memory ballot = encryptedBallot;
        if (ballot.length > 1024) return;
        if (ballot.length == 0) ballot = hex"01";
        // A residue of zero is rejected. Remap it so the campaign still votes.
        if (nullifier % 21888242871839275222246405745257275088548364400416034343698204186575808495617 == 0) {
            nullifier = uint256(keccak256(abi.encode(electionSeed, votesAccepted, ballot)));
            if (nullifier % 21888242871839275222246405745257275088548364400416034343698204186575808495617 == 0) {
                nullifier = 1;
            }
        }

        uint256 commitment = uint256(keccak256(abi.encode(nullifier, "commitment")));
        bool enrolled = voterRegistry.isRegistered(electionId, commitment);
        if (!enrolled) {
            _tryRegister(electionId, commitment);
            enrolled = voterRegistry.isRegistered(electionId, commitment);
        }
        if (!enrolled) return;
        _tryFreeze(electionId);
        _tryWarpIntoWindow(electionId);

        address el = factory.getElection(electionId);
        if (el == address(0)) return;
        bool frozen;
        try IElection(el).rollFrozen() returns (bool f) {
            frozen = f;
        } catch {}
        if (!frozen) return;
        if (block.timestamp < startOf[electionId] || block.timestamp >= cutoffOf[electionId]) return;

        uint256[] memory inputs = Fixtures.publicInputs(
            IElection(el).eligibleRoot(),
            IElection(el).disqualificationRoot(),
            nullifier,
            uint256(keccak256(ballot)) % 21888242871839275222246405745257275088548364400416034343698204186575808495617,
            electionId
        );
        vm.prank(relayer);
        try inbox.submitVote(electionId, _a, _b, _c, inputs, ballot) {
            _recordVote(electionId, nullifier, frozen);
        } catch {}
    }

    function _tryDoubleVote(uint256 electionSeed, uint256 spentIndex, bytes calldata encryptedBallot) internal {
        uint256 electionId = _pick(electionSeed);
        if (electionId == 0) return;
        uint256 used = _nullifiersOf[electionId].length;
        if (used == 0) return;
        uint256 nullifier = _nullifiersOf[electionId][_clamp(spentIndex, 0, used - 1)];

        bytes memory ballot = encryptedBallot;
        if (ballot.length > 1024) return;
        if (ballot.length == 0) ballot = hex"02";

        address el = factory.getElection(electionId);
        if (el == address(0)) return;
        bool frozen;
        try IElection(el).rollFrozen() returns (bool f) {
            frozen = f;
        } catch {}
        if (!frozen) return;
        if (block.timestamp < startOf[electionId] || block.timestamp >= cutoffOf[electionId]) return;

        uint256[] memory inputs = Fixtures.publicInputs(
            IElection(el).eligibleRoot(),
            IElection(el).disqualificationRoot(),
            nullifier,
            uint256(keccak256(ballot)) % 21888242871839275222246405745257275088548364400416034343698204186575808495617,
            electionId
        );
        vm.prank(relayer);
        try inbox.submitVote(electionId, _a, _b, _c, inputs, ballot) {
            _recordDoubleVoteAttempt(true);
            _recordVote(electionId, nullifier, frozen);
        } catch {
            _recordDoubleVoteAttempt(false);
        }
    }

    function _tryDisqualify(uint256 electionSeed, uint256 commitment, uint16 reasonCode) internal {
        uint256 electionId = _pick(electionSeed);
        if (electionId == 0) return;
        if (commitment == 0) return;
        uint16 code = uint16(_clamp(reasonCode, 1, ReasonCodes.MAX_CODE));
        bytes32 evidence = keccak256(abi.encode(electionId, commitment, code));
        address who = officerOf[electionId];
        if (who == address(0)) who = officer;
        vm.prank(who);
        try disqualification.disqualify(electionId, commitment, code, evidence) {}
        catch {
            vm.prank(admin);
            try disqualification.disqualify(electionId, commitment, code, evidence) {} catch {}
        }
    }

    function _tryTally(uint256 electionSeed) internal {
        uint256 electionId = _pick(electionSeed);
        if (electionId == 0) return;
        uint64 cutoff = cutoffOf[electionId];
        if (block.timestamp < cutoff) {
            vm.warp(cutoff);
        }
        uint256 accepted = 0;
        try inbox.acceptedBallots(electionId) returns (uint256 n) {
            accepted = n;
        } catch {}
        uint256[] memory counts = new uint256[](1);
        counts[0] = accepted;
        address who = tallyOpOf[electionId];
        if (who == address(0)) who = tallyOperator;
        vm.prank(who);
        try tally.submitTally(electionId, counts, _a, _b, _c) {} catch {}
    }

    function _params(uint64 start, uint64 cutoff, uint8 depth, uint8 questions, uint32 cap)
        internal
        view
        returns (ElectionParams memory p)
    {
        p = Fixtures.build(
            "ZK-Voting invariant election",
            "ipfs://zk-voting-invariant",
            start,
            cutoff,
            cap,
            depth,
            clerk,
            registrar,
            officer,
            tallyOperator,
            address(verifier),
            questions,
            JURISDICTION
        );
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        uint256 n = trackedElectionIds.length;
        if (n == 0) return 0;
        return trackedElectionIds[_clamp(seed, 0, n - 1)];
    }

    function _clamp(uint256 x, uint256 min, uint256 max) internal pure returns (uint256) {
        if (min > max) (min, max) = (max, min);
        if (min == max) return min;
        return min + (x % (max - min + 1));
    }
}
