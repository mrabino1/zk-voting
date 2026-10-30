// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IBallotInbox} from "../src/interfaces/IBallotInbox.sol";
import {IElection} from "../src/interfaces/IElection.sol";
import {IElectionFactory} from "../src/interfaces/IElectionFactory.sol";
import {IL1TallyMirror} from "../src/interfaces/IL1TallyMirror.sol";
import {ElectionParams, ElectionType, TallyScheme} from "../src/interfaces/ElectionParams.sol";
import {ITallyVerifier} from "../src/interfaces/ITallyVerifier.sol";
import {L1TallyMirror} from "../src/l2/L1TallyMirror.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice POLL keeps interim publication. VOTE stays sealed until cutoff.
///         Neither kind accepts a ballot or a tally component after close.
contract ElectionTypeTest is Deployer {
    uint256[2] internal a;
    uint256[2][2] internal b;
    uint256[2] internal c;
    L1TallyMirror internal mirror;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        (a, b, c) = Fixtures.dummyProof();
        mirror = new L1TallyMirror(admin, address(0));
    }

    function testDefaultElectionIsPollAndGetterMatchesParams() public {
        (uint256 id, address el) = createElection();
        assertEq(factory.electionType(id), ElectionType.POLL);
        assertEq(IElection(el).electionType(), ElectionType.POLL);
        assertEq(IElection(el).params().electionType, ElectionType.POLL);
        assertEq(factory.electionType.selector, bytes4(keccak256("electionType(uint256)")));
        assertEq(IElection(el).electionType.selector, bytes4(keccak256("electionType()")));
    }

    function testUnknownElectionTypeReverts() public {
        vm.expectRevert(IElectionFactory.UnknownElection.selector);
        factory.electionType(0);
    }

    function testInvalidElectionTypeReverts() public {
        ElectionParams memory p = defaultParams();
        p.electionType = 2;
        uint256 before = factory.electionCount();
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.InvalidElectionType.selector);
        factory.createElection(p);
        assertEq(factory.electionCount(), before);
    }

    function testElectionTypeIsImmutable() public {
        (uint256 id, address el) = _create(ElectionType.VOTE);
        _assertType(id, el, ElectionType.VOTE);

        bytes4[4] memory setters = [
            bytes4(keccak256("setElectionType(uint8)")),
            bytes4(keccak256("setElectionType(uint256,uint8)")),
            bytes4(keccak256("setType(uint256,uint8)")),
            bytes4(keccak256("updateElectionType(uint256,uint8)"))
        ];
        for (uint256 i; i < setters.length; ++i) {
            (bool onClone,) = el.call(abi.encodeWithSelector(setters[i], ElectionType.POLL));
            (bool onFactory,) = address(factory).call(abi.encodeWithSelector(setters[i], id, ElectionType.POLL));
            assertFalse(onClone, "clone setter");
            assertFalse(onFactory, "factory setter");
        }

        ElectionParams memory p = IElection(el).params();
        vm.prank(address(factory));
        vm.expectRevert(IElection.AlreadyInitialized.selector);
        IElection(el)
            .initialize(id, p, address(factory), address(voterRegistry), address(disqualification), address(inbox));

        _openAndVote(id, el);
        warpClosed(el);
        _postFinal(id, keccak256("sealed-plain"));
        _assertType(id, el, ElectionType.VOTE);
        assertEq(IElection(el).params().tallyScheme, TallyScheme.SUM_ONLY);
    }

    function testPollAllowsInterimAndKeepsTallyUntilClose() public {
        (uint256 id, address el) = _create(ElectionType.POLL);
        bytes32 interim = keccak256("poll-interim");
        bytes32 disclosure = keccak256("poll-disclosure");
        bytes32 component = keccak256("poll-component");

        vm.startPrank(tallyOperator);
        tally.postInterimResult(id, interim);
        tally.disclose(id, disclosure);
        tally.addTallyComponent(id, component);
        vm.stopPrank();
        assertEq(tally.interimResult(id), interim);
        assertEq(tally.disclosureHash(id), disclosure);
        assertEq(tally.tallyComponentCount(id), 1);
        assertEq(tally.tallyComponentAt(id, 0), component);

        uint256[] memory counts = new uint256[](1);
        counts[0] = 0;
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.ElectionNotClosed.selector);
        tally.submitTally(id, counts, a, b, c);
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.ElectionNotClosed.selector);
        tally.submitDecryption(id, keccak256("early-plain"));

        _certify(el, id, keccak256("poll-result"));
        assertEq(mirror.resultHashOfIdentity(_certId(id, el)), keccak256("poll-result"));
    }

    function testVoteSealsResultsUntilEndThenAllowsThem() public {
        (uint256 id, address el) = _create(ElectionType.VOTE);
        _openAndVote(id, el);

        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.startPrank(tallyOperator);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.ResultsSealedUntilEnd.selector, id));
        tally.submitTally(id, counts, a, b, c);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.ResultsSealedUntilEnd.selector, id));
        tally.submitAggregateTally(id, counts, keccak256("agg"), a, b, c);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.ResultsSealedUntilEnd.selector, id));
        tally.submitDecryption(id, keccak256("plain"));
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.ResultsSealedUntilEnd.selector, id));
        tally.postInterimResult(id, keccak256("interim"));
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.ResultsSealedUntilEnd.selector, id));
        tally.disclose(id, keccak256("disclosure"));
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.ResultsSealedUntilEnd.selector, id));
        tally.addTallyComponent(id, keccak256("component"));
        vm.stopPrank();

        _expectSealedCertify(el, id);
        assertFalse(tally.isTallied(id));
        assertEq(tally.decryptionHash(id), bytes32(0));
        assertEq(tally.interimResult(id), bytes32(0));
        assertEq(tally.disclosureHash(id), bytes32(0));

        warpClosed(el);
        bytes32 plain = keccak256("aggregate-plain");
        bytes32 interim = keccak256("after-interim");
        bytes32 disclosure = keccak256("after-disclosure");
        vm.startPrank(tallyOperator);
        tally.submitTally(id, counts, a, b, c);
        tally.submitDecryption(id, plain);
        tally.postInterimResult(id, interim);
        tally.disclose(id, disclosure);
        vm.stopPrank();
        assertTrue(tally.isTallied(id));
        assertEq(tally.tally(id)[0], 1);
        assertEq(tally.decryptionHash(id), plain);
        assertEq(tally.interimResult(id), interim);
        assertEq(tally.disclosureHash(id), disclosure);
        assertEq(tally.postedScheme(id), TallyScheme.SUM_ONLY);

        _certify(el, id, keccak256("final-l1"));
        assertEq(mirror.resultHashOfIdentity(_certId(id, el)), keccak256("final-l1"));

        (bool opened,) = address(tally)
            .call(
                abi.encodeWithSignature(
                    "submitOpenedTally(uint256,uint256[],uint256[],uint256[2],uint256[2][2],uint256[2])",
                    id,
                    counts,
                    counts,
                    a,
                    b,
                    c
                )
            );
        assertFalse(opened, "per-ballot openings stay unavailable");
        assertEq(
            IBallotInbox.submitVote.selector,
            bytes4(keccak256("submitVote(uint256,uint256[2],uint256[2][2],uint256[2],uint256[],bytes)"))
        );
        assertEq(ITallyVerifier.submitDecryption.selector, bytes4(keccak256("submitDecryption(uint256,bytes32)")));
    }

    function testPollInterimUpdatesBeforeCutoffAndFreezesAfterClose() public {
        (uint256 id, address el) = _create(ElectionType.POLL);
        _replaceBeforeClose(id);
        vm.prank(tallyOperator);
        tally.addTallyComponent(id, keccak256("while-open"));
        warpClosed(el);
        _expectFinalBeforeTally(id);
        assertEq(tally.interimResult(id), keccak256("interim-2"));
        assertEq(tally.disclosureHash(id), keccak256("disc-2"));

        uint256[] memory counts = new uint256[](1);
        counts[0] = 0;
        vm.prank(tallyOperator);
        tally.submitTally(id, counts, a, b, c);

        bytes32 finalInterim = keccak256("final-interim");
        bytes32 finalDisc = keccak256("final-disc");
        vm.startPrank(tallyOperator);
        tally.postInterimResult(id, finalInterim);
        tally.disclose(id, finalDisc);
        vm.stopPrank();
        assertEq(tally.interimResult(id), finalInterim);
        assertEq(tally.disclosureHash(id), finalDisc);

        _expectReplaceReverts(id);
        vm.prank(tallyOperator);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.TallyComponentsClosed.selector, id));
        tally.addTallyComponent(id, keccak256("after-close"));
        assertEq(tally.tallyComponentCount(id), 1);
        _expectDecryptOnceAfterTally(id);
        _expectSecondTallyReverts(id);
    }

    function testFinalHashBeforeTallyReverts() public {
        (uint256 id, address el) = _create(ElectionType.POLL);
        (uint256 vid, address vel) = _create(ElectionType.VOTE);
        _openAndVote(vid, vel);
        warpClosed(el);
        _expectFinalBeforeTally(id);
        _expectFinalBeforeTally(vid);
        assertEq(tally.interimResult(id), bytes32(0));
        assertEq(tally.disclosureHash(id), bytes32(0));
        assertEq(tally.interimResult(vid), bytes32(0));
        assertFalse(tally.isTallied(vid));
    }

    function _expectFinalBeforeTally(uint256 id) internal {
        vm.startPrank(tallyOperator);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.FinalBeforeTally.selector, id));
        tally.postInterimResult(id, keccak256("final-too-soon"));
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.FinalBeforeTally.selector, id));
        tally.disclose(id, keccak256("disc-too-soon"));
        vm.stopPrank();
    }

    function _expectDecryptOnceAfterTally(uint256 id) internal {
        vm.startPrank(tallyOperator);
        tally.submitDecryption(id, keccak256("plain"));
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.ResultAlreadyFinal.selector, id));
        tally.submitDecryption(id, keccak256("plain-2"));
        vm.stopPrank();
        assertEq(tally.decryptionHash(id), keccak256("plain"));
    }

    function _expectSecondTallyReverts(uint256 id) internal {
        uint256[] memory again = new uint256[](1);
        again[0] = 0;
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.AlreadyTallied.selector);
        tally.submitTally(id, again, a, b, c);
    }

    function testVoteResultHashesAreWriteOnceAfterClose() public {
        (uint256 id, address el) = _create(ElectionType.VOTE);
        _openAndVote(id, el);
        warpClosed(el);
        _expectDecryptBeforeTallyReverts(id);
        _postFinal(id, keccak256("plain"));
        _expectReplaceReverts(id);
        assertEq(tally.decryptionHash(id), keccak256("plain"));
    }

    function testTallyComponentAtOutOfRangeReverts() public {
        (uint256 id,) = _create(ElectionType.POLL);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.TallyComponentOutOfRange.selector, uint256(0)));
        tally.tallyComponentAt(id, 0);
    }

    function testPollRejectsVotesAndComponentsAfterClose() public {
        _assertClosedToNewInputs(ElectionType.POLL);
    }

    function testVoteRejectsVotesAndComponentsAfterClose() public {
        _assertClosedToNewInputs(ElectionType.VOTE);
    }

    function _assertClosedToNewInputs(uint8 kind) internal {
        (uint256 id, address el) = _create(kind);
        uint256 commitment = Fixtures.identityCommitment(uint256(kind) + 7);
        registerVoter(id, commitment);
        freezeRoll(el);
        warpOpen(el);
        uint256 cast = uint256(keccak256(abi.encodePacked("during", kind)));
        submitVote(id, el, cast);

        if (kind == ElectionType.POLL) {
            vm.prank(tallyOperator);
            tally.addTallyComponent(id, keccak256("while-open"));
            assertEq(tally.tallyComponentCount(id), 1);
        }

        warpClosed(el);
        _expectVoteClosed(id, el, uint256(keccak256(abi.encodePacked("after", kind))));
        _expectBatchClosed(id, el, uint256(keccak256(abi.encodePacked("batch-after", kind))));
        assertEq(inbox.acceptedBallots(id), 1);

        vm.prank(tallyOperator);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.TallyComponentsClosed.selector, id));
        tally.addTallyComponent(id, keccak256("after-close"));
        uint256 expectedComponents = kind == ElectionType.POLL ? 1 : 0;
        assertEq(tally.tallyComponentCount(id), expectedComponents);
    }

    function _create(uint8 kind) internal returns (uint256 id, address el) {
        (id, el) = createElection(Fixtures.withElectionType(defaultParams(), kind));
        assertEq(factory.electionType(id), kind);
    }

    function _assertType(uint256 id, address el, uint8 kind) internal view {
        assertEq(factory.electionType(id), kind);
        assertEq(IElection(el).electionType(), kind);
        assertEq(IElection(el).params().electionType, kind);
    }

    function _openAndVote(uint256 id, address el) internal {
        registerVoter(id, Fixtures.identityCommitment(uint256(42)));
        freezeRoll(el);
        warpOpen(el);
        submitVote(id, el, uint256(keccak256("vote-nullifier")));
    }

    function _postFinal(uint256 id, bytes32 plain) internal {
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.startPrank(tallyOperator);
        tally.submitTally(id, counts, a, b, c);
        tally.submitDecryption(id, plain);
        tally.postInterimResult(id, keccak256("late-interim"));
        tally.disclose(id, keccak256("late-disclosure"));
        vm.stopPrank();
    }

    function _replaceBeforeClose(uint256 id) internal {
        vm.startPrank(tallyOperator);
        tally.postInterimResult(id, keccak256("interim-1"));
        tally.postInterimResult(id, keccak256("interim-2"));
        tally.disclose(id, keccak256("disc-1"));
        tally.disclose(id, keccak256("disc-2"));
        vm.stopPrank();
        assertEq(tally.interimResult(id), keccak256("interim-2"));
        assertEq(tally.disclosureHash(id), keccak256("disc-2"));
    }

    function _expectDecryptBeforeTallyReverts(uint256 id) internal {
        vm.prank(tallyOperator);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.DecryptionBeforeTally.selector, id));
        tally.submitDecryption(id, keccak256("plain-early"));
    }

    function _expectReplaceReverts(uint256 id) internal {
        bytes32 interim = tally.interimResult(id);
        bytes32 disclosed = tally.disclosureHash(id);
        bytes32 plain = tally.decryptionHash(id);
        vm.startPrank(tallyOperator);
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.ResultAlreadyFinal.selector, id));
        tally.postInterimResult(id, keccak256("interim-again"));
        vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.ResultAlreadyFinal.selector, id));
        tally.disclose(id, keccak256("disc-again"));
        if (plain != bytes32(0)) {
            vm.expectRevert(abi.encodeWithSelector(ITallyVerifier.ResultAlreadyFinal.selector, id));
            tally.submitDecryption(id, keccak256("plain-again"));
        }
        vm.stopPrank();
        assertEq(tally.interimResult(id), interim);
        assertEq(tally.disclosureHash(id), disclosed);
        assertEq(tally.decryptionHash(id), plain);
    }

    function _expectVoteClosed(uint256 id, address el, uint256 nullifier) internal {
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        (uint256[2] memory pa, uint256[2][2] memory pb, uint256[2] memory pc) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(id, el, nullifier, enc);
        assertEq(inputs.length, 5);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.OutsideVotingWindow.selector);
        inbox.submitVote(id, pa, pb, pc, inputs, enc);
    }

    function _expectBatchClosed(uint256 id, address el, uint256 nullifier) internal {
        uint256[2][] memory proofA = new uint256[2][](1);
        uint256[2][2][] memory proofB = new uint256[2][2][](1);
        uint256[2][] memory proofC = new uint256[2][](1);
        (proofA[0], proofB[0], proofC[0]) = Fixtures.dummyProof();
        bytes[] memory ballots = new bytes[](1);
        ballots[0] = Fixtures.encryptedBallot(nullifier);
        uint256[][] memory inputs = new uint256[][](1);
        inputs[0] = voteInputs(id, el, nullifier, ballots[0]);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.OutsideVotingWindow.selector);
        inbox.submitVoteBatch(id, proofA, proofB, proofC, inputs, ballots);
    }

    function _cert(address el, uint256 id, bytes32 resultHash)
        internal
        view
        returns (IL1TallyMirror.Certification memory cert)
    {
        cert.factory = address(factory);
        cert.electionId = id;
        cert.jurisdictionId = IElection(el).params().jurisdictionId;
        cert.resultHash = resultHash;
        cert.totalBallots = 1;
    }

    function _certify(address el, uint256 id, bytes32 resultHash) internal {
        IL1TallyMirror.Certification memory cert = _cert(el, id, resultHash);
        vm.prank(admin);
        mirror.postCertifiedResult(cert);
    }

    function _expectSealedCertify(address el, uint256 id) internal {
        IL1TallyMirror.Certification memory cert = _cert(el, id, keccak256("early-l1"));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IL1TallyMirror.ResultsSealedUntilEnd.selector, id));
        mirror.postCertifiedResult(cert);
    }

    function _certId(uint256 id, address el) internal view returns (bytes32) {
        return mirror.certificationIdOf(address(factory), id, IElection(el).params().jurisdictionId);
    }
}
