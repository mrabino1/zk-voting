// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Script, console2} from "forge-std/Script.sol";
import {RollupSettlement} from "../src/l2/RollupSettlement.sol";
import {L1TallyMirror} from "../src/l2/L1TallyMirror.sol";
import {RepublicMailbox} from "../src/l2/RepublicMailbox.sol";

/// @notice Ethereum (or Sepolia) settlement: rollup, tally mirror, mailbox.
///         `BATCH_VERIFIER` may be unset / zero until a production VK exists.
///         `mockMode` is false on L1.
contract DeployL1 is Script {
    function run() external {
        vm.startBroadcast();
        address admin = msg.sender;
        address sequencer = vm.envOr("SEQUENCER", admin);
        address prover = vm.envOr("PROVER", admin);
        address batchVerifier = vm.envOr("BATCH_VERIFIER", address(0));

        RollupSettlement settlement = new RollupSettlement(admin, sequencer, prover, batchVerifier, false);
        RepublicMailbox mailbox = new RepublicMailbox(admin);
        L1TallyMirror mirror = new L1TallyMirror(admin, address(mailbox));
        address l2Factory = vm.envOr("L2_FACTORY", address(0));
        if (l2Factory != address(0)) {
            mirror.setL2Factory(l2Factory);
        }
        vm.stopBroadcast();

        _log("SETTLEMENT", address(settlement));
        _log("TALLY_MIRROR", address(mirror));
        _log("MAILBOX", address(mailbox));
        _log("BATCH_VERIFIER", batchVerifier);
    }

    function _log(string memory name, address addr) internal view {
        console2.log(string.concat(name, "=", vm.toString(addr)));
    }
}
