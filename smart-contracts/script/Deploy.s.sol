// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Script, console2} from "forge-std/Script.sol";

import {ZkVotingRollup} from "../src/ZkVotingRollup.sol";
import {DesertVerifier} from "../src/verifiers/DesertVerifier.sol";
import {Groth16Verifier} from "../src/verifiers/Groth16Verifier.sol";

/// @notice Public-chain deploy. Needs the batch circuit's verifying key from a completed
///         ceremony, as snarkjs `verification_key.json` (one public input). There is no mock
///         path here: the rollup itself refuses a mock verifier outside chain 31337.
///
///         GOVERNOR=0x… BATCH_VK=path/to/verification_key.json \
///         forge script script/Deploy.s.sol --rpc-url $RPC --private-key $KEY --broadcast
contract Deploy is Script {
    error WrongPublicInputCount();

    function run() external returns (ZkVotingRollup rollup) {
        address governor = vm.envAddress("GOVERNOR");
        Groth16Verifier.VerifyingKey memory vk = _readKey(vm.readFile(vm.envString("BATCH_VK")));

        vm.startBroadcast();
        DesertVerifier desert = new DesertVerifier();
        Groth16Verifier verifier = new Groth16Verifier(vk);
        rollup = new ZkVotingRollup(governor, verifier, desert);
        vm.stopBroadcast();

        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "batchVerifier", address(verifier));
        vm.serializeBytes32(json, "verifyingKeyHash", verifier.verifyingKeyHash());
        vm.serializeAddress(json, "desertVerifier", address(desert));
        vm.serializeAddress(json, "governor", governor);
        string memory out = vm.serializeAddress(json, "rollup", address(rollup));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console2.log("ZkVotingRollup", address(rollup));
    }

    /// @dev snarkjs G2 points are `[[x0, x1], [y0, y1], [1, 0]]`; EIP-197 wants `(x1, x0, y1, y0)`.
    function _readKey(string memory raw) internal pure returns (Groth16Verifier.VerifyingKey memory vk) {
        if (vm.parseJsonUint(raw, ".nPublic") != 1) revert WrongPublicInputCount();
        vk.alpha = [vm.parseJsonUint(raw, ".vk_alpha_1[0]"), vm.parseJsonUint(raw, ".vk_alpha_1[1]")];
        vk.beta = _g2(raw, ".vk_beta_2");
        vk.gamma = _g2(raw, ".vk_gamma_2");
        vk.delta = _g2(raw, ".vk_delta_2");
        vk.ic0 = [vm.parseJsonUint(raw, ".IC[0][0]"), vm.parseJsonUint(raw, ".IC[0][1]")];
        vk.ic1 = [vm.parseJsonUint(raw, ".IC[1][0]"), vm.parseJsonUint(raw, ".IC[1][1]")];
    }

    function _g2(string memory raw, string memory key) internal pure returns (uint256[4] memory p) {
        p[0] = vm.parseJsonUint(raw, string.concat(key, "[0][1]"));
        p[1] = vm.parseJsonUint(raw, string.concat(key, "[0][0]"));
        p[2] = vm.parseJsonUint(raw, string.concat(key, "[1][1]"));
        p[3] = vm.parseJsonUint(raw, string.concat(key, "[1][0]"));
    }
}
