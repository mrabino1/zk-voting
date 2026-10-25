// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.
// L1 (and the shared election stack) deploy once. Containers never call this.
// Addresses come from env after the one-time run. FORCE_REDEPLOY=1 is the only override.

import {Script, console2} from "forge-std/Script.sol";

abstract contract DeployOnce is Script {
    error AlreadyDeployed(string reason);

    function _forceRedeploy() internal view returns (bool) {
        if (!vm.envExists("FORCE_REDEPLOY")) return false;
        string memory raw = vm.envString("FORCE_REDEPLOY");
        bytes32 h = keccak256(bytes(raw));
        return h == keccak256("1") || h == keccak256("true") || h == keccak256("TRUE") || h == keccak256("yes")
            || h == keccak256("YES") || h == keccak256("on") || h == keccak256("ON");
    }

    function _refuseIfSet(string memory name) internal view {
        if (!vm.envExists(name)) return;
        string memory raw = vm.envString(name);
        if (bytes(raw).length == 0) return;
        revert AlreadyDeployed(
            string.concat(name, " is already set; refusing redeploy. Set FORCE_REDEPLOY=1 to override.")
        );
    }

    function _refuseIfRecord() internal view {
        if (!vm.envExists("DEPLOYMENTS_FILE")) return;
        string memory file = vm.envString("DEPLOYMENTS_FILE");
        if (bytes(file).length == 0 || !vm.exists(file)) return;
        string memory raw = vm.readFile(file);
        if (vm.keyExists(raw, ".deployed") && vm.parseJsonBool(raw, ".deployed")) {
            revert AlreadyDeployed(
                "deployment record exists; refusing redeploy. Set FORCE_REDEPLOY=1 to override."
            );
        }
    }

    /// @dev Call before broadcast. Empty env values do not count as a deploy.
    function _refuseIfAlreadyDeployed() internal view {
        if (_forceRedeploy()) {
            console2.log("WARNING: FORCE_REDEPLOY=1 - this can split the chain of record. Do not use on a live election.");
            return;
        }
        _refuseIfSet("SETTLEMENT_ADDRESS");
        _refuseIfSet("VERIFIER_ADDRESS");
        _refuseIfSet("L1_TALLY_MIRROR_ADDRESS");
        _refuseIfSet("L1_SETTLEMENT_ADDRESS");
        _refuseIfSet("ELECTION_FACTORY_ADDRESS");
        _refuseIfSet("BALLOT_INBOX_ADDRESS");
        _refuseIfRecord();
    }
}
