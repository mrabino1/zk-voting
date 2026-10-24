// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "../../src/interfaces/ElectionParams.sol";

/// @title Fixtures
/// @notice Sample `ElectionParams` builders and dummy Groth16 / ballot values for Foundry tests.
library Fixtures {
    uint64 internal constant TIME_ORIGIN = 1_700_000_000;
    uint64 internal constant ONE_DAY = 1 days;
    uint8 internal constant TREE_DEPTH = 16;

    bytes32 internal constant DEFAULT_JURISDICTION = keccak256("republic-test-jurisdiction");
    bytes32 internal constant DEFAULT_BALLOT_SPEC = keccak256("canonical-ballot-json");

    /// @notice Default civic election: unlimited roll, one-day window starting one day after origin.
    function sampleParams(
        address clerk,
        address registrar,
        address officer,
        address tallyOperator,
        address verifier
    ) internal pure returns (ElectionParams memory p) {
        p = build({
            title: "Republic Civic Election",
            metadataURI: "ipfs://republic/ballot",
            startTime: TIME_ORIGIN + ONE_DAY,
            cutoffTime: TIME_ORIGIN + (2 * ONE_DAY),
            maxParticipants: 0,
            treeDepth: TREE_DEPTH,
            clerk: clerk,
            registrar: registrar,
            officer: officer,
            tallyOperator: tallyOperator,
            verifier: verifier,
            questionCount: 1,
            jurisdictionId: DEFAULT_JURISDICTION
        });
    }

    function build(
        string memory title,
        string memory metadataURI,
        uint64 startTime,
        uint64 cutoffTime,
        uint32 maxParticipants,
        uint8 treeDepth,
        address clerk,
        address registrar,
        address officer,
        address tallyOperator,
        address verifier,
        uint8 questionCount,
        bytes32 jurisdictionId
    ) internal pure returns (ElectionParams memory p) {
        p.title = title;
        p.metadataURI = metadataURI;
        p.startTime = startTime;
        p.cutoffTime = cutoffTime;
        p.maxParticipants = maxParticipants;
        p.treeDepth = treeDepth;
        p.ballotSpecHash = DEFAULT_BALLOT_SPEC;
        p.clerk = clerk;
        p.registrar = registrar;
        p.disqualificationOfficer = officer;
        p.tallyOperator = tallyOperator;
        p.verifier = verifier;
        p.questionCount = questionCount;
        p.jurisdictionId = jurisdictionId;
        // Additive defaults: SUM_ONLY, no tally pubkey. OPENS_BALLOTS tests set these.
        p.tallyPubKeyX = bytes32(0);
        p.tallyPubKeyY = bytes32(0);
        p.tallyScheme = 0;
    }

    function withCap(ElectionParams memory p, uint32 cap) internal pure returns (ElectionParams memory) {
        p.maxParticipants = cap;
        return p;
    }

    function withTimes(ElectionParams memory p, uint64 startTime, uint64 cutoffTime)
        internal
        pure
        returns (ElectionParams memory)
    {
        p.startTime = startTime;
        p.cutoffTime = cutoffTime;
        return p;
    }

    function withTitle(ElectionParams memory p, string memory title) internal pure returns (ElectionParams memory) {
        p.title = title;
        return p;
    }

    function withJurisdiction(ElectionParams memory p, bytes32 jurisdictionId)
        internal
        pure
        returns (ElectionParams memory)
    {
        p.jurisdictionId = jurisdictionId;
        return p;
    }

    function withTallyScheme(ElectionParams memory p, uint8 scheme)
        internal
        pure
        returns (ElectionParams memory)
    {
        p.tallyScheme = scheme;
        return p;
    }

    function withTallyPubKey(ElectionParams memory p, bytes32 x, bytes32 y)
        internal
        pure
        returns (ElectionParams memory)
    {
        p.tallyPubKeyX = x;
        p.tallyPubKeyY = y;
        return p;
    }

    /// @notice keccak stand-in for poseidon(trapdoor, nullifierSecret). Never a wallet address.
    function identityCommitment(bytes32 secret) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked("identityCommitment", secret)));
    }

    function identityCommitment(uint256 n) internal pure returns (uint256) {
        return identityCommitment(bytes32(n));
    }

    function encryptedBallot(uint256 nullifier) internal pure returns (bytes memory) {
        return abi.encodePacked("elgamal-ciphertext", nullifier);
    }

    function ballotHash(bytes memory encrypted) internal pure returns (uint256) {
        return uint256(keccak256(encrypted)) % 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    }

    /// @dev Circuit / proof-helpers order: [root, disqRoot, nullifier, ballotHash, electionId]
    function publicInputs(bytes32 root, bytes32 disqRoot, uint256 nullifier, uint256 ballotHash_, uint256 electionId)
        internal
        pure
        returns (uint256[] memory inputs)
    {
        inputs = new uint256[](5);
        inputs[0] = uint256(root);
        inputs[1] = uint256(disqRoot);
        inputs[2] = nullifier;
        inputs[3] = ballotHash_;
        inputs[4] = electionId;
    }

    function dummyProof()
        internal
        pure
        returns (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c)
    {
        a = [uint256(1), uint256(2)];
        b = [[uint256(3), uint256(4)], [uint256(5), uint256(6)]];
        c = [uint256(7), uint256(8)];
    }
}
