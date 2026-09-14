// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

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
        uint64 startTime = uint64(vm.envUint("START"));
        uint64 cutoffTime = uint64(vm.envUint("CUTOFF"));
        string memory title = vm.envString("TITLE");
        uint32 maxParticipants = uint32(vm.envOr("MAX_PARTICIPANTS", uint256(0)));
        uint8 treeDepth = uint8(vm.envOr("TREE_DEPTH", uint256(20)));

        vm.startBroadcast();
        address actor = msg.sender;
        ElectionParams memory p;
        p.title = title;
        p.metadataURI = vm.envOr("METADATA_URI", string(""));
        p.startTime = startTime;
        p.cutoffTime = cutoffTime;
        p.maxParticipants = maxParticipants;
        p.treeDepth = treeDepth;
        p.ballotSpecHash = vm.envOr("BALLOT_SPEC_HASH", bytes32(0));
        p.clerk = vm.envOr("CLERK", actor);
        p.registrar = vm.envOr("REGISTRAR", actor);
        p.disqualificationOfficer = vm.envOr("DISQUALIFICATION_OFFICER", actor);
        p.tallyOperator = vm.envOr("TALLY_OPERATOR", actor);
        p.verifier = vm.envOr("VERIFIER", address(0));
        p.questionCount = uint8(vm.envOr("QUESTION_COUNT", uint256(1)));
        p.jurisdictionId = vm.envOr("JURISDICTION_ID", keccak256("CIVIC"));

        (uint256 electionId, address election) = IElectionFactory(factoryAddr).createElection(p);
        vm.stopBroadcast();

        console2.log(string.concat("FACTORY=", vm.toString(factoryAddr)));
        console2.log(string.concat("ELECTION=", vm.toString(election)));
        console2.log(string.concat("ELECTION_ID=", vm.toString(electionId)));
    }
}
