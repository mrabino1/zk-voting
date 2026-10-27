// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Script, console2} from "forge-std/Script.sol";
import {ElectionParams} from "../src/interfaces/ElectionParams.sol";
import {IElectionFactory} from "../src/interfaces/IElectionFactory.sol";

/// @notice Create one election on an already-deployed factory.
/// @dev Required env: FACTORY, START, CUTOFF, TITLE.
///      Optional: MAX_PARTICIPANTS (0), TREE_DEPTH (20), VERIFIER, CLERK,
///      REGISTRAR, DISQUALIFICATION_OFFICER, TALLY_OPERATOR, QUESTION_COUNT (1),
///      METADATA_URI, BALLOT_SPEC_HASH, JURISDICTION_ID.
contract CreateElection is Script {
    function run() external {
        address factoryAddr = vm.envAddress("FACTORY");
        vm.startBroadcast();
        (uint256 electionId, address election) =
            IElectionFactory(factoryAddr).createElection(_readParams(msg.sender));
        vm.stopBroadcast();

        console2.log(string.concat("FACTORY=", vm.toString(factoryAddr)));
        console2.log(string.concat("ELECTION=", vm.toString(election)));
        console2.log(string.concat("ELECTION_ID=", vm.toString(electionId)));
    }

    function _readParams(address actor) internal view returns (ElectionParams memory p) {
        uint256 startRaw = vm.envUint("START");
        uint256 cutoffRaw = vm.envUint("CUTOFF");
        require(startRaw <= type(uint64).max && cutoffRaw <= type(uint64).max, "time");
        require(startRaw < cutoffRaw, "START>=CUTOFF");

        uint256 maxParticipantsRaw = vm.envOr("MAX_PARTICIPANTS", uint256(0));
        require(maxParticipantsRaw <= type(uint32).max, "MAX_PARTICIPANTS");
        uint256 treeDepthRaw = vm.envOr("TREE_DEPTH", uint256(20));
        require(treeDepthRaw >= 16 && treeDepthRaw <= 32, "TREE_DEPTH");
        uint256 questionCountRaw = vm.envOr("QUESTION_COUNT", uint256(1));
        require(questionCountRaw >= 1 && questionCountRaw <= 32, "QUESTION_COUNT");

        p.title = vm.envString("TITLE");
        p.metadataURI = vm.envOr("METADATA_URI", string(""));
        // forge-lint: disable-next-line(unsafe-typecast)
        p.startTime = uint64(startRaw);
        // forge-lint: disable-next-line(unsafe-typecast)
        p.cutoffTime = uint64(cutoffRaw);
        // forge-lint: disable-next-line(unsafe-typecast)
        p.maxParticipants = uint32(maxParticipantsRaw);
        // forge-lint: disable-next-line(unsafe-typecast)
        p.treeDepth = uint8(treeDepthRaw);
        p.ballotSpecHash = vm.envOr("BALLOT_SPEC_HASH", bytes32(0));
        p.clerk = vm.envOr("CLERK", actor);
        p.registrar = vm.envOr("REGISTRAR", actor);
        p.disqualificationOfficer = vm.envOr("DISQUALIFICATION_OFFICER", actor);
        p.tallyOperator = vm.envOr("TALLY_OPERATOR", actor);
        p.verifier = vm.envOr("VERIFIER", address(0));
        // forge-lint: disable-next-line(unsafe-typecast)
        p.questionCount = uint8(questionCountRaw);
        p.jurisdictionId = vm.envOr("JURISDICTION_ID", keccak256("CIVIC"));
        p.tallyPubKeyX = vm.envOr("TALLY_PUB_X", bytes32(0));
        p.tallyPubKeyY = vm.envOr("TALLY_PUB_Y", bytes32(0));
        uint256 schemeRaw = vm.envOr("TALLY_SCHEME", uint256(0));
        require(schemeRaw <= 1, "TALLY_SCHEME");
        // forge-lint: disable-next-line(unsafe-typecast)
        p.tallyScheme = uint8(schemeRaw);
    }
}
