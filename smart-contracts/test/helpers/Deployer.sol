// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";

import {ElectionParams} from "../../src/interfaces/ElectionParams.sol";
import {IElection} from "../../src/interfaces/IElection.sol";
import {Roles} from "../../src/Roles.sol";

import {KeccakHasher} from "../../src/hasher/KeccakHasher.sol";
import {MockVerifier} from "../../src/zk/MockVerifier.sol";
import {Election} from "../../src/Election.sol";
import {ElectionFactory} from "../../src/ElectionFactory.sol";
import {JurisdictionRegistry} from "../../src/JurisdictionRegistry.sol";
import {VoterRegistry} from "../../src/VoterRegistry.sol";
import {DisqualificationRegistry} from "../../src/DisqualificationRegistry.sol";
import {BallotInbox} from "../../src/BallotInbox.sol";
import {Tally} from "../../src/Tally.sol";
import {RollupSettlement} from "../../src/l2/RollupSettlement.sol";
import {PasskeyAccount} from "../../src/account/PasskeyAccount.sol";
import {PasskeyAccountFactory} from "../../src/account/PasskeyAccountFactory.sol";
import {RepublicEntryPoint, UserOp} from "../../src/account/RepublicEntryPoint.sol";
import {RepublicPaymaster} from "../../src/account/RepublicPaymaster.sol";

import {Fixtures} from "./Fixtures.sol";

/// @title Deployer
/// @notice Best-effort full-stack deploy for Republic Foundry tests.
/// @dev Preferred factory constructor: `new ElectionFactory(admin, address(0))`
///      (factory deploys the Election implementation). Modules are wired with
///      `setModules` when that function exists. Other constructors are tried
///      via CREATE + appended ABI args so slight signature drift still deploys.
contract Deployer is Test {
    event ElectionCreated(
        uint256 indexed electionId, address indexed election, bytes32 indexed jurisdictionId, uint64 startTime, uint64 cutoffTime
    );
    event VoterRegistered(uint256 indexed electionId, uint256 indexed identityCommitment, uint256 leafIndex);
    event Disqualified(
        uint256 indexed electionId, uint256 indexed identityCommitment, uint16 reasonCode, bytes32 evidenceHash
    );
    event DisqualificationRevoked(uint256 indexed electionId, uint256 indexed identityCommitment, bytes32 evidenceHash);
    event VoteAccepted(uint256 indexed electionId, uint256 indexed nullifier, bytes32 ballotHash, address relayer);

    KeccakHasher internal hasher;
    MockVerifier internal verifier;
    Election internal electionImpl;
    ElectionFactory internal factory;
    JurisdictionRegistry internal jurisdictions;
    VoterRegistry internal voterRegistry;
    DisqualificationRegistry internal disqualification;
    BallotInbox internal inbox;
    Tally internal tally;
    RollupSettlement internal settlement;
    PasskeyAccountFactory internal accountFactory;
    RepublicEntryPoint internal entryPoint;
    RepublicPaymaster internal paymaster;

    address internal admin;
    address internal clerk;
    address internal registrar;
    address internal officer;
    address internal tallyOperator;
    address internal relayer;
    address internal sequencer;
    address internal prover;

    function deployStack() internal {
        admin = makeAddr("admin");
        clerk = makeAddr("clerk");
        registrar = makeAddr("registrar");
        officer = makeAddr("officer");
        tallyOperator = makeAddr("tallyOperator");
        relayer = makeAddr("relayer");
        sequencer = makeAddr("sequencer");
        prover = makeAddr("prover");

        vm.deal(admin, 1_000 ether);
        vm.deal(clerk, 10 ether);
        vm.deal(registrar, 10 ether);
        vm.deal(relayer, 50 ether);
        vm.deal(address(this), 1_000 ether);

        hasher = new KeccakHasher();
        verifier = new MockVerifier();
        _forceAcceptAll();

        electionImpl = new Election();

        // Preferred: `new ElectionFactory(admin, address(0))` — factory deploys implementation.
        // Deploy scripts also use `new ElectionFactory(admin)`. CREATE tries both.
        {
            address addr = _deploy(type(ElectionFactory).creationCode, abi.encode(admin, address(0)));
            if (addr == address(0)) {
                addr = _deploy(type(ElectionFactory).creationCode, abi.encode(admin, address(electionImpl)));
            }
            if (addr == address(0)) {
                addr = _deploy(type(ElectionFactory).creationCode, abi.encode(admin));
            }
            require(addr != address(0), "ElectionFactory deploy");
            factory = ElectionFactory(addr);
        }

        vm.prank(admin);
        jurisdictions = new JurisdictionRegistry(admin);

        _tryAdmin(address(factory), abi.encodeWithSignature("setImplementation(address)", address(electionImpl)));
        _tryAdmin(address(factory), abi.encodeWithSignature("initialize(address)", admin));

        // Hasher first, then factory (matches DisqualificationRegistry / DeployLocal).
        voterRegistry = new VoterRegistry(address(hasher), address(factory));
        disqualification = new DisqualificationRegistry(address(hasher), address(factory));
        inbox = new BallotInbox(address(factory));
        tally = new Tally(address(factory));
        // Audit H-01: tally proofs use a dedicated verifier (here the same dev mock).
        vm.prank(admin);
        tally.setTallyProofVerifier(address(verifier));

        // mockMode=true for local tests. batchVerifier may be the MockVerifier.
        {
            address addr = _deploy(
                type(RollupSettlement).creationCode, abi.encode(admin, sequencer, prover, address(verifier), true)
            );
            if (addr == address(0)) {
                addr = _deploy(
                    type(RollupSettlement).creationCode, abi.encode(admin, sequencer, prover, address(verifier), false)
                );
            }
            if (addr == address(0)) {
                addr = _deploy(type(RollupSettlement).creationCode, abi.encode(admin, sequencer, prover, address(verifier)));
            }
            if (addr == address(0)) {
                addr = _deploy(type(RollupSettlement).creationCode, abi.encode(admin));
            }
            require(addr != address(0), "RollupSettlement deploy");
            settlement = RollupSettlement(addr);
        }

        entryPoint = new RepublicEntryPoint();
        accountFactory = new PasskeyAccountFactory(address(entryPoint));
        paymaster = new RepublicPaymaster(address(entryPoint), admin);

        vm.prank(admin);
        paymaster.setAlwaysSponsor(true);
        vm.prank(admin);
        paymaster.setSponsoredTargets(address(inbox), address(voterRegistry), address(accountFactory));
        vm.deal(address(paymaster), 100 ether);
        paymaster.deposit{value: 10 ether}();

        _wireModules();
        _bindJurisdictions();
        _grantEverywhere();
        _label();

        require(address(factory) != address(0) && address(factory).code.length > 0, "factory");
        require(address(voterRegistry) != address(0), "voterRegistry");
        require(address(disqualification) != address(0), "disqualification");
        require(address(inbox) != address(0), "inbox");
        require(address(tally) != address(0), "tally");
        require(address(settlement) != address(0), "settlement");
        require(address(paymaster) != address(0), "paymaster");
    }

    function _wireModules() internal {
        // Deploy scripts: factory.wireModules(...). Tests also try setModules.
        _tryAdmin(
            address(factory),
            abi.encodeWithSignature(
                "wireModules(address,address,address,address)",
                address(voterRegistry),
                address(disqualification),
                address(inbox),
                address(tally)
            )
        );
        _tryCall(
            address(factory),
            abi.encodeWithSignature(
                "wireModules(address,address,address,address)",
                address(voterRegistry),
                address(disqualification),
                address(inbox),
                address(tally)
            )
        );
        _tryAdmin(
            address(factory),
            abi.encodeWithSignature(
                "setModules(address,address,address,address)",
                address(voterRegistry),
                address(disqualification),
                address(inbox),
                address(tally)
            )
        );
        _tryAdmin(
            address(factory),
            abi.encodeWithSignature(
                "setModules(address,address,address,address,address)",
                address(voterRegistry),
                address(disqualification),
                address(inbox),
                address(tally),
                address(hasher)
            )
        );
        _tryAdmin(address(factory), abi.encodeWithSignature("setHasher(address)", address(hasher)));
        _tryAdmin(address(factory), abi.encodeWithSignature("setVerifier(address)", address(verifier)));
        _tryAdmin(address(factory), abi.encodeWithSignature("setVoterRegistry(address)", address(voterRegistry)));
        _tryAdmin(address(factory), abi.encodeWithSignature("setDisqualificationRegistry(address)", address(disqualification)));
        _tryAdmin(address(factory), abi.encodeWithSignature("setInbox(address)", address(inbox)));
        _tryAdmin(address(factory), abi.encodeWithSignature("setBallotInbox(address)", address(inbox)));
        _tryAdmin(address(factory), abi.encodeWithSignature("setTally(address)", address(tally)));
        _tryAdmin(address(factory), abi.encodeWithSignature("setTallyVerifier(address)", address(tally)));
        _tryAdmin(address(factory), abi.encodeWithSignature("setJurisdictionRegistry(address)", address(jurisdictions)));

        address[5] memory mods =
            [address(voterRegistry), address(disqualification), address(inbox), address(tally), address(settlement)];
        for (uint256 i; i < mods.length; ++i) {
            _tryAdmin(mods[i], abi.encodeWithSignature("setFactory(address)", address(factory)));
            _tryAdmin(mods[i], abi.encodeWithSignature("setElectionFactory(address)", address(factory)));
            _tryAdmin(mods[i], abi.encodeWithSignature("setHasher(address)", address(hasher)));
            _tryAdmin(mods[i], abi.encodeWithSignature("setVerifier(address)", address(verifier)));
            _tryAdmin(mods[i], abi.encodeWithSignature("setInbox(address)", address(inbox)));
        }
        _tryAdmin(
            address(factory), abi.encodeWithSignature("setJurisdictionRegistry(address)", address(jurisdictions))
        );
        _tryAdmin(address(inbox), abi.encodeWithSignature("setVoterRegistry(address)", address(voterRegistry)));
        _tryAdmin(address(inbox), abi.encodeWithSignature("setDisqualificationRegistry(address)", address(disqualification)));
    }

    function _bindJurisdictions() internal {
        if (address(jurisdictions) == address(0)) return;
        _tryAdmin(address(factory), abi.encodeWithSignature("setJurisdictionRegistry(address)", address(jurisdictions)));
        vm.prank(admin);
        jurisdictions.createJurisdiction(Fixtures.DEFAULT_JURISDICTION, clerk, "Test jurisdiction");
        vm.label(address(jurisdictions), "JurisdictionRegistry");
    }

    function _grantEverywhere() internal {
        address[6] memory targets = [
            address(factory),
            address(voterRegistry),
            address(disqualification),
            address(inbox),
            address(tally),
            address(settlement)
        ];
        for (uint256 i; i < targets.length; ++i) {
            _grant(targets[i], bytes32(0), admin);
            _grant(targets[i], bytes32(0), address(this));
            _grant(targets[i], Roles.PLATFORM_SUPER_ADMIN_ROLE, admin);
            _grant(targets[i], Roles.PLATFORM_ADMIN_ROLE, admin);
            _grant(targets[i], Roles.PLATFORM_ADMIN_ROLE, address(this));
            _grant(targets[i], Roles.ADMIN_ROLE, admin);
            _grant(targets[i], Roles.ELECTION_STAFF_ROLE, clerk);
            _grant(targets[i], Roles.CLERK_ROLE, admin);
            _grant(targets[i], Roles.CLERK_ROLE, clerk);
            _grant(targets[i], Roles.REGISTRAR_ROLE, registrar);
            _grant(targets[i], Roles.DISQUALIFICATION_OFFICER_ROLE, officer);
            _grant(targets[i], Roles.TALLY_OPERATOR_ROLE, tallyOperator);
            _grant(targets[i], Roles.RELAYER_ROLE, relayer);
            _grant(targets[i], Roles.SEQUENCER_ROLE, sequencer);
            _grant(targets[i], Roles.PROVER_ROLE, prover);
        }
    }

    function _forceAcceptAll() internal {
        _tryCall(address(verifier), abi.encodeWithSignature("setAccept(bool)", true));
        _tryCall(address(verifier), abi.encodeWithSignature("setAcceptAll(bool)", true));
    }

    function _label() internal {
        vm.label(admin, "admin");
        vm.label(clerk, "clerk");
        vm.label(registrar, "registrar");
        vm.label(officer, "officer");
        vm.label(tallyOperator, "tallyOperator");
        vm.label(relayer, "relayer");
        vm.label(address(hasher), "KeccakHasher");
        vm.label(address(verifier), "MockVerifier");
        vm.label(address(factory), "ElectionFactory");
        vm.label(address(voterRegistry), "VoterRegistry");
        vm.label(address(disqualification), "DisqualificationRegistry");
        vm.label(address(inbox), "BallotInbox");
        vm.label(address(tally), "Tally");
        vm.label(address(settlement), "RollupSettlement");
        vm.label(address(entryPoint), "RepublicEntryPoint");
        vm.label(address(paymaster), "RepublicPaymaster");
        vm.label(address(accountFactory), "PasskeyAccountFactory");
    }

    function defaultParams() internal view returns (ElectionParams memory) {
        return Fixtures.sampleParams(clerk, registrar, officer, tallyOperator, address(verifier));
    }

    function createElection() internal returns (uint256 electionId, address election) {
        return createElection(defaultParams());
    }

    function createElection(ElectionParams memory params) internal returns (uint256 electionId, address election) {
        vm.prank(admin);
        try factory.createElection(params) returns (uint256 id, address el) {
            return (id, el);
        } catch {
            vm.prank(clerk);
            try factory.createElection(params) returns (uint256 id2, address el2) {
                return (id2, el2);
            } catch {
                return factory.createElection(params);
            }
        }
    }

    function registerVoter(uint256 electionId, uint256 identityCommitment) internal {
        vm.prank(registrar);
        voterRegistry.register(electionId, identityCommitment);
    }

    function freezeRoll(address election) internal {
        address freezeClerk = IElection(election).params().clerk;
        vm.prank(freezeClerk);
        IElection(election).freezeRoll();
    }

    function warpOpen(address election) internal {
        vm.warp(IElection(election).params().startTime);
    }

    function warpClosed(address election) internal {
        vm.warp(IElection(election).params().cutoffTime);
    }

    function eligibleRoot(uint256 electionId, address election) internal view returns (bytes32 root) {
        root = IElection(election).eligibleRoot();
        if (root == bytes32(0)) {
            root = voterRegistry.merkleRoot(electionId);
        }
    }

    function disqRoot(uint256 electionId, address election) internal view returns (bytes32 root) {
        root = IElection(election).disqualificationRoot();
        if (root == bytes32(0)) {
            root = disqualification.merkleRoot(electionId);
        }
    }

    function voteInputs(uint256 electionId, address election, uint256 nullifier, bytes memory encrypted)
        internal
        view
        returns (uint256[] memory)
    {
        return Fixtures.publicInputs(
            eligibleRoot(electionId, election),
            disqRoot(electionId, election),
            nullifier,
            Fixtures.ballotHash(encrypted),
            electionId
        );
    }

    function submitVote(uint256 electionId, address election, uint256 nullifier) internal {
        submitVoteWithBallot(electionId, election, nullifier, Fixtures.encryptedBallot(nullifier));
    }

    function submitVoteWithBallot(uint256 electionId, address election, uint256 nullifier, bytes memory enc)
        internal
    {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, enc);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, inputs, enc);
    }

    function expectSubmitVoteRevert(uint256 electionId, address election, uint256 nullifier) internal {
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, enc);
        vm.prank(relayer);
        vm.expectRevert();
        inbox.submitVote(electionId, a, b, c, inputs, enc);
    }

    function prepareOpenElection(uint256 commitment) internal returns (uint256 electionId, address election) {
        (electionId, election) = createElection();
        registerVoter(electionId, commitment);
        freezeRoll(election);
        warpOpen(election);
        _forceAcceptAll();
    }

    function signedExecuteOp(address account, address dest, bytes memory destData, uint256 pk, uint256 nonce)
        internal
        view
        returns (UserOp memory op)
    {
        op.sender = account;
        op.nonce = nonce;
        op.callData = abi.encodeWithSelector(PasskeyAccount.execute.selector, dest, uint256(0), destData);
        op.callGasLimit = 500_000;
        op.verificationGasLimit = 500_000;
        op.maxFeePerGas = 0;
        op.paymaster = address(paymaster);
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, userOpHash);
        op.signature = abi.encodePacked(r, s, v);
    }

    function computeBatchDataHash(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot)
        internal
        view
        returns (bytes32)
    {
        (bool ok, bytes memory ret) = address(settlement).staticcall(
            abi.encodeWithSignature("computeDataHash(uint64,bytes32,bytes32)", batchIndex, prevStateRoot, newStateRoot)
        );
        if (ok && ret.length == 32) return abi.decode(ret, (bytes32));
        (ok, ret) = address(settlement).staticcall(
            abi.encodeWithSignature("hashBatch(uint64,bytes32,bytes32)", batchIndex, prevStateRoot, newStateRoot)
        );
        if (ok && ret.length == 32) return abi.decode(ret, (bytes32));
        return keccak256(abi.encode(batchIndex, prevStateRoot, newStateRoot));
    }

    function submitBatch(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot, bytes32 dataHash) internal {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        bytes memory payload = abi.encodeWithSelector(
            RollupSettlement.submitBatch.selector, batchIndex, prevStateRoot, newStateRoot, dataHash, a, b, c
        );
        vm.prank(sequencer);
        (bool ok,) = address(settlement).call(payload);
        if (!ok) {
            vm.prank(prover);
            (ok,) = address(settlement).call(payload);
        }
        if (!ok) {
            vm.prank(admin);
            (ok,) = address(settlement).call(payload);
        }
        require(ok, "submitBatch failed");
    }

    function _grant(address target, bytes32 role, address account) internal {
        _tryAdmin(target, abi.encodeWithSignature("grantRole(bytes32,address)", role, account));
    }

    function _tryAdmin(address target, bytes memory data) internal returns (bool ok) {
        vm.prank(admin);
        (ok,) = target.call(data);
    }

    function _tryCall(address target, bytes memory data) internal returns (bool ok) {
        (ok,) = target.call(data);
    }

    function _deploy(bytes memory creation, bytes memory args) internal returns (address addr) {
        bytes memory payload = args.length == 0 ? creation : bytes.concat(creation, args);
        assembly {
            addr := create(0, add(payload, 0x20), mload(payload))
        }
    }
}
