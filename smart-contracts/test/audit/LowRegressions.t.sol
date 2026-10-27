// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {BallotInbox} from "../../src/BallotInbox.sol";
import {Election} from "../../src/Election.sol";
import {ExternalPartyRegistry} from "../../src/ExternalPartyRegistry.sol";
import {JurisdictionRegistry} from "../../src/JurisdictionRegistry.sol";
import {PersonRegistry} from "../../src/PersonRegistry.sol";
import {Roles} from "../../src/Roles.sol";
import {VoterRegistry} from "../../src/VoterRegistry.sol";
import {ZkVotingMailbox} from "../../src/l2/ZkVotingMailbox.sol";
import {Deployer} from "../helpers/Deployer.sol";
import {Fixtures} from "../helpers/Fixtures.sol";
import {IBallotInbox} from "../../src/interfaces/IBallotInbox.sol";
import {IElection} from "../../src/interfaces/IElection.sol";
import {IExternalPartyRegistry} from "../../src/interfaces/IExternalPartyRegistry.sol";
import {IJurisdictionRegistry} from "../../src/interfaces/IJurisdictionRegistry.sol";
import {IPersonRegistry} from "../../src/interfaces/IPersonRegistry.sol";
import {IVoterRegistry} from "../../src/interfaces/IVoterRegistry.sol";

contract LowRegressionsTest is Deployer {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
    }

    // ------------------------------------------------------------------ L-01

    function testL01_ImplementationsAreLocked() public {
        Election impl = Election(factory.implementation());
        vm.expectRevert(IElection.AlreadyInitialized.selector);
        impl.initialize(1, defaultParams(), address(this), address(1), address(2), address(3));

        ExternalPartyRegistry pimpl = ExternalPartyRegistry(factory.partyRegistryImplementation());
        vm.expectRevert(IExternalPartyRegistry.AlreadyInitialized.selector);
        pimpl.initialize(1, address(this));

        // Clones still initialize exactly once through the factory.
        (uint256 id, address el) = createElection();
        assertEq(Election(el).electionId(), id);
    }

    // ------------------------------------------------------------------ L-02

    function testL02_FreezeRollEmits() public {
        (uint256 id, address el) = createElection();
        vm.expectEmit(true, true, false, true, el);
        emit IElection.RollFrozen(id, clerk);
        freezeRoll(el);
    }

    // ------------------------------------------------------------------ L-03

    function testL03_ExtraPublicInputsRejected() public {
        (uint256 id, address el) = prepareOpenElection(Fixtures.identityCommitment(uint256(1)));
        bytes memory enc = Fixtures.encryptedBallot(5);
        uint256[] memory five = voteInputs(id, el, 5, enc);
        uint256[] memory six = new uint256[](6);
        for (uint256 i; i < 5; ++i) six[i] = five[i];
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.InvalidPublicInputs.selector);
        inbox.submitVote(id, a, b, c, six, enc);
    }

    // ------------------------------------------------------------------ L-04

    function testL04_JurisdictionNoSilentOverwriteAndRoleRevoke() public {
        JurisdictionRegistry j = new JurisdictionRegistry(admin);
        bytes32 jid = keccak256("ward-9");
        vm.prank(admin);
        j.createJurisdiction(jid, clerk, "Ward 9");
        vm.prank(admin);
        vm.expectRevert(IJurisdictionRegistry.JurisdictionExists.selector);
        j.createJurisdiction(jid, makeAddr("hijack"), "Ward 9");
        assertEq(j.clerkOf(jid), clerk);

        address x = makeAddr("x");
        vm.prank(admin);
        j.grantRole(Roles.REGISTRAR_ROLE, x);
        assertTrue(j.roles(Roles.REGISTRAR_ROLE, x));
        vm.prank(admin);
        j.revokeRole(Roles.REGISTRAR_ROLE, x);
        assertFalse(j.roles(Roles.REGISTRAR_ROLE, x));
    }

    // ------------------------------------------------------------------ L-05

    function testL05_RegistrarRoleRevocable() public {
        address x = makeAddr("globalRegistrar");
        vm.prank(admin);
        voterRegistry.grantRole(Roles.REGISTRAR_ROLE, x);
        (uint256 id,) = createElection();
        vm.prank(x);
        voterRegistry.register(id, Fixtures.identityCommitment(uint256(11)));
        vm.prank(admin);
        voterRegistry.revokeRole(Roles.REGISTRAR_ROLE, x);
        vm.prank(x);
        vm.expectRevert(IVoterRegistry.NotRegistrar.selector);
        voterRegistry.register(id, Fixtures.identityCommitment(uint256(12)));

        PersonRegistry p = new PersonRegistry(admin);
        vm.prank(admin);
        p.grantRole(Roles.REGISTRAR_ROLE, x);
        vm.prank(admin);
        p.revokeRole(Roles.REGISTRAR_ROLE, x);
        vm.prank(x);
        vm.expectRevert(IPersonRegistry.NotRegistrar.selector);
        p.verifyAddress(keccak256("p"), makeAddr("acct"));
    }

    // ------------------------------------------------------------------ L-06

    function testL06_ExploitNullifierAliasRejected() public {
        (uint256 id, address el) = prepareOpenElection(Fixtures.identityCommitment(uint256(2)));
        uint256 n = 42;
        submitVote(id, el, n);
        assertTrue(inbox.nullifierUsed(id, n + R), "alias reported used");
        // Under an accept-all verifier, n + r used to be a second ballot.
        bytes memory enc = Fixtures.encryptedBallot(n + R);
        uint256[] memory inputs = voteInputs(id, el, n + R, enc);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.NullifierUsed.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
        assertEq(inbox.acceptedBallots(id), 1);
    }

    // ------------------------------------------------------------------ L-07

    function testL07_MailboxRefusesValue() public {
        ZkVotingMailbox m = new ZkVotingMailbox(admin);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(m).call{value: 1 ether}(abi.encodeCall(ZkVotingMailbox.sendToL2, (hex"01")));
        assertFalse(ok);
        assertEq(address(m).balance, 0);
    }

    // ------------------------------------------------------------------ L-08

    function testL08_FixedConstructorOrder() public {
        VoterRegistry v = new VoterRegistry(address(hasher), address(factory));
        assertEq(address(v.hasher()), address(hasher));
        assertEq(address(v.factory()), address(factory));
        // No more guessing: arguments are taken literally.
        VoterRegistry swapped = new VoterRegistry(address(factory), address(hasher));
        assertEq(address(swapped.hasher()), address(factory));
    }
}
