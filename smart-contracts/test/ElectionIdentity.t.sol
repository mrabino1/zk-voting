// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionFactory} from "../src/ElectionFactory.sol";
import {ElectionIdentity} from "../src/ElectionIdentity.sol";
import {ElectionParams} from "../src/interfaces/ElectionParams.sol";
import {IElection} from "../src/interfaces/IElection.sol";
import {JurisdictionRegistry} from "../src/JurisdictionRegistry.sol";
import {L1TallyMirror} from "../src/l2/L1TallyMirror.sol";
import {Roles} from "../src/Roles.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";
import {IElectionFactory} from "../src/interfaces/IElectionFactory.sol";
import {IL1TallyMirror} from "../src/interfaces/IL1TallyMirror.sol";

/// @notice UUID copies and forged factory ids must not share an L1 proof slot.
contract ElectionIdentitySeparationTest is Deployer {
    L1TallyMirror internal mirror;
    address internal publisherA;
    address internal publisherB;
    address internal attacker;

    bytes32 internal jurisdictionA;
    bytes32 internal jurisdictionB;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        publisherA = makeAddr("publisherA");
        publisherB = makeAddr("publisherB");
        attacker = makeAddr("attacker");
        jurisdictionA = Fixtures.DEFAULT_JURISDICTION;
        jurisdictionB = keccak256("zk-voting-foreign-jurisdiction");
        vm.prank(admin);
        jurisdictions.createJurisdiction(jurisdictionB, attacker, "Foreign");
        vm.prank(admin);
        mirror = new L1TallyMirror(admin, address(0));
    }

    function _countsHash(uint256 a, uint256 b) internal pure returns (bytes32) {
        uint256[] memory counts = new uint256[](2);
        counts[0] = a;
        counts[1] = b;
        return keccak256(abi.encode(counts));
    }

    function _cert(address factory_, uint256 electionId, bytes32 jurisdictionId, bytes32 publicIdHash, bytes32 resultHash)
        internal
        pure
        returns (IL1TallyMirror.Certification memory c)
    {
        c.factory = factory_;
        c.electionId = electionId;
        c.jurisdictionId = jurisdictionId;
        c.election = address(0);
        c.publicIdHash = publicIdHash;
        c.ballotSpecHash = bytes32(0);
        c.resultHash = resultHash;
        c.totalBallots = 2;
        c.l2StateRoot = bytes32(0);
    }

    function testFactoryRejectsZeroJurisdiction() public {
        ElectionParams memory p = defaultParams();
        p.jurisdictionId = bytes32(0);
        vm.prank(admin);
        vm.expectRevert(IElectionFactory.InvalidJurisdiction.selector);
        factory.createElection(p);
    }

    function testClerkOfACannotCreateForJurisdictionB() public {
        ElectionParams memory p = defaultParams();
        p.jurisdictionId = jurisdictionB;
        p.clerk = clerk;
        vm.prank(clerk);
        vm.expectRevert(IElectionFactory.NotJurisdictionClerk.selector);
        factory.createElection(p);
    }

    function testSelfDeclaredClerkCannotSpoofForeignJurisdiction() public {
        ElectionParams memory p = defaultParams();
        p.jurisdictionId = jurisdictionA;
        p.clerk = attacker;
        vm.prank(attacker);
        vm.expectRevert(IElectionFactory.NotJurisdictionClerk.selector);
        factory.createElection(p);
    }

    function testGlobalClerkRoleCannotSpoofForeignJurisdiction() public {
        vm.prank(admin);
        factory.grantRole(Roles.CLERK_ROLE, attacker);
        ElectionParams memory p = defaultParams();
        p.jurisdictionId = jurisdictionA;
        p.clerk = attacker;
        vm.prank(attacker);
        vm.expectRevert(IElectionFactory.NotJurisdictionClerk.selector);
        factory.createElection(p);
    }

    function testClerkOfJurisdictionCanCreate() public {
        uint256 before = factory.electionCount();
        ElectionParams memory p = defaultParams();
        vm.prank(clerk);
        (uint256 id, address el) = factory.createElection(p);
        assertEq(id, before + 1);
        assertEq(IElection(el).params().jurisdictionId, jurisdictionA);
    }

    /// @dev Audit M-02: without a registry, self-declared clerks no longer
    ///      create; an admin-granted CLERK_ROLE plus an approved verifier does.
    function testWithoutRegistrySelfDeclaredClerkNeedsRoleAndApprovedVerifier() public {
        ElectionFactory naked = new ElectionFactory(admin, address(0));
        vm.prank(admin);
        naked.setAllowMockVerifiers(true);
        ElectionParams memory p = defaultParams();
        vm.prank(p.clerk);
        vm.expectRevert(IElectionFactory.MissingRole.selector);
        naked.createElection(p);

        vm.prank(admin);
        naked.grantRole(Roles.CLERK_ROLE, p.clerk);
        vm.prank(p.clerk);
        vm.expectRevert(IElectionFactory.VerifierNotApproved.selector);
        naked.createElection(p);

        vm.prank(admin);
        naked.setVerifierApproved(p.verifier, true);
        vm.prank(p.clerk);
        (uint256 id, address el) = naked.createElection(p);
        assertEq(id, 1);
        assertTrue(el != address(0));
    }

    function testSameUint256OnTwoFactoriesAreDistinctL1Slots() public {
        ElectionFactory factoryB = new ElectionFactory(admin, address(0));
        vm.prank(admin);
        factoryB.setAllowMockVerifiers(true);
        ElectionParams memory p = defaultParams();
        vm.prank(admin);
        (uint256 idA,) = factory.createElection(p);
        vm.prank(admin);
        (uint256 idB,) = factoryB.createElection(p);
        assertEq(idA, 1);
        assertEq(idB, 1);

        bytes32 slotA = ElectionIdentity.certificationId(address(factory), idA, jurisdictionA);
        bytes32 slotB = ElectionIdentity.certificationId(address(factoryB), idB, jurisdictionA);
        assertTrue(slotA != slotB, "factory is part of the L1 key");

        bytes32 hashA = _countsHash(2, 0);
        bytes32 hashB = _countsHash(0, 2);
        vm.prank(admin);
        mirror.postCertifiedResult(_cert(address(factory), idA, jurisdictionA, bytes32(0), hashA));
        vm.prank(admin);
        mirror.postCertifiedResult(_cert(address(factoryB), idB, jurisdictionA, bytes32(0), hashB));
        assertEq(mirror.resultHashOfIdentity(slotA), hashA);
        assertEq(mirror.resultHashOfIdentity(slotB), hashB);
    }

    function testCopiedPublicIdDoesNotTakeHonestSlot() public {
        (uint256 idA,) = createElection();
        ElectionParams memory p = defaultParams();
        p.jurisdictionId = jurisdictionB;
        p.clerk = attacker;
        vm.prank(admin);
        (uint256 idB,) = factory.createElection(p);

        bytes32 stolenUuidHash = ElectionIdentity.publicIdHash("3f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01");
        bytes32 honestHash = _countsHash(2, 0);
        bytes32 fakeHash = _countsHash(9, 9);

        vm.prank(admin);
        mirror.postCertifiedResult(_cert(address(factory), idA, jurisdictionA, stolenUuidHash, honestHash));
        vm.prank(admin);
        mirror.postCertifiedResult(_cert(address(factory), idB, jurisdictionB, stolenUuidHash, fakeHash));

        bytes32 slotA = ElectionIdentity.certificationId(address(factory), idA, jurisdictionA);
        bytes32 slotB = ElectionIdentity.certificationId(address(factory), idB, jurisdictionB);
        assertTrue(slotA != slotB);
        assertEq(mirror.resultHashOfIdentity(slotA), honestHash);
        assertEq(mirror.resultHashOfIdentity(slotB), fakeHash);
        assertTrue(mirror.publicIdCollision(stolenUuidHash));
        assertEq(mirror.certificationsOfPublicId(stolenUuidHash).length, 2);
    }

    function testPinnedFactoryRejectsRogueFactory() public {
        vm.prank(admin);
        mirror.setL2Factory(address(factory));
        IL1TallyMirror.Certification memory c =
            _cert(address(0xB0B), 1, jurisdictionA, bytes32(0), _countsHash(1, 0));
        vm.prank(admin);
        vm.expectRevert(IL1TallyMirror.WrongFactory.selector);
        mirror.postCertifiedResult(c);
    }

    function testPinnedFactoryRejectsLegacyUint256Post() public {
        vm.prank(admin);
        mirror.setL2Factory(address(factory));
        vm.prank(admin);
        vm.expectRevert(IL1TallyMirror.UseIdentityPost.selector);
        mirror.postResult(1, _countsHash(1, 0), 1, bytes32(0));
    }

    function testPinnedFactoryCannotBeUnpinnedOrReplaced() public {
        vm.prank(admin);
        mirror.setL2Factory(address(factory));
        vm.prank(admin);
        mirror.setL2Factory(address(factory));
        vm.prank(admin);
        vm.expectRevert(IL1TallyMirror.ZeroAddress.selector);
        mirror.setL2Factory(address(0));
        vm.prank(admin);
        vm.expectRevert(IL1TallyMirror.FactoryAlreadyPinned.selector);
        mirror.setL2Factory(address(0xB0B));
        assertEq(mirror.l2Factory(), address(factory));
    }

    function testPinnedFactoryRejectsGlobalPublisher() public {
        (uint256 idA,) = createElection();
        vm.prank(admin);
        mirror.setL2Factory(address(factory));
        vm.prank(admin);
        mirror.setPublisher(publisherA, true);
        vm.prank(publisherA);
        vm.expectRevert(IL1TallyMirror.NotAuthorized.selector);
        mirror.postCertifiedResult(_cert(address(factory), idA, jurisdictionA, bytes32(0), _countsHash(1, 0)));
    }

    function testOfficerCannotCreateElection() public {
        vm.prank(admin);
        jurisdictions.grantOfficer(jurisdictionA, attacker);
        ElectionParams memory p = defaultParams();
        p.clerk = attacker;
        vm.prank(attacker);
        vm.expectRevert(IElectionFactory.NotJurisdictionClerk.selector);
        factory.createElection(p);
    }

    function testRotatedClerkLosesCreateRights() public {
        address successor = makeAddr("successor");
        vm.prank(admin);
        jurisdictions.setClerk(jurisdictionA, successor);
        ElectionParams memory p = defaultParams();
        p.clerk = clerk;
        vm.prank(clerk);
        vm.expectRevert(IElectionFactory.NotJurisdictionClerk.selector);
        factory.createElection(p);
        p.clerk = successor;
        vm.prank(successor);
        (uint256 id,) = factory.createElection(p);
        assertTrue(id > 0);
    }

    function testJurisdictionPublisherCannotCertifyForeignElection() public {
        vm.prank(admin);
        mirror.setJurisdictionPublisher(jurisdictionA, publisherA, true);
        // No code at the factory: L1 cannot read Election.params, so publisher ACL is the defense.
        address rogueFactory = address(uint160(uint256(keccak256("rogue-factory"))));
        IL1TallyMirror.Certification memory foreign =
            _cert(rogueFactory, 1, jurisdictionB, bytes32(0), _countsHash(1, 0));
        vm.prank(publisherA);
        vm.expectRevert(IL1TallyMirror.NotAuthorized.selector);
        mirror.postCertifiedResult(foreign);
    }

    function testJurisdictionPublisherCanCertifyOwnElection() public {
        (uint256 idA,) = createElection();
        bytes32 hash = _countsHash(2, 0);
        vm.prank(admin);
        mirror.setJurisdictionPublisher(jurisdictionA, publisherA, true);
        vm.prank(publisherA);
        mirror.postCertifiedResult(_cert(address(factory), idA, jurisdictionA, bytes32(0), hash));
        bytes32 slot = ElectionIdentity.certificationId(address(factory), idA, jurisdictionA);
        assertEq(mirror.resultHashOfIdentity(slot), hash);
    }

    function testOnChainVerifyRejectsJurisdictionSpoofWhenFactoryIsReadable() public {
        (uint256 idA,) = createElection();
        bytes32 hash = _countsHash(2, 0);
        IL1TallyMirror.Certification memory spoof =
            _cert(address(factory), idA, jurisdictionB, bytes32(0), hash);
        vm.prank(admin);
        vm.expectRevert(IL1TallyMirror.JurisdictionMismatch.selector);
        mirror.postCertifiedResult(spoof);
    }

    function testTallyOperatorCanPostWhenFactoryIsReadable() public {
        (uint256 idA,) = createElection();
        bytes32 hash = _countsHash(2, 0);
        vm.prank(tallyOperator);
        mirror.postCertifiedResult(_cert(address(factory), idA, jurisdictionA, bytes32(0), hash));
        bytes32 slot = ElectionIdentity.certificationId(address(factory), idA, jurisdictionA);
        assertEq(mirror.resultHashOfIdentity(slot), hash);
    }

    function testAlreadyPostedIsPerIdentityNotBareUint256() public {
        (uint256 idA,) = createElection();
        bytes32 hash = _countsHash(2, 0);
        vm.prank(admin);
        mirror.postCertifiedResult(_cert(address(factory), idA, jurisdictionA, bytes32(0), hash));
        vm.prank(admin);
        vm.expectRevert(IL1TallyMirror.AlreadyPosted.selector);
        mirror.postCertifiedResult(_cert(address(factory), idA, jurisdictionA, bytes32(0), _countsHash(0, 2)));
    }

    function testPublicIdHashIsKeccakOfLowercasedUuidString() public pure {
        assertEq(
            ElectionIdentity.publicIdHash("3F1C0A6E-9B2D-4E11-8C7A-1A2B3C4D5E01"),
            keccak256(bytes("3f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01"))
        );
    }

    function testCertificationIdDomainMatchesLiteral() public pure {
        assertEq(ElectionIdentity.DOMAIN, keccak256("zk-voting.election.identity.v1"));
        address fac = address(0x1111111111111111111111111111111111111111);
        bytes32 got = ElectionIdentity.certificationId(fac, 7, keccak256("demo"));
        assertEq(got, keccak256(abi.encode(ElectionIdentity.DOMAIN, fac, uint256(7), keccak256("demo"))));
    }
}

/// @notice Keep the original uint256 postResult behaviour for explorers / scripts.
contract L1TallyMirrorLegacyCompatTest is Deployer {
    L1TallyMirror internal mirror;

    function setUp() public {
        admin = makeAddr("admin");
        vm.prank(admin);
        mirror = new L1TallyMirror(admin, address(0));
    }

    function testLegacyPostResultStillWritesUint256Slot() public {
        bytes32 hash = keccak256(abi.encodePacked(uint256(2), uint256(0)));
        vm.prank(admin);
        mirror.postResult(1, hash, 2, bytes32(0));
        assertEq(mirror.resultHashOf(1), hash);
        assertEq(mirror.totalBallotsOf(1), 2);
    }
}
